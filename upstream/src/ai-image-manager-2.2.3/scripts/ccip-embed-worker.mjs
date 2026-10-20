/**
 * CCIP 角色特征抽取 worker（NEXT 版新增）。
 *
 * 用途：为「角色识别」产出 **768 维角色特征**。CCIP（deepghs/ccip-caformer_b36-24）
 * 是角色专用特征，实测对"区分同一个角色"远强于现有整图特征。
 *
 * 消息协议（与 pixai-tagger-worker.mjs 同构，便于复用池写法）：
 *   主进程 → worker : { type:"init", modelsDir, threads? }
 *                     { type:"embed", photos:[{id,path}] }
 *                     { type:"abort" } / { type:"shutdown" }
 *   worker → 主进程 : { type:"ready", dim }
 *                     { type:"result", results:[{id, vector?}|{id, error}] }
 *                     { type:"init-error", error }
 *
 * ⚠️ 规格（实测确认，不是猜的）：
 *   · 输入 `[1, 3, 384, 384]`（NCHW、RGB）
 *   · 归一化：`(x/255 - ImageNet均值) / ImageNet标准差`
 *   · 缩放方式与实验脚本一致：`resize(384, 384, { fit:"cover" })` + `removeAlpha()`
 *   · 输出 `[1, 768]`
 *   · 相似度换算：官方 `model_metrics` 的距离 **D = 0.5 × (1 − 余弦)**（实测恒等），
 *     所以这里**自带 L2 归一化**，后续用余弦即可等价换算，无需再带 metrics 模型。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";

const require = createRequire(import.meta.url);

const SIZE = 384;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const EXPECTED_DIM = 768;

const sharpThreads = Math.max(
  1,
  Number.parseInt(process.env.AI_CCIP_SHARP_THREADS || "1", 10) || 1
);
sharp.concurrency(sharpThreads);

const RAW_EXTENSIONS = new Set([
  ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf", ".sr2", ".dng",
  ".orf", ".rw2", ".raf", ".pef", ".rwl", ".3fr", ".raw",
]);

function isRawFile(filePath) {
  return RAW_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function resolveImageInput(filePath) {
  if (!isRawFile(filePath)) {
    return filePath;
  }
  try {
    const { extractRawPreview } = await import("./raw-preview.mjs");
    return extractRawPreview(filePath) || filePath;
  } catch {
    return filePath;
  }
}

let ort = null;
function loadOrt() {
  if (ort) {
    return ort;
  }
  try {
    ort = require("onnxruntime-node");
  } catch {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    ort = require(path.join(projectRoot, "node_modules", "onnxruntime-node"));
  }
  return ort;
}

let session = null;
let inputName = "input";
let outputName = "output";
let aborted = false;

function toNCHW(rgb) {
  const ppc = SIZE * SIZE;
  const out = new Float32Array(3 * ppc);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const s = (y * SIZE + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[c * ppc + y * SIZE + x] =
          (rgb[s + c] / 255 - MEAN[c]) / STD[c];
      }
    }
  }
  return out;
}

/** L2 归一化（保留 6 位小数，减少 IPC 体积）。 */
function l2normalize(data) {
  let norm = 0;
  for (let i = 0; i < data.length; i++) {
    norm += data[i] * data[i];
  }
  norm = Math.sqrt(norm) || 1;
  const vector = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    vector[i] = Math.round((data[i] / norm) * 1e6) / 1e6;
  }
  return vector;
}

async function handleInit(message) {
  const modelsDir = message.modelsDir;
  if (typeof modelsDir !== "string" || modelsDir.length === 0) {
    throw new Error("init 缺少 modelsDir");
  }
  const threads =
    Number.isInteger(message.threads) && message.threads > 0
      ? Number(message.threads)
      : 1;
  const modelPath = path.join(modelsDir, "ccip", "model_feat.onnx");
  if (!fs.existsSync(modelPath)) {
    throw new Error(`缺少 CCIP 模型文件: ${modelPath}`);
  }

  const ortNs = loadOrt();
  /*
   * 自用（2026-10-17，实测 6.4 倍）：**支持 DirectML（显卡）** ✓
   *   实测同一批 40 张：CPU 4 线程 2.43 张/秒、**DML 15.55 张/秒**（输出余弦 1.000000）；
   *   而生产环境"12 进程 × 1 线程 CPU"合计只有 3.7 张/秒 → **单进程 GPU 就快约 4 倍** ✓
   * 没显卡 / 驱动不支持时必须**安全回退 CPU**（不能把整个任务搞挂）✓
   */
  const wantGpu = message.provider === "dml";
  const deviceId =
    Number.isInteger(message.deviceId) && message.deviceId >= 0
      ? Number(message.deviceId)
      : 0;
  let providerLabel = "cpu";
  if (wantGpu) {
    try {
      session = await ortNs.InferenceSession.create(modelPath, {
        executionProviders: [{ name: "dml", deviceId }],
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
        logSeverityLevel: 3,
      });
      providerLabel = `dml:${deviceId}`;
    } catch (error) {
      console.warn(
        `[CCIP] DirectML 初始化失败，回退 CPU：${String(error?.message ?? error)}`
      );
      session = null;
    }
  }
  if (!session) {
    session = await ortNs.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      logSeverityLevel: 3,
    });
    providerLabel = "cpu";
  }
  inputName = session.inputNames[0];
  outputName = session.outputNames[0];

  process.send?.({
    type: "ready",
    dim: EXPECTED_DIM,
    threads,
    provider: providerLabel,
  });
}

async function handleEmbed(message) {
  const photos = Array.isArray(message.photos) ? message.photos : [];
  if (!session) {
    process.send?.({
      type: "result",
      results: photos.map((photo) => ({
        id: photo.id,
        error: "Model not initialized",
      })),
    });
    return;
  }

  const ortNs = loadOrt();
  const results = [];

  for (const photo of photos) {
    if (aborted) {
      break;
    }
    try {
      const input = await resolveImageInput(photo.path);
      const { data } = await sharp(input, { failOn: "none" })
        .rotate()
        .resize(SIZE, SIZE, { fit: "cover", position: "center" })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const tensor = new ortNs.Tensor("float32", toNCHW(rgb), [
        1,
        3,
        SIZE,
        SIZE,
      ]);
      const outputs = await session.run({ [inputName]: tensor });
      const raw = outputs[outputName]?.data;
      if (!raw || raw.length !== EXPECTED_DIM) {
        throw new Error(
          `特征输出异常：期望 ${EXPECTED_DIM} 维，实际 ${raw?.length ?? 0}`
        );
      }
      results.push({ id: photo.id, vector: l2normalize(raw) });
      for (const value of Object.values(outputs)) {
        value?.dispose?.();
      }
    } catch (error) {
      results.push({
        id: photo.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  process.send?.({ type: "result", results });
}

process.on("message", async (message) => {
  try {
    if (message?.type === "init") {
      await handleInit(message);
    } else if (message?.type === "embed") {
      aborted = false;
      await handleEmbed(message);
    } else if (message?.type === "abort") {
      aborted = true;
    } else if (message?.type === "shutdown") {
      process.exit(0);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (message?.type === "embed") {
      process.send?.({
        type: "result",
        results: (message.photos || []).map((photo) => ({
          id: photo.id,
          error: text,
        })),
      });
    } else if (message?.type === "init") {
      process.send?.({ type: "init-error", error: text });
    }
  }
});