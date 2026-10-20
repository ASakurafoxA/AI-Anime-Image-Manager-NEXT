/**
 * CCIP 角色特征的全库重建编排（NEXT 版新增）。
 *
 * 职责：把「该算特征的照片」找出来 → 交给 worker 池算 → 边算边写 `ccip_embeddings`。
 *
 * 设计要点：
 *   · **断点续跑**：每次开始前读出"已经有特征的照片 id"，只算缺的那些。
 *     所以中断/关闭应用后重跑不会从头再来。
 *   · **边算边写**：每批算完立即 `upsertCcipVectors`，取消也不丢已完成的成果。
 *   · **不与其它 AI 任务抢**：AI 正忙（建向量 / 打标）时直接拒绝并说明原因。
 *   · 进度写进 `app_settings`，界面刷新后仍能看到"上次算什么了"。
 */
import { and, isNull, isNotNull } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { getCachedDetection, resolveDmlDeviceId, resolveWorkerDevices } from "@/services/gpu-detector";
import { getSetting, setSetting } from "@/services/settings-manager";
import { createLogger } from "@/utils/logger";
import { getAiControlState } from "./state";
import { ccipWorkerSlotDevices } from "./ccip-worker-config";
import { embedPhotosWithCcip, type CcipEmbedProgress } from "./ccip-embed-client";
import {
  addCcipVectors,
  listCcipVectorIds,
  rebuildCcipIndex,
  runVectorMaintenanceNow,
  upsertCcipVectors,
} from "./vector-db";

const log = createLogger("ccip-embedder");

/** 上次运行结果的 settings 键（界面展示用）。 */
export const CCIP_LAST_RUN_AT_KEY = "ccip.embed.lastRunAt";
export const CCIP_LAST_RUN_SUMMARY_KEY = "ccip.embed.lastRunSummary";

/**
 * 自用（2026-10-17）：决定 CCIP 用哪个后端、开几个进程 ✓
 *
 * 实测（`scripts/probe-ccip-providers.mjs`，同一批 40 张）：
 *   · CPU 4 线程：**2.43 张/秒**
 *   · **DML：15.55 张/秒**（输出余弦 1.000000）→ 单进程 GPU 就比"生产 12 进程 CPU 3.7 张/秒"快约 4 倍
 * 所以：GPU 开着 → **一卡一个进程**（多卡并行 = 卡数翻倍）；关着/没显卡 → 老 CPU 多进程 ✓
 */
/**
 * 自用（2026-10-18 · 会话#9 补回）：**每张卡开几个 CCIP 进程**，从「设置 → 每卡 worker 数」读 ✓
 *
 * 为什么必须读设置（这就是"慢"的根因）：
 *   2026-10-17 用生产 worker 协议复测过同一张卡（RTX 4070 Ti SUPER，72 张 × 2 轮）：
 *
 *   | 每卡进程数 | 吞吐 | 相对 1 个 |
 *   |---|---|---|
 *   | 1 | 15.73 张/秒 | 100% |
 *   | 2 | 23.77 | 151% |
 *   | 3 | 29.65 | 188% |
 *   | **4** | **34.66** | **220%** ← 拐点 |
 *   | 6 / 8 | 33.2 / 34.2 | ≈211 / 217% |
 *
 *   而回滚到 1.18 时这里被写死成 **2**，实际只跑到 13 张/秒（全库 6.5 万张要 1 小时 22 分）✗
 *   —— 因为**真正的瓶颈是每张图的 sharp 解码（单进程内串行）**，不是显卡算力：
 *   进程越多，同时在解码的图越多，吞吐才上得去 ✓
 *
 * 键名用 `ai.faceWorkersPerCard`（**历史遗留名字**，2026-10-18 剔除 SFace 时故意没改键值 ——
 * 改了会让用户已存的设置失效；设置页里那一项读的就是这个键，**不另造第二个键**，
 * 免得"界面上改了不生效"）；轮转分配复用 `ccip-worker-config` 里已测过的纯函数 ✓
 */
function readCcipWorkersPerCard(): number {
  try {
    const parsed = Number.parseInt(
      getSetting("ai.faceWorkersPerCard") ?? "",
      10
    );
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.min(8, parsed);
    }
  } catch {
    /* 读不到设置就用实测拐点 */
  }
  // 默认 4 = 实测拐点（再多不变快，只多占内存；6/8 只慢 4%）
  return 4;
}

/**
 * 自用（2026-10-18 · 会话#9，**这是"只有 20 张/秒"的真正元凶**）：
 * 把"用哪张显卡"解析成**明确的适配器序号**，绝不留给系统默认 ✓
 *
 * 事故经过（实测数据对得上）：
 *   · `gpu.detected` 缓存里 `detectorVersion = 2`，而代码版本已升到 3
 *     → `getCachedDetection()` 认为缓存作废、返回 null
 *     → 同步的 `getDmlDeviceId()` 返回 **null**
 *     → worker 收到 `deviceId: undefined` → 在 worker 里被兜底成 **0**
 *   · 而这台机器 DirectML 的适配器枚举是：
 *       **0 = OrayIddDriver Device（虚拟显示器）**、1 = GameViewer 虚拟显示器、
 *       **2 = NVIDIA RTX 4070 Ti SUPER（真正的独显）**、3 = AMD 核显
 *     —— 也就是说：**整整一场全库任务都跑在虚拟显示器驱动上** ✗✗
 *     （所以 4 个进程也只有 20 张/秒；用 2 号适配器实测 4 个进程是 34.66 张/秒）
 *
 * 修法：这里走**异步解析** `resolveDmlDeviceId()` —— 缓存作废时它会真的探一次并回写，
 * 然后把明确的序号传给每个 worker。这台机器探一次约 1~2 秒，只发生一次（之后走缓存）✓
 */
async function resolveCcipDevices(
  options: BuildCcipVectorsOptions
): Promise<Array<number | null>> {
  if (options.deviceIds && options.deviceIds.length > 0) {
    return options.deviceIds;
  }
  let devices: Array<number | null> = [];
  try {
    // 多卡模式勾选了具体的卡 → 用它（此时一定不是 null）
    devices = resolveWorkerDevices();
  } catch {
    devices = [];
  }
  const usable = devices.filter((id): id is number => typeof id === "number");
  if (usable.length > 0) {
    return usable;
  }
  // 走到这里说明"当前应交给 DirectML 的适配器"还不知道 → 补一次探测
  try {
    const resolved = await resolveDmlDeviceId(options.modelsDir);
    if (typeof resolved === "number") {
      log.info({ deviceId: resolved }, "CCIP 适配器已解析（补探测）");
      return [resolved];
    }
    log.warn(
      "CCIP 无法确定独显序号，将使用系统默认适配器（若机器上有虚拟显示器，可能落到虚拟设备上）"
    );
  } catch (error) {
    log.warn({ error: String(error) }, "CCIP 适配器解析失败，回退系统默认适配器");
  }
  return devices.length > 0 ? devices : [null];
}

async function resolveCcipEngine(options: BuildCcipVectorsOptions): Promise<{
  deviceLabel: string | null;
  provider: "cpu" | "dml";
  workers: number | undefined;
  deviceIds: Array<number | null> | undefined;
}> {
  let wanted = options.provider;
  if (!wanted) {
    try {
      wanted = getSetting("gpu.enabled") === "true" ? "dml" : "cpu";
    } catch {
      wanted = "cpu";
    }
  }
  if (wanted === "dml") {
    const devices = await resolveCcipDevices(options);
    /*
     * 每张卡开 N 个进程（N 来自设置，默认 4 = 拐点）。
     * 为什么"同卡多开"反而更快（和打标/建向量的结论相反）：CCIP 每张图有很重的
     * **预处理**（sharp 解码 + 缩放 384×384），多进程才能让"解码"与"推理"重叠 ✓
     * 多卡时按轮转分配（0,1,0,1…），派活"谁空闲谁接"，快卡自然多接几批 ✓
     */
    const perCard = readCcipWorkersPerCard();
    const slotDevices = ccipWorkerSlotDevices(devices, perCard);
    log.info(
      { perCard, sourceDevices: devices, slotDevices },
      "CCIP 进程布局"
    );
    return {
      deviceLabel: describeDeviceSet(devices),
      provider: "dml",
      workers: options.workers ?? slotDevices.length,
      deviceIds: slotDevices,
    };
  }
  return {
    deviceLabel: "CPU",
    provider: "cpu",
    workers: options.workers,
    deviceIds: undefined,
  };
}

/**
 * 自用（2026-10-18 · 会话#9）：把适配器序号翻译成一句人话，**显示在顶栏上**。
 *
 * 为什么值得做：这次的坑就是"跑在虚拟显示器上"却完全看不出来（速度只有 20 张/秒）。
 * 顶栏写明「显卡：RTX 4070 Ti SUPER」，用户一眼就知道走没走对路 ✓
 */
function describeDevice(deviceId: number | null): string {
  if (deviceId === null) {
    return "系统默认适配器";
  }
  try {
    const adapters = getCachedDetection()?.adapters ?? [];
    const hit = adapters.find((item) => item.deviceId === deviceId);
    if (!hit?.name) {
      return `适配器 #${deviceId}`;
    }
    // 去掉厂商前缀，顶栏放不下「NVIDIA GeForce RTX 4070 Ti SUPER」这么长
    return hit.name
      .replace(/^NVIDIA\s+(GeForce\s+)?/i, "")
      .replace(/^AMD\s+(Radeon\S*\s*)?/i, "")
      .replace(/^Intel\(R\)\s*/i, "")
      .replace(/\s*\(TM\)/gi, "")
      .trim();
  } catch {
    return `适配器 #${deviceId}`;
  }
}

/**
 * 自用（2026-10-18 · 会话#9）：多卡时**把每张卡都写出来**（用户明说以后会上第二张独显）。
 *
 * 以前这里只取 `devices[0]` → 双卡跑着，顶栏却只显示第一张卡的名字，
 * 用户没法确认第二张卡到底有没有在干活 ✗
 */
function describeDeviceSet(devices: Array<number | null>): string {
  if (devices.length === 0) {
    return "系统默认适配器";
  }
  if (devices.length === 1) {
    return describeDevice(devices[0] ?? null);
  }
  const names = [...new Set(devices.map((id) => describeDevice(id ?? null)))];
  return `${names.length} 张卡（${names.join(" + ")}）`;
}

export interface BuildCcipVectorsOptions {
  /** `<图库>/models` */
  modelsDir: string;
  /** 只算这些照片（默认全库未删除的）。 */
  photoIds?: number[];
  /** 跳过已有特征的（默认 true = 断点续跑）。 */
  skipExisting?: boolean;
  /** 最多算多少张（试跑用；默认不限）。 */
  limit?: number;
  workers?: number;
  threadsPerWorker?: number;
  batchSize?: number;
  /**
   * 自用（2026-10-17，实测）：推理后端。
   *   · `"dml"` = 显卡，实测 **15.5 张/秒**（CPU 4 线程 2.43、生产 12 进程合计 3.7）→ **约 4 倍**
   *   · `"cpu"` = 老行为
   * 默认走「设置 → GPU 加速」：开着就用显卡（多卡时**一卡一个进程**），关着或没显卡就用 CPU ✓
   */
  provider?: "cpu" | "dml";
  /** 显式指定设备清单（不传则按 GPU 设置自动决定） */
  deviceIds?: Array<number | null>;
  onProgress?: (progress: CcipEmbedProgress) => void;
  signal?: AbortSignal;
}

export interface BuildCcipVectorsResult {
  /** 本次实际要算的张数（已排除算过的） */
  total: number;
  embedded: number;
  failed: number;
  /** 因为已经有特征而跳过的张数 */
  skipped: number;
  cancelled: boolean;
  elapsedMs: number;
  /** 库里可参与的照片总数 */
  libraryTotal: number;
}

/** 进程内重入保护：全库重算同时只允许一个。 */
let building = false;
/** 当前这次重算的取消器（供 IPC 触发取消）。 */
let currentAbort: AbortController | null = null;
/** 当前这次运行的实时进度（界面轮询用；几小时的任务不能是黑箱）。 */
let liveProgress: {
  done: number;
  total: number;
  embedded: number;
  failed: number;
  startedAt: number;
  /**
   * 自用（2026-10-18 · 会话#9）：**还在启动识别进程**（每个进程都要加载一次模型）。
   * 这一阶段可能要 5~20 秒，界面必须能说清楚"现在在干嘛"，否则用户只觉得卡住 ✗
   */
  starting: boolean;
  /** 已经就绪的进程数 / 要启动的总数（starting 期间界面显示 1/4、2/4…）。 */
  workersReady: number;
  workersTotal: number;
  /** 这次实际用的设备（顶栏显示，一眼能看出走没走对显卡）。 */
  device: string | null;
  /** 实际开了几个进程（0 = 还没定下来）。 */
  workers: number;
} | null = null;

export function isBuildingCcipVectors(): boolean {
  return building;
}

export interface CcipBuildProgress {
  running: boolean;
  done: number;
  total: number;
  embedded: number;
  failed: number;
  startedAt: number | null;
  /** 给界面判断"还在启动进程、还没开始算"（此时别把速度显示成 0 张/秒）。 */
  starting: boolean;
  /** 正在用的显卡（界面上写明，避免"跑在虚拟显示器上"看不出来）。 */
  device: string | null;
  /** 实际开了几个识别进程（顶栏写明，方便判断设置生没生效）。 */
  workers: number;
  workersReady: number;
  workersTotal: number;
  /** 估算速度（张/秒），跑起来才有值。 */
  photosPerSecond: number | null;
  /** 估算剩余秒数。 */
  etaSeconds: number | null;
  lastRunAt: number | null;
  lastSummary: string | null;
}

/**
 * 读当前进度（供界面轮询）。
 *
 * 几小时的任务必须能看见进展：这里同时给"已处理 / 总数 / 已写入 / 失败 / 速度 / 预计剩余"。
 */
export function getCcipBuildProgress(): CcipBuildProgress {
  const last = getCcipLastRunSummary();
  if (!(building && liveProgress)) {
    return {
      running: building,
      done: liveProgress?.done ?? 0,
      total: liveProgress?.total ?? 0,
      embedded: liveProgress?.embedded ?? 0,
      failed: liveProgress?.failed ?? 0,
      startedAt: liveProgress?.startedAt ?? null,
      starting: liveProgress?.starting ?? false,
      workersReady: liveProgress?.workersReady ?? 0,
      workersTotal: liveProgress?.workersTotal ?? 0,
      device: liveProgress?.device ?? null,
      workers: liveProgress?.workers ?? 0,
      photosPerSecond: null,
      etaSeconds: null,
      lastRunAt: last.at,
      lastSummary: last.summary,
    };
  }
  const elapsed = Math.max(0.001, (Date.now() - liveProgress.startedAt) / 1000);
  const rate = liveProgress.done / elapsed;
  const remaining = liveProgress.total - liveProgress.done;
  return {
    running: true,
    done: liveProgress.done,
    total: liveProgress.total,
    embedded: liveProgress.embedded,
    failed: liveProgress.failed,
    startedAt: liveProgress.startedAt,
    starting: liveProgress.starting,
    workersReady: liveProgress.workersReady,
    workersTotal: liveProgress.workersTotal,
    device: liveProgress.device,
    workers: liveProgress.workers,
    photosPerSecond:
      liveProgress.starting || rate <= 0
        ? null
        : Math.round(rate * 100) / 100,
    etaSeconds:
      !liveProgress.starting && rate > 0 && remaining > 0
        ? Math.round(remaining / rate)
        : null,
    lastRunAt: last.at,
    lastSummary: last.summary,
  };
}

/** 请求取消当前这次特征生成（已算好的不会丢）。 */export function cancelCcipVectorsBuild(): boolean {
  if (!currentAbort) {
    return false;
  }
  currentAbort.abort();
  return true;
}

/** 读取"上次运行摘要"（界面展示）。 */
export function getCcipLastRunSummary(): {
  at: number | null;
  summary: string | null;
} {
  try {
    const at = Number(getSetting(CCIP_LAST_RUN_AT_KEY) ?? "");
    const summary = getSetting(CCIP_LAST_RUN_SUMMARY_KEY) ?? null;
    return {
      at: Number.isFinite(at) && at > 0 ? at : null,
      summary: summary && summary.length > 0 ? summary : null,
    };
  } catch {
    return { at: null, summary: null };
  }
}

/** 取库里参与角色识别的照片（未删除、有路径）。 */
function listLibraryPhotos(): Array<{ id: number; path: string }> {
  const db = getDatabase();
  const rows = db
    .select({ id: photos.id, path: photos.path })
    .from(photos)
    .where(and(isNull(photos.deletedAt), isNotNull(photos.path)))
    .all();
  return rows
    .filter((row) => typeof row.path === "string" && row.path.length > 0)
    .map((row) => ({ id: row.id, path: row.path as string }));
}

/**
 * 为图库补齐 CCIP 角色特征。
 *
 * @throws 当 AI 正忙或已有一次重算在跑时抛出（原因写明）。
 */
export async function buildCcipVectors(
  options: BuildCcipVectorsOptions
): Promise<BuildCcipVectorsResult> {
  if (building) {
    throw new Error("角色特征正在生成中，请等当前这次跑完");
  }
  const aiState = getAiControlState();
  if (aiState !== "idle") {
    throw new Error(
      `AI 正忙（${aiState}），先等建向量 / 打标跑完再生成角色特征`
    );
  }

  building = true;
  currentAbort = new AbortController();
  // 调用方若自带 signal，取消时一并生效（两者取"任一取消"）。
  const externalSignal = options.signal;
  const onExternalAbort = () => currentAbort?.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const startedAt = Date.now();
  try {
    const library = listLibraryPhotos();
    const libraryTotal = library.length;

    const wanted =
      options.photoIds && options.photoIds.length > 0
        ? (() => {
            const wantedSet = new Set(options.photoIds);
            return library.filter((photo) => wantedSet.has(photo.id));
          })()
        : library;

    const skipExisting = options.skipExisting !== false;
    let skipped = 0;
    let pending = wanted;
    if (skipExisting) {
      const existing = new Set(await listCcipVectorIds());
      const before = pending.length;
      pending = pending.filter((photo) => !existing.has(photo.id));
      skipped = before - pending.length;
    }
    if (options.limit && options.limit > 0 && pending.length > options.limit) {
      pending = pending.slice(0, options.limit);
    }

    log.info(
      {
        libraryTotal,
        want: wanted.length,
        skipped,
        pending: pending.length,
        workers: options.workers,
      },
      "CCIP 角色特征生成开始"
    );

    if (pending.length === 0) {
      const summary = `无需生成：${libraryTotal} 张里已有 ${skipped} 张特征`;
      setSetting(CCIP_LAST_RUN_AT_KEY, String(Date.now()));
      setSetting(CCIP_LAST_RUN_SUMMARY_KEY, summary);
      return {
        total: 0,
        embedded: 0,
        failed: 0,
        skipped,
        cancelled: false,
        elapsedMs: Date.now() - startedAt,
        libraryTotal,
      };
    }

    let written = 0;
    // 实时进度：几小时的任务必须能在界面上看见"算到哪了"
    const progress = {
      done: 0,
      total: pending.length,
      embedded: 0,
      failed: 0,
      startedAt: Date.now(),
      starting: true,
      workersReady: 0,
      workersTotal: 0,
      device: null as string | null,
      workers: 0,
    };
    liveProgress = progress;
    /*
     * 自用（2026-10-17，实测）：**优先用显卡** ✓
     * 实测同一批 40 张：DML **15.55 张/秒** vs CPU 4 线程 2.43 张/秒（输出余弦 1.000000），
     * 也就是**单进程 GPU 就比"生产 12 进程 CPU（3.7 张/秒）"快约 4 倍** ✓
     * 所以：GPU 开着 → 一卡多个进程（多卡并行）；否则回退 CPU 多进程（老行为）✓
     */
    const engine = await resolveCcipEngine(options);
    progress.device = engine.deviceLabel;
    progress.workers = engine.workers ?? 0;
    log.info(
      {
        device: engine.deviceLabel,
        provider: engine.provider,
        workers: engine.workers,
        deviceIds: engine.deviceIds,
      },
      "CCIP 推理后端"
    );
    /*
     * 自用（2026-10-18 · 会话#9）：**写库"攒着写 + 不挡算"** ✓
     *
     * ① 攒批：以前每算完一批（24 张）就写一次 → 全库 ~3200 次事务；现在攒到 192 张或 5 秒 ✓
     * ② 只 add、不 delete：本次要算的照片是"库里还没有特征"的那些（skipExisting 过滤过），
     *    再 `delete` 一次等于**每次全表扫描 + 一个多余事务**，纯浪费 ✗
     *    （只有调用方显式 skipExisting=false 时才需要先删后插，那条路保留 upsert）
     * ③ **不等写完**：写库排成一条链在后台跑，worker 立刻去领下一批 ——
     *    以前 `await onBatch(...)` 会让出这批的进程干等写库，实测占掉一大截吞吐 ✗
     *    链条积压超过 4 批才稍微等一下（背压），防止内存里堆太多向量 ✓
     */
    const WRITE_BATCH = 192;
    const WRITE_INTERVAL_MS = 5000;
    const MAX_PENDING_WRITES = 4;
    let buffer: Array<{ photoId: number; vector: number[] }> = [];
    let bufferSince = Date.now();
    let writeChain: Promise<void> = Promise.resolve();
    let pendingWrites = 0;

    const enqueueWrite = (entries: Array<{ photoId: number; vector: number[] }>) => {
      pendingWrites += 1;
      writeChain = writeChain
        .then(async () => {
          if (skipExisting) {
            await addCcipVectors(entries);
          } else {
            await upsertCcipVectors(entries);
          }
          written += entries.length;
        })
        .catch((error) => {
          log.warn({ error: String(error) }, "CCIP 特征写入失败（这批会重算）");
        })
        .finally(() => {
          pendingWrites -= 1;
        });
    };

    const flushWrites = async (force: boolean): Promise<void> => {
      if (buffer.length === 0) {
        return;
      }
      if (
        !force &&
        buffer.length < WRITE_BATCH &&
        Date.now() - bufferSince < WRITE_INTERVAL_MS
      ) {
        return;
      }
      const entries = buffer;
      buffer = [];
      bufferSince = Date.now();
      enqueueWrite(entries);
      // 背压：写库积压太多时，等一下再继续算
      if (pendingWrites > MAX_PENDING_WRITES) {
        await writeChain;
      }
    };

    let result: Awaited<ReturnType<typeof embedPhotosWithCcip>>;
    try {
      result = await embedPhotosWithCcip({
        modelsDir: options.modelsDir,
        photos: pending,
        workers: engine.workers,
        threadsPerWorker:
          engine.provider === "dml" ? 1 : options.threadsPerWorker,
        batchSize: options.batchSize,
        provider: engine.provider,
        deviceIds: engine.deviceIds,
        signal: currentAbort.signal,
        onWorkerReady: (ready, total) => {
          progress.workersReady = ready;
          progress.workersTotal = total;
        },
        onStarted: () => {
          // 全部进程就绪、真正开始算 → 从现在起算速度（别把启动时间摊进速度里）
          progress.starting = false;
          progress.startedAt = Date.now();
        },
        onProgress: (p) => {
          progress.done = p.done;
          progress.total = p.total;
          progress.embedded = p.embedded;
          progress.failed = p.failed;
          options.onProgress?.(p);
        },
        onBatch: async (entries) => {
          buffer.push(...entries);
          await flushWrites(false);
        },
      });
    } finally {
      // 取消 / 出错也要把攒着的写完，不能白算
      await flushWrites(true).catch(() => undefined);
      // 等后台写库链跑完，保证"返回时已经落库"
      await writeChain.catch(() => undefined);
    }
    // 保留最终数值（running 变 false，界面还能显示"上次算完 X 张"）
    progress.done = result.done;
    progress.embedded = result.embedded;
    progress.failed = result.failed;

    const summary =
      `本次算好 ${result.embedded} 张（失败 ${result.failed}，跳过 ${skipped}），` +
      `用时 ${Math.round(result.elapsedMs / 1000)} 秒` +
      (result.cancelled ? "（已取消，可继续重跑续算）" : "");
    setSetting(CCIP_LAST_RUN_AT_KEY, String(Date.now()));
    setSetting(CCIP_LAST_RUN_SUMMARY_KEY, summary);

    /*
     * 收尾两件事（**不能省**）：
     *  ① 重建近邻索引 —— LanceDB 的索引只覆盖"建索引那一刻已有的行"，
     *     不重建的话，聚类逐张查近邻会退化成暴力扫描（慢上百倍 ✗）；
     *  ② 清一次碎片 —— 每写一批就多一个版本，全库会堆出几千个旧版本
     *     （与之前"1.9 万个文件 / 1.4 GB"是同一类事故 ✗）。
     *     维护放后台跑（几分钟），不拖住"完成"提示。
     */
    if (!result.cancelled) {
      try {
        await rebuildCcipIndex();
      } catch {
        /* rebuildCcipIndex 内部已兜底，不会抛 */
      }
      void runVectorMaintenanceNow("ccip-embed-complete");
    }

    log.info(
      {
        embedded: result.embedded,
        failed: result.failed,
        written,
        cancelled: result.cancelled,
        elapsedMs: result.elapsedMs,
      },
      "CCIP 角色特征生成结束"
    );

    return {
      total: pending.length,
      embedded: result.embedded,
      failed: result.failed,
      skipped,
      cancelled: result.cancelled,
      elapsedMs: result.elapsedMs,
      libraryTotal,
    };
  } finally {
    externalSignal?.removeEventListener("abort", onExternalAbort);
    currentAbort = null;
    building = false;
  }
}