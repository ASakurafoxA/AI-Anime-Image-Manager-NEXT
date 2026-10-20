/**
 * 修正版：大样本 CCIP 特征 + 正确的完整距离矩阵。
 *
 * 上一版的 bug：分块时只把「当前块」喂进 metrics 模型，输出是 [块, 块]，
 * 却按 [块, 全量] 的宽度去取数据 -> 越界 -> nan。
 * 正确做法：输出矩阵是 [batch, batch]，要拿到「所有两两距离」必须一次把全部特征喂进去。
 *
 * 特征会缓存到 big_ccip_feats.json，重跑不用重新算。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { InferenceSession, Tensor } = require("onnxruntime-node");

const [inPath, featPath, outPath, modelDir] = process.argv.slice(2, 6);
const SIZE = 384;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const featSession = await InferenceSession.create(path.join(modelDir, "ccip", "model_feat.onnx"), {
  executionProviders: ["cpu"],
  logSeverityLevel: 3,
});

let cached = null;
if (fs.existsSync(featPath)) {
  cached = JSON.parse(fs.readFileSync(featPath, "utf-8"));
  console.error(`[fix] 使用缓存特征 ${cached.rows.length} 条`);
}

let rows = cached?.rows;
let feats = cached?.feats;

if (!feats) {
  const input = JSON.parse(fs.readFileSync(inPath, "utf-8"));
  rows = [];
  feats = [];

  function toNCHW(rgb) {
    const ppc = SIZE * SIZE;
    const out = new Float32Array(3 * ppc);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const s = (y * SIZE + x) * 3;
        for (let c = 0; c < 3; c++) out[c * ppc + y * SIZE + x] = (rgb[s + c] / 255 - MEAN[c]) / STD[c];
      }
    }
    return out;
  }

  let done = 0;
  const t0 = Date.now();
  for (const r of input) {
    try {
      const { data } = await sharp(r.path, { failOn: "none" })
        .rotate()
        .resize(SIZE, SIZE, { fit: "cover", position: "center" })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const out = await featSession.run({
        [featSession.inputNames[0]]: new Tensor("float32", toNCHW(rgb), [1, 3, SIZE, SIZE]),
      });
      feats.push(Array.from(out[featSession.outputNames[0]].data));
      rows.push({ id: r.id, character: r.character, path: r.path });
    } catch (err) {
      console.error(`[fix] 跳过 ${r.id}: ${err.message}`);
    }
    done++;
    if (done % 200 === 0) console.error(`[fix] 特征 ${done}/${input.length} ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  fs.writeFileSync(featPath, JSON.stringify({ rows, feats }));
  console.error(`[fix] 特征已缓存 ${feats.length} 条`);
}

// ---- 正确的距离矩阵：一次喂全部特征，输出 [N, N] ----
const n = feats.length;
const flat = new Float32Array(n * 768);
feats.forEach((v, i) => flat.set(v, i * 768));
console.error(`[fix] 计算 ${n}x${n} 距离矩阵（输出约 ${Math.round((n * n * 4) / 1048576)}MB）`);
const metricsSession = await InferenceSession.create(path.join(modelDir, "ccip", "model_metrics.onnx"), {
  executionProviders: ["cpu"],
  logSeverityLevel: 3,
});
const out = await metricsSession.run({
  [metricsSession.inputNames[0]]: new Tensor("float32", flat, [n, 768]),
});
const d = out[metricsSession.outputNames[0]];
console.error(`[fix] 输出形状 ${JSON.stringify(d.dims)}`);

const mat = [];
for (let r = 0; r < n; r++) {
  const row = new Array(n);
  for (let c = 0; c < n; c++) {
    const v = d.data[r * n + c];
    row[c] = Number.isFinite(v) ? Number(v.toFixed(6)) : null;
  }
  mat.push(row);
}

// 自检：对角线应接近 0，矩阵应对称
let diagSum = 0;
let diagNaN = 0;
for (let i = 0; i < n; i++) {
  const v = mat[i][i];
  if (v === null) diagNaN++;
  else diagSum += v;
}
let asym = 0;
for (let i = 0; i < n; i += 7) {
  for (let j = 0; j < n; j += 11) {
    if (mat[i][j] !== null && mat[j][i] !== null && Math.abs(mat[i][j] - mat[j][i]) > 1e-3) asym++;
  }
}
console.error(`[fix] 自检: 对角线非空 ${n - diagNaN}/${n}，均值 ${(diagSum / Math.max(1, n - diagNaN)).toFixed(6)}；抽样不对称对数 ${asym}`);

fs.writeFileSync(outPath, JSON.stringify({ rows, mat }));
console.error(`[fix] -> ${outPath}`);
