/**
 * WD14 动漫标签 worker（自用新增，AI Anime Image Manager）。
 *
 * 为什么不能直接复用 embed-worker.mjs —— 它有三处不满足 WD14 的硬性要求：
 *   1. **通道序**：embed-worker 只支持 RGB，WD14 必须 **BGR**（官方预处理 image[:, :, ::-1]）
 *   2. **数值范围**：embed-worker 走 mean/std 归一化，WD14 必须用**原始 0-255**
 *      （实测：用 mean/std=0.5 归一化会让模型彻底失效 —— 4 张完全不同的图输出一模一样的垃圾）
 *   3. **多输出**：embed-worker 只取一个输出，WD14 需要同时取标签 [N,10861] 与特征 [N,768]
 *
 * 另有两处实测确认的规格：
 *   - 输入布局是 **NHWC** `[N,448,448,3]`（config.json 写的 [3,448,448] 是 timm 的约定，
 *     ONNX 导出时已被转置 —— 这个必须问模型自己，不能照抄 config.json）
 *   - 预处理要**白底补成正方形**再缩放到 448×448（bicubic）
 *
 * 消息协议（与 embed-worker 同构，便于复用同一套 pool 写法）：
 *   主进程 → worker : { type:"init", modelsDir, useGPU }
 *                     { type:"tag", photos:[{id,path}], thresholds:{general,character}, includeEmbedding }
 *                     { type:"abort" } / { type:"shutdown" }
 *   worker → 主进程 : { type:"ready", embeddingOutput, tagCount }
 *                     { type:"result", results:[{id, tags:[{name,category,score}], embedding?}] }
 *                     { type:"init-error", error } / { type:"provider-error", ... }
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";

const require = createRequire(import.meta.url);

const IMAGE_SIZE = 448;
/** WD14 官方推荐阈值：通用标签 0.35，角色标签 0.85（角色取高阈值以压误判）。 */
const DEFAULT_GENERAL_THRESHOLD = 0.35;
const DEFAULT_CHARACTER_THRESHOLD = 0.85;
const LABEL_COUNT = 10_861;

const sharpThreads = Math.max(
  1,
  Number.parseInt(process.env.AI_TAGGER_SHARP_THREADS || "1", 10) || 1
);
sharp.concurrency(sharpThreads);

const RAW_EXTENSIONS = new Set([
  ".cr2",
  ".cr3",
  ".nef",
  ".nrw",
  ".arw",
  ".srf",
  ".sr2",
  ".dng",
  ".orf",
  ".rw2",
  ".raf",
  ".pef",
  ".rwl",
  ".3fr",
  ".raw",
]);

function isRawFile(filePath) {
  return RAW_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

let ort = null;
let session = null;
let vocab = null;
let embeddingOutputName = null;
let tagOutputName = "output";
let inputName = "input";
let modelsDir = null;
let activeProvider = "cpu";
let aborted = false;

function loadOrt() {
  if (ort) {
    return ort;
  }
  try {
    ort = require("onnxruntime-node");
  } catch (error) {
    console.error(
      "[WD14] Primary onnxruntime-node load failed:",
      error.message
    );
    const projectRoot = path.resolve(import.meta.dirname, "..");
    ort = require(path.join(projectRoot, "node_modules", "onnxruntime-node"));
  }
  return ort;
}

/** 解析 selected_tags.csv（列：tag_id,name,category,count）。行序 = 模型输出下标。 */
function loadVocab(csvPath) {
  const text = fs.readFileSync(csvPath, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const header = lines[0].split(",");
  const iName = header.indexOf("name");
  const iCategory = header.indexOf("category");
  if (iName < 0 || iCategory < 0) {
    throw new Error("selected_tags.csv 缺少 name / category 列");
  }
  const tags = [];
  for (let i = 1; i < lines.length; i++) {
    // 按逗号切分即可：name 与 category 都在前几列，name 本身不含逗号
    const parts = lines[i].split(",");
    tags.push({
      name: parts[iName],
      category: Number.parseInt(parts[iCategory], 10),
    });
  }
  if (tags.length !== LABEL_COUNT) {
    throw new Error(
      `标签词表行数异常：期望 ${LABEL_COUNT}，实际 ${tags.length}`
    );
  }
  return tags;
}

/**
 * 预处理：白底补成正方形 → 448×448（bicubic）→ **BGR** 原始 0-255 → NHWC 张量。
 * 这三项都必须与验证过的规格严格一致，否则模型输出会退化成噪声。
 */
async function preprocessImage(imagePath) {
  const { data, info } = await sharp(imagePath)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(IMAGE_SIZE, IMAGE_SIZE, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255 },
      kernel: "cubic",
    })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (
    info.channels !== 3 ||
    info.width !== IMAGE_SIZE ||
    info.height !== IMAGE_SIZE
  ) {
    throw new Error(
      `预处理结果异常: ${info.width}x${info.height}x${info.channels}`
    );
  }

  const floats = new Float32Array(IMAGE_SIZE * IMAGE_SIZE * 3);
  for (let i = 0; i < IMAGE_SIZE * IMAGE_SIZE; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    // BGR 通道序（与官方 image[:, :, ::-1] 等价），数值保持原始 0-255
    floats[i * 3] = b;
    floats[i * 3 + 1] = g;
    floats[i * 3 + 2] = r;
  }
  return floats;
}

function pickEmbeddingOutputName(sessionOutputs) {
  // 特征输出的形状是 [batch, 768]；标签输出是 [batch, 10861]。
  // 不按名字硬编码 —— 不同重导出版本的特征输出名不一样（实测为 /core_model/ReduceMean_output_0）。
  for (const meta of sessionOutputs) {
    const dims = meta.shape ?? [];
    if (dims.length === 2 && Number(dims[1]) !== LABEL_COUNT) {
      return meta.name;
    }
  }
  return null;
}

async function handleInit(message) {
  modelsDir = message.modelsDir;
  const useGPU = Boolean(message.useGPU);
  const dir = path.join(modelsDir, "SmilingWolf", "wd-vit-tagger-v3");
  const modelPath = path.join(dir, "model.onnx");
  const csvPath = path.join(dir, "selected_tags.csv");

  if (!fs.existsSync(modelPath)) {
    throw new Error(`缺少 WD14 模型文件: ${modelPath}`);
  }
  if (!fs.existsSync(csvPath)) {
    throw new Error(`缺少 WD14 标签词表: ${csvPath}`);
  }
  vocab = loadVocab(csvPath);

  const ortNs = loadOrt();
  const providers =
    useGPU && process.platform === "win32" && process.arch === "x64"
      ? ["dml", "cpu"]
      : ["cpu"];
  activeProvider = providers[0];

  try {
    session = await ortNs.InferenceSession.create(modelPath, {
      executionProviders: providers,
      graphOptimizationLevel: "all",
    });
  } catch (error) {
    // DirectML 不可用时退回 CPU，而不是整体失败
    if (activeProvider !== "cpu") {
      console.error(
        `[WD14] ${activeProvider} 初始化失败，退回 CPU:`,
        error.message
      );
      activeProvider = "cpu";
      session = await ortNs.InferenceSession.create(modelPath, {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
      });
    } else {
      throw error;
    }
  }

  inputName = session.inputNames[0];
  tagOutputName = session.outputNames.includes("output")
    ? "output"
    : session.outputNames[0];
  embeddingOutputName = pickEmbeddingOutputName(session.outputMetadata);

  process.send?.({
    type: "ready",
    provider: activeProvider,
    tagCount: vocab.length,
    embeddingOutput: embeddingOutputName,
    hasEmbedding: embeddingOutputName !== null,
  });
}

async function handleTag(message) {
  const photos = Array.isArray(message.photos) ? message.photos : [];
  const thresholds = message.thresholds ?? {};
  const generalThreshold =
    typeof thresholds.general === "number"
      ? thresholds.general
      : DEFAULT_GENERAL_THRESHOLD;
  const characterThreshold =
    typeof thresholds.character === "number"
      ? thresholds.character
      : DEFAULT_CHARACTER_THRESHOLD;
  const includeEmbedding = Boolean(message.includeEmbedding);

  if (!(session && vocab)) {
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
  let providerError = null;

  for (const photo of photos) {
    if (aborted) {
      break;
    }
    try {
      const floats = await preprocessImage(await resolveImageInput(photo.path));
      const input = new ortNs.Tensor("float32", floats, [
        1,
        IMAGE_SIZE,
        IMAGE_SIZE,
        3,
      ]);
      const outputs = await session.run({ [inputName]: input });

      const scores = outputs[tagOutputName]?.data;
      if (!scores || scores.length !== vocab.length) {
        throw new Error(
          `标签输出异常：期望 ${vocab.length} 个分数，实际 ${scores?.length ?? 0}`
        );
      }

      // 阈值判定放在 worker 内 —— 否则要把每张图 10,861 个分数全部过 IPC，代价极高
      const tags = [];
      for (let i = 0; i < scores.length; i++) {
        const score = scores[i];
        const meta = vocab[i];
        // category 9 = rating 分级（general / sensitive / questionable / explicit）。
        // 本版不采集分级标签（与 wd14-tagger.ts 的词表导入保持一致），
        // 若在此返回，主进程会因"标签名不在 tags 表中"而整条丢弃并刷警告。
        if (meta.category === 9) {
          continue;
        }
        const limit =
          meta.category === 4 ? characterThreshold : generalThreshold;
        if (score >= limit) {
          tags.push({
            name: meta.name,
            category: meta.category,
            score: Math.round(score * 1000) / 1000,
          });
        }
      }
      tags.sort((a, b) => b.score - a.score);

      const entry = { id: photo.id, tags };

      if (includeEmbedding && embeddingOutputName) {
        const raw = outputs[embeddingOutputName]?.data;
        if (raw && raw.length > 0) {
          // L2 归一化，保留 5 位小数（JSON IPC，位数越少传输越小）
          let norm = 0;
          for (let i = 0; i < raw.length; i++) {
            norm += raw[i] * raw[i];
          }
          norm = Math.sqrt(norm) || 1;
          const vector = new Array(raw.length);
          for (let i = 0; i < raw.length; i++) {
            vector[i] = Math.round((raw[i] / norm) * 100000) / 100000;
          }
          entry.embedding = vector;
        }
      }

      for (const value of Object.values(outputs)) {
        value?.dispose?.();
      }
      results.push(entry);
    } catch (error) {
      if (activeProvider === "dml") {
        providerError = error instanceof Error ? error.message : String(error);
        break;
      }
      results.push({
        id: photo.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (providerError) {
    process.send?.({
      type: "provider-error",
      error: providerError,
      provider: activeProvider,
    });
    return;
  }

  process.send?.({ type: "result", results });
}

process.on("message", async (message) => {
  try {
    if (message?.type === "init") {
      await handleInit(message);
    } else if (message?.type === "tag") {
      aborted = false;
      await handleTag(message);
    } else if (message?.type === "abort") {
      aborted = true;
    } else if (message?.type === "shutdown") {
      process.exit(0);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (message?.type === "tag") {
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

// RAW 文件走内嵌预览（与 embed-worker 一致）
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
