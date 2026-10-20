/**
 * CCIP 特征抽取客户端：worker 池 + 批次分发（NEXT 版新增）。
 *
 * 为什么用**多进程池**而不是单进程多线程：
 *   实测 CCIP（caformer_b36，384×384）单进程 8 线程约 3 张/秒；
 *   而实验阶段 12 个进程各 1 线程能跑满 CPU、吞吐高得多。全库 7.7 万张
 *   只有多进程并行才能在"可接受的时间"内算完。
 *
 * 设计（保持简单可靠，不引入 pixai 那套槽位协议）：
 *   · fork N 个 `scripts/ccip-embed-worker.mjs`；
 *   · 照片切成固定大小的批次（默认 8 张）放进共享队列；
 *   · 每个 worker 空下来就领下一批，结果经 `onBatch` 回调**边算边写**；
 *   · 支持中途取消（`signal`）：当前批次跑完即停，已完成的不丢。
 */
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

/**
 * 默认批次大小。
 *
 * 权衡（实测）：批次越大 → LanceDB 写入次数越少（旧版本/碎片越少），
 * 但进度更新与取消响应越迟钝。8 张时全库要写 ~9650 次（碎片太多 ✗）；
 * 24 张时约 3200 次，而进度仍是每几秒一次 ✓。
 */
const DEFAULT_BATCH_SIZE = 24;
/**
 * worker 数硬上限（避免把机器打满到无法操作）。
 *
 * 自用（2026-10-18 · 会话#9）：**12 → 24** ✓
 * 原来是 12，而"每卡进程数"是按卡乘的：2 张卡 × 6 = 12 刚好卡满，
 * **3 张卡 × 6 = 18 会被悄悄截断**（第三张卡分不到应有的份额）✗
 * 现在 24 = 最多 3 张卡（`MAX_MULTI_GPU_DEVICES`）× 每卡最多 8 个 ✓
 */
const MAX_WORKERS = 24;

export interface CcipEmbedPhoto {
  id: number;
  path: string;
}

export interface CcipEmbedOptions {
  /** `<图库>/models` */
  modelsDir: string;
  photos: CcipEmbedPhoto[];
  /** 并行 worker 数（默认按 CPU 核数推算，上限 12）。 */
  workers?: number;
  /** 每个 worker 的 onnxruntime 线程数（默认 1；多进程时 1 最划算）。 */
  threadsPerWorker?: number;
  /** 每批张数（默认 8）。 */
  batchSize?: number;
  /**
   * 自用（2026-10-17，实测 6.4 倍）：**推理后端**。
   *   · `"dml"` = DirectML（显卡），实测 **15.5 张/秒 vs CPU 4 线程 2.43 张/秒**（同一批 40 张，输出余弦 1.000000）；
   *   · `"cpu"` = 老行为（多进程 × 1 线程，实测合计 3.7 张/秒）。
   * 单进程 GPU 就比 12 进程 CPU 快 4 倍，所以 GPU 时**一卡一个进程**即可 ✓
   */
  provider?: "cpu" | "dml";
  /** `provider="dml"` 时每个 worker 用的适配器序号（多卡时一卡一个 worker）✓ */
  deviceIds?: Array<number | null>;
  /** 每批算完就回调（用于立即落库，避免全量结果堆在内存里）。 */
  onBatch?: (
    entries: Array<{ photoId: number; vector: number[] }>
  ) => Promise<void> | void;
  /** 进度回调（done/total/embedded/failed）。 */
  onProgress?: (progress: CcipEmbedProgress) => void;
  /**
   * 自用（2026-10-18 · 会话#9）：**启动阶段**的可见性。
   * 每个进程都要各自加载一次模型（几秒），N 个进程并行加载时界面会"安静"十几秒 ✗
   * → 这里把"已就绪几个 / 一共几个"报出去，进度条就能显示「正在启动识别进程 2/4…」✓
   */
  onWorkerReady?: (ready: number, total: number) => void;
  /** 全部进程就绪、真正开始算第一张（此时才开始计时，速度里不含启动耗时）。 */
  onStarted?: () => void;
  /** 取消信号。 */
  signal?: AbortSignal;
  /** 每张图失败时回调（诊断用，可选）。 */
  onPhotoError?: (photoId: number, error: string) => void;
}

export interface CcipEmbedProgress {
  done: number;
  total: number;
  embedded: number;
  failed: number;
}

export interface CcipEmbedResult extends CcipEmbedProgress {
  cancelled: boolean;
  workers: number;
  elapsedMs: number;
}

function findWorkerScript(): string {
  const fileName = "ccip-embed-worker.mjs";
  if (app.isPackaged) {
    const unpacked = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "scripts",
      fileName
    );
    if (fs.existsSync(unpacked)) {
      return unpacked;
    }
    const bundled = path.join(process.resourcesPath, "scripts", fileName);
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }
  const candidate = path.join(process.cwd(), "scripts", fileName);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const alt = path.join(app.getAppPath(), "scripts", fileName);
  if (fs.existsSync(alt)) {
    return alt;
  }
  throw new Error(`${fileName} not found`);
}

/** 默认 worker 数：核数 − 1，至少 1，最多 MAX_WORKERS。 */
function defaultWorkerCount(): number {
  try {
    return Math.max(1, Math.min(MAX_WORKERS, os.cpus().length - 1));
  } catch {
    return 2;
  }
}

interface WorkerHandle {
  child: ChildProcess;
  ready: boolean;
  exitCode: number | null;
  stderrTail: string;
}

/** 等 worker 报 ready（或 init-error / 退出）。返回 ready 消息（含实际 provider）。 */
function waitForReady(
  handle: WorkerHandle,
  modelsDir: string,
  threads: number,
  provider: "cpu" | "dml" = "cpu",
  deviceId: number | null = null
): Promise<{ provider?: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("CCIP worker 初始化超时（120s）"));
    }, 120_000);

    const onMessage = (message: unknown) => {
      const msg = message as { type?: string; error?: string; provider?: string };
      if (msg?.type === "ready") {
        cleanup();
        handle.ready = true;
        resolve({ provider: msg.provider });
      } else if (msg?.type === "init-error") {
        cleanup();
        reject(new Error(`CCIP worker 初始化失败：${msg.error ?? "未知原因"}`));
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `CCIP worker 初始化期间退出（code ${code ?? "null"}）${handle.stderrTail.trim() ? ` :: ${handle.stderrTail.trim()}` : ""}`
        )
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      handle.child.off("message", onMessage);
      handle.child.off("exit", onExit);
    };

    handle.child.on("message", onMessage);
    handle.child.on("exit", onExit);
    handle.child.send({
      type: "init",
      modelsDir,
      threads,
      provider,
      deviceId: deviceId ?? undefined,
    });
  });
}

/** 让 worker 处理一批，返回结果。 */
function embedBatch(
  handle: WorkerHandle,
  photos: CcipEmbedPhoto[]
): Promise<Array<{ id: number; vector?: number[]; error?: string }>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("CCIP worker 处理批次超时（300s）"));
    }, 300_000);

    const onMessage = (message: unknown) => {
      const msg = message as {
        type?: string;
        results?: Array<{ id: number; vector?: number[]; error?: string }>;
      };
      if (msg?.type === "result" && Array.isArray(msg.results)) {
        cleanup();
        resolve(msg.results);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `CCIP worker 处理中退出（code ${code ?? "null"}）${handle.stderrTail.trim() ? ` :: ${handle.stderrTail.trim()}` : ""}`
        )
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      handle.child.off("message", onMessage);
      handle.child.off("exit", onExit);
    };

    handle.child.on("message", onMessage);
    handle.child.on("exit", onExit);
    handle.child.send({ type: "embed", photos });
  });
}

function spawnWorker(script: string): WorkerHandle {
  const child = fork(script, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const handle: WorkerHandle = {
    child,
    ready: false,
    exitCode: null,
    stderrTail: "",
  };
  child.stderr?.on("data", (chunk: Buffer) => {
    handle.stderrTail = (handle.stderrTail + chunk.toString()).slice(-2000);
  });
  child.on("exit", (code) => {
    handle.exitCode = code;
  });
  return handle;
}

/**
 * 用 CCIP 模型为一批照片算 768 维角色特征。
 *
 * 边算边写：每批完成后立即调用 `onBatch`（调用方负责写库），
 * 因此即使中途取消，已算好的部分不会白费。
 */
export async function embedPhotosWithCcip(
  options: CcipEmbedOptions
): Promise<CcipEmbedResult> {
  const startedAt = Date.now();
  const photos = options.photos ?? [];
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const workerCount = Math.max(
    1,
    Math.min(MAX_WORKERS, options.workers ?? defaultWorkerCount())
  );
  const threads = Math.max(1, options.threadsPerWorker ?? 1);

  const total = photos.length;
  const state: CcipEmbedProgress = { done: 0, total, embedded: 0, failed: 0 };
  let cancelled = false;

  if (total === 0) {
    return { ...state, cancelled: false, workers: 0, elapsedMs: 0 };
  }

  const script = findWorkerScript();
  const batches: CcipEmbedPhoto[][] = [];
  for (let i = 0; i < photos.length; i += batchSize) {
    batches.push(photos.slice(i, i + batchSize));
  }

  let nextBatch = 0;
  const onAbort = () => {
    cancelled = true;
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  /*
   * 自用（2026-10-18 · 会话#9）：**先并行把所有进程起起来，再开始派活** ✓
   *
   * 之前是"每个 worker 自己 init 完就自己开始领活" —— 于是第 1 个进程就绪时
   * 已经在算图，而界面完全不知道"还有 3 个在加载模型"，看起来就是"初始化好慢"✗
   * 现在：全部就绪 → 报一次 onStarted → 才开始派活（速度也从这一刻起算）✓
   */
  const handles: WorkerHandle[] = Array.from({ length: workerCount }, () =>
    spawnWorker(script)
  );

  const shutdownHandle = async (handle: WorkerHandle): Promise<void> => {
    try {
      handle.child.send({ type: "shutdown" });
    } catch {
      /* worker 可能已经退出 */
    }
    const child = handle.child;
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  const shutdownAll = () => Promise.all(handles.map(shutdownHandle));

  try {
    let readyCount = 0;
    let warnedCpuFallback = false;
    await Promise.all(
      handles.map(async (handle, index) => {
        const ready = await waitForReady(
          handle,
          options.modelsDir,
          threads,
          options.provider ?? "cpu",
          options.deviceIds?.[index] ?? null
        );
        /*
         * 自用（2026-10-18 · 会话#9）：**别让"其实没用上显卡"静默发生**。
         * worker 在 DML 初始化失败时会自己回退 CPU —— 那速度差好几倍，
         * 但界面只会显示"慢"。这里至少留一条明确的警告（主进程日志/控制台）。
         */
        if (
          (options.provider ?? "cpu") === "dml" &&
          !String(ready.provider ?? "").startsWith("dml")
        ) {
          if (!warnedCpuFallback) {
            warnedCpuFallback = true;
            console.warn(
              `[CCIP] 有进程没跑在显卡上（provider=${ready.provider}），已回退 CPU，速度会明显变慢`
            );
          }
        }
        readyCount += 1;
        options.onWorkerReady?.(readyCount, workerCount);
      })
    );
    options.onStarted?.();

    const runOneWorker = async (handle: WorkerHandle): Promise<void> => {
      while (!cancelled) {
        const index = nextBatch;
        nextBatch += 1;
        if (index >= batches.length) {
          break;
        }
        const batch = batches[index];
        let results: Array<{ id: number; vector?: number[]; error?: string }>;
        try {
          results = await embedBatch(handle, batch);
        } catch (error) {
          // 这个 worker 不行了：本批整体记失败，让其它 worker 继续。
          const text = error instanceof Error ? error.message : String(error);
          state.failed += batch.length;
          state.done += batch.length;
          for (const photo of batch) {
            options.onPhotoError?.(photo.id, text);
          }
          options.onProgress?.({ ...state });
          return;
        }

        const ok: Array<{ photoId: number; vector: number[] }> = [];
        for (const item of results) {
          if (item.vector && item.vector.length > 0) {
            ok.push({ photoId: item.id, vector: item.vector });
          } else {
            state.failed += 1;
            if (item.error) {
              options.onPhotoError?.(item.id, item.error);
            }
          }
        }
        if (ok.length > 0 && options.onBatch) {
          await options.onBatch(ok);
        }
        state.embedded += ok.length;
        state.done += batch.length;
        options.onProgress?.({ ...state });
      }
    };

    await Promise.all(handles.map((handle) => runOneWorker(handle)));
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await shutdownAll();
  }

  return {
    ...state,
    cancelled,
    workers: workerCount,
    elapsedMs: Date.now() - startedAt,
  };
}