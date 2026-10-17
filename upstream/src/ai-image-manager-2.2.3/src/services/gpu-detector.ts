/**
 * GPU capability detection service (main process).
 *
 * Forks a lightweight gpu-probe.mjs worker to check DirectML availability.
 * Caches the result in app_settings so detection only runs once.
 * Notifies the renderer via webContents.send so the UI can show a
 * one-time onboarding dialog for users whose GPU supports DirectML.
 */

import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { captureWorkerOutput } from "@/services/diagnostics/worker-output";
import { getSetting, setSetting } from "@/services/settings-manager";
import { trackChildProcess } from "@/services/tracked-child-processes";
import { createLogger } from "@/utils/logger";
import { getActiveEmbeddingAdapter } from "./ai/model-adapter";

const log = createLogger("gpu-detector");
const MODEL_PATH_SEPARATOR = /[\\/]/u;

// ── Types ────────────────────────────────────────────────────────────

export interface GpuProbeResult {
  /** 逐个探测过的适配器（界面下拉框用；deviceId + 名字 + 是否可用）。 */
  adapters?: Array<{
    deviceId: number;
    name: string | null;
    ok: boolean;
    error?: string;
    probeTimeMs?: number;
  }>;
  dmlAvailable: boolean;
  /** DirectML 实际使用的适配器序号（null = 用系统默认适配器）。 */
  dmlDeviceId?: number | null;
  embeddingDmlAvailable?: boolean;
  embeddingError?: string;
  embeddingProbeTimeMs?: number;
  error?: string;
  /** 该显卡在 Win32_VideoController 列表里的序号。 */
  gpuIndex?: number | null;
  gpuName?: string;
  probeTimeMs: number;
}

// ── Path resolution (matches face-detector / worker-pool conventions) ──

export function findModelsDir(): string {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "models-release");
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }
  const cwd = process.cwd();
  const candidate = path.join(cwd, "models");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const alt = path.join(app.getAppPath(), "models");
  if (fs.existsSync(alt)) {
    return alt;
  }
  return path.join(cwd, "models");
}

function findProbeScript(scriptName = "gpu-probe.mjs"): string {
  if (app.isPackaged) {
    const unpacked = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "scripts",
      scriptName
    );
    if (fs.existsSync(unpacked)) {
      return unpacked;
    }
    const bundled = path.join(process.resourcesPath, "scripts", scriptName);
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }
  const cwd = process.cwd();
  const candidate = path.join(cwd, "scripts", scriptName);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const alt = path.join(app.getAppPath(), "scripts", scriptName);
  if (fs.existsSync(alt)) {
    return alt;
  }
  throw new Error(`${scriptName} not found`);
}

// ── Detection ────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Fork the gpu-probe worker and wait for its DML availability verdict.
 * The parent enforces a 15 s timeout — if the worker hangs (driver issue),
 * we return dmlAvailable=false rather than blocking indefinitely.
 */
function probeFaceGpuCapability(modelsDir: string): Promise<GpuProbeResult> {
  const scriptPath = findProbeScript("gpu-probe.mjs");

  return new Promise((resolve) => {
    let resolved = false;

    const child = trackChildProcess(
      fork(scriptPath, [], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        timeout: PROBE_TIMEOUT_MS,
      })
    );
    captureWorkerOutput(child, "gpu-probe-worker");

    const timeout = setTimeout(() => {
      if (resolved) {
        return;
      }
      resolved = true;
      child.kill();
      resolve({
        dmlAvailable: false,
        error: "Detection timed out after 15s",
        probeTimeMs: PROBE_TIMEOUT_MS,
      });
    }, PROBE_TIMEOUT_MS);

    child.on(
      "message",
      (msg: {
        adapters?: GpuProbeResult["adapters"];
        type?: string;
        dmlAvailable?: boolean;
        dmlDeviceId?: number | null;
        gpuIndex?: number | null;
        gpuName?: string;
        error?: string;
        probeTimeMs?: number;
      }) => {
        if (msg?.type === "result" && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({
            adapters: Array.isArray(msg.adapters) ? msg.adapters : undefined,
            dmlAvailable: msg.dmlAvailable === true,
            dmlDeviceId:
              typeof msg.dmlDeviceId === "number" ? msg.dmlDeviceId : null,
            gpuIndex: typeof msg.gpuIndex === "number" ? msg.gpuIndex : null,
            gpuName: msg.gpuName,
            error: msg.error,
            probeTimeMs: msg.probeTimeMs ?? 0,
          });
        }
      }
    );

    child.on("exit", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          dmlAvailable: false,
          error: "Probe worker exited unexpectedly",
          probeTimeMs: 0,
        });
      }
    });

    child.send({ type: "probe", modelsDir });
  });
}

export interface EmbeddingGpuProbeResult {
  dmlAvailable: boolean;
  error?: string;
  probeTimeMs: number;
}

const EMBEDDING_PROBE_TIMEOUT_MS = 30_000;

function sanitizeEmbeddingProbeError(error: string, modelsDir: string): string {
  return error.replaceAll(modelsDir, "<models>");
}

/** Probe the actual SigLIP vision model in an isolated process. */
export function probeEmbeddingGpuCapability(
  modelsDir: string,
  deviceId: number | null = null
): Promise<EmbeddingGpuProbeResult> {
  let scriptPath: string;
  let image: ReturnType<
    typeof getActiveEmbeddingAdapter
  >["embeddingSpace"]["image"];
  try {
    scriptPath = findProbeScript("embedding-gpu-probe.mjs");
    image = getActiveEmbeddingAdapter().embeddingSpace.image;
  } catch (error) {
    return Promise.resolve({
      dmlAvailable: false,
      error: error instanceof Error ? error.message : String(error),
      probeTimeMs: 0,
    });
  }
  const modelPath = path.join(
    modelsDir,
    ...image.modelRelativePath.split(MODEL_PATH_SEPARATOR)
  );

  return new Promise((resolve) => {
    let resolved = false;
    const child = trackChildProcess(
      fork(scriptPath, [], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        timeout: EMBEDDING_PROBE_TIMEOUT_MS,
      })
    );
    captureWorkerOutput(child, "embedding-gpu-probe-worker");

    const timeout = setTimeout(() => {
      if (resolved) {
        return;
      }
      resolved = true;
      child.kill();
      resolve({
        dmlAvailable: false,
        error: `Embedding detection timed out after ${EMBEDDING_PROBE_TIMEOUT_MS}ms`,
        probeTimeMs: EMBEDDING_PROBE_TIMEOUT_MS,
      });
    }, EMBEDDING_PROBE_TIMEOUT_MS);

    child.on(
      "message",
      (msg: {
        type?: string;
        dmlAvailable?: boolean;
        error?: string;
        probeTimeMs?: number;
      }) => {
        if (msg?.type !== "result" || resolved) {
          return;
        }
        resolved = true;
        clearTimeout(timeout);
        resolve({
          dmlAvailable: msg.dmlAvailable === true,
          error: msg.error
            ? sanitizeEmbeddingProbeError(msg.error, modelsDir)
            : undefined,
          probeTimeMs: msg.probeTimeMs ?? 0,
        });
        child.kill();
      }
    );

    child.on("exit", () => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      resolve({
        dmlAvailable: false,
        error: "Embedding probe worker exited unexpectedly",
        probeTimeMs: 0,
      });
    });

    child.on("error", (error) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      resolve({
        dmlAvailable: false,
        error: error.message,
        probeTimeMs: 0,
      });
    });

    child.send({
      type: "probe",
      deviceId: deviceId ?? undefined,
      imageSize: image.imageSize,
      inputName: image.inputName,
      modelPath,
    });
  });
}

export async function probeGpuCapability(
  modelsDir: string
): Promise<GpuProbeResult> {
  // ⚠️ 顺序有意为之：先跑 YuNet（人脸）那条探针，它会挑出**独立显卡的序号**
  // 并验证该序号真能建 DML 会话；这个序号随后交给图像嵌入探针。
  // 若两条并行，嵌入探针拿不到序号，就会用系统默认适配器（双显卡笔记本上通常是核显）。
  const face = await probeFaceGpuCapability(modelsDir);
  const embedding = await probeEmbeddingGpuCapability(
    modelsDir,
    typeof face.dmlDeviceId === "number" ? face.dmlDeviceId : null
  );
  return {
    ...face,
    embeddingDmlAvailable: embedding.dmlAvailable,
    embeddingError: embedding.error,
    embeddingProbeTimeMs: embedding.probeTimeMs,
  };
}

// ── Settings cache helpers ───────────────────────────────────────────

/**
 * 探测逻辑的版本号。**改动探测/选卡逻辑时必须 +1**。
 *
 * 原因：探测结果缓存在 app_settings 的 `gpu.detected` 里，老用户的旧结论不会自己失效。
 * 不加版本号就会踩这个坑：代码改好了、用户升级后仍按旧结论跑
 * （继续"图像嵌入用 CPU"或用核显）。版本号不一致时旧缓存直接判废、下次启动重探。
 */
export const GPU_DETECTOR_VERSION = 2;

/** Persist probe result so we don't re-detect on every launch. */
export function cacheDetectionResult(result: GpuProbeResult): void {
  setSetting(
    "gpu.detected",
    JSON.stringify({
      ...result,
      detectorVersion: GPU_DETECTOR_VERSION,
      timestamp: Date.now(),
    })
  );
}

/** Read the cached probe result, if any. */
export function getCachedDetection(): GpuProbeResult | null {
  const raw = getSetting("gpu.detected");
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as GpuProbeResult & {
      detectorVersion?: number;
      timestamp?: number;
    };
    // 旧版本探测逻辑留下的结论：作废，让启动流程重新探测。
    if (parsed.detectorVersion !== GPU_DETECTOR_VERSION) {
      return null;
    }
    // Reject cached results that picked up a virtual adapter
    // (e.g. OrayIddDriver or MuMu Virtual Display Adapter).
    if (parsed.gpuName && isVirtualGpuName(parsed.gpuName)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 当前应交给 DirectML 的适配器序号（deviceId）。
 * 取不到（旧缓存 / 探测失败 / 实际上不需要选卡）时返回 null = 用系统默认适配器。
 */
/**
 * 用户在「设置 → GPU 加速 → 使用显卡」里手选的适配器序号。
 * 值为 "auto"（或未设置/非法）时返回 null = 用自动挑出来的独显。
 */
export function getUserSelectedDeviceId(): number | null {
  const raw = getSetting("gpu.deviceId");
  if (!raw || raw === "auto") {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 当前应交给 DirectML 的适配器序号（deviceId）。
 * **手选优先**；没手选就用探测时自动挑的独显序号；都没有则 null = 系统默认适配器。
 */
export function getDmlDeviceId(): number | null {
  const manual = getUserSelectedDeviceId();
  if (manual !== null) {
    return manual;
  }
  const cached = getCachedDetection();
  const value = cached?.dmlDeviceId;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

// ───────────────────────────────────────────────────────────────────────────
// 自用（多卡）：多卡模式设置
// ───────────────────────────────────────────────────────────────────────────

/** 多卡模式最多支持的卡数（用户："最高三张卡就够了"）。 */
export const MAX_MULTI_GPU_DEVICES = 3;

export const MULTI_GPU_ENABLED_KEY = "gpu.multiEnabled";
export const MULTI_GPU_DEVICES_KEY = "gpu.deviceIds";

/** 多卡模式是否开启。 */
export function isMultiGpuEnabled(): boolean {
  return getSetting(MULTI_GPU_ENABLED_KEY) === "true";
}

/**
 * 用户在「使用显卡」里勾选的适配器序号列表（仅多卡模式用）。
 * 未设置/非法/去重后为空 → 返回 `[]`（调用方回退到单卡逻辑）。
 */
export function getSelectedDeviceIds(): number[] {
  const raw = getSetting(MULTI_GPU_DEVICES_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const ids = parsed
      .map((item) => Number.parseInt(String(item), 10))
      .filter((value) => Number.isInteger(value) && value >= 0);
    return [...new Set(ids)].slice(0, MAX_MULTI_GPU_DEVICES);
  } catch {
    return [];
  }
}

/**
 * 多卡模式下**实际启用**的设备列表（每个设备一个常驻 worker）。
 *
 * 规则：
 *   · 多卡模式关闭 → 返回 `[getDmlDeviceId()]`（单卡，行为与以前完全一致）；
 *   · 多卡开启且勾了 ≥1 张 → 返回勾选的（最多 `MAX_MULTI_GPU_DEVICES` 张）；
 *   · 多卡开启但没勾 → 回退单卡，避免"开了多卡却一张都不选"导致不干活。
 */
export function resolveWorkerDevices(): Array<number | null> {
  const single: Array<number | null> = [getDmlDeviceId()];
  if (!isMultiGpuEnabled()) {
    return single;
  }
  const selected = getSelectedDeviceIds();
  if (selected.length === 0) {
    return single;
  }
  return selected.map((id) => id as number | null);
}

/**
 * 自用（多卡·安全闸 2026-10-09）：解析出的设备列表里**是否有重复设备**
 * （即两个 worker 会被分到同一张卡上）。
 *
 * 为什么要单独判这个：**同一张卡上多开会互相踩 —— 实测 1 个 1.70 张/秒、
 * 2 个只有 0.82 张/秒**（显存顶到 15.6/16.4GB）。用户明确要求"一张卡一个 worker"，
 * 所以只要出现重复设备，调用方就必须**串行化**，而不是并发。
 *
 * 触发场景：`AIM_EMBED_WORKERS` / `AIM_PIXAI_WORKERS` 被调大、或 worker 数 > 卡数。
 */
export function hasDuplicatedWorkerDevice(
  devices: Array<number | null>
): boolean {
  if (devices.length <= 1) {
    return false;
  }
  // null（系统默认适配器）也算一个"设备"
  const keys = devices.map((id) => (id === null ? "default" : String(id)));
  return new Set(keys).size < keys.length;
}

/**
 * 把"图像嵌入探针"的真实结论写回缓存，让界面显示与实际一致。
 *
 * 背景：界面上的「图像嵌入 GPU 加速中 / 探测失败，使用 CPU」读的是 `gpu.detected` 缓存，
 * 而该缓存只在「检测 GPU」按钮里更新。工作进程每次启动其实都会重探一次，
 * 若不回写，就会出现"实际已经用上 GPU、界面却说用 CPU"的矛盾。
 */
export function recordEmbeddingProbeResult(
  dmlAvailable: boolean,
  deviceId: number | null,
  error?: string
): void {
  const cached = getCachedDetection();
  if (!cached) {
    return;
  }
  /**
   * ⚠️ 自用（多卡·修复 2026-10-09）：**探针失败不能把已知的显卡列表抹掉**。
   *
   * 背景（用户截图）：某个进程正在重度使用显卡时，图像嵌入探针会失败
   *（"Probe worker exited unexpectedly"），而失败结果里**没有 `adapters` 字段**。
   * 写缓存时直接 `{...cached, ...fail}` 会让 `adapters` 变成空数组，
   * 于是界面「使用显卡」一整块（含新加的多卡开关、每卡速度）**整段不渲染**。
   * 这里在失败时保留上一次探测到的 `adapters` / `gpuName` —— 它们并没有失效。
   */
  const payload: GpuProbeResult = {
    ...cached,
    dmlDeviceId: deviceId ?? cached.dmlDeviceId ?? null,
    embeddingDmlAvailable: dmlAvailable,
    embeddingError: error,
  };
  if (payload.adapters === undefined) {
    payload.adapters = cached.adapters;
  }
  if (payload.gpuName === undefined) {
    payload.gpuName = cached.gpuName;
  }
  cacheDetectionResult(payload);
}

/**
 * 确保"该用哪块显卡"是已知的：有缓存用缓存，没有就补跑一次轻量探测（YuNet + DML，约 1 s），
 * 并把结果并入 `gpu.detected` 缓存。
 *
 * 为什么需要：探测结果的写入点只有「设置 → GPU 加速 → 检测 GPU」按钮（和未被调用的启动探测）。
 * 用户没点过按钮时，图像嵌入的工作进程启动时拿不到序号，就会退回系统默认适配器
 * —— 双显卡笔记本上通常正是核显（用户反馈的那个 bug）。
 */
export async function resolveDmlDeviceId(
  modelsDir: string
): Promise<number | null> {
  const cached = getCachedDetection();
  const cachedDeviceId = getDmlDeviceId();
  if (cachedDeviceId !== null) {
    return cachedDeviceId;
  }
  // 已经探测过、且明确不需要选卡（deviceId 字段存在但为 null）：不要反复探测。
  if (cached && "dmlDeviceId" in cached) {
    return null;
  }
  const face = await probeFaceGpuCapability(modelsDir);
  /**
   * ⚠️ 自用（多卡·修复 2026-10-09）：探针失败时**不要**用空结果覆盖已知的显卡列表。
   * 详见 `recordEmbeddingProbeResult` 的注释 —— 一次偶发失败（显卡被别的任务占满）
   * 会让界面整块「使用显卡」消失。
   */
  const merged: GpuProbeResult = {
    ...(cached ?? {
      dmlAvailable: face.dmlAvailable,
      probeTimeMs: face.probeTimeMs,
    }),
    ...face,
  };
  if (merged.adapters === undefined) {
    merged.adapters = cached?.adapters;
  }
  if (merged.gpuName === undefined) {
    merged.gpuName = cached?.gpuName;
  }
  cacheDetectionResult(merged);
  return typeof face.dmlDeviceId === "number" ? face.dmlDeviceId : null;
}

const VIRTUAL_GPU_PATTERNS = [
  /virtual/i,
  /mumu/i,
  /oray/i,
  /remote\s*display/i,
  /basic\s*display/i,
  /hyper-?v/i,
  /vmware/i,
  /virtualbox/i,
  /citrix/i,
  /parsec/i,
  /software/i,
  /indirect\s*display/i,
];

export function isVirtualGpuName(name: string): boolean {
  return VIRTUAL_GPU_PATTERNS.some((p) => p.test(name));
}

// ── Prompt gating ───────────────────────────────────────────────────

/**
 * Should we show the "GPU detected — enable now?" onboarding dialog?
 *
 * Conditions:
 *   1. User has NOT already seen the dialog (gpu.promptShown is absent).
 *   2. User has NOT explicitly chosen a GPU preference
 *      (gpu.enabled is absent — meaning they never toggled it).
 *   3. The cached probe says DML is available.
 */
export function shouldPromptUser(): boolean {
  if (getSetting("gpu.promptShown") === "true") {
    return false;
  }
  if (getSetting("gpu.enabled") !== null) {
    return false; // user chose
  }
  const cached = getCachedDetection();
  return (
    cached?.dmlAvailable === true || cached?.embeddingDmlAvailable === true
  );
}

export function markPromptShown(): void {
  setSetting("gpu.promptShown", "true");
}

// ── Orchestration: called on startup ────────────────────────────────

/**
 * Run once after background services are up.  Probes GPU (or reads the
 * cache), persists the result, and sends the appropriate IPC event to
 * every open renderer window so the UI can decide whether to show the
 * onboarding dialog.
 */
export async function probeAndNotifyIfNeeded(): Promise<void> {
  let result = getCachedDetection();

  if (!result || result.embeddingDmlAvailable === undefined) {
    const modelsDir = findModelsDir();
    result = await probeGpuCapability(modelsDir);
    cacheDetectionResult(result);
    log.info(
      {
        dmlAvailable: result.dmlAvailable,
        embeddingDmlAvailable: result.embeddingDmlAvailable,
        embeddingError: result.embeddingError,
        gpuName: result.gpuName,
      },
      "GPU detection complete"
    );
  }

  const shouldPrompt = shouldPromptUser();

  for (const win of BrowserWindow.getAllWindows()) {
    if (shouldPrompt) {
      win.webContents.send("gpu:prompt-user", result);
    } else {
      win.webContents.send("gpu:detection-done", result);
    }
  }
}
