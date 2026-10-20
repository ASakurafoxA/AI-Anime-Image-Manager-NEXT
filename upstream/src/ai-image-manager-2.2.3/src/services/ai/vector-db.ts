import { fork } from "node:child_process";
import { app } from "electron";
import fs from "node:fs";
import { createLogger } from "@/utils/logger";
import path from "node:path";
import type {
  Connection as LanceConnection,
  Table as LanceTable,
} from "@lancedb/lancedb";
import {
  Field,
  FixedSizeList,
  Float32,
  Float64,
  Int32,
  Schema,
} from "apache-arrow";
import { eq, inArray, isNull, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { appSettings, photos } from "@/db/schema";
import { getDataPath } from "@/utils/data-path";
import { APP_DISPLAY_NAME } from "@/config/private-build";
import { MIN_VECTORS_FOR_INDEX } from "./constants";
import { getAiControlState } from "./state";
import { getActiveEmbeddingAdapter } from "./model-adapter";
import {
  getActiveEmbeddingModel,
  getActiveEmbeddingRuntimeInfo,
} from "./model-config";
import {
  decideVectorCompatibility,
  getModelFingerprint,
  inspectStoredVectorFingerprint,
  isVectorCompatibilitySearchable,
  type VectorCompatibility,
  verifyAdapterArtifacts,
  writeStoredVectorFingerprint,
} from "./model-fingerprint";
import {
  _localModelPath,
  colorTable,
  getActiveEmbeddingRuntime,
  isVectorDBReady,
  photoTable,
  setActiveEmbeddingRuntime,
  setColorTable,
  setCcipTable,
  ccipTable,
  setPixaiTable,
  setWd14Table,
  wd14Table,
  setIsVectorDBReady,
  setPhotoTable,
  setVectorCompatibility,
  setVectordb,
  setWasAutoRepaired,
  pixaiTable,
  vectordb,
} from "./state";
import { getActiveThresholdProfile } from "./threshold-profile";

/** 自用：维护与索引构建的日志统一走 pino（原来 console.log 只到终端 ✗）。 */
const log = createLogger("ai-vector-db");
import {
  getUnreconciledVectorIds,
  planVectorReconciliation,
} from "./vector-reconciliation";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function getListSize(type: unknown): number | undefined {
  if (
    typeof type === "object" &&
    type !== null &&
    "listSize" in type &&
    typeof type.listSize === "number"
  ) {
    return type.listSize;
  }
  return undefined;
}

interface ArrayLikeVector {
  toArray: () => ArrayLike<number>;
}

function isArrayLikeVector(value: unknown): value is ArrayLikeVector {
  return (
    typeof value === "object" &&
    value !== null &&
    "toArray" in value &&
    typeof value.toArray === "function"
  );
}

function isNumberIterable(value: unknown): value is Iterable<number> {
  return (
    typeof value === "object" && value !== null && Symbol.iterator in value
  );
}

// ── 向量数据库定期维护 ──────────────────────────────────────────────
// 数据追加后 LanceDB 产生碎片和旧版本文件，定期压缩清理释放磁盘空间。
//
// 自用（2026-10-16 修正）：**清理动作一律在 worker 进程里跑** ✓（见 runMaintenanceInWorker），
// 主进程只负责"什么时候清"。原来在主进程里直接调维护 API 的那段代码已删除 ✗ ——
// 它调的 `compactFiles()` / `cleanupOldVersions()` 在 @lancedb/lancedb 0.18 里**根本不存在** ✗，
// 外面又有 `if (typeof … === "function")` 守卫 → 一直**静默空转**，
// 碎片/旧版本从未被清理过（实测 vectors 目录涨到 19,409 个文件、1.42 GB ✗）。
//
// 正确的 API 是 `table.optimize({ cleanupOlderThan: 刚刚, deleteUnverified: true })` ✓
// 注意 `cleanupOlderThan` 会被 JS 封装换算成"年龄"（= Date.now() − 该日期），
// 语义是"清掉比 (现在 − 年龄) 更早的版本"，所以**必须传"刚刚"才清得干净** ✓；
// 传 `new Date(0)`（年龄 56 年）实测**一个都清不掉** ✗，传 1 秒前也清不掉（版本还没那么老）✗。
// worker 里固定用"1 分钟前"，既有清理效果又留一点时间旅行窗口 ✓。

let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
let firstMaintenanceTimer: ReturnType<typeof setTimeout> | null = null;
/** 首次维护延迟：避开启动 I/O 高峰，也给用户一点先动手的时间 ✓。 */
const FIRST_MAINTENANCE_DELAY_MS = 2 * 60 * 1000;
let maintenanceRunning = false;

/*
 * 自用（2026-10）：把"维护 / 建索引"这类**不可中断的同步原生调用** ✗ 放到独立进程里跑 ✓。
 *
 * 为什么：createIndex 在 2.2 万行要 30 秒、7.7 万行要 1~2 分钟；optimize（compaction）要数分钟 ✗
 * —— 在主进程里跑会把界面卡到「未响应」（Windows 甚至判 AppHang 关掉应用 ✗）。
 * 放到 worker 后，主进程只是 await 子进程（事件循环自由 ✓），界面全程流畅 ✓。
 */
function findVectorMaintenanceWorkerScript(): string {
  const candidates = [
    path.join(app.getAppPath(), "scripts", "vector-maintenance-worker.mjs"),
    path.join(
      app.getAppPath(),
      "app.asar.unpacked",
      "scripts",
      "vector-maintenance-worker.mjs"
    ),
    path.join(process.cwd(), "scripts", "vector-maintenance-worker.mjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("vector-maintenance-worker.mjs not found");
}

interface MaintenanceTableResult {
  name: string;
  rows: number | null;
  filesBefore: number | null;
  filesAfter: number | null;
  bytesBefore: number | null;
  bytesAfter: number | null;
  versionsBefore: number | null;
  versionsAfter: number | null;
  optimizeMs: number;
  fragmentsRemoved: number;
  filesRemoved: number;
  filesAdded: number;
  oldVersionsRemoved: number;
  bytesRemoved: number;
  /** 非 null 表示这张表清理失败（必须记日志，不能像旧代码那样静默跳过 ✗）。 */
  error: string | null;
}

interface MaintenanceWorkerResult {
  optimizeMs: number;
  indexMs: number;
  rows: number | null;
  skipped: string[];
  filesBefore: number;
  filesAfter: number;
  tables: MaintenanceTableResult[];
  indexErrors: string[];
}

/** 把一次维护的结果写成一行可读日志（碎片数看得见 ✓）。 */
function describeMaintenanceResult(result: MaintenanceWorkerResult): string {
  const parts = result.tables.map((table) => {
    const delta =
      table.filesBefore === null || table.filesAfter === null
        ? "?"
        : `${table.filesBefore}→${table.filesAfter}`;
    const versions =
      table.versionsBefore === null
        ? "?"
        : `${table.versionsBefore}→${table.versionsAfter ?? "?"}`;
    const failed = table.error ? ` 失败:${table.error}` : "";
    return `${table.name}: ${table.optimizeMs}ms 文件${delta} 版本${versions} 合并${table.fragmentsRemoved}片 清旧版本${table.oldVersionsRemoved} 释放${(
      table.bytesRemoved /
      (1024 * 1024)
    ).toFixed(1)}MB${failed}`;
  });
  return parts.join(" ｜ ");
}

function runVectorMaintenanceWorker(
  tasks: {
    /** 清理（compaction + 清旧版本）。 */
    optimize?: boolean;
    /** @deprecated 旧字段，等价于 optimize。 */
    compact?: boolean;
    /** @deprecated 旧字段，等价于 optimize。 */
    cleanup?: boolean;
    index?: boolean;
    /** 建索引用：分区数（主进程算好传进来，worker 里不再依赖主进程状态 ✓）。 */
    numPartitions?: number;
    /** 只清这几张表（不传 = worker 默认四张表）。 */
    tables?: string[];
  },
  timeoutMs = 30 * 60 * 1000
): Promise<MaintenanceWorkerResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof fork>;
    try {
      child = fork(findVectorMaintenanceWorkerScript(), [], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // worker 的 stderr 收着（只留末尾一段）—— 失败时能直接给出原因 ✓。
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-2000);
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`维护 worker 超时（${timeoutMs}ms）`));
    }, timeoutMs);

    child.on("message", (message: { type?: string; ok?: boolean; result?: MaintenanceWorkerResult; error?: string }) => {
      if (message?.type !== "result" || settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (message.ok && message.result) {
        resolve(message.result);
      } else {
        reject(
          new Error(
            `${message.error ?? "维护 worker 失败"}${stderrTail ? ` :: ${stderrTail.trim()}` : ""}`
          )
        );
      }
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    /*
     * 自用（2026-10-16，**修"worker 崩了以后维护静默卡死 30 分钟"** ✗→✓）：
     * 原来只监听 `message` 与 `error` ✗ —— 而子进程在原生代码（optimize / createIndex，
     * 几分钟级）里**崩溃或被系统杀掉**时，这两条都可能不触发 ✗ →
     * `resolve/reject` 都不会发生 ✗ → `maintenanceRunning` 一直为 true ✓
     * → 这期间所有维护请求（写向量/打标每批后都会调 ✓）**静默返回、连日志都没有** ✗，
     * 碎片治理等于停了最长 30 分钟（要等超时 ✓）。
     * 补一条 `close`：进程真的退出就立刻带 stderr 收尾 ✓。
     */
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `维护 worker 意外退出（code=${code ?? "null"}, signal=${signal ?? "null"}）${stderrTail ? ` :: ${stderrTail.trim()}` : ""}`
        )
      );
    });
    child.send({
      type: "run",
      vectorsPath: path.join(getDataPath(), "vectors"),
      tasks,
    });
  });
}

/**
 * 自用（2026-10-16）：**库已经很干净就别折腾** ✓。
 *
 * 每次维护都要 fork 一个子进程 + 打开向量库；而「版本数」就是"自上次清理以来
 * 写了几次"（LanceDB 每写一次就多一个版本 ✓）。
 * 官方建议是「改了 20 次以上再 optimize」，所以版本数很少时直接跳过：
 *   · 省掉一次没必要的子进程与磁盘往返 ✓
 *   · 也避免维护在用户刚启动时无意义地"碰"向量库 ✓
 * 有异常（查不出数据）时**照旧清一次**，不影响正确性 ✓。
 */
const NEGLIGIBLE_MAINTENANCE_VERSIONS = 8;

/**
 * 自用：跑一次 worker 维护并记日志（耗时与碎片数都来自 worker ✓）。
 *
 * 四道守卫，缺一不可：
 *  ① 正在建向量 / 打标 → 不跑（两条链都在写同一张表，实测会把速度从 40+ 拖到 16 张/秒 ✗）。
 *  ② 上一次还没跑完 → 不重入。
 *  ③ 向量库没就绪 → 不跑。
 *  ④ 版本数太少（没什么可清）→ 不跑（省一次子进程 ✓）。
 */
async function runMaintenanceInWorker(reason: string): Promise<void> {
  if (maintenanceRunning) {
    return;
  }
  if (!(isVectorDBReady && photoTable)) {
    return;
  }
  if (getAiControlState() !== "idle") {
    log.info(
      `[AI] Maintenance deferred while AI is busy (${getAiControlState()}) — ${reason}`
    );
    return;
  }
  try {
    const versions = (await photoTable.listVersions()).length;
    if (versions <= NEGLIGIBLE_MAINTENANCE_VERSIONS) {
      log.info(
        `[AI] Maintenance: skipped (only ${versions} version(s), nothing to clean) — ${reason}`
      );
      return;
    }
  } catch {
    /* 查不出就照旧清一次 */
  }
  maintenanceRunning = true;
  const startedAt = Date.now();
  try {
    log.info(`[AI] Maintenance: start in worker (${reason})`);
    const result = await runVectorMaintenanceWorker({ optimize: true });
    log.info(
      `[AI] Maintenance: done in ${Date.now() - startedAt}ms (worker ${result.optimizeMs}ms) 文件总数 ${result.filesBefore}→${result.filesAfter} ｜ ${describeMaintenanceResult(result)}`
    );
    for (const table of result.tables) {
      if (table.error) {
        log.warn(`[AI] Maintenance: ${table.name} 清理失败 — ${table.error}`);
      }
    }
    if (result.skipped.length > 0) {
      log.info(`[AI] Maintenance: skipped → ${result.skipped.join(", ")}`);
    }
  } catch (error) {
    log.warn(`[AI] Maintenance: worker failed: ${getErrorMessage(error)}`);
  } finally {
    maintenanceRunning = false;
  }
}

/**
 * 自用新增：**立刻**跑一次维护（供"大批量写入刚结束"时调用）。
 *
 * 为什么需要：全库 CCIP 特征会分几千批写入，LanceDB 每写一次就多一个版本
 * —— 正是之前"1.9 万个文件 / 1.4 GB"那类碎片事故的成因。
 * 自动维护虽然每 10 分钟一次，但用户可能写完就关软件了，所以**收尾时主动清一次** ✓。
 */
export async function runVectorMaintenanceNow(reason: string): Promise<void> {
  await runMaintenanceInWorker(reason);
}

/**
 * 自用（2026-10-16 重新开启自动维护）：
 *
 * 之前**默认关闭**的唯一理由是"清理动作占主线程 → 界面未响应"✗；
 * 现在清理已经在 worker 进程里跑 ✓（主进程只 await 子进程，事件循环自由 ✓），
 * 所以恢复为**默认开启**：
 *   · 启动后 FIRST_MAINTENANCE_DELAY_MS（2 分钟）先补一次（把之前堆的碎片清掉 ✓）
 *   · 之后每 10 分钟一次（AI 忙时自动让路 ✓）
 *   · `AI_VECTOR_MAINTENANCE_MINUTES=0` 关闭；=任意正数 改间隔
 */
function scheduleVectorMaintenance(): void {
  const intervalMs = periodicMaintenanceIntervalMs();
  if (!Number.isFinite(intervalMs)) {
    log.info(
      "[AI] Maintenance: 自动维护已关闭（AI_VECTOR_MAINTENANCE_MINUTES=0）"
    );
    return;
  }
  if (maintenanceTimer || firstMaintenanceTimer) {
    return;
  }
  log.info(
    `[AI] Maintenance: scheduled (first in ${Math.round(FIRST_MAINTENANCE_DELAY_MS / 1000)}s, then every ${Math.round(intervalMs / 60000)}min)`
  );
  firstMaintenanceTimer = setTimeout(() => {
    firstMaintenanceTimer = null;
    void runMaintenanceInWorker("startup catch-up");
  }, FIRST_MAINTENANCE_DELAY_MS);
  maintenanceTimer = setInterval(() => {
    void runMaintenanceInWorker("periodic");
  }, intervalMs);
}

/*
 * 自用：定期维护的间隔。默认 **10 分钟** ✓
 * （实测 2 分钟太勤：一次清理还没跑完下一次又该开始 ✗；
 *   而现在清理在 worker 里、不再占主线程，10 分钟不会拖慢建向量 ✓）。
 * 环境变量覆盖：`AI_VECTOR_MAINTENANCE_MINUTES=0` 表示**关闭**（方便对比验证）。
 */
function periodicMaintenanceIntervalMs(): number {
  const raw = process.env.AI_VECTOR_MAINTENANCE_MINUTES;
  if (raw === undefined || raw.trim() === "") {
    return 10 * 60 * 1000;
  }
  const minutes = Number.parseFloat(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return minutes * 60 * 1000;
}
let lastPeriodicMaintenanceAt = 0;

/**
 * 自用（2026-10，**修"越跑越慢"**）：
 * 建向量/打标都是往 LanceDB **追加**，每批都会产生新的数据碎片 ✗，
 * 碎片越多、每次写入越慢（实测 47 张/秒 → 33 张/秒，且打标也一样）✓。
 *
 * 这个函数给"写入过程中"用的：每批写入后调用，最多每 10 分钟真正清一次 ✓。
 * **AI 忙时直接返回、也不消耗配额** ✓ —— 否则清理会和写入抢同一张表。
 */
export function requestVectorMaintenance(): void {
  if (maintenanceRunning) {
    return;
  }
  if (getAiControlState() !== "idle") {
    return;
  }
  const now = Date.now();
  if (now - lastPeriodicMaintenanceAt < periodicMaintenanceIntervalMs()) {
    return;
  }
  lastPeriodicMaintenanceAt = now;
  void runMaintenanceInWorker("after writes");
}

function clearVectorMaintenance(): void {
  if (firstMaintenanceTimer) {
    clearTimeout(firstMaintenanceTimer);
    firstMaintenanceTimer = null;
  }
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}

let vectorDbInitPromise: Promise<void> | null = null;
let vectorDbGeneration = 0;
let vectorDbOperationTail = Promise.resolve();

/** Serialize destructive rebuild/close operations with embedding and search IO. */
export function withVectorDbOperation<T>(
  operation: () => Promise<T> | T
): Promise<T> {
  const run = vectorDbOperationTail.then(operation, operation);
  vectorDbOperationTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function getVectorDbGeneration(): number {
  return vectorDbGeneration;
}

/** Use Lance's committed version, not SQLite's stable per-photo vector ID.
 * The operation queue also waits for embedding writes and SQLite bookkeeping.
 * An interrupted write changes the durable version even before bookkeeping.
 */
export function getDuplicateVectorRevision(): Promise<string> {
  return withVectorDbOperation(async () => {
    if (!(isVectorDBReady && photoTable)) {
      return `unavailable:${vectorDbGeneration}`;
    }
    return `${vectorDbGeneration}:${await photoTable.version()}:${getActiveEmbeddingRuntime()?.vectorCompatibility ?? "unknown"}`;
  });
}

function modelRootCandidates(): string[] {
  const candidates = [
    path.join(getDataPath(), "models"),
    path.join(process.cwd(), "models"),
    _localModelPath,
  ];
  return [
    ...new Set(
      candidates.filter((candidate): candidate is string => !!candidate)
    ),
  ];
}

async function canAdoptLegacyVectorStore(): Promise<boolean> {
  const adapter = getActiveEmbeddingAdapter();
  for (const modelRoot of modelRootCandidates()) {
    if (await verifyAdapterArtifacts(modelRoot, adapter.artifacts)) {
      return true;
    }
  }
  return false;
}

async function inspectVectorCompatibility(
  dataPath: string,
  dimensions: number,
  rowCount: number
): Promise<{ status: VectorCompatibility; adoptLegacy: boolean }> {
  const adapter = getActiveEmbeddingAdapter();
  const fingerprint = getModelFingerprint(adapter);
  const marker = inspectStoredVectorFingerprint(dataPath);
  const shouldVerifyLegacyArtifacts =
    marker.state === "missing" &&
    rowCount > 0 &&
    adapter.legacyKind === "siglip" &&
    dimensions === adapter.embeddingSpace.dimensions;

  return decideVectorCompatibility({
    active: {
      adapterId: adapter.id,
      dimensions: adapter.embeddingSpace.dimensions,
      fingerprint,
      legacyKind: adapter.legacyKind,
    },
    marker,
    rowCount,
    vectorDimensions: dimensions,
    legacyArtifactsVerified:
      shouldVerifyLegacyArtifacts && (await canAdoptLegacyVectorStore()),
  });
}

function initializeEmbeddingRuntime(): void {
  const info = getActiveEmbeddingRuntimeInfo();
  const profile = getActiveThresholdProfile();
  const current = getActiveEmbeddingRuntime();
  setActiveEmbeddingRuntime({
    ...info,
    vectorCompatibility:
      current?.adapterId === info.adapterId &&
      current.fingerprint === info.fingerprint &&
      current.dimensions === info.dimensions
        ? current.vectorCompatibility
        : "empty",
    thresholdProfileId: profile.profileId,
    calibrationStatus: profile.calibrationStatus,
  });
}

export async function persistActiveVectorFingerprint(
  source: "fresh-build" | "legacy-adoption" = "fresh-build"
): Promise<void> {
  const adapter = getActiveEmbeddingAdapter();
  await writeStoredVectorFingerprint(getDataPath(), {
    schemaVersion: 1,
    fingerprint: getModelFingerprint(adapter),
    adapterId: adapter.id,
    dimensions: adapter.embeddingSpace.dimensions,
    createdAt: new Date().toISOString(),
    source,
  });
  setVectorCompatibility(
    source === "legacy-adoption" ? "legacy-compatible" : "matching"
  );
}

export function initVectorDB(): Promise<void> {
  if (isVectorDBReady && vectordb && photoTable) {
    return Promise.resolve();
  }

  if (!vectorDbInitPromise) {
    const promise = initializeVectorDB();
    const trackedPromise = promise.finally(() => {
      if (vectorDbInitPromise === trackedPromise) {
        vectorDbInitPromise = null;
      }
    });
    vectorDbInitPromise = trackedPromise;
  }

  return vectorDbInitPromise;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Vector DB startup keeps compatibility checks, corruption recovery, and table setup in one flow.
async function initializeVectorDB(): Promise<void> {
  const generation = vectorDbGeneration;
  initializeEmbeddingRuntime();
  // 清理上次重建残留的 .bak 目录
  await cleanupStaleBackups();

  const vectorPath = path.join(getDataPath(), "vectors");

  console.log(`[AI] Initializing vector DB at: ${vectorPath}`);
  const lancedb = await import("@lancedb/lancedb");

  let db: LanceConnection;
  try {
    db = await lancedb.connect(vectorPath);
  } catch (err: unknown) {
    const message = getErrorMessage(err);
    console.error("[AI] LanceDB connect failed:", message);
    throw new Error(`Failed to connect to vector database: ${message}`);
  }
  if (generation !== vectorDbGeneration) {
    try {
      await db.close();
    } catch {
      /* best-effort close for a superseded connection */
    }
    throw new Error("Vector DB initialization superseded");
  }
  setVectordb(db);
  const model = getActiveEmbeddingModel();
  const vectorDimensions = model.vectorDimensions;

  const tableNames = await db.tableNames();

  if (tableNames.includes("photo_embeddings")) {
    let table: LanceTable | null = null;
    try {
      table = await db.openTable("photo_embeddings");
    } catch (err: unknown) {
      console.error("[AI] LanceDB openTable failed:", getErrorMessage(err));
      // Table exists but can't be opened — likely corrupted. Drop and recreate.
      try {
        await db.dropTable("photo_embeddings");
      } catch {
        // best-effort cleanup
      }
      setPhotoTable(null);
      // Fall through to create fresh table below
    }

    if (table) {
      setPhotoTable(table);

      const existingRowCount = await table.countRows();
      const compatibility = await inspectVectorCompatibility(
        getDataPath(),
        vectorDimensions,
        existingRowCount
      );
      setVectorCompatibility(compatibility.status);
      if (
        existingRowCount > 0 &&
        !isVectorCompatibilitySearchable(compatibility.status)
      ) {
        throw new Error(
          `Vector store is incompatible with active embedding model (${compatibility.status}); rebuild required`
        );
      }

      // Model changes also change the vector schema and require re-indexing.
      const schema = await table.schema();
      const vectorField = schema.fields.find(
        (field) => field.name === "vector"
      );
      const schemaValid =
        vectorField &&
        vectorField.type !== null &&
        typeof vectorField.type === "object" &&
        getListSize(vectorField.type) === vectorDimensions;

      if (schemaValid) {
        console.log("[AI] Opened existing photo_embeddings table (schema OK)");

        // Run deep validation BEFORE checking the crash-safety marker.
        // If the data is actually healthy (e.g. dev server restart where
        // closeVectorDB never ran), we should NOT drop it — just write the
        // marker and proceed. Only rebuild if validation genuinely fails.
        const validation = await validateVectorDB();

        if (validation.healthy) {
          if (compatibility.adoptLegacy) {
            await persistActiveVectorFingerprint("legacy-adoption");
            console.log("[AI] Adopted legacy SigLIP v1 vector fingerprint");
          }
          // Data is intact. If the marker is missing, it was a clean dev
          // restart or similar — just write it now and continue.
          if (!isIndexCleanShutdown()) {
            console.log(
              "[AI] Marker missing but data healthy — writing marker (clean restart)"
            );
            markIndexReady();
          }

          /*
           * 自用（2026-10，方案 A）：索引构建**不能在启动链上 await** ✗。
           *
           * IVF_PQ 在 2.2 万行要 30 秒、7.7 万行要 1~2 分钟（实测同步构建
           * 卡住整个启动 → 界面白屏 ✗）；而且它在建之前会写"脏标记"，
           * 中途被强杀（白屏时用户很可能这么做）→ 下次启动再建一遍 ✗。
           *
           * 现在改成后台建：数据库先就绪、界面立刻可用 ✓，
           * 索引在后台慢慢建 ✓（没索引时搜索本来就有暴力兜底 ✓）。
           * 这里的结果只用于打一条警告，没有任何逻辑依赖它，所以不 await 是安全的。
           */
          /*
           * 自用（2026-10-16 恢复默认建索引）：
           *
           * 之前默认不建的唯一理由是"建索引是 30 秒~2 分钟的不可中断同步原生调用 ✗，
           * 占住主线程 → 界面未响应"✗。现在这个调用已经在 **worker 进程**里跑 ✓
           *（见 ensureVectorIndex → runVectorMaintenanceWorker({index:true})），
           * 主进程只 await 子进程，界面全程流畅 ✓，所以恢复为**默认开启** ✓。
           *
           * 另外 ensureVectorIndex 里还有两道守卫，不会白建：
           *   · AI 忙（正在建向量/打标）→ 不建 ✓
           *   · 全库还有没处理完的照片（pending > 0）→ 不建 ✓
           * 想手动关掉：设 `AI_VECTOR_INDEX=0` ✓
           */
          if (process.env.AI_VECTOR_INDEX === "0") {
            log.info("[AI] Vector index build disabled by AI_VECTOR_INDEX=0");
          } else {
            ensureVectorIndex()
              .then((indexOk) => {
                log.info(
                  indexOk
                    ? "[AI] Vector index ensured in background"
                    : "[AI] Proceeding without vector index — search may be slower"
                );
              })
              .catch((err: unknown) => {
                log.warn(
                  `[AI] Background index build failed: ${getErrorMessage(err)}`
                );
              });
          }

          // ── 初始化颜色向量表（如不存在则创建） ───────────────
          await initColorTable(db);

          // ── 自用新增：初始化 WD14 动漫特征表（如不存在则创建）──
          await initWd14Table(db);

          // ── 自用新增：初始化 PixAI Tagger v1.0 特征表（1024 维）──
          await initPixaiTable(db);

          // ── 自用新增：初始化 CCIP 角色特征表（768 维）──
          await initCcipTable(db);

          // 后台回填已有的 dominant_colors 到 LanceDB 颜色表
          backfillColorVectors().catch((err) =>
            console.warn("[AI] Color backfill failed:", getErrorMessage(err))
          );

          setIsVectorDBReady(true);
          scheduleVectorMaintenance();
          return;
        }

        // Validation failed — genuine corruption detected. Auto-rebuild.
        console.error(
          `[AI] Vector DB validation failed: ${validation.reason}. Auto-rebuilding...`
        );
        diagLog(
          `initVectorDB: validation failed — ${validation.reason}, auto-rebuilding`
        );

        if (vectordb) {
          try {
            await vectordb.close();
          } catch {
            /* best-effort */
          }
          setVectordb(null);
          setPhotoTable(null);
          setIsVectorDBReady(false);
        }

        const rebuildResult = await rebuildVectorDB();
        if (rebuildResult.success) {
          console.log("[AI] Auto-repair: vector DB rebuilt successfully");
          const resetCount = resetAllAiProcessedFlags();
          console.log(
            `[AI] Auto-repair: ${resetCount} photos marked for re-index`
          );
          setWasAutoRepaired(true);
          return;
        }
        console.error(
          `[AI] Auto-repair failed: ${rebuildResult.error}, proceeding degraded`
        );
      }
      console.log(
        `[AI] Schema mismatch — expected FixedSizeList<${vectorDimensions}> for ${model.displayName}. Recreating...`
      );
      await db.dropTable("photo_embeddings");
      setPhotoTable(null);
      const resetCount = resetAllAiProcessedFlags();
      console.log(
        `[AI] Model migration: ${resetCount} photos marked for ${model.displayName} re-index`
      );
      setWasAutoRepaired(true);
    }
  }

  // Create a fresh table matching the active embedding model.
  const schema = new Schema([
    new Field("photo_id", new Int32()),
    new Field(
      "vector",
      new FixedSizeList(vectorDimensions, new Field("item", new Float32()))
    ),
    new Field("created_at", new Float64()),
  ]);

  const newTable = await db.createEmptyTable("photo_embeddings", schema);
  setPhotoTable(newTable);
  setVectorCompatibility("empty");
  console.log(
    `[AI] Created photo_embeddings table (FixedSizeList<Float32>[${vectorDimensions}], ${model.displayName})`
  );
  markIndexDirty(); // New table has no data — will be set to ready after index build completes

  // ── 初始化颜色向量表（3D RGB） ───────────────────────────────────
  await initColorTable(db);

  // ── 自用新增：初始化 WD14 动漫特征表（768 维） ────────────────────
  // 用于升级「以图搜图」。表不存在时只是建空表，不阻塞启动；
  // 特征会在 WD14 打标过程中逐步写入。
  await initWd14Table(db);

  // ── 自用新增：初始化 PixAI Tagger v1.0 特征表（1024 维） ──────────
  // 与 WD14 同理：表不存在时只是建空表，不阻塞启动；
  // 特征会在 PixAI 打标过程中逐步写入。两张表并存，互不影响。
  await initPixaiTable(db);

  // 后台回填已有的 dominant_colors 到 LanceDB 颜色表（不阻塞启动）
  backfillColorVectors().catch((err) =>
    console.warn("[AI] Color backfill failed:", getErrorMessage(err))
  );

  setIsVectorDBReady(true);
  scheduleVectorMaintenance();
}

export function buildPhotoIdFilter(ids: number[]): string {
  const validated = ids.filter(
    (id) => Number.isInteger(id) && id > 0 && id < 2_147_483_647
  );
  if (validated.length === 0) {
    throw new Error("[AI] buildPhotoIdFilter: no valid IDs");
  }
  return `photo_id IN (${validated.join(", ")})`;
}

/**
 * 清理孤儿和重复向量。
 * - SQLite 中不存在或已软删除的 photo_id：直接删除
 * - 同一有效 photo_id 存在多条向量：删除全部旧向量，并把照片重新排队嵌入
 */
export async function cleanupOrphanVectors(
  softDeletedIds: number[]
): Promise<number> {
  if (!(isVectorDBReady && photoTable)) {
    return 0;
  }
  let deleted = 0;
  try {
    const allRows = (await photoTable
      .query()
      .select(["photo_id"])
      .toArray()) as Array<{ photo_id: number }>;
    const db = getDatabase();
    const validIds = new Set(
      db
        .select({ id: photos.id })
        .from(photos)
        .where(isNull(photos.deletedAt))
        .all()
        .map((row) => row.id)
    );
    const { duplicateIds, orphanIds } = planVectorReconciliation(
      allRows.map((row) => row.photo_id),
      validIds,
      softDeletedIds
    );
    const idsToDelete = [...new Set([...orphanIds, ...duplicateIds])];
    const CHUNK_SIZE = 500;

    for (let index = 0; index < idsToDelete.length; index += CHUNK_SIZE) {
      await photoTable.delete(
        buildPhotoIdFilter(idsToDelete.slice(index, index + CHUNK_SIZE))
      );
    }

    if (duplicateIds.length > 0) {
      for (let index = 0; index < duplicateIds.length; index += CHUNK_SIZE) {
        db.update(photos)
          .set({ isAiProcessed: false })
          .where(
            inArray(photos.id, duplicateIds.slice(index, index + CHUNK_SIZE))
          )
          .run();
      }
    }

    if (idsToDelete.length > 0) {
      const remainingRows = (await photoTable
        .query()
        .select(["photo_id"])
        .toArray()) as Array<{ photo_id: number }>;
      const failedIds = getUnreconciledVectorIds(
        idsToDelete,
        remainingRows.map((row) => Number(row.photo_id))
      );
      if (failedIds.length > 0) {
        throw new Error(
          `Vector reconciliation could not remove photo IDs: ${failedIds.join(",")}`
        );
      }
      deleted = Math.max(0, allRows.length - remainingRows.length);
      console.log(
        `[AI] Vector reconciliation: removed ${deleted} rows (${orphanIds.length} orphan photo IDs, ${duplicateIds.length} duplicate photo IDs re-queued)`
      );
    }
  } catch (err: unknown) {
    console.error("[AI] Orphan vector cleanup failed:", getErrorMessage(err));
    throw err;
  }
  return deleted;
}

export async function deletePhotoVectors(photoIds: number[]): Promise<void> {
  if (photoIds.length === 0) {
    return;
  }

  try {
    if (!(isVectorDBReady && photoTable)) {
      await initVectorDB();
    }
    if (!photoTable) {
      throw new Error("vector database is not available");
    }

    const uniqueIds = [...new Set(photoIds)];
    const CHUNK_SIZE = 500;
    for (let index = 0; index < uniqueIds.length; index += CHUNK_SIZE) {
      await photoTable.delete(
        buildPhotoIdFilter(uniqueIds.slice(index, index + CHUNK_SIZE))
      );
    }
    console.log(
      `[AI] Deleted vectors for ${uniqueIds.length} photos from LanceDB`
    );

    /*
     * 自用（2026-10-17，待办「deleteCcipVectors 未接线」）：**连带清另外两张表的特征** ✓
     *
     * 原来这里只删 `photo_embeddings` —— 照片删了，PixAI(1024 维) 与 CCIP(768 维) 的特征
     * **永久留在库里** ✗（越积越多；角色识别的近邻检索还可能拿到"已经不存在的照片"）。
     * 两个函数自身都是"表不存在就跳过、出错只记日志"✓，所以在这里直接调用，
     * 不会影响删除主流程，也不需要每个调用方各改一遍 ✓（它们都走这个函数）。
     */
    await Promise.all([
      deletePixaiVectors(uniqueIds),
      deleteCcipVectors(uniqueIds),
    ]);
  } catch (err: unknown) {
    console.error("[AI] Failed to delete vectors:", getErrorMessage(err));
    throw err;
  }
}

export async function getPhotoVectors(
  photoIds: number[],
  strict = false
): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (!(isVectorDBReady && photoTable) || photoIds.length === 0) {
    return map;
  }
  try {
    const filter = buildPhotoIdFilter(photoIds);
    const rows = (await photoTable.query().where(filter).toArray()) as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      const pid = row.photo_id as number;
      const rawVec = row.vector;
      if (pid == null || !rawVec) {
        continue;
      }

      // LanceDB returns Apache Arrow Vector — normalize to number[]
      let vec: number[];
      if (Array.isArray(rawVec)) {
        vec = rawVec as number[];
      } else if (isArrayLikeVector(rawVec)) {
        vec = Array.from(rawVec.toArray());
      } else if (ArrayBuffer.isView(rawVec)) {
        vec = Array.from(rawVec as Float32Array);
      } else if (isNumberIterable(rawVec)) {
        vec = Array.from(rawVec);
      } else {
        continue;
      }

      if (vec.length > 0) {
        map.set(pid, vec);
      }
    }
  } catch (err: unknown) {
    console.error("[AI] getPhotoVectors failed:", getErrorMessage(err));
    if (strict) {
      throw err;
    }
  }
  return map;
}

export async function ensureVectorIndex(force = false): Promise<boolean> {
  if (!photoTable) {
    return false;
  }

  try {
    const indices = await photoTable.listIndices();
    const hasIndex = indices.some(
      (idx) => idx.columns.includes("vector") || idx.name === "vector_idx"
    );

    if (hasIndex && !force) {
      /*
       * 自用（2026-10-16，**修"排序不准"**）：**旧的有损 PQ 索引自动换掉** ✗→✓。
       *
       * IVF_PQ 用乘积量化把向量**压缩**存储（省空间，但距离是近似值 ✗）：
       * 分数会失真、真正的最近邻可能压根取不回来 ✗。
       * 用户对比同类工具（同模型、同图库）发现排序明显不如对方 ✓ —— 对方用的是精确检索 ✓。
       *
       * 改成 IVF_FLAT（不压缩、精确距离）✓；**只重建索引，向量一个字节都不用动** ✓，
       * 在 7.7 万行上建一次大约几十秒，只在第一次启动时发生 ✓。
       */
      const existing = indices.find(
        (idx) => idx.columns.includes("vector") || idx.name === "vector_idx"
      );
      const isLossyPq = String(existing?.indexType ?? "")
        .toUpperCase()
        .includes("PQ");
      if (!isLossyPq) {
        return true;
      }
      log.info(
        `[AI] 检测到有损索引 ${existing?.indexType}（排序会失真）→ 删除后改用 ivfFlat ✓`
      );
      try {
        if (existing?.name) {
          await photoTable.dropIndex(existing.name);
        }
      } catch (err: unknown) {
        log.warn(`[AI] 删除旧索引失败：${getErrorMessage(err)}`);
        return true;
      }
      // 落到下面继续重建 ✓
    } else if (hasIndex && force) {
      // 强制重建：直接把旧索引删掉再建 ✓
      const existing = indices.find(
        (idx) => idx.columns.includes("vector") || idx.name === "vector_idx"
      );
      try {
        if (existing?.name) {
          await photoTable.dropIndex(existing.name);
        }
      } catch {
        /* 删不掉就交给 createIndex 覆盖 */
      }
    }

    const rowCount = await photoTable.countRows();
    if (rowCount < MIN_VECTORS_FOR_INDEX) {
      console.log(
        `[AI] Index not needed: ${rowCount} < ${MIN_VECTORS_FOR_INDEX} threshold`
      );
      return true;
    }

    /*
     * 自用（2026-10，方案 B）：**正在批量建向量时不要建索引**。
     *
     * 为什么：IVF_PQ 建索引是**同步长任务** —— 2.2 万行就要 30 秒，
     * 7.7 万行会到 1~2 分钟，期间界面直接白屏/未响应。
     * 而且建之前会写"脏标记"，中途被强杀（白屏时用户很可能这么做）
     * 下次启动又会重建一遍 —— 于是"每次启动都要等好久"。
     *
     * 批量建向量期间搜索用暴力检索兜底（代码本来就有，5 万行以内够快），
     * 等空闲了再建索引。
     */
    if (getAiControlState() !== "idle") {
      log.info(
        `[AI] Index build skipped while embedding is active (${getAiControlState()})`
      );
      return true;
    }

    /*
     * 自用（2026-10，**对症修"卡死被 Windows 关掉"**）：
     * 只要整库还有没处理的照片，就**不建索引**。
     *
     * 为什么：IVF_PQ 建索引是一次 30 秒~2 分钟的**不可中断同步原生调用** ✗，
     * 期间主线程完全不响应 → Windows 判定 AppHang 并把应用关掉 ✗
     *（实测事件日志 AppHangTransient / Application Hang）。
     * 而整库没建完之前这个索引也没多大意义 —— 搜索本来就有暴力兜底 ✓。
     * 等全部照片都处理完（pending === 0）再建一次即可 ✓。
     */
    const { getDatabase } = await import("@/db");
    const { photos: photosTable } = await import("@/db/schema");
    const { sql: sqlTag } = await import("drizzle-orm");
    const pendingRows = getDatabase()
      .select({ value: sqlTag<number>`count(*)` })
      .from(photosTable)
      .where(
        sqlTag`${photosTable.isAiProcessed} = 0 AND ${photosTable.deletedAt} IS NULL`
      )
      .get();
    const pendingCount = pendingRows?.value ?? 0;
    if (pendingCount > 0) {
      log.info(
        `[AI] Index build skipped while ${pendingCount} photos are still pending`
      );
      return true;
    }

    const { Index: LIdx } = await import("@lancedb/lancedb");
    console.log(
      `[AI] ${force ? "Rebuilding" : "Creating"} vector index on ${rowCount} rows...`
    );
    // Crash-safety: mark dirty before the potentially-long index build,
    // so unclean shutdown during ANY index creation is detected on next startup.
    markIndexDirty();
    /* 自用（2026-10）：建索引交给 worker（不可中断的同步原生调用 ✗ → 会卡界面 ✓）。 */
    const indexResult = await runVectorMaintenanceWorker({
      index: true,
      numPartitions: rowCount,
    });
    if (indexResult.skipped.includes("index-unavailable")) {
      throw new Error("worker could not build index");
    }
    if (indexResult.skipped.includes("photo_embeddings-index-failed")) {
      throw new Error(
        `worker index build failed: ${indexResult.indexErrors.join("; ")}`
      );
    }
    console.log("[AI] Vector index ready");
    markIndexReady();
    return true;
  } catch (err: unknown) {
    console.error("[AI] Index creation failed:", getErrorMessage(err));
    return false;
  }
}

export function isVectorDBInitialized(): boolean {
  return isVectorDBReady && vectordb !== null && photoTable !== null;
}

/**
 * 对已初始化的向量数据库进行快速健康检查。
 * 在不触发重量操作的前提下验证底层数据文件可读性。
 * 返回 { healthy: true } 表示通过；{ healthy: false, reason } 表示需要自动修复。
 */
export async function validateVectorDB(): Promise<{
  healthy: boolean;
  reason?: string;
}> {
  // 直接检查 photoTable 实例是否存在（不依赖 isVectorDBReady，
  // 因为本函数可能在 initVectorDB 还未标记 ready 时被调用）。
  if (!photoTable) {
    return { healthy: false, reason: "vector DB not initialized" };
  }

  // Phase 1: countRows — 验证数据文件可读
  let rowCount = 0;
  try {
    rowCount = await photoTable.countRows();
  } catch (err: unknown) {
    return {
      healthy: false,
      reason: `countRows failed (data file corruption): ${getErrorMessage(err)}`,
    };
  }

  // Phase 2: query 1 row — 验证向量列结构可序列化
  if (rowCount > 0) {
    try {
      await photoTable.query().limit(1).toArray();
    } catch (err: unknown) {
      return {
        healthy: false,
        reason: `query failed (vector data corruption): ${getErrorMessage(err)}`,
      };
    }
  }

  // Phase 3: listIndices — 验证索引元数据可读
  try {
    await photoTable.listIndices();
  } catch (err: unknown) {
    return {
      healthy: false,
      reason: `listIndices failed (IVF_PQ index corruption): ${getErrorMessage(err)}`,
    };
  }

  return { healthy: true };
}

/**
 * 将所有照片的 isAiProcessed 标志重置为 false。
 * 在向量数据库重建后调用，使系统重新索引导入所有图片。
 */
export function resetAllAiProcessedFlags(): number {
  try {
    const db = getDatabase();
    const result = db
      .update(photos)
      .set({ isAiProcessed: false })
      .where(sql`${photos.deletedAt} IS NULL`)
      .run();
    console.log(
      `[AI] Reset isAiProcessed flags: ${result.changes} photos marked for re-index`
    );
    return result.changes;
  } catch (err: unknown) {
    console.error(
      "[AI] Failed to reset isAiProcessed flags:",
      getErrorMessage(err)
    );
    return 0;
  }
}

/**
 * 重建整个向量数据库：关闭连接 → 删除磁盘文件 → 重新初始化空表。
 * 用于修复 LanceDB 索引损坏导致的搜索闪退问题。
 * 调用方需要额外重置 isAiProcessed 标志并重新触发索引。
 *
 * 注意：Windows 上 LanceDB 可能持有 mmap 文件句柄，close() 后不会立即释放。
 * 优先使用 LanceDB 的 dropTable API 清理，失败时用 rename 绕过文件锁。
 */
export function rebuildVectorDB(): Promise<{
  success: boolean;
  error?: string;
}> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Rebuild keeps filesystem and LanceDB recovery ordering atomic.
  return withVectorDbOperation(async () => {
    vectorDbGeneration++;
    vectorDbInitPromise = null;
    setIsVectorDBReady(false);
    setPhotoTable(null);
    try {
      // 1. 优先通过 LanceDB API 清理（正确处理内部文件锁）
      if (vectordb) {
        const tableNames = await vectordb.tableNames();
        if (tableNames.includes("photo_embeddings")) {
          try {
            await vectordb.dropTable("photo_embeddings");
            console.log("[AI] rebuildVectorDB: dropped via LanceDB API");
          } catch (dropErr: unknown) {
            console.warn(
              "[AI] rebuildVectorDB: dropTable failed, will use filesystem fallback:",
              getErrorMessage(dropErr)
            );
          }
        }
      }

      // 2. 关闭连接（先清理维护定时器，避免在已关闭连接上执行维护操作）
      clearVectorMaintenance();
      if (vectordb) {
        try {
          await vectordb.close();
        } catch (err: unknown) {
          console.warn(
            "[AI] rebuildVectorDB: close failed:",
            getErrorMessage(err)
          );
        }
        setVectordb(null);
        setPhotoTable(null);
        setIsVectorDBReady(false);
      }

      // 3. 清理残留文件（处理 dropTable 失败或 close 未释放句柄的情况）
      const vectorPath = path.join(getDataPath(), "vectors");
      if (fs.existsSync(vectorPath)) {
        try {
          await fs.promises.rm(vectorPath, { recursive: true, force: true });
          console.log(`[AI] rebuildVectorDB: removed ${vectorPath}`);
        } catch (rmErr: unknown) {
          // Windows mmap 锁：重命名绕过，下次启动时清理
          const code = getErrorCode(rmErr);
          if (code === "EPERM" || code === "EBUSY") {
            const bakPath = path.join(
              getDataPath(),
              `vectors.bak.${Date.now()}`
            );
            await fs.promises.rename(vectorPath, bakPath);
            console.log(
              `[AI] rebuildVectorDB: renamed to ${bakPath} (mmap lock bypass)`
            );
            // 异步清理备份（延迟 10s 等系统释放句柄）
            setTimeout(() => {
              try {
                fs.promises.rm(bakPath, { recursive: true, force: true });
              } catch {
                // 残留文件不阻塞，下次 initVectorDB 时会跳过（目录名已不同）
              }
            }, 10_000);
          } else {
            throw rmErr;
          }
        }
      }

      // 4. 重新初始化
      await initVectorDB();

      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      console.error("[AI] rebuildVectorDB failed:", message);
      return { success: false, error: message };
    }
  });
}

/**
 * 清理上一次重建遗留的 .bak 目录（在 initVectorDB 之前调用）。
 * 这些目录是 rebuildVectorDB 在 Windows 上因 mmap 锁无法删除时残留的。
 */
export async function cleanupStaleBackups(): Promise<void> {
  const dataPath = getDataPath();
  try {
    const entries = await fs.promises.readdir(dataPath);
    for (const entry of entries) {
      if (entry.startsWith("vectors.bak.")) {
        const fullPath = path.join(dataPath, entry);
        try {
          await fs.promises.rm(fullPath, { recursive: true, force: true });
          console.log(`[AI] Cleaned up stale backup: ${entry}`);
        } catch {
          // best-effort, will try again next startup
        }
      }
    }
  } catch {
    // best-effort
  }
}

export function closeVectorDB(): Promise<void> {
  return withVectorDbOperation(async () => {
    vectorDbGeneration++;
    vectorDbInitPromise = null;
    clearVectorMaintenance();
    const currentDb = vectordb;
    setVectordb(null);
    setPhotoTable(null);
    setIsVectorDBReady(false);
    if (currentDb) {
      try {
        diagLog("closeVectorDB: calling vectordb.close()");
        await currentDb.close();
        diagLog("closeVectorDB: OK");
        markIndexReady();
      } catch (err: unknown) {
        diagLog(`closeVectorDB: ERROR ${getErrorMessage(err)}`);
      }
    } else {
      diagLog("closeVectorDB: vectordb already null, skip");
    }
  });
}

// ── Crash-safety marker ─────────────────────────────────────────────────
// Writes a .index_ready marker after clean shutdown / index completion.
// If the marker is missing on startup, the previous session did not exit
// cleanly — auto-rebuild to avoid corruption from partial index builds.

function indexReadyPath(): string {
  return path.join(getDataPath(), "vectors", ".index_ready");
}

function markIndexReady(): void {
  try {
    const markerPath = indexReadyPath();
    const dir = path.dirname(markerPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(markerPath, Date.now().toString(), "utf-8");
  } catch {
    // best-effort
  }
}

function markIndexDirty(): void {
  try {
    const markerPath = indexReadyPath();
    if (fs.existsSync(markerPath)) {
      fs.unlinkSync(markerPath);
    }
  } catch {
    // best-effort
  }
}

function isIndexCleanShutdown(): boolean {
  try {
    return fs.existsSync(indexReadyPath());
  } catch {
    return false;
  }
}

// ── 颜色向量表（Color Vector Table） ──────────────────────────────
// 替代 SQLite closest_color_dist JS UDF 全表扫描，将主导色 [R,G,B] 存入
// LanceDB 3D 向量表，利用 IVF_PQ ANN 将 O(N) 转化为 O(log N)。

const COLOR_TABLE_NAME = "color_embeddings";
const COLOR_VECTOR_DIM = 3;

async function initColorTable(db: LanceConnection): Promise<void> {
  try {
    const tableNames = await db.tableNames();

    if (tableNames.includes(COLOR_TABLE_NAME)) {
      const table = await db.openTable(COLOR_TABLE_NAME);
      setColorTable(table);
      console.log("[AI] Opened existing color_embeddings table");
      return;
    }

    // 创建新表
    const schema = new Schema([
      new Field("photo_id", new Int32()),
      new Field(
        "vector",
        new FixedSizeList(COLOR_VECTOR_DIM, new Field("item", new Float32()))
      ),
    ]);

    const table = await db.createEmptyTable(COLOR_TABLE_NAME, schema);
    setColorTable(table);
    console.log(
      "[AI] Created color_embeddings table (FixedSizeList<Float32>[3])"
    );
  } catch (err: unknown) {
    console.warn("[AI] Color table init skipped:", getErrorMessage(err));
    // 非关键路径：颜色搜索降级为 SQLite UDF
  }
}

// ── 自用新增：WD14 动漫特征表（768 维）──────────────────────────────────
//
// 为什么单独一张表，而不是复用 photo_embeddings：
//   photo_embeddings 里是 SigLIP 的"通用图像"特征；WD14 是"动漫专用"特征，
//   实测区分同一角色的能力约为 SigLIP 的 2.7 倍（+0.149 vs +0.056）。
//   分表存放 → 完全不影响现有语义搜索链路，需要时也能单独停用 / 重建。

const WD14_TABLE_NAME = "wd14_embeddings";
const WD14_VECTOR_DIM = 768;

async function initWd14Table(db: LanceConnection): Promise<void> {
  try {
    const tableNames = await db.tableNames();
    if (tableNames.includes(WD14_TABLE_NAME)) {
      setWd14Table(await db.openTable(WD14_TABLE_NAME));
      console.log("[AI] Opened existing wd14_embeddings table");
      return;
    }
    const schema = new Schema([
      new Field("photo_id", new Int32()),
      new Field(
        "vector",
        new FixedSizeList(WD14_VECTOR_DIM, new Field("item", new Float32()))
      ),
    ]);
    setWd14Table(await db.createEmptyTable(WD14_TABLE_NAME, schema));
    console.log(
      "[AI] Created wd14_embeddings table (FixedSizeList<Float32>[768])"
    );
  } catch (err: unknown) {
    // 非关键路径：建表失败只是"以图搜图"继续用 SigLIP，不影响打标
    console.warn("[AI] WD14 table init skipped:", getErrorMessage(err));
  }
}

/** 批量写入 / 更新 WD14 特征（先删后插，保证幂等）。 */
export async function upsertWd14Vectors(
  entries: Array<{ photoId: number; vector: number[] }>
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  if (!wd14Table) {
    throw new Error("wd14 vector table is not initialized");
  }
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    await wd14Table.delete(
      `photo_id IN (${chunk.map((entry) => entry.photoId).join(",")})`
    );
    await wd14Table.add(
      chunk.map((entry) => ({
        photo_id: entry.photoId,
        vector: entry.vector,
      }))
    );
  }
}

/**
 * WD14 特征 ANN 搜索（「以图搜图」优先用这条）。
 *
 * 表不可用时返回 null，调用方回退到 SigLIP 的 photo_embeddings。
 * 向量在 worker 里已做 L2 归一化，所以 `similarity = 1 - d²/2`（d 为 L2 距离）。
 */
export async function searchByWd14Vector(
  vector: number[],
  limit: number
): Promise<Array<{ photoId: number; similarity: number }> | null> {
  if (!wd14Table) {
    return null;
  }
  try {
    const rawResults = (await wd14Table
      .vectorSearch(Array.from(vector))
      .distanceType("l2")
      .limit(limit)
      .toArray()) as Record<string, unknown>[];
    return rawResults.map((row) => {
      const distanceSquared = Number(row._distance ?? 0);
      return {
        photoId: row.photo_id as number,
        similarity: Math.max(0, 1 - distanceSquared / 2),
      };
    });
  } catch (err: unknown) {
    console.warn("[AI] WD14 vector search failed:", getErrorMessage(err));
    return null;
  }
}

/**
 * 主特征表（Chinese-CLIP 整图向量）的最近邻检索。
 *
 * 自用新增：人物识别需要「拿一个角色特征中心去找最像的图」，
 * 原先只导出了 WD14 / PixAI / 颜色的检索，主特征只能按 id 批量取。
 * 向量已归一化，故 l2 距离平方 d 对应余弦 1 - d/2。
 */
export async function searchByPhotoVector(
  vector: number[] | Float64Array,
  limit: number
): Promise<Array<{ photoId: number; similarity: number }> | null> {
  if (!photoTable) {
    return null;
  }
  try {
    const rawResults = (await photoTable
      .vectorSearch(Array.from(vector))
      .distanceType("l2")
      .limit(limit)
      .toArray()) as Record<string, unknown>[];
    return rawResults
      .map((row) => ({
        photoId: row.photo_id as number,
        similarity: Math.max(0, 1 - Number(row._distance ?? 0) / 2),
      }))
      .filter((hit) => Number.isFinite(hit.photoId));
  } catch (err: unknown) {
    console.warn("[AI] photo vector search failed:", getErrorMessage(err));
    return null;
  }
}

/** WD14 特征表里已有多少条（用于判断"以图搜图"该走哪条路）。 */
export async function getWd14VectorCount(): Promise<number> {  if (!wd14Table) {
    return 0;
  }
  try {
    return await wd14Table.countRows();
  } catch {
    return 0;
  }
}

/** 删除指定照片的 WD14 特征（照片被删除时调用）。 */
export async function deleteWd14Vectors(photoIds: number[]): Promise<void> {
  if (!(wd14Table && photoIds.length > 0)) {
    return;
  }
  try {
    const CHUNK = 500;
    for (let i = 0; i < photoIds.length; i += CHUNK) {
      await wd14Table.delete(
        `photo_id IN (${photoIds.slice(i, i + CHUNK).join(",")})`
      );
    }
  } catch (err: unknown) {
    console.warn("[AI] Delete WD14 vectors failed:", getErrorMessage(err));
  }
}

// ── 自用新增：PixAI Tagger v1.0 特征表（1024 维）────────────────────────
//
// 为什么是**新表**，而不是把 wd14_embeddings 的维度改成 1024：
//   PixAI Tagger v1.0 的 ONNX 双输出里，embedding 是 1024 维；
//   WD14 的 embedding 是 768 维，两者的向量空间完全不通。
//   而**所有工作区共用同一个向量库**（默认 <图库>\），
//   一旦原地改维度，已归档的本地版 / LAN 版打开旧表就会因为
//   FixedSizeList 长度对不上而报错甚至触发重建。
//   因此只**新增** pixai_embeddings 一张表，旧的三张表
//   （photo_embeddings / color_embeddings / wd14_embeddings）原样保留、
//   维度一个都不动；PixAI 与 WD14 双模型并存，可随时回退。

export const PIXAI_TABLE_NAME = "pixai_embeddings";
export const PIXAI_VECTOR_DIM = 1024;

/** 向量维度必须是 1024，否则抛错并说明实际维度（不静默丢弃）。 */
function assertPixaiVector(vector: number[], context: string): void {
  if (vector.length !== PIXAI_VECTOR_DIM) {
    throw new Error(
      `[AI] ${context}: expected vector dimension ${PIXAI_VECTOR_DIM}, got ${vector.length}`
    );
  }
}

/**
 * 为新表建 ANN 索引（与 photo_embeddings 的 ensureVectorIndex 同样的
 * 阈值 + cosine 配置）。行数不足或建索引失败都不算致命：
 * 搜索会退化为暴力扫描，pixai 表本身仍然可用。
 */
async function ensurePixaiIndex(): Promise<boolean> {
  if (!pixaiTable) {
    return false;
  }
  try {
    const indices = await pixaiTable.listIndices();
    const hasIndex = indices.some(
      (idx) => idx.columns.includes("vector") || idx.name === "vector_idx"
    );
    if (hasIndex) {
      return true;
    }
    const rowCount = await pixaiTable.countRows();
    if (rowCount < MIN_VECTORS_FOR_INDEX) {
      console.log(
        `[AI] PixAI index not needed: ${rowCount} < ${MIN_VECTORS_FOR_INDEX} threshold`
      );
      return true;
    }
    const { Index: LIdx } = await import("@lancedb/lancedb");
    /*
     * 自用（2026-10-16）：与 photo_embeddings 同样改用 **ivfFlat**（不压缩、精确距离 ✓），
     * 理由见 ensureVectorIndex 里的说明 ✓（只重建索引，向量不动 ✓）。
     */
    await pixaiTable.createIndex("vector", {
      config: LIdx.ivfFlat({
        numPartitions: Math.max(2, Math.floor(Math.sqrt(rowCount))),
        distanceType: "cosine",
      }),
    });
    console.log(`[AI] PixAI vector index ready (${rowCount} rows)`);
    return true;
  } catch (err: unknown) {
    console.warn(
      "[AI] PixAI index creation skipped:",
      getErrorMessage(err)
    );
    return false;
  }
}

async function initPixaiTable(db: LanceConnection): Promise<void> {
  try {
    const tableNames = await db.tableNames();
    if (tableNames.includes(PIXAI_TABLE_NAME)) {
      setPixaiTable(await db.openTable(PIXAI_TABLE_NAME));
      console.log("[AI] Opened existing pixai_embeddings table");
      await ensurePixaiIndex();
      return;
    }
    const schema = new Schema([
      new Field("photo_id", new Int32()),
      new Field(
        "vector",
        new FixedSizeList(PIXAI_VECTOR_DIM, new Field("item", new Float32()))
      ),
    ]);
    setPixaiTable(await db.createEmptyTable(PIXAI_TABLE_NAME, schema));
    console.log(
      "[AI] Created pixai_embeddings table (FixedSizeList<Float32>[1024])"
    );
    await ensurePixaiIndex();
  } catch (err: unknown) {
    // 非关键路径：建表失败只是 PixAI 的「以图搜图」不可用，
    // 不影响打标本身，也不影响 WD14 / SigLIP 的老链路。
    console.warn("[AI] PixAI table init skipped:", getErrorMessage(err));
  }
}

/** 批量写入 / 更新 PixAI 特征（先删后插，保证幂等）。 */
export async function upsertPixaiVectors(
  entries: Array<{ photoId: number; vector: number[] }>
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  if (!pixaiTable) {
    throw new Error("pixai vector table is not initialized");
  }
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    for (const entry of chunk) {
      assertPixaiVector(
        entry.vector,
        `upsertPixaiVectors(photo ${entry.photoId})`
      );
    }
    await pixaiTable.delete(
      `photo_id IN (${chunk.map((entry) => entry.photoId).join(",")})`
    );
    await pixaiTable.add(
      chunk.map((entry) => ({
        photo_id: entry.photoId,
        vector: entry.vector,
      }))
    );
  }
}

/**
 * PixAI 特征 ANN 搜索（PixAI 模式下的「以图搜图」走这条）。
 *
 * 表不可用时返回 null，调用方回退到 WD14 或 SigLIP 的既有链路。
 * 向量在 worker 里已做 L2 归一化，所以 `similarity = 1 - d²/2`（d 为 L2 距离）。
 */
export async function searchByPixaiVector(
  vector: number[],
  limit: number
): Promise<Array<{ photoId: number; similarity: number }> | null> {
  if (!pixaiTable) {
    return null;
  }
  try {
    assertPixaiVector(vector, "searchByPixaiVector");
    const rawResults = (await pixaiTable
      .vectorSearch(Array.from(vector))
      .distanceType("l2")
      .limit(limit)
      .toArray()) as Record<string, unknown>[];
    return rawResults.map((row) => {
      const distanceSquared = Number(row._distance ?? 0);
      return {
        photoId: row.photo_id as number,
        similarity: Math.max(0, 1 - distanceSquared / 2),
      };
    });
  } catch (err: unknown) {
    console.warn("[AI] PixAI vector search failed:", getErrorMessage(err));
    return null;
  }
}

/** PixAI 特征表里已有多少条（用于判断「以图搜图」该走哪条路）。 */
export async function getPixaiVectorCount(): Promise<number> {
  if (!pixaiTable) {
    return 0;
  }
  try {
    return await pixaiTable.countRows();
  } catch {
    return 0;
  }
}

/** 删除指定照片的 PixAI 特征（照片被删除时调用）。 */
export async function deletePixaiVectors(photoIds: number[]): Promise<void> {
  if (!(pixaiTable && photoIds.length > 0)) {
    return;
  }
  try {
    const CHUNK = 500;
    for (let i = 0; i < photoIds.length; i += CHUNK) {
      await pixaiTable.delete(
        `photo_id IN (${photoIds.slice(i, i + CHUNK).join(",")})`
      );
    }
  } catch (err: unknown) {
    console.warn("[AI] Delete PixAI vectors failed:", getErrorMessage(err));
  }
}

// ── 自用新增：CCIP 角色特征表（768 维）────────────────────────────────
//
// 为什么也是**新表**：CCIP（deepghs/ccip-caformer_b36-24）是**角色专用**特征，
// 实测输出 768 维（输入 1×3×384×384，ImageNet 归一化），与现有
// photo_embeddings(512) / pixai_embeddings(1024) 都不同；同样只**新增**一张表，
// 旧表一个都不动，便于实现「首选 CCIP、缺模型/关开关回退 CLIP」。
// 向量在 worker 里已做 L2 归一化，故余弦相似度可用 `1 - d²/2` 近似。

export const CCIP_TABLE_NAME = "ccip_embeddings";
export const CCIP_VECTOR_DIM = 768;

/** 向量维度必须是 768，否则抛错并说明实际维度（不静默丢弃）。 */
function assertCcipVector(vector: number[], context: string): void {
  if (vector.length !== CCIP_VECTOR_DIM) {
    throw new Error(
      `[AI] ${context}: expected vector dimension ${CCIP_VECTOR_DIM}, got ${vector.length}`
    );
  }
}

/** 为新表建 ANN 索引（与其它表同样的阈值 + cosine 配置）。行数不足或失败都不致命。 */
async function ensureCcipIndex(): Promise<boolean> {
  if (!ccipTable) {
    return false;
  }
  try {
    const indices = await ccipTable.listIndices();
    const hasIndex = indices.some(
      (idx) => idx.columns.includes("vector") || idx.name === "vector_idx"
    );
    if (hasIndex) {
      return true;
    }
    const rowCount = await ccipTable.countRows();
    if (rowCount < MIN_VECTORS_FOR_INDEX) {
      console.log(
        `[AI] CCIP index not needed: ${rowCount} < ${MIN_VECTORS_FOR_INDEX} threshold`
      );
      return true;
    }
    const { Index: LIdx } = await import("@lancedb/lancedb");
    await ccipTable.createIndex("vector", {
      config: LIdx.ivfFlat({
        numPartitions: Math.max(2, Math.floor(Math.sqrt(rowCount))),
        distanceType: "cosine",
      }),
    });
    console.log(`[AI] CCIP vector index ready (${rowCount} rows)`);
    return true;
  } catch (err: unknown) {
    console.warn("[AI] CCIP index creation skipped:", getErrorMessage(err));
    return false;
  }
}

/**
 * 自用新增：**强制重建** CCIP 表的近邻索引。
 *
 * 为什么需要：LanceDB 的索引只覆盖"建索引那一刻已有的行"。全库特征生成会分几千批
 * 写入，若跑完不重建，聚类要逐张查 7.7 万次近邻时就会**退化成暴力扫描**（慢上百倍 ✗）。
 * 所以特征生成结束后必须重建一次。
 */
export async function rebuildCcipIndex(): Promise<boolean> {
  if (!ccipTable) {
    return false;
  }
  try {
    const rowCount = await ccipTable.countRows();
    if (rowCount < MIN_VECTORS_FOR_INDEX) {
      console.log(
        `[AI] CCIP index rebuild skipped: ${rowCount} < ${MIN_VECTORS_FOR_INDEX}`
      );
      return true;
    }
    const { Index: LIdx } = await import("@lancedb/lancedb");
    await ccipTable.createIndex("vector", {
      config: LIdx.ivfFlat({
        numPartitions: Math.max(2, Math.floor(Math.sqrt(rowCount))),
        distanceType: "cosine",
      }),
    });
    console.log(`[AI] CCIP vector index rebuilt (${rowCount} rows)`);
    return true;
  } catch (err: unknown) {
    console.warn("[AI] CCIP index rebuild failed:", getErrorMessage(err));
    return false;
  }
}

async function initCcipTable(db: LanceConnection): Promise<void> {
  try {
    const tableNames = await db.tableNames();
    if (tableNames.includes(CCIP_TABLE_NAME)) {
      setCcipTable(await db.openTable(CCIP_TABLE_NAME));
      console.log("[AI] Opened existing ccip_embeddings table");
      await ensureCcipIndex();
      return;
    }
    const schema = new Schema([
      new Field("photo_id", new Int32()),
      new Field(
        "vector",
        new FixedSizeList(CCIP_VECTOR_DIM, new Field("item", new Float32()))
      ),
    ]);
    setCcipTable(await db.createEmptyTable(CCIP_TABLE_NAME, schema));
    console.log(
      "[AI] Created ccip_embeddings table (FixedSizeList<Float32>[768])"
    );
    await ensureCcipIndex();
  } catch (err: unknown) {
    // 非关键路径：CCIP 表初始化失败只影响「角色识别」，不影响其它链路。
    console.warn("[AI] CCIP table init skipped:", getErrorMessage(err));
  }
}

/**
 * 自用（2026-10-18 · 会话#9）：**纯新增**的 CCIP 特征写入（不先删）。
 *
 * 为什么需要：全库构建时，进到这里的照片都是"库里还没有特征"的（调用方已按 id 过滤），
 * 再来一次 `delete ... IN (...)` 等于**每次全表扫描 + 一个多余事务**，纯浪费 ✗
 * 实测这条 DELETE 是"算得挺快、但整体只有 20 张/秒"的重要一环 ✓
 *
 * ⚠️ 只用于"确认这些 id 一定没有旧特征"的场合（全库续算）；其它场合请用
 * `upsertCcipVectors`（先删后插，幂等）。
 */
export async function addCcipVectors(
  entries: Array<{ photoId: number; vector: number[] }>
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  if (!ccipTable) {
    throw new Error("ccip vector table is not initialized");
  }
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    for (const entry of chunk) {
      assertCcipVector(entry.vector, `addCcipVectors(photo ${entry.photoId})`);
    }
    await ccipTable.add(
      chunk.map((entry) => ({
        photo_id: entry.photoId,
        vector: entry.vector,
      }))
    );
  }
}

/** 批量写入 / 更新 CCIP 特征（先删后插，保证幂等）。 */
export async function upsertCcipVectors(
  entries: Array<{ photoId: number; vector: number[] }>
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  if (!ccipTable) {
    throw new Error("ccip vector table is not initialized");
  }
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    for (const entry of chunk) {
      assertCcipVector(entry.vector, `upsertCcipVectors(photo ${entry.photoId})`);
    }
    await ccipTable.delete(
      `photo_id IN (${chunk.map((entry) => entry.photoId).join(",")})`
    );
    await ccipTable.add(
      chunk.map((entry) => ({
        photo_id: entry.photoId,
        vector: entry.vector,
      }))
    );
  }
}

/** 批量读取指定照片的 CCIP 特征（角色识别用；表不可用返回空 map）。 */
export async function getCcipVectors(
  photoIds: number[],
  strict = false
): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (!(ccipTable && photoIds.length > 0)) {
    return map;
  }
  try {
    const uniqueIds = [...new Set(photoIds)];
    const CHUNK = 2000;
    for (let i = 0; i < uniqueIds.length; i += CHUNK) {
      const slice = uniqueIds.slice(i, i + CHUNK);
      const rows = (await ccipTable
        .query()
        .where(`photo_id IN (${slice.join(",")})`)
        .toArray()) as Record<string, unknown>[];
      for (const row of rows) {
        const pid = row.photo_id as number;
        const rawVec = row.vector;
        if (pid == null || !rawVec) {
          continue;
        }
        let vec: number[];
        if (Array.isArray(rawVec)) {
          vec = rawVec as number[];
        } else if (isArrayLikeVector(rawVec)) {
          vec = Array.from(rawVec.toArray());
        } else if (ArrayBuffer.isView(rawVec)) {
          vec = Array.from(rawVec as Float32Array);
        } else if (isNumberIterable(rawVec)) {
          vec = Array.from(rawVec);
        } else {
          continue;
        }
        if (vec.length > 0) {
          map.set(pid, vec);
        }
      }
    }
  } catch (err: unknown) {
    console.error("[AI] getCcipVectors failed:", getErrorMessage(err));
    if (strict) {
      throw err;
    }
  }
  return map;
}

/** CCIP 特征 ANN 搜索（角色识别走 CCIP 时用）。表不可用返回 null。 */
export async function searchByCcipVector(
  vector: number[],
  limit: number
): Promise<Array<{ photoId: number; similarity: number }> | null> {
  if (!ccipTable) {
    return null;
  }
  try {
    assertCcipVector(vector, "searchByCcipVector");
    const rawResults = (await ccipTable
      .vectorSearch(Array.from(vector))
      .distanceType("l2")
      .limit(limit)
      .toArray()) as Record<string, unknown>[];
    return rawResults
      .map((row) => {
        const distanceSquared = Number(row._distance ?? 0);
        return {
          photoId: row.photo_id as number,
          similarity: Math.max(0, 1 - distanceSquared / 2),
        };
      })
      .filter((hit) => Number.isFinite(hit.photoId));
  } catch (err: unknown) {
    console.warn("[AI] CCIP vector search failed:", getErrorMessage(err));
    return null;
  }
}

/** CCIP 特征表里已有多少条（用于判断角色识别能否走 CCIP）。 */
export async function getCcipVectorCount(): Promise<number> {
  if (!ccipTable) {
    return 0;
  }
  try {
    return await ccipTable.countRows();
  } catch {
    return 0;
  }
}

/**
 * 列出已经有 CCIP 特征的照片 id（全库重算时用来**跳过算过的**，实现断点续跑）。
 *
 * 只取 `photo_id` 一列，7 万行量级下开销可接受。
 */
export async function listCcipVectorIds(): Promise<number[]> {
  if (!ccipTable) {
    return [];
  }
  try {
    const rows = (await ccipTable
      .query()
      .select(["photo_id"])
      .toArray()) as Array<{ photo_id?: number }>;
    const ids: number[] = [];
    for (const row of rows) {
      if (typeof row.photo_id === "number") {
        ids.push(row.photo_id);
      }
    }
    return ids;
  } catch (err: unknown) {
    console.warn("[AI] listCcipVectorIds failed:", getErrorMessage(err));
    return [];
  }
}

/** 删除指定照片的 CCIP 特征（照片被删除时调用）。 */
export async function deleteCcipVectors(photoIds: number[]): Promise<void> {
  if (!(ccipTable && photoIds.length > 0)) {
    return;
  }
  try {
    const CHUNK = 500;
    for (let i = 0; i < photoIds.length; i += CHUNK) {
      await ccipTable.delete(
        `photo_id IN (${photoIds.slice(i, i + CHUNK).join(",")})`
      );
    }
  } catch (err: unknown) {
    console.warn("[AI] Delete CCIP vectors failed:", getErrorMessage(err));
  }
}

/** 写入或更新照片的主导颜色向量 */
export async function upsertColorVector(
  photoId: number,
  r: number,
  g: number,
  b: number
): Promise<void> {
  if (!colorTable) {
    throw new Error("color vector table is not initialized");
  }
  try {
    // 删除旧记录（如果存在）
    await colorTable.delete(`photo_id = ${photoId}`);
    // 写入新记录
    await colorTable.add([{ photo_id: photoId, vector: [r, g, b] }]);
  } catch (err: unknown) {
    console.error(
      `[AI] Upsert color vector failed for photo ${photoId}:`,
      getErrorMessage(err)
    );
    throw err;
  }
}

/** 批量写入颜色向量 */
export async function upsertColorVectors(
  entries: Array<{ photoId: number; r: number; g: number; b: number }>
): Promise<void> {
  if (!colorTable || entries.length === 0) {
    if (entries.length > 0 && !colorTable) {
      throw new Error("color vector table is not initialized");
    }
    return;
  }
  try {
    // 批量删除旧记录
    const ids = entries.map((e) => e.photoId);
    await colorTable.delete(`photo_id IN (${ids.join(",")})`);
    // 批量写入
    const rows = entries.map((e) => ({
      photo_id: e.photoId,
      vector: [e.r, e.g, e.b],
    }));
    await colorTable.add(rows);
    console.log(`[AI] Upserted ${entries.length} color vectors`);
  } catch (err: unknown) {
    console.error(
      "[AI] Batch upsert color vectors failed:",
      getErrorMessage(err)
    );
    throw err;
  }
}

/** 颜色向量 ANN 搜索。colorTable 不可用时返回 null，调用方降级 SQLite UDF。 */
export async function searchByColorVector(
  r: number,
  g: number,
  b: number,
  limit: number
): Promise<Array<{ photoId: number; distanceSquared: number }> | null> {
  if (!colorTable) {
    return null;
  }
  try {
    const targetVector = Array.from(
      { length: COLOR_VECTOR_DIM },
      (_, i) => [r, g, b][i]
    );
    const rawResults = (await colorTable
      .vectorSearch(targetVector)
      .distanceType("l2")
      .limit(limit)
      .toArray()) as Record<string, unknown>[];

    return rawResults.map((row) => ({
      photoId: row.photo_id as number,
      // LanceDB L2 exposes squared Euclidean distance, the same unit used by
      // SQLite closest_color_dist.
      distanceSquared: row._distance as number,
    }));
  } catch (err: unknown) {
    console.error("[AI] Color vector search failed:", getErrorMessage(err));
    return null;
  }
}

/** 删除指定照片的颜色向量 */
export async function deleteColorVectors(photoIds: number[]): Promise<void> {
  if (!colorTable || photoIds.length === 0) {
    return;
  }
  try {
    await colorTable.delete(`photo_id IN (${photoIds.join(",")})`);
  } catch (err: unknown) {
    console.error("[AI] Delete color vectors failed:", getErrorMessage(err));
  }
}

// best-effort sync write for native crash diagnostics
function diagLog(msg: string) {
  try {
    const dir = path.join(
      process.env.APPDATA || "/tmp",
      APP_DISPLAY_NAME,
      "logs"
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "migrate.log"),
      `${new Date().toISOString()} ${msg}\n`,
      { flag: "a" }
    );
  } catch {
    /* best-effort */
  }
}

// ── 颜色向量回填 ─────────────────────────────────────────────────────
// 将已有 dominant_colors 但 LanceDB 中无颜色向量的照片批量回填。
// 首次启动时自动运行，后续跳过（通过 app_settings 标记）。
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Backfill coordinates marker checks, JSON normalization, batch writes, and yielding without changing startup lifecycle.
export async function backfillColorVectors(): Promise<{
  total: number;
  backfilled: number;
}> {
  if (!colorTable) {
    console.log("[AI] Color backfill skipped: colorTable not initialized");
    return { total: 0, backfilled: 0 };
  }

  const db = getDatabase();

  // 检查是否已回填
  const marker = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "color_vectors_backfilled"))
    .get();

  if (marker?.value === "true") {
    console.log("[AI] Color backfill: already completed (marker set)");
    return { total: 0, backfilled: 0 };
  }

  // 只统计需要处理的行，并按批读取，避免一次性把旧数据全部载入内存。
  const needsBackfill = sql`
    ${photos.deletedAt} IS NULL AND
    ${photos.dominantColors} IS NOT NULL AND
    ${photos.colorBucket} IS NULL
  `;
  const totalRow = db
    .select({ count: sql<number>`count(*)` })
    .from(photos)
    .where(needsBackfill)
    .get();
  const total = Number(totalRow?.count ?? 0);
  if (total === 0) {
    console.log("[AI] Color backfill: 0 photos need backfill (all up to date)");
    try {
      db.run(
        sql`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('color_vectors_backfilled', 'true', ${Date.now()})`
      );
    } catch (err: unknown) {
      console.error(
        "[AI] Color backfill completion marker failed:",
        getErrorMessage(err)
      );
    }
    return { total: 0, backfilled: 0 };
  }

  const BATCH = 100;
  let backfilled = 0;
  let failed = 0;

  for (let i = 0; i < total; i += BATCH) {
    const batch = db
      .select({
        id: photos.id,
        dominantColors: photos.dominantColors,
      })
      .from(photos)
      .where(needsBackfill)
      .limit(BATCH)
      .offset(i)
      .all();
    const entries: Array<{ photoId: number; r: number; g: number; b: number }> =
      [];

    for (const row of batch) {
      try {
        if (!row.dominantColors) {
          failed++;
          continue;
        }
        const palette = JSON.parse(row.dominantColors) as Array<{
          r: number;
          g: number;
          b: number;
          weight: number;
        }>;
        const color = palette[0];
        if (!color) {
          failed++;
          continue;
        }
        const hasValidChannels = [color.r, color.g, color.b].every(
          (channel) =>
            typeof channel === "number" &&
            Number.isFinite(channel) &&
            channel >= 0 &&
            channel <= 255
        );
        if (!hasValidChannels) {
          failed++;
          continue;
        }
        entries.push({ photoId: row.id, r: color.r, g: color.g, b: color.b });
      } catch {
        failed++;
      }
    }

    if (entries.length > 0) {
      try {
        await upsertColorVectors(entries);
        backfilled += entries.length;
      } catch (err: unknown) {
        failed += entries.length;
        console.error(
          "[AI] Color backfill batch failed:",
          getErrorMessage(err)
        );
      }
    }

    // 避免长时间阻塞
    await new Promise((r) => setTimeout(r, 0));
  }

  // 只有每一行都成功写入且完成标记本身写入成功时，才宣布回填完成。
  if (failed === 0 && backfilled === total) {
    try {
      db.run(
        sql`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('color_vectors_backfilled', 'true', ${Date.now()})`
      );
    } catch (err: unknown) {
      console.error(
        "[AI] Color backfill completion marker failed:",
        getErrorMessage(err)
      );
    }
  }

  console.log(
    `[AI] Color vector backfill: ${backfilled}/${total}${failed > 0 ? ` (${failed} failed)` : ""}`
  );
  return { total, backfilled };
}
