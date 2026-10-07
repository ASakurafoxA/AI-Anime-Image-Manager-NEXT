/**
 * PixAI Tagger v1.0 打标 worker（NEXT 版，替代 WD14；WD14 保留可回退）。
 *
 * 与 `wd14-tagger-worker.mjs` 的**消息协议完全同构**（便于复用客户端与 pool 写法），
 * 但模型规格**处处不同**，逐条列在这里以防照抄出错：
 *
 *   | 项        | WD14            | PixAI v1.0                    |
 *   |-----------|-----------------|-------------------------------|
 *   | 尺寸      | 448             | **1008**                      |
 *   | 布局      | NHWC            | **NCHW** `[1,3,1008,1008]`    |
 *   | 通道序    | BGR             | **RGB**                       |
 *   | 数值      | 0–255           | **-1 .. 1**（(x/255-0.5)/0.5）|
 *   | 补边      | 白底            | **黑边（0）**                 |
 *   | 缩放      | 先补方再缩      | **先等比缩放再补边**（官方 rescale_pad）|
 *   | 插值      | bicubic         | **bilinear**                  |
 *   | 词表      | selected_tags.csv（10,861）| **config.json 的 tags（30,877）** |
 *   | 输出      | 标签 + 768 维特征 | 标签 + **1024 维特征**       |
 *   | session   | `graphOptimizationLevel:"all"` | **`"disabled"`** ⚠️ |
 *   | 分级      | **丢弃**（category 9 跳过）| **保留**（rating:s/g/q/e）|
 *
 * ⚠️ `graphOptimizationLevel` 必须是 `"disabled"`：这个模型有 9,217 个节点
 *    （RoPE 展开出的大量 Constant/Unsqueeze/Shape），ORT 1.26 的图优化器会**栈溢出**
 *    直接 0xC0000005 崩溃。实测 `all` / `basic` 都崩，`disabled` 正常。
 *
 * 消息协议：
 *   主进程 → worker : { type:"init", modelsDir, useGPU }
 *                     { type:"tag", photos:[{id,path}], thresholds?:{general,character,copyright,style,meta,rating}, includeEmbedding }
 *                     { type:"abort" } / { type:"shutdown" }
 *   worker → 主进程 : { type:"ready", provider, tagCount, categories, embeddingDim, hasEmbedding }
 *                     { type:"result", results:[{id, tags:[{name,category,score}], embedding?}] }
 *                     { type:"init-error", error } / { type:"provider-error", ... }
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import { IMAGE_SIZE, preprocessImage } from "./pixai-preprocess.mjs";

const require = createRequire(import.meta.url);
/** 六分类顺序固定（config.json 的 tags_split），输出里的区间按这个顺序切。 */
const DEFAULT_THRESHOLDS = {
  general: 0.17,
  character: 0.27,
  copyright: 0.24,
  style: 0.15,
  meta: 0.17,
  rating: 0.41,
};

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
/** [{name, category, categoryIndex, start}] —— 顺序 = 模型输出下标。 */
let vocab = null;
let categoryOrder = null;
let inputName = "pixel_values";
let logitsOutputName = "logits";
let embeddingOutputName = "embedding";
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
      "[PixAI] Primary onnxruntime-node load failed:",
      error.message
    );
    const projectRoot = path.resolve(import.meta.dirname, "..");
    ort = require(path.join(projectRoot, "node_modules", "onnxruntime-node"));
  }
  return ort;
}

/**
 * 从 `config.json` 建词表。
 *
 * WD14 的词表在 `selected_tags.csv` 里逐行带 category；PixAI 没有这个文件 ——
 * 分类信息在 `tags_split` 的**区间**里：`[["general",15043],["character",8308],...]`，
 * 而 `tags` 就是按这个顺序摊平的 30,877 个名字。所以要把区间展开成每个标签的分类。
 */
function loadVocab(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const tags = cfg.tags;
  const splits = cfg.tags_split;
  if (!Array.isArray(tags) || !Array.isArray(splits)) {
    throw new Error("config.json 缺少 tags / tags_split");
  }

  const built = [];
  const order = [];
  let start = 0;
  for (const entry of splits) {
    const [category, count] = Array.isArray(entry) ? entry : [entry, 0];
    const categoryIndex = order.length;
    order.push({ category, count, start });
    for (let i = 0; i < count; i++) {
      built.push({ category, categoryIndex, name: tags[start + i] });
    }
    start += count;
  }
  if (built.length !== tags.length) {
    throw new Error(
      `词表长度对不上：tags_split 合计 ${built.length}，tags 实际 ${tags.length}`
    );
  }
  categoryOrder = order;
  return built;
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function pickOutputs() {
  // 实测名字就是 pixel_values / logits / embedding，但仍按形状兜底，
  // 免得换个导出脚本就静默取错输出。
  const outputs = session.outputMetadata ?? [];
  let logits = null;
  let embedding = null;
  for (const meta of outputs) {
    const dims = meta.shape ?? [];
    if (dims.length !== 2) {
      continue;
    }
    const last = Number(dims[1]);
    if (last === 1024) {
      embedding = meta.name;
    } else if (last > 1024) {
      logits = meta.name;
    }
  }
  logitsOutputName = logits ?? session.outputNames[0];
  embeddingOutputName = embedding ?? session.outputNames[1] ?? null;
  inputName = session.inputNames[0];
}

async function handleInit(message) {
  modelsDir = message.modelsDir;
  const useGPU = Boolean(message.useGPU);
  const dir = path.join(modelsDir, "pixai-tagger-v1.0");
  const modelPath = path.join(dir, "pixai-tagger-v1.0.onnx");
  const configPath = path.join(dir, "config.json");

  if (!fs.existsSync(modelPath)) {
    throw new Error(`缺少 PixAI 模型文件: ${modelPath}`);
  }
  if (!fs.existsSync(configPath)) {
    throw new Error(`缺少 PixAI 词表 config.json: ${configPath}`);
  }
  vocab = loadVocab(configPath);

  const ortNs = loadOrt();
  const providers =
    useGPU && process.platform === "win32" && process.arch === "x64"
      ? ["dml", "cpu"]
      : ["cpu"];
  activeProvider = providers[0];

  const createSession = (executionProviders) =>
    ortNs.InferenceSession.create(modelPath, {
      executionProviders,
      // ⚠️ 必须 disabled —— 见文件头注释（否则段错误崩溃）
      graphOptimizationLevel: "disabled",
    });

  try {
    session = await createSession(providers);
  } catch (error) {
    // DirectML 不可用时退回 CPU，而不是整体失败
    if (activeProvider !== "cpu") {
      console.error(
        `[PixAI] ${activeProvider} 初始化失败，退回 CPU:`,
        error.message
      );
      activeProvider = "cpu";
      session = await createSession(["cpu"]);
    } else {
      throw error;
    }
  }

  pickOutputs();

  process.send?.({
    type: "ready",
    provider: activeProvider,
    tagCount: vocab.length,
    categories: categoryOrder,
    embeddingDim: 1024,
    embeddingOutput: embeddingOutputName,
    hasEmbedding: embeddingOutputName !== null,
  });
}

async function handleTag(message) {
  const photos = Array.isArray(message.photos) ? message.photos : [];
  const overrides = message.thresholds ?? {};
  const thresholds = {};
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    thresholds[key] =
      typeof overrides[key] === "number"
        ? overrides[key]
        : DEFAULT_THRESHOLDS[key];
  }
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
        3,
        IMAGE_SIZE,
        IMAGE_SIZE,
      ]);
      const outputs = await session.run({ [inputName]: input });

      const logits = outputs[logitsOutputName]?.data;
      if (!logits || logits.length !== vocab.length) {
        throw new Error(
          `标签输出异常：期望 ${vocab.length} 个分数，实际 ${logits?.length ?? 0}`
        );
      }

      // 阈值判定放在 worker 内 —— 否则每张图 30,877 个分数全过 IPC，代价极高。
      // ⚠️ PixAI 保留 rating（WD14 是丢弃 category 9），因为分级是新模型的主要收益之一。
      const tags = [];
      for (let i = 0; i < logits.length; i++) {
        const meta = vocab[i];
        const limit = thresholds[meta.category] ?? 0.2;
        const score = sigmoid(logits[i]);
        // 官方是**严格大于**（tagger_pipeline.py: mask = prob_c > threshold_c）
        if (score > limit) {
          tags.push({
            category: meta.category,
            categoryIndex: meta.categoryIndex,
            name: meta.name,
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
