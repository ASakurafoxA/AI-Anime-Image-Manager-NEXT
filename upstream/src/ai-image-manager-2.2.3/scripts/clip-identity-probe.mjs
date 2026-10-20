/**
 * 对照实验：既有的 Chinese-CLIP 能不能按「角色」分组？
 *
 * 为什么要试这个：CLIP 向量全库 7.7 万张**已经算好存在库里了**，
 * 如果一个够用，就完全不需要下载新模型、也不需要重扫。
 *
 * 三路对比（同一批 12 个角色、每个角色 25 张）：
 *   ① 整图 CLIP 向量        —— 对应库里已有的向量，零额外成本
 *   ② 人脸裁切 CLIP 向量    —— 与 SFace 在同等条件下比（只用脸）
 *   ③ 角色名文本向量做零样本检索 —— 能不能直接「按名字找角色」
 *
 * 用法：electron.exe scripts/clip-identity-probe.mjs <identity_result.json> <out.json> [modelsDir]
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { InferenceSession, Tensor } = require("onnxruntime-node");

const [inPath, outPath] = process.argv.slice(2, 4);
const MODELS_DIR = process.argv[4] || "F:\\AI Anime Image Manager NEXT\\models";

const CLIP_ONNX = path.join(
  MODELS_DIR,
  "Xenova",
  "chinese-clip-vit-base-patch16",
  "onnx",
  "model_quantized.onnx"
);
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const SIZE = 224;

const session = await InferenceSession.create(CLIP_ONNX, {
  executionProviders: ["cpu"],
  logSeverityLevel: 3,
});

function buildFeeds(provided) {
  const feeds = { ...provided };
  const have = new Set(Object.keys(feeds));
  for (const name of session.inputNames ?? []) {
    if (!have.has(name)) {
      feeds[name] = new Tensor("int64", new BigInt64Array(16), [1, 16]);
    }
  }
  return feeds;
}

function toNCHWClIP(rgb, size) {
  const ppc = size * size;
  const out = new Float32Array(3 * ppc);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[c * ppc + y * size + x] = (rgb[s + c] / 255 - MEAN[c]) / STD[c];
      }
    }
  }
  return out;
}

async function embedImageBuffer(input, isRaw, w, h) {
  const pipeline = isRaw
    ? sharp(input, { raw: { channels: 3, width: w, height: h } })
    : sharp(input, { failOn: "none" }).rotate();
  const { data, info } = await pipeline
    .resize(SIZE, SIZE, { fit: "cover", position: "center" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const out = await session.run(
    buildFeeds({
      pixel_values: new Tensor("float32", toNCHWClIP(rgb, SIZE), [1, 3, SIZE, SIZE]),
    })
  );
  const key = session.outputNames.find((n) => /image_embeds/i.test(n)) ?? session.outputNames[0];
  const vec = Array.from(out[key].data);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / (norm || 1));
}

async function cropFacePng(filePath, bbox) {
  const meta = await sharp(filePath, { failOn: "none" }).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!(W && H)) return null;
  const ex = 0.2;
  const left = Math.max(0, Math.round(bbox.x - bbox.width * ex));
  const top = Math.max(0, Math.round(bbox.y - bbox.height * ex));
  const width = Math.min(W - left, Math.round(bbox.width * (1 + 2 * ex)));
  const height = Math.min(H - top, Math.round(bbox.height * (1 + 2 * ex)));
  if (width < 16 || height < 16) return null;
  return sharp(filePath, { failOn: "none" })
    .extract({ left, top, width, height })
    .png()
    .toBuffer();
}

// ---- 文本塔：角色名 ----
let textEmbed = async () => null;
try {
  const { AutoTokenizer, env } = await import("@xenova/transformers");
  env.allowRemoteModels = false;
  env.localModelPath = MODELS_DIR;
  const tok = await AutoTokenizer.from_pretrained("Xenova/chinese-clip-vit-base-patch16");
  textEmbed = async (text) => {
    const enc = await tok([text], { padding: "max_length", truncation: true, max_length: 52 });
    const ids = BigInt64Array.from(Array.from(enc.input_ids.data, (v) => BigInt(v)));
    const mask = BigInt64Array.from(Array.from(enc.attention_mask.data, (v) => BigInt(v)));
    const dims = [1, enc.input_ids.dims[1]];
    const feeds = buildFeeds({
      input_ids: new Tensor("int64", ids, dims),
      attention_mask: new Tensor("int64", mask, dims),
      pixel_values: new Tensor("float32", new Float32Array(3 * SIZE * SIZE), [1, 3, SIZE, SIZE]),
    });
    const out = await session.run(feeds);
    const key = session.outputNames.find((n) => /text_embeds/i.test(n)) ?? session.outputNames[0];
    const vec = Array.from(out[key].data);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / (norm || 1));
  };
  console.error("[clip] 文本塔分词器加载成功");
} catch (err) {
  console.error(`[clip] 文本塔不可用（跳过零样本检索）: ${err.message}`);
}

const records = JSON.parse(fs.readFileSync(inPath, "utf-8")).records;
const out = [];
let done = 0;
const t0 = Date.now();
for (const r of records) {
  const item = { character: r.character, id: r.id, path: r.path, whole: null, face: null, error: null };
  try {
    item.whole = await embedImageBuffer(r.path, false);
    if (r.bbox && (r.faces ?? 0) > 0) {
      const crop = await cropFacePng(r.path, r.bbox);
      if (crop) item.face = await embedImageBuffer(crop, false);
    }
  } catch (err) {
    item.error = err instanceof Error ? err.message : String(err);
  }
  out.push(item);
  done++;
  if (done % 50 === 0) console.error(`[clip] ${done}/${records.length} ${Math.round((Date.now() - t0) / 1000)}s`);
}

// 先把昂贵的图像向量落盘，再算文本向量（文本塔崩了也不丢结果）
fs.writeFileSync(outPath, JSON.stringify({ records: out, textEmbeddings: {} }, null, 1));
console.error(`[clip] 图像向量已落盘 ${out.length} 张，用时 ${Math.round((Date.now() - t0) / 1000)}s`);

// 角色名文本向量
const names = [...new Set(records.map((r) => r.character))];
const texts = {};
for (const n of names) {
  try {
    const e = await textEmbed(`一张${n}的图片`);
    if (e) texts[n] = e;
  } catch (err) {
    console.error(`[clip] 文本向量失败 ${n}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

fs.writeFileSync(outPath, JSON.stringify({ records: out, textEmbeddings: texts }, null, 1));
console.error(
  `[clip] 整图向量 ${out.filter((o) => o.whole).length}，人脸裁切向量 ${out.filter((o) => o.face).length}，文本向量 ${Object.keys(texts).length}/${names.length}`
);
console.error(`[clip] -> ${outPath}`);
