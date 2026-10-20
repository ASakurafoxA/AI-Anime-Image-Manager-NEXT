/**
 * CCIP（deepghs/ccip-caformer_b36-24）角色相似度评测。
 *
 * 结构：model_feat.onnx  384x384 -> 768 维特征
 *       model_metrics.onnx [N,768] -> [N,N] 相似度矩阵（官方阈值 0.2132, F1 0.941）
 *
 * 用法：electron.exe scripts/ccip-probe.mjs <identity_result.json> <out.json> <modelDir>
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { InferenceSession, Tensor } = require("onnxruntime-node");

const [inPath, outPath, modelDir] = process.argv.slice(2, 5);
const SIZE = 384;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const featSession = await InferenceSession.create(path.join(modelDir, "ccip", "model_feat.onnx"), {
  executionProviders: ["cpu"],
  logSeverityLevel: 3,
});
const metricsSession = await InferenceSession.create(path.join(modelDir, "ccip", "model_metrics.onnx"), {
  executionProviders: ["cpu"],
  logSeverityLevel: 3,
});

function toNCHW(rgb) {
  const ppc = SIZE * SIZE;
  const out = new Float32Array(3 * ppc);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const s = (y * SIZE + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[c * ppc + y * SIZE + x] = (rgb[s + c] / 255 - MEAN[c]) / STD[c];
      }
    }
  }
  return out;
}

async function featOf(input) {
  const { data } = await input
    .resize(SIZE, SIZE, { fit: "cover", position: "center" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const out = await featSession.run({
    [featSession.inputNames[0]]: new Tensor("float32", toNCHW(rgb), [1, 3, SIZE, SIZE]),
  });
  return Array.from(out[featSession.outputNames[0]].data);
}

async function featWhole(file) {
  return featOf(sharp(file, { failOn: "none" }).rotate());
}

async function featCrop(file, bbox) {
  const meta = await sharp(file, { failOn: "none" }).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!(W && H)) return null;
  const ex = 0.2;
  const left = Math.max(0, Math.round(bbox.x - bbox.width * ex));
  const top = Math.max(0, Math.round(bbox.y - bbox.height * ex));
  const width = Math.min(W - left, Math.round(bbox.width * (1 + 2 * ex)));
  const height = Math.min(H - top, Math.round(bbox.height * (1 + 2 * ex)));
  if (width < 16 || height < 16) return null;
  return featOf(sharp(file, { failOn: "none" }).extract({ left, top, width, height }));
}

const records = JSON.parse(fs.readFileSync(inPath, "utf-8")).records;
const out = [];
let done = 0;
const t0 = Date.now();
for (const r of records) {
  const item = { character: r.character, id: r.id, whole: null, face: null, error: null };
  try {
    item.whole = await featWhole(r.path);
    if (r.bbox && (r.faces ?? 0) > 0) item.face = await featCrop(r.path, r.bbox);
  } catch (err) {
    item.error = err instanceof Error ? err.message : String(err);
  }
  out.push(item);
  done++;
  if (done % 25 === 0) console.error(`[ccip] ${done}/${records.length} ${Math.round((Date.now() - t0) / 1000)}s`);
}

/** 用官方 metrics 头算 N x N 相似度矩阵 */
async function matrix(vectors) {
  const idx = vectors.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  const flat = new Float32Array(idx.length * 768);
  idx.forEach((i, k) => flat.set(vectors[i], k * 768));
  const t = new Tensor("float32", flat, [idx.length, 768]);
  const res = await metricsSession.run({ [metricsSession.inputNames[0]]: t });
  const d = res[metricsSession.outputNames[0]];
  const N = idx.length;
  const mat = Array.from({ length: N }, (_, a) => Array.from({ length: N }, (_, b) => d.data[a * N + b]));
  return { idx, mat };
}

const whole = await matrix(out.map((o) => o.whole));
const face = await matrix(out.map((o) => o.face));

fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      records: out,
      wholeMatrix: { idx: whole.idx, characters: whole.idx.map((i) => out[i].character), mat: whole.mat },
      faceMatrix: { idx: face.idx, characters: face.idx.map((i) => out[i].character), mat: face.mat },
    },
    null,
    1
  )
);
const flat = whole.mat.flat();
flat.sort((a, b) => a - b);
console.error(`[ccip] 完成 ${out.length}，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
console.error(`[ccip] 整图相似度矩阵 ${whole.idx.length}x${whole.idx.length}；人脸裁切 ${face.idx.length}x${face.idx.length}`);
console.error(`[ccip] 整图相似度分位: p10=${flat[Math.floor(flat.length*0.1)].toFixed(3)} p50=${flat[Math.floor(flat.length*0.5)].toFixed(3)} p90=${flat[Math.floor(flat.length*0.9)].toFixed(3)} max=${flat.at(-1).toFixed(3)}`);
console.error(`[ccip] -> ${outPath}`);
