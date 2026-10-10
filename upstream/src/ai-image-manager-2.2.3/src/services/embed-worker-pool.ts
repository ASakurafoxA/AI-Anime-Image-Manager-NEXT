import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type { SerializedWorkerAdapter } from "@/services/ai/model-adapter";
import { getActiveEmbeddingWorkerAdapter } from "@/services/ai/model-config";
import { captureWorkerOutput } from "@/services/diagnostics/worker-output";
import {
  getDmlDeviceId,
  hasDuplicatedWorkerDevice,
  isMultiGpuEnabled,
  MAX_MULTI_GPU_DEVICES,
  probeEmbeddingGpuCapability,
  recordEmbeddingProbeResult,
  resolveDmlDeviceId,
  resolveWorkerDevices,
} from "@/services/gpu-detector";
import { trackChildProcess } from "@/services/tracked-child-processes";

interface EmbedResult {
  error?: string;
  id: number;
  vector?: number[];
}

export type EmbeddingExecutionProvider = "cpu" | "directml";

export class EmbeddingProviderError extends Error {
  readonly code = "GPU_PROVIDER_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

export function isEmbeddingProviderError(error: unknown): boolean {
  return (
    error instanceof EmbeddingProviderError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "GPU_PROVIDER_FAILED")
  );
}

type WorkerStatus = "initializing" | "idle" | "busy" | "dead";

interface WorkerSlot {
  consecutiveFailures: number;
  /** 多卡模式下这个 worker 绑定的适配器序号。 */
  deviceId?: number | null;
  generation: number;
  index: number;
  pendingReject: ((err: Error) => void) | null;
  pendingResolve: ((results: EmbedResult[]) => void) | null;
  process: ChildProcess;
  status: WorkerStatus;
  timeoutId?: ReturnType<typeof setTimeout> | null;
}

interface QueuedRequest {
  photos: Array<{ id: number; path: string }>;
  reject: (err: Error) => void;
  resolve: (results: EmbedResult[]) => void;
}

interface EmbedPoolConfig {
  batchSize: number;
  intraOpNumThreads: number;
  workers: number;
}

type EmbedBatchResultCallback = (
  results: EmbedResult[],
  batch: Array<{ id: number; path: string }>
) => Promise<void> | void;

const DEFAULT_BATCH_SIZE = 20;
const WORKER_TIMEOUT = 300_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RESPAWN_DELAY_MS = 1000;
const L2_NORM_TOLERANCE = 1e-3;
/**
 * 自用（吞吐修复 2026-10-09）：GPU worker 死亡容忍上限。
 *
 * 单个 DirectML worker 死亡只重启它自己；但若**反复死亡**（说明 DML 在这台机器上
 * 就是不稳），超过这个次数才整池退 CPU —— 避免"越修越慢"地无限重试。
 */
const MAX_DEAD_WORKER_FAILURES = 6;
/** 单批因 worker 死亡而重试的次数上限（超过就交给上层做 CPU 兜底）。 */
const BATCH_RETRY_LIMIT = 3;
/** 等一个"活着的空闲 worker"来重试本批的最长时间。 */
const RETRY_SLOT_WAIT_MS = 120_000;

let slots: WorkerSlot[] = [];
let requestQueue: QueuedRequest[] = [];
let modelPath: string | null = null;
let workerAdapter: SerializedWorkerAdapter | null = null;
let poolUseGPU = false;
let poolExecutionProvider: EmbeddingExecutionProvider = "cpu";
/** 要交给 DirectML 的适配器序号（null = 系统默认适配器，通常是核显）。 */
let poolDeviceId: number | null = null;
/** 多卡模式下实际使用的设备清单（每个 worker 一张卡）。 */
let poolDevices: Array<number | null> = [];
/**
 * 自用（多卡·安全闸）：本代池里是否有两个以上 worker 落在**同一张卡**上。
 * 有就串行化批处理（同卡并发只会互相踩，实测慢一倍）。
 */
let poolDevicesAreShared = false;
let initialized = false;
/** 本代池内"GPU worker 死亡"累计次数（用于判断是否还值得留在 GPU 上）。 */
let deadWorkerFailures = 0;
let poolSize = 0;
let poolBatchSize = DEFAULT_BATCH_SIZE;
let poolIntraOpNumThreads = 1;
let poolGeneration = 0;
let activePoolKey: string | null = null;
let initializationKey: string | null = null;
let initializationPromise: Promise<void> | null = null;
let gpuProviderFailure: EmbeddingProviderError | null = null;

/** Per-worker init progress: Map<workerIndex, percent 0-100> */
const workerInitProgress = new Map<number, number>();

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function validateEmbedResults(results: unknown): EmbedResult[] {
  if (!Array.isArray(results)) {
    throw new Error("Invalid image embedding result: expected an array");
  }
  const dimensions = workerAdapter?.image.dimensions ?? 768;
  for (const entry of results) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Invalid image embedding result entry");
    }
    const result = entry as EmbedResult;
    if (result.vector === undefined) {
      if (typeof result.error !== "string" || result.error.length === 0) {
        throw new Error(
          `Invalid image embedding result for id ${String(result.id)}: missing vector or error`
        );
      }
      continue;
    }
    if (
      !Array.isArray(result.vector) ||
      result.vector.length !== dimensions ||
      result.vector.some((value) => !Number.isFinite(value))
    ) {
      throw new Error(
        `Invalid image embedding result for id ${String(result.id)}: expected ${dimensions} finite values`
      );
    }
    const norm = Math.sqrt(
      result.vector.reduce((sum, value) => sum + value * value, 0)
    );
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > L2_NORM_TOLERANCE) {
      throw new Error(
        `Invalid image embedding result for id ${String(result.id)}: expected an L2-normalized vector`
      );
    }
  }
  return results as EmbedResult[];
}

export function resolveEmbedPoolConfig(
  cpuCount = os.cpus().length,
  useGPU = false,
  env: NodeJS.ProcessEnv = process.env
): EmbedPoolConfig {
  const safeCpuCount = Math.max(1, cpuCount);
  // Keep defaults conservative for both CPU and DirectML. DirectML uses the
  // same pool sizing but its worker session applies its own safe ORT options.
  let defaultWorkers = 1;
  if ((useGPU && safeCpuCount >= 8) || safeCpuCount >= 12) {
    defaultWorkers = 2;
  }
  const maxWorkers = Math.max(1, Math.min(3, safeCpuCount - 1 || 1));
  const workers = Math.max(
    1,
    Math.min(
      parsePositiveInt(env.AI_EMBED_WORKERS) ?? defaultWorkers,
      maxWorkers
    )
  );

  const maxThreadsPerWorker = Math.max(
    1,
    Math.floor(Math.max(1, safeCpuCount - 1) / workers)
  );
  const defaultThreads = Math.max(1, Math.min(4, maxThreadsPerWorker));
  const intraOpNumThreads = Math.max(
    1,
    Math.min(
      parsePositiveInt(env.AI_EMBED_THREADS) ?? defaultThreads,
      maxThreadsPerWorker
    )
  );

  const batchSize = Math.max(
    1,
    Math.min(
      parsePositiveInt(env.AI_EMBED_BATCH_SIZE) ?? DEFAULT_BATCH_SIZE,
      100
    )
  );

  return { batchSize, intraOpNumThreads, workers };
}

function findWorkerScript(): string {
  if (app.isPackaged) {
    // Preferred: app.asar.unpacked/scripts/embed-worker.mjs — sibling of
    // app.asar.unpacked/node_modules/, so ESM `import sharp from "sharp"`
    // resolves correctly via Node's normal node_modules lookup.
    const unpacked = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "scripts",
      "embed-worker.mjs"
    );
    if (fs.existsSync(unpacked)) {
      return unpacked;
    }
    // Backward-compat: legacy extraResource layout (resources/scripts/...).
    const bundled = path.join(
      process.resourcesPath,
      "scripts",
      "embed-worker.mjs"
    );
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }
  const cwd = process.cwd();
  const candidate = path.join(cwd, "scripts", "embed-worker.mjs");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const alt = path.join(app.getAppPath(), "scripts", "embed-worker.mjs");
  if (fs.existsSync(alt)) {
    return alt;
  }
  throw new Error("embed-worker.mjs not found");
}

function isCurrentSlot(slot: WorkerSlot): boolean {
  return slot.generation === poolGeneration && slots[slot.index] === slot;
}

function spawnWorker(index: number, generation: number): WorkerSlot {
  const workerScript = findWorkerScript();
  const child = trackChildProcess(
    fork(workerScript, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
  );
  captureWorkerOutput(child, `embed-worker-${index}`);

  const slot: WorkerSlot = {
    process: child,
    generation,
    index,
    status: "initializing",
    pendingResolve: null,
    pendingReject: null,
    consecutiveFailures: 0,
  };

  child.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().trim();
    if (lines) {
      console.error(`[Pool Worker ${index}] ${lines}`);
      try {
        const logDir = path.join(app.getPath("userData"), "logs");
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(
          path.join(logDir, "ai-worker.log"),
          `${new Date().toISOString()} [Pool Worker ${index}] ${lines}\n`,
          { flag: "a" }
        );
      } catch {
        /* best-effort */
      }
    }
  });

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: worker IPC handler keeps progress, lifecycle, and stale-result validation together.
  child.on("message", (msg: unknown) => {
    const message = msg as {
      error?: string;
      adapterId?: string;
      fingerprint?: string;
      percent?: number;
      provider?: EmbeddingExecutionProvider;
      results?: EmbedResult[];
      type?: string;
    };
    // Clear any pending dispatch timeout when worker responds
    if (slot.timeoutId) {
      clearTimeout(slot.timeoutId);
      slot.timeoutId = null;
    }
    if (message.type === "init-progress") {
      if (!isCurrentSlot(slot)) {
        return;
      }
      const pct = Number(message.percent ?? 0);
      workerInitProgress.set(index, pct);
      return;
    }
    if (message.type === "init-error") {
      console.error(
        `[Pool] Worker ${index} init failed: ${message.error || "unknown error"}`
      );
      handleWorkerDeath(slot);
      return;
    }
    if (message.type === "provider-error") {
      failGpuPool(
        new EmbeddingProviderError(
          message.error || "DirectML image embedding failed"
        )
      );
      return;
    }
    if (message.type === "ready") {
      if (!isCurrentSlot(slot)) {
        return;
      }
      if (
        !workerAdapter ||
        message.adapterId !== workerAdapter.adapterId ||
        message.fingerprint !== workerAdapter.fingerprint
      ) {
        console.error(
          `[Pool] Worker ${index} reported stale identity on ready`
        );
        slot.process.kill();
        handleWorkerDeath(slot);
        return;
      }
      workerInitProgress.set(index, 100);
      slot.status = "idle";
      console.log(
        `[Pool] Worker ${index} ready provider=${message.provider ?? "unknown"}`
      );
      if (message.provider && message.provider !== poolExecutionProvider) {
        failGpuPool(
          new EmbeddingProviderError(
            `Embedding worker selected ${message.provider} instead of ${poolExecutionProvider}`
          )
        );
        return;
      }
      drainQueue();
      return;
    }
    if (message.type === "result" && slot.status === "busy") {
      const resolve = slot.pendingResolve;
      const reject = slot.pendingReject;
      slot.pendingResolve = null;
      slot.pendingReject = null;
      slot.status = "idle";
      slot.consecutiveFailures = 0;
      if (
        !workerAdapter ||
        message.adapterId !== workerAdapter.adapterId ||
        message.fingerprint !== workerAdapter.fingerprint
      ) {
        reject?.(new Error("Stale embedding worker result discarded"));
      } else {
        try {
          resolve?.(validateEmbedResults(message.results));
        } catch (error) {
          reject?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
      drainQueue();
    }
  });

  child.on("exit", (code, signal) => {
    console.warn(
      `[Pool] Worker ${index} exited (code=${code}, signal=${signal})`
    );
    handleWorkerDeath(slot);
  });

  child.on("error", (err) => {
    console.error(`[Pool] Worker ${index} error:`, err.message);
    handleWorkerDeath(slot);
  });

  return slot;
}

function failGpuPool(error: EmbeddingProviderError): void {
  if (gpuProviderFailure) {
    return;
  }
  gpuProviderFailure = error;
  initialized = false;
  activePoolKey = null;
  poolUseGPU = false;
  poolGeneration++;
  const oldSlots = slots;
  slots = [];
  workerInitProgress.clear();

  for (const request of requestQueue) {
    request.reject(error);
  }
  requestQueue = [];

  for (const slot of oldSlots) {
    if (slot.timeoutId) {
      clearTimeout(slot.timeoutId);
      slot.timeoutId = null;
    }
    slot.pendingResolve = null;
    slot.pendingReject?.(error);
    slot.pendingReject = null;
    slot.status = "dead";
    try {
      slot.process.kill();
    } catch {
      /* best-effort */
    }
  }
  console.error(`[Pool] DirectML embedding pool failed: ${error.message}`);
}

function handleWorkerDeath(slot: WorkerSlot): void {
  if (slot.status === "dead") {
    return;
  }

  /**
   * 单个 GPU worker 死亡 → **只重启它**，不再整池退 CPU（自用·吞吐修复 2026-10-09）。
   *
   * 原来的逻辑是"DirectML 下任何 worker 死亡 = 整池报废 → 清理半成品 → 整轮改 CPU 重跑"。
   * 后果非常贵：
   *   · CPU 比 DirectML 慢约 10 倍（实测原图 3.3MB 时 DML 15.6 张/秒 vs CPU 更低）；
   *   · 还要先把已建好的向量删掉重来（日志里就是"清理 1720 张部分嵌入的照片"）。
   * 实测日志显示这一条把一整轮从"14~18 张/秒"打到"3~4 张/秒"。
   *
   * 现在：正常死亡 → 标记该 slot 死亡 + 用 `EmbeddingProviderError` 拒绝在跑的那批，
   *   让上层的批次重试逻辑换一个健康 worker 重跑本批；同时 `handleWorkerExit` 会
   *   在本代池内**原地重启**这个 slot（原有能力，之前被 failGpuPool 短路了）。
   * 只有"死亡次数超出预算 / 全池都没有活着的 worker"才升级成整池退 CPU —— 保留兜底。
   */
  if (isCurrentSlot(slot) && poolExecutionProvider === "directml") {
    const slotIndex = slot.index;
    const providerError = new EmbeddingProviderError(
      `DirectML worker ${slotIndex} exited during embedding`
    );
    const reject = slot.pendingReject;
    slot.status = "dead";
    slot.pendingResolve = null;
    slot.pendingReject = null;
    slot.consecutiveFailures++;
    deadWorkerFailures++;
    if (reject) {
      reject(providerError);
    }

    const aliveAfter = slots.filter((s) => s.status !== "dead").length;
    if (aliveAfter === 0 || deadWorkerFailures > MAX_DEAD_WORKER_FAILURES) {
      // 兜底：所有 worker 都死了，或反复死亡（说明 DML 在这台机器上就是不稳），
      // 才把整池判废、让上层清理半成品并改 CPU 重跑。
      failGpuPool(
        new EmbeddingProviderError(
          `DirectML worker ${slotIndex} exited during embedding` +
            (aliveAfter === 0
              ? "（已无存活 worker）"
              : `（累计 ${deadWorkerFailures} 次，超出容忍上限 ${MAX_DEAD_WORKER_FAILURES}）`)
        )
      );
      return;
    }

    console.warn(
      `[Pool] DirectML worker ${slotIndex} 已退出：本代池内重启该 worker，本批改由其它 worker 重试` +
        `（存活 ${aliveAfter}/${slots.length}，累计死亡 ${deadWorkerFailures}）`
    );

    // 与下面的通用路径一样：只有"初始化完成的一代"才允许原地补位
    if (initialized && slot.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      const generation = slot.generation;
      setTimeout(() => {
        if (
          slot.status !== "dead" ||
          generation !== poolGeneration ||
          slots[slotIndex] !== slot ||
          !initialized
        ) {
          return;
        }
        console.log(
          `[Pool] Respawning worker ${slotIndex} (attempt ${slot.consecutiveFailures})`
        );
        const newSlot = spawnWorker(slotIndex, generation);
        newSlot.consecutiveFailures = slot.consecutiveFailures;
        // 多卡：重启后仍绑原来那张卡
        newSlot.deviceId = slot.deviceId ?? null;
        slots[slotIndex] = newSlot;
        newSlot.process.send({
          type: "init",
          adapter: workerAdapter,
          execution: {
            provider: poolExecutionProvider,
            deviceId: newSlot.deviceId ?? poolDeviceId ?? undefined,
            intraOpNumThreads: poolIntraOpNumThreads,
          },
        });
      }, RESPAWN_DELAY_MS);
    }
    return;
  }

  const hadPending = slot.pendingReject !== null;
  const reject = slot.pendingReject;
  slot.status = "dead";
  slot.pendingResolve = null;
  slot.pendingReject = null;
  slot.consecutiveFailures++;

  if (hadPending && reject) {
    reject(new Error(`Worker ${slot.index} died during processing`));
  }

  // A previous pool generation may exit after shutdown or replacement. It must
  // never mutate or respawn into the current pool.
  if (!isCurrentSlot(slot)) {
    return;
  }

  const aliveCount = slots.filter((s) => s.status !== "dead").length;
  if (aliveCount === 0) {
    initialized = false;
    // Reject all queued requests
    for (const req of requestQueue) {
      req.reject(new Error("All workers died, pool reset"));
    }
    requestQueue = [];
    return;
  }

  // Initialization failures are handled by startWorkerPool(). Only a fully
  // initialized generation may replace one failed worker in place.
  if (!initialized) {
    return;
  }

  if (
    slot.consecutiveFailures < MAX_CONSECUTIVE_FAILURES &&
    modelPath &&
    workerAdapter
  ) {
    const generation = slot.generation;
    setTimeout(() => {
      if (
        slot.status !== "dead" ||
        generation !== poolGeneration ||
        slots[slot.index] !== slot ||
        !initialized
      ) {
        return;
      }
      console.log(
        `[Pool] Respawning worker ${slot.index} (attempt ${slot.consecutiveFailures})`
      );
      const newSlot = spawnWorker(slot.index, generation);
      newSlot.consecutiveFailures = slot.consecutiveFailures;
      slots[slot.index] = newSlot;
      newSlot.process.send({
        type: "init",
        adapter: workerAdapter,
        execution: {
          provider: poolExecutionProvider,
          deviceId: poolDeviceId ?? undefined,
          intraOpNumThreads: poolIntraOpNumThreads,
        },
      });
    }, RESPAWN_DELAY_MS);
  } else if (slot.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    console.warn(
      `[Pool] Worker ${slot.index} exceeded max failures (${MAX_CONSECUTIVE_FAILURES}), not respawning`
    );
  }
}

function drainQueue(): void {
  while (requestQueue.length > 0) {
    const idleSlot = slots.find((s) => s.status === "idle");
    if (!idleSlot) {
      break;
    }

    const request = requestQueue.shift();
    if (!request) {
      break;
    }
    dispatchToSlot(idleSlot, request.photos, request.resolve, request.reject);
  }
}

function dispatchToSlot(
  slot: WorkerSlot,
  photos: Array<{ id: number; path: string }>,
  resolve: (results: EmbedResult[]) => void,
  reject: (err: Error) => void
): void {
  slot.status = "busy";
  slot.pendingResolve = resolve;
  slot.pendingReject = reject;

  console.log(
    `[Pool] Dispatching ${photos.length} photos to Worker ${slot.index}`
  );

  slot.timeoutId = setTimeout(() => {
    if (slot.status === "busy" && slot.pendingReject) {
      /**
       * 自用（吞吐修复 2026-10-09）：worker **卡住**也算"这个 worker 废了"，只重启它，
       * 不再整池退 CPU。原来 DML 分支直接 `failGpuPool()` —— 一个卡住的 worker
       * 就能把整轮从 14~18 张/秒拉到 3 张/秒（实测日志正是这样）。
       * 现在：拒绝本批（带 provider 错误）→ 交给上层重试；`handleWorkerDeath`
       * 会把它标记死亡并原地重启，其余 worker 继续干活。
       */
      const rej = slot.pendingReject;
      slot.pendingResolve = null;
      slot.pendingReject = null;
      console.warn(
        `[Pool] Worker ${slot.index} 超时（${WORKER_TIMEOUT}ms），杀掉并重启该 worker`
      );
      slot.process.kill();
      rej(
        poolExecutionProvider === "directml"
          ? new EmbeddingProviderError(
              `DirectML worker ${slot.index} timed out during embedding`
            )
          : new Error(`Worker ${slot.index} timed out`)
      );
      handleWorkerDeath(slot);
    }
  }, WORKER_TIMEOUT);

  slot.process.send({
    type: "embed",
    photos,
  });
}

/**
 * 自用（吞吐修复 2026-10-09）：等一个"活着且初始化完成"的 worker。
 *
 * 用于"本批因 GPU worker 死亡而失败 → 换一个健康 worker 重试"。原地重启一个
 * DirectML worker 需要重新加载模型（1~3 秒），所以这里轮询等待，而不是立刻放弃。
 * 返回 false 表示等超时或整池已无救（调用方据此走 CPU 兜底）。
 */
async function waitForHealthySlot(
  timeoutMs: number,
  shouldCancel?: () => boolean
): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    // "idle" 才是真正可以立刻派活的状态（initializing/busy 都不算）
    if (slots.some((s) => s.status === "idle")) {
      return true;
    }
    if (!slots.some((s) => s.status !== "dead")) {
      return false;
    }
    if (shouldCancel?.() || Date.now() - started > timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function createPoolKey(
  adapter: SerializedWorkerAdapter,
  executionProvider: EmbeddingExecutionProvider
): string {
  return JSON.stringify({
    adapterId: adapter.adapterId,
    fingerprint: adapter.fingerprint,
    modelRoot: adapter.modelRoot,
    executionProvider,
  });
}

export async function resolveEmbeddingExecutionProvider(
  mp: string,
  useGPU: boolean
): Promise<EmbeddingExecutionProvider> {
  if (!useGPU || process.platform !== "win32" || process.arch !== "x64") {
    return "cpu";
  }
  try {
    // 先确定"用哪块显卡"（没有缓存时补跑一次轻量探测），再拿这个序号去探图像嵌入。
    // 这样双显卡笔记本不会把 DirectML 落在核显上。
    const deviceId = await resolveDmlDeviceId(mp);
    const result = await probeEmbeddingGpuCapability(mp, deviceId);
    // 把真实结论写回缓存，免得界面还显示旧的"使用 CPU"。
    recordEmbeddingProbeResult(result.dmlAvailable, deviceId, result.error);
    if (result.dmlAvailable) {
      console.log(
        `[Pool] SigLIP DirectML probe passed in ${result.probeTimeMs}ms (deviceId=${deviceId ?? "default"})`
      );
      return "directml";
    }
    console.warn(
      `[Pool] SigLIP DirectML unavailable; using CPU: ${result.error || "unknown reason"}`
    );
  } catch (error) {
    console.warn(
      `[Pool] SigLIP DirectML probe failed; using CPU: ${getErrorMessage(error)}`
    );
  }
  return "cpu";
}

async function startWorkerPool(
  mp: string,
  executionProvider: EmbeddingExecutionProvider,
  key: string
): Promise<void> {
  const generation = ++poolGeneration;
  modelPath = mp;
  workerAdapter = getActiveEmbeddingWorkerAdapter(mp);
  poolUseGPU = executionProvider === "directml";
  poolExecutionProvider = executionProvider;
  // 用探测阶段挑出的独立显卡序号；取不到就交给 DirectML 用默认适配器。
  poolDeviceId =
    executionProvider === "directml" ? getDmlDeviceId() : null;
  gpuProviderFailure = null;
  // 新一代池：GPU worker 死亡计数从零开始（见 MAX_DEAD_WORKER_FAILURES）
  deadWorkerFailures = 0;
  slots = [];
  requestQueue = [];
  workerInitProgress.clear();

  const config = resolveEmbedPoolConfig(
    os.cpus().length,
    executionProvider === "directml"
  );
  /**
   * 自用（多卡）：一张卡一个 worker。
   *
   * 关键取舍（用户明确要求"一张卡只分一个 worker"，因为实测同卡多开会互相踩）：
   *   · 多卡模式**关闭** → 沿用原来的并发数（单卡多 worker 对 SigLIP 有意义：
   *     它算子轻，多 worker 用来把 CPU 预处理与 GPU 推理叠起来）；
   *   · 多卡模式**开启** → **一卡一个 worker**：
   *       - 勾了 1 张卡 → 就只开 1 个（**不能**按原并发数开 2 个，那会在同一张卡上互踩）；
   *       - 勾了 N 张卡 → 开 N 个，每个绑一张。
   * 另外只要解析出的设备列表里出现**重复设备**（例如 `AI_EMBED_WORKERS` 被调大），
   * 也强制串行化 —— 见 `poolDevicesAreShared`。
   */
  const multiGpuOn = executionProvider === "directml" && isMultiGpuEnabled();
  poolDevices =
    executionProvider === "directml" ? resolveWorkerDevices() : [];
  poolDevicesAreShared = hasDuplicatedWorkerDevice(poolDevices);
  if (multiGpuOn) {
    poolSize = Math.max(1, Math.min(poolDevices.length, MAX_MULTI_GPU_DEVICES));
  } else {
    // 每个 worker ~200MB；单卡时沿用原并发数
    poolSize = config.workers;
  }
  poolSize = Math.max(1, Math.min(poolSize, MAX_MULTI_GPU_DEVICES));
  // 自用：批量与 ORT 线程数直接用配置值（原「占用限制」滑块的缩放已整体删除）
  poolBatchSize = config.batchSize;
  poolIntraOpNumThreads = config.intraOpNumThreads;
  const workerScript = findWorkerScript();
  console.log(
    `[Pool] Starting ${poolSize} persistent workers (provider=${poolExecutionProvider}, ${poolIntraOpNumThreads} ORT threads each, batch=${poolBatchSize}): ${workerScript}`
  );

  const readyPromises: Promise<void>[] = [];

  for (let i = 0; i < poolSize; i++) {
    const slot = spawnWorker(i, generation);
    // 多卡：第 i 个 worker 绑定第 i 张卡（超出部分复用最后一张）
    slot.deviceId =
      poolDevices.length > 0
        ? (poolDevices[Math.min(i, poolDevices.length - 1)] ?? null)
        : poolDeviceId;
    slots.push(slot);

    readyPromises.push(
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Worker ${i} init timed out`));
        }, 60_000);

        const check = setInterval(() => {
          if (slot.status === "idle") {
            clearInterval(check);
            clearTimeout(timer);
            resolve();
          } else if (slot.status === "dead") {
            clearInterval(check);
            clearTimeout(timer);
            reject(new Error(`Worker ${i} died during init`));
          }
        }, 50);
      })
    );
  }

  // Send init to all workers
  for (const slot of slots) {
    slot.process.send({
      type: "init",
      adapter: workerAdapter,
      execution: {
        provider: poolExecutionProvider,
        // 多卡：用这个 worker 自己绑定的卡
        deviceId: slot.deviceId ?? poolDeviceId ?? undefined,
        intraOpNumThreads: poolIntraOpNumThreads,
      },
    });
  }

  try {
    await Promise.all(readyPromises);
    if (generation !== poolGeneration) {
      throw new Error("Worker pool initialization superseded");
    }
    console.log(`[Pool] All ${poolSize} workers ready`);
    initialized = true;
    activePoolKey = key;
  } catch (error) {
    if (generation === poolGeneration) {
      initialized = false;
      activePoolKey = null;
      for (const slot of slots) {
        slot.status = "dead";
        try {
          slot.process.kill();
        } catch {
          /* best-effort */
        }
      }
      slots = [];
      workerInitProgress.clear();
    }
    throw error;
  }
}

/** Start the persistent worker pool exactly once for a given configuration. */
export function initWorkerPool(mp: string, useGPU = false): Promise<void> {
  const adapter = getActiveEmbeddingWorkerAdapter(mp);
  const requestedProvider: EmbeddingExecutionProvider = useGPU
    ? "directml"
    : "cpu";
  const requestedKey = createPoolKey(adapter, requestedProvider);

  if (
    initialized &&
    activePoolKey === requestedKey &&
    slots.some((slot) => slot.status !== "dead")
  ) {
    return Promise.resolve();
  }

  if (initializationPromise) {
    if (initializationKey === requestedKey) {
      return initializationPromise;
    }
    return initializationPromise
      .catch(() => undefined)
      .then(() => initWorkerPool(mp, useGPU));
  }

  if (initialized || slots.length > 0) {
    shutdownPool();
  }

  initializationKey = requestedKey;
  if (!useGPU || process.platform !== "win32") {
    const pending = startWorkerPool(
      mp,
      "cpu",
      createPoolKey(adapter, "cpu")
    ).finally(() => {
      if (initializationPromise === pending) {
        initializationPromise = null;
        initializationKey = null;
      }
    });
    initializationPromise = pending;
    return pending;
  }

  const pending = (async () => {
    const executionProvider = await resolveEmbeddingExecutionProvider(
      mp,
      useGPU
    );
    const key = createPoolKey(adapter, executionProvider);

    if (
      initialized &&
      activePoolKey === key &&
      slots.some((slot) => slot.status !== "dead")
    ) {
      return;
    }

    if (initialized || slots.length > 0) {
      shutdownPool();
    }

    try {
      await startWorkerPool(mp, executionProvider, key);
    } catch (error) {
      if (executionProvider !== "directml") {
        throw error;
      }

      console.warn(
        `[Pool] DirectML worker initialization failed; restarting with CPU: ${getErrorMessage(error)}`
      );
      shutdownPool();
      await startWorkerPool(mp, "cpu", createPoolKey(adapter, "cpu"));
    }
  })().finally(() => {
    if (initializationPromise === pending) {
      initializationPromise = null;
      initializationKey = null;
    }
  });
  initializationPromise = pending;
  return pending;
}

/** Send a batch of photos to an available worker for embedding. */
/**
 * 自用（多卡·安全闸 2026-10-09）：当多个 worker 落在**同一张卡**上时，
 * 把批次派发**串行化**，避免"同卡并发互相踩"。
 *
 * 实测依据：同一张卡上 2 个 worker 并发只有 0.82 张/秒，而 1 个是 1.70 张/秒。
 * 触发场景：`AI_EMBED_WORKERS` 被调大、或 worker 数 > 卡数。
 */
let dispatchChain: Promise<unknown> = Promise.resolve();

function dispatchBatch(
  photos: Array<{ id: number; path: string }>
): Promise<EmbedResult[]> {
  if (!poolDevicesAreShared) {
    return dispatchBatchNow(photos);
  }
  const run = dispatchChain.then(
    () => dispatchBatchNow(photos),
    () => dispatchBatchNow(photos)
  );
  dispatchChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function dispatchBatchNow(
  photos: Array<{ id: number; path: string }>
): Promise<EmbedResult[]> {
  return new Promise((resolve, reject) => {
    // Auto-reinitialize if pool is dead
    if (!initialized || slots.every((s) => s.status === "dead")) {
      if (!modelPath) {
        reject(new Error("Worker pool not initialized and no model path"));
        return;
      }
      initWorkerPool(modelPath, poolUseGPU)
        .then(() => {
          const idleSlot = slots.find((s) => s.status === "idle");
          if (idleSlot) {
            dispatchToSlot(idleSlot, photos, resolve, reject);
          } else {
            requestQueue.push({ photos, resolve, reject });
          }
        })
        .catch(reject);
      return;
    }

    const idleSlot = slots.find((s) => s.status === "idle");
    if (idleSlot) {
      dispatchToSlot(idleSlot, photos, resolve, reject);
    } else {
      requestQueue.push({ photos, resolve, reject });
    }
  });
}

/** Send abort signal to all running workers (best-effort mid-batch interrupt). */
export function abortAllWorkers(): void {
  for (const slot of slots) {
    try {
      slot.process.send({ type: "abort" });
    } catch {
      /* ignore */
    }
  }
}

/** Shut down all workers gracefully. */
export function shutdownPool(): void {
  const oldSlots = slots;
  const shutdownError = new Error("Worker pool shut down");

  // Detach the old generation immediately. This lets a new initialization
  // start safely during the grace period and makes old exit events inert.
  poolGeneration++;
  slots = [];
  initialized = false;
  activePoolKey = null;
  gpuProviderFailure = null;
  initializationPromise = null;
  initializationKey = null;
  workerInitProgress.clear();
  for (const request of requestQueue) {
    request.reject(shutdownError);
  }
  requestQueue = [];

  // Send abort first so workers can stop mid-batch if idle enough
  // to receive the message, then send shutdown + kill.
  for (const slot of oldSlots) {
    if (slot.timeoutId) {
      clearTimeout(slot.timeoutId);
      slot.timeoutId = null;
    }
    const reject = slot.pendingReject;
    slot.pendingResolve = null;
    slot.pendingReject = null;
    slot.status = "dead";
    reject?.(shutdownError);
    try {
      slot.process.send({ type: "abort" });
    } catch {
      /* ignore */
    }
  }
  // Small grace period for abort messages to be processed
  const killAll = () => {
    for (const slot of oldSlots) {
      try {
        slot.process.kill();
      } catch {
        /* ignore */
      }
    }
  };
  // Give workers a brief chance to process abort, then kill
  setTimeout(killAll, 500);
}

/** Aggregate init progress across all workers (0-100). Returns 0 if no workers have reported yet. */
export function getPoolInitProgress(): number {
  if (slots.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const slot of slots) {
    sum += workerInitProgress.get(slot.index) ?? 0;
  }
  return Math.round(sum / slots.length);
}

export function isPoolReady(): boolean {
  return (
    initialized && slots.some((s) => s.status === "idle" || s.status === "busy")
  );
}

export function getPoolHealth(): {
  alive: number;
  busy: number;
  idle: number;
  dead: number;
  queueLength: number;
} {
  return {
    alive: slots.filter((s) => s.status !== "dead").length,
    busy: slots.filter((s) => s.status === "busy").length,
    idle: slots.filter((s) => s.status === "idle").length,
    dead: slots.filter((s) => s.status === "dead").length,
    queueLength: requestQueue.length,
  };
}

export async function embedSingleImage(
  imagePath: string,
  mp: string
): Promise<number[]> {
  if (!initialized || slots.every((s) => s.status === "dead")) {
    await initWorkerPool(mp, poolUseGPU);
  }
  const results = await dispatchBatch([{ id: 0, path: imagePath }]);
  const result = results[0];
  if (result?.vector && result.vector.length > 0) {
    return result.vector;
  }
  throw new Error(result?.error || "Empty vector from pool");
}

/**
 * Embed all given photos using the persistent worker pool.
 * Returns the full results array with vectors for persistence.
 */
export async function embedWithPool(
  photos: Array<{ id: number; path: string }>,
  onProgress?: (processed: number, total: number) => void,
  shouldCancel?: () => boolean,
  onBatchResults?: EmbedBatchResultCallback
): Promise<EmbedResult[]> {
  if (!initialized) {
    throw new Error("Worker pool not initialized");
  }

  const total = photos.length;
  const aliveCount = slots.filter((s) => s.status !== "dead").length;
  const concurrency = Math.min(poolSize, aliveCount);
  if (concurrency < 1) {
    throw new Error("Worker pool has no live workers");
  }

  // 预切批次
  const batchList: Array<Array<{ id: number; path: string }>> = [];
  for (let i = 0; i < photos.length; i += poolBatchSize) {
    batchList.push(photos.slice(i, i + poolBatchSize));
  }

  const allResults: EmbedResult[] = [];
  let processed = 0;
  let cursor = 0;
  let callbackChain = Promise.resolve();

  async function publishBatchResults(
    results: EmbedResult[],
    batch: Array<{ id: number; path: string }>
  ): Promise<void> {
    if (!onBatchResults) {
      return;
    }
    const next = callbackChain.then(() => onBatchResults(results, batch));
    callbackChain = next.then(
      () => undefined,
      () => undefined
    );
    await next;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: scheduling loop keeps cancellation, retry, progress, and callback ordering together.
  async function worker(): Promise<void> {
    while (cursor < batchList.length) {
      if (shouldCancel?.()) {
        break;
      }
      const idx = cursor++;
      if (idx >= batchList.length) {
        break;
      }
      if (shouldCancel?.()) {
        break;
      }
      const batch = batchList[idx];
      try {
        /**
         * 自用（吞吐修复 2026-10-09）：本批因 GPU worker 死亡/超时失败时，
         * **不立刻整池退 CPU**，而是等一个健康的 worker 重试本批（最多 BATCH_RETRY_LIMIT 次）。
         * 这样一次 worker 崩溃只损失一批，不会让整轮掉到 CPU 速度。
         */
        let results = await dispatchBatch(batch);
        allResults.push(...results);
        await publishBatchResults(results, batch);
      } catch (err: unknown) {
        let finalError = err;
        if (isEmbeddingProviderError(err)) {
          for (let attempt = 1; attempt <= BATCH_RETRY_LIMIT; attempt++) {
            const healthy = slots.some((s) => s.status !== "dead");
            if (!healthy || shouldCancel?.()) {
              break;
            }
            console.warn(
              `[Pool] 本批因 GPU worker 故障失败，第 ${attempt}/${BATCH_RETRY_LIMIT} 次重试（换健康 worker）`
            );
            const waited = await waitForHealthySlot(RETRY_SLOT_WAIT_MS, shouldCancel);
            if (!waited) {
              break;
            }
            try {
              const retryResults = await dispatchBatch(batch);
              allResults.push(...retryResults);
              await publishBatchResults(retryResults, batch);
              finalError = null;
              break;
            } catch (retryErr: unknown) {
              finalError = retryErr;
              if (!isEmbeddingProviderError(retryErr)) {
                break;
              }
            }
          }
        }
        if (finalError === null) {
          processed += batch.length;
          onProgress?.(Math.min(processed, total), total);
          continue;
        }
        const errToHandle = finalError;
        if (isEmbeddingProviderError(errToHandle)) {
          throw errToHandle;
        }
        const message = getErrorMessage(errToHandle);
        console.warn(`[Pool] Batch failed: ${message}`);
        // If cancelled, don't retry — just mark failed and move on
        let fallbackResults: EmbedResult[];
        if (shouldCancel?.()) {
          fallbackResults = batch.map((p) => ({
            id: p.id,
            error: "cancelled",
          }));
        } else if (batch.length > 1) {
          const left = await processResultsFallback(
            batch.slice(0, Math.floor(batch.length / 2))
          );
          const right = await processResultsFallback(
            batch.slice(Math.floor(batch.length / 2))
          );
          fallbackResults = [...left, ...right];
        } else {
          fallbackResults = [{ id: batch[0].id, error: message }];
        }
        allResults.push(...fallbackResults);
        await publishBatchResults(fallbackResults, batch);
      }
      processed += batch.length;
      onProgress?.(Math.min(processed, total), total);
    }
  }

  // 启动 poolSize 个并发调度 worker
  const workers = Array.from({ length: concurrency }, () => worker());
  try {
    await Promise.all(workers);
  } catch (error) {
    // A provider failure can happen while a previous batch's persistence
    // callback is still running. Wait for that callback before the caller
    // deletes partial vectors and starts the CPU retry.
    await callbackChain;
    throw error;
  }
  await callbackChain;

  return allResults;
}

async function processResultsFallback(
  batch: Array<{ id: number; path: string }>
): Promise<EmbedResult[]> {
  if (batch.length === 0) {
    return [];
  }
  try {
    return await dispatchBatch(batch);
  } catch (err: unknown) {
    if (isEmbeddingProviderError(err)) {
      throw err;
    }
    const message = getErrorMessage(err);
    if (batch.length === 1) {
      console.warn(
        `[Pool] Skipping corrupted photo ${batch[0].id}: ${message}`
      );
      return [{ id: batch[0].id, error: message }];
    }
    const mid = Math.floor(batch.length / 2);
    const left = await processResultsFallback(batch.slice(0, mid));
    const right = await processResultsFallback(batch.slice(mid));
    return [...left, ...right];
  }
}
