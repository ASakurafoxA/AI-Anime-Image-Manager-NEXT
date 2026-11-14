/**
 * 动漫人脸检测 worker（2026-11-14 · 会话#12 新增，方案 C 阶段 1）。
 *
 * 模型：`deepghs/anime_face_detection` 的 `face_detect_v1.4_n.onnx`
 *       （YOLOv8n、640 输入、单标签 `face`、官方阈值 0.278、**MIT**）。
 *
 * 消息协议（与 pixai / ccip worker 同构，便于复用池与进度写法）：
 *   主 → worker : { type:"init", modelsDir, useGPU, deviceId? }
 *                 { type:"detect", photos:[{id, path}], confidence?, inputSize? }
 *                 { type:"abort" } / { type:"shutdown" }
 *   worker → 主 : { type:"ready", provider, modelPath }
 *                 { type:"result", results:[{ id, width, height, faces:[{x1,y1,x2,y2,score}] }] }
 *                 { type:"init-error", error } / { type:"provider-error", error, provider }
 *
 * ⚠️ 解码/NMS 的数学与 `src/services/anime-face/geometry.ts` **必须保持一致**
 *    （那边有单测；改一处必须同步另一处）。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";

const require = createRequire(import.meta.url);

const INPUT_SIZE = 640;
const CONFIDENCE = 0.278;
const IOU_THRESHOLD = 0.45;
const MIN_SIDE = 4;
const MAX_FACES = 8;

const RAW_EXTENSIONS = new Set([
  ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf", ".sr2", ".dng",
  ".orf", ".rw2", ".raf", ".pef", ".rwl", ".3fr", ".raw",
]);

sharp.concurrency(Number.parseInt(process.env.AI_FACE_SHARP_THREADS || "1", 10) || 1);

let ort = null;
let session = null;
let inputName = "images";
let outputName = "output0";
let activeProvider = "cpu";
let aborted = false;

function loadOrt() {
  if (ort) {
    return ort;
  }
  try {
    ort = require("onnxruntime-node");
  } catch (error) {
    console.error("[FaceDetect] 主 onnxruntime 加载失败:", error.message);
    ort = require(path.join(path.resolve(import.meta.dirname, ".."), "node_modules", "onnxruntime-node"));
  }
  return ort;
}

function isRawFile(filePath) {
  return RAW_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function resolveImageInput(filePath) {
  if (!isRawFile(filePath)) {
    return filePath;
  }
  const { extractRawPreview } = await import("./raw-preview.mjs");
  return extractRawPreview(filePath) || filePath;
}

/** 与 geometry.ts 的 computeLetterbox 一致 */
function computeLetterbox(width, height, inputSize) {
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`图片尺寸无效: ${width}x${height}`);
  }
  const scale = Math.min(inputSize / width, inputSize / height);
  const newW = Math.max(1, Math.round(width * scale));
  const newH = Math.max(1, Math.round(height * scale));
  return { scale, newW, newH, padX: Math.floor((inputSize - newW) / 2), padY: Math.floor((inputSize - newH) / 2) };
}

async function letterbox(file, inputSize) {
  const image = sharp(file, { failOn: "none" }).rotate();
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const box = computeLetterbox(width, height, inputSize);
  const resized = await image
    .resize(box.newW, box.newH, { fit: "fill" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();
  const canvas = Buffer.alloc(inputSize * inputSize * 3, 114);
  for (let y = 0; y < box.newH; y += 1) {
    resized.copy(
      canvas,
      ((y + box.padY) * inputSize + box.padX) * 3,
      y * box.newW * 3,
      (y + 1) * box.newW * 3
    );
  }
  const data = new Float32Array(3 * inputSize * inputSize);
  const plane = inputSize * inputSize;
  for (let i = 0; i < plane; i += 1) {
    data[i] = canvas[i * 3] / 255;
    data[plane + i] = canvas[i * 3 + 1] / 255;
    data[2 * plane + i] = canvas[i * 3 + 2] / 255;
  }
  return { data, ...box, width, height, inputSize };
}

/** 与 geometry.ts 的 decodeFaceBoxes 一致 */
function decodeBoxes(data, n, rows, transform, imageWidth, imageHeight, confidence, inputSize) {
  const boxes = [];
  for (let i = 0; i < n; i += 1) {
    const score = data[4 * n + i];
    if (!Number.isFinite(score) || score < confidence) continue;
    const cx = data[i];
    const cy = data[n + i];
    const w = data[2 * n + i];
    const h = data[3 * n + i];
    if (!(w > 0) || !(h > 0)) continue;
    const x1 = (cx - w / 2 - transform.padX) / transform.scale;
    const y1 = (cy - h / 2 - transform.padY) / transform.scale;
    const x2 = (cx + w / 2 - transform.padX) / transform.scale;
    const y2 = (cy + h / 2 - transform.padY) / transform.scale;
    const cx1 = Math.max(0, x1);
    const cy1 = Math.max(0, y1);
    const cx2 = Math.min(imageWidth, x2);
    const cy2 = Math.min(imageHeight, y2);
    if (cx2 - cx1 < MIN_SIDE || cy2 - cy1 < MIN_SIDE) continue;
    boxes.push({ x1: cx1, y1: cy1, x2: cx2, y2: cy2, score });
  }
  return boxes;
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

function nms(boxes, threshold) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of sorted) {
    if (kept.every((other) => iou(other, box) < threshold)) kept.push(box);
  }
  return kept;
}

async function handleInit(message) {
  const modelsDir = typeof message.modelsDir === "string" ? message.modelsDir : "";
  if (!modelsDir) throw new Error("init 缺少 modelsDir");

  const dir = path.join(modelsDir, "anime_face");
  const candidates = ["face_detect_v1.4_n.onnx", "face_detect_v1.4_s.onnx"];
  const modelPath = candidates.map((f) => path.join(dir, f)).find((p) => fs.existsSync(p));
  if (!modelPath) {
    throw new Error(`缺少动漫人脸检测模型：${path.join(dir, candidates[0])}`);
  }

  const ortNs = loadOrt();
  const useGPU = Boolean(message.useGPU);
  const deviceId = Number.isInteger(message.deviceId) && message.deviceId >= 0 ? message.deviceId : null;
  const dmlProvider = deviceId === null ? "dml" : { name: "dml", deviceId };
  const providers =
    useGPU && process.platform === "win32" && process.arch === "x64" ? [dmlProvider, "cpu"] : ["cpu"];
  activeProvider = providers[0] === "cpu" ? "cpu" : "dml";

  const create = (executionProviders) =>
    ortNs.InferenceSession.create(modelPath, {
      executionProviders,
      graphOptimizationLevel: "disabled",
    });

  try {
    session = await create(providers);
  } catch (error) {
    if (activeProvider !== "cpu") {
      console.error(`[FaceDetect] ${activeProvider} 初始化失败，退回 CPU:`, error.message);
      activeProvider = "cpu";
      session = await create(["cpu"]);
    } else {
      throw error;
    }
  }
  inputName = session.inputNames[0] ?? "images";
  outputName = session.outputNames[0] ?? "output0";
  process.send?.({ type: "ready", provider: activeProvider, modelPath });
}

async function handleDetect(message) {
  const photos = Array.isArray(message.photos) ? message.photos : [];
  const confidence = typeof message.confidence === "number" ? message.confidence : CONFIDENCE;
  const inputSize = Number.isInteger(message.inputSize) ? message.inputSize : INPUT_SIZE;
  if (!session) {
    process.send?.({ type: "result", results: photos.map((p) => ({ id: p.id, error: "模型未初始化" })) });
    return;
  }

  const results = [];
  let providerError = null;
  for (const photo of photos) {
    if (aborted) break;
    try {
      const lb = await letterbox(await resolveImageInput(photo.path), inputSize);
      const input = new ort.Tensor("float32", lb.data, [1, 3, inputSize, inputSize]);
      const out = await session.run({ [inputName]: input });
      const tensor = out[outputName];
      const dims = tensor.dims;
      const n = dims[dims.length - 1];
      const rows = dims[dims.length - 2];
      const decoded = decodeBoxes(tensor.data, n, rows, lb, lb.width, lb.height, confidence, inputSize);
      const faces = nms(decoded, IOU_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_FACES);
      for (const value of Object.values(out)) value?.dispose?.();
      results.push({ id: photo.id, width: lb.width, height: lb.height, faces });
    } catch (error) {
      if (activeProvider === "dml") {
        providerError = error instanceof Error ? error.message : String(error);
        break;
      }
      results.push({ id: photo.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (providerError) {
    process.send?.({ type: "provider-error", error: providerError, provider: activeProvider });
    return;
  }
  process.send?.({ type: "result", results });
}

process.on("message", async (message) => {
  try {
    if (message?.type === "init") {
      await handleInit(message);
    } else if (message?.type === "detect") {
      aborted = false;
      await handleDetect(message);
    } else if (message?.type === "abort") {
      aborted = true;
    } else if (message?.type === "shutdown") {
      process.exit(0);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (message?.type === "init") {
      process.send?.({ type: "init-error", error: text });
    } else if (message?.type === "detect") {
      process.send?.({ type: "result", results: (message.photos || []).map((p) => ({ id: p.id, error: text })) });
    }
  }
});
