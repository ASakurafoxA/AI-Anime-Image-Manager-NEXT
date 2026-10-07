/**
 * WD14 动漫标签 worker 客户端（自用新增）。
 *
 * 设计取舍：用**单个常驻 worker**，而不是像 SigLIP / 人脸那样开多 worker 的 pool。
 * 原因：WD14 的 ViT-B/448 模型单个进程常驻内存就不小（模型文件 361 MB），
 * 多开几个会让内存成倍上涨；而实测单进程 CPU 速度已有 0.23 秒/张，
 * 配合"后台慢慢跑 + 可中断"，单 worker 是稳妥的默认。
 * 若将来需要提速，把 `WORKER_COUNT` 调大即可 —— 请求会按空闲槽位分发。
 *
 * 协议见 `scripts/wd14-tagger-worker.mjs` 头部注释。
 */
import type { ChildProcess } from "node:child_process";
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { PRIVATE_BUILD } from "@/config/private-build";
import { createLogger } from "@/utils/logger";

const log = createLogger("wd14-tagger");

/** 同时常驻的 worker 数量。1 = 最省内存；2–3 可提速但内存成倍。 */
const WORKER_COUNT = 1;
/** 单批超时（毫秒）。批量推理远比 SigLIP 慢，给足余量。 */
const BATCH_TIMEOUT_MS = 300_000;

export interface Wd14Tag {
  /** 标签名（英文 / 罗马字，与 selected_tags.csv 一致） */
  name: string;
  /** 0=general，4=character（9=rating，本版不采集） */
  category: number;
  score: number;
}

export interface Wd14PhotoResult {
  id: number;
  tags?: Wd14Tag[];
  /** 768 维动漫特征（L2 归一化，保留 5 位小数），仅当 includeEmbedding 时返回 */
  embedding?: number[];
  error?: string;
}

export interface Wd14TagRequest {
  id: number;
  path: string;
}

export interface Wd14TagOptions {
  generalThreshold?: number;
  characterThreshold?: number;
  includeEmbedding?: boolean;
}

interface WorkerSlot {
  process: ChildProcess;
  index: number;
  ready: boolean;
  dead: boolean;
}

interface PendingBatch {
  resolve: (results: Wd14PhotoResult[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

let slots: WorkerSlot[] = [];
let slotPending = new Map<number, PendingBatch>();
let initPromise: Promise<void> | null = null;
let resolvedModelsDir = "";
let resolvedUseGpu = false;
let shuttingDown = false;

function findWorkerScript(): string {
  const fileName = "wd14-tagger-worker.mjs";
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
  const cwd = process.cwd();
  const candidate = path.join(cwd, "scripts", fileName);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const alt = path.join(app.getAppPath(), "scripts", fileName);
  if (fs.existsSync(alt)) {
    return alt;
  }
  throw new Error(`${fileName} not found`);
}

/** WD14 模型是否已就位（缺文件时直接给出清晰原因，而不是让 worker 报错）。 */
export function isWd14ModelAvailable(modelsDir: string): boolean {
  const dir = path.join(modelsDir, "SmilingWolf", "wd-vit-tagger-v3");
  return (
    fs.existsSync(path.join(dir, "model.onnx")) &&
    fs.existsSync(path.join(dir, "selected_tags.csv"))
  );
}

function failSlot(index: number, error: Error): void {
  const pending = slotPending.get(index);
  if (pending) {
    clearTimeout(pending.timer);
    slotPending.delete(index);
    pending.reject(error);
  }
}

function handleWorkerExit(slot: WorkerSlot, code: number | null): void {
  slot.dead = true;
  slot.ready = false;
  failSlot(
    slot.index,
    new Error(`WD14 worker ${slot.index} exited (code ${code ?? "null"})`)
  );
  log.warn({ index: slot.index, code }, "WD14 worker exited");
}

function spawnSlot(index: number): WorkerSlot {
  const script = findWorkerScript();
  const child = fork(script, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const slot: WorkerSlot = {
    process: child,
    index,
    ready: false,
    dead: false,
  };

  child.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      log.warn({ index }, text);
    }
  });

  child.on("message", (raw: unknown) => {
    const message = raw as {
      type?: string;
      error?: string;
      provider?: string;
      results?: Wd14PhotoResult[];
    };
    if (message.type === "ready") {
      slot.ready = true;
      return;
    }
    if (message.type === "result") {
      const pending = slotPending.get(index);
      if (pending) {
        clearTimeout(pending.timer);
        slotPending.delete(index);
        pending.resolve(message.results ?? []);
      }
      return;
    }
    if (message.type === "init-error" || message.type === "provider-error") {
      slot.ready = false;
      failSlot(index, new Error(message.error ?? "WD14 worker error"));
    }
  });

  child.on("exit", (code) => handleWorkerExit(slot, code));
  child.on("error", (error) => {
    failSlot(index, error instanceof Error ? error : new Error(String(error)));
    handleWorkerExit(slot, null);
  });

  return slot;
}

function waitForReady(slot: WorkerSlot, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (slot.ready) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (slot.dead || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`WD14 worker ${slot.index} 初始化超时或已退出`));
      }
    }, 100);
  });
}

/**
 * 启动 worker 并加载模型。可重复调用（已就绪时直接返回）。
 *
 * @param modelsDir `<dataPath>/models`
 * @param useGpu    true 时尝试 DirectML，失败自动退回 CPU（由 worker 内部处理）
 */
export async function initWd14Tagger(
  modelsDir: string,
  useGpu: boolean
): Promise<void> {
  if (!PRIVATE_BUILD.useWd14Tagger) {
    return;
  }
  if (initPromise) {
    return initPromise;
  }
  resolvedModelsDir = modelsDir;
  resolvedUseGpu = useGpu;
  shuttingDown = false;

  initPromise = (async () => {
    if (!isWd14ModelAvailable(modelsDir)) {
      throw new Error(
        "WD14 模型文件缺失（需要 SmilingWolf/wd-vit-tagger-v3 下的 model.onnx 与 selected_tags.csv）"
      );
    }
    slots = [];
    slotPending = new Map();
    for (let i = 0; i < WORKER_COUNT; i++) {
      const slot = spawnSlot(i);
      slots.push(slot);
      slot.process.send({ type: "init", modelsDir, useGPU: useGpu });
    }
    await Promise.all(slots.map((slot) => waitForReady(slot, 120_000)));
    log.info({ workers: slots.length, useGpu }, "WD14 tagger ready");
  })().catch((error) => {
    initPromise = null;
    shutdownWd14Tagger();
    throw error;
  });

  return initPromise;
}

export function isWd14TaggerReady(): boolean {
  return slots.length > 0 && slots.every((slot) => slot.ready && !slot.dead);
}

/** 取一个空闲且存活的槽位；没有则返回 null。 */
function pickIdleSlot(): WorkerSlot | null {
  for (const slot of slots) {
    if (slot.ready && !slot.dead && !slotPending.has(slot.index)) {
      return slot;
    }
  }
  return null;
}

/** 等一个空闲槽位（用于顺序化多批请求）。 */
async function acquireSlot(timeoutMs = 60_000): Promise<WorkerSlot> {
  const started = Date.now();
  for (;;) {
    const slot = pickIdleSlot();
    if (slot) {
      return slot;
    }
    if (!isWd14TaggerReady()) {
      throw new Error("WD14 tagger 未就绪");
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待 WD14 空闲 worker 超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * 对一批照片打标签。
 *
 * ⚠️ 一定要传**缩略图路径**而不是原图：项目缩略图是 512px（`thumbnailer.ts`），
 * 而 WD14 只需要 448px —— 用缩略图可避免重读 200 GB 原图。
 */
export async function tagPhotoBatch(
  photos: Wd14TagRequest[],
  options: Wd14TagOptions = {}
): Promise<Wd14PhotoResult[]> {
  if (photos.length === 0) {
    return [];
  }
  const slot = await acquireSlot();
  return new Promise<Wd14PhotoResult[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      slotPending.delete(slot.index);
      // 超时的 worker 视为不可用，杀掉让下次重新拉起
      slot.process.kill();
      reject(new Error(`WD14 批次超时（${BATCH_TIMEOUT_MS} ms）`));
    }, BATCH_TIMEOUT_MS);
    slotPending.set(slot.index, { resolve, reject, timer });
    slot.process.send({
      type: "tag",
      photos,
      thresholds: {
        general: options.generalThreshold,
        character: options.characterThreshold,
      },
      includeEmbedding: Boolean(options.includeEmbedding),
    });
  });
}

/** 请求中止当前批次（worker 会在当前图片处理完后停止）。 */
export function abortWd14Tagger(): void {
  for (const slot of slots) {
    try {
      slot.process.send({ type: "abort" });
    } catch {
      /* 进程可能已退出 */
    }
  }
}

export function shutdownWd14Tagger(): void {
  shuttingDown = true;
  for (const slot of slots) {
    try {
      slot.process.send({ type: "shutdown" });
    } catch {
      /* ignore */
    }
    slot.process.kill();
  }
  slots = [];
  for (const index of [...slotPending.keys()]) {
    failSlot(index, new Error("WD14 tagger 已关闭"));
  }
  slotPending = new Map();
  initPromise = null;
}

/** 供诊断面板使用。 */
export function getWd14TaggerState(): {
  enabled: boolean;
  modelsDir: string;
  useGpu: boolean;
  workers: number;
  ready: boolean;
  shuttingDown: boolean;
} {
  return {
    enabled: PRIVATE_BUILD.useWd14Tagger,
    modelsDir: resolvedModelsDir,
    useGpu: resolvedUseGpu,
    workers: slots.length,
    ready: isWd14TaggerReady(),
    shuttingDown,
  };
}
