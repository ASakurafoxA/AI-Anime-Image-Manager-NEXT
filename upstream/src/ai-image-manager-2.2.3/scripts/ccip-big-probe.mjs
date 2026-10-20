/**
 * 大样本 CCIP 整图特征 + 完整距离矩阵（只输出整图，因为整图在小样本上最好）。
 * 用法：electron.exe scripts/ccip-big-probe.mjs <samplePaths.json> <out.json> <modelDir>
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
      for (let c = 0; c < 3; c++) out[c * ppc + y * SIZE + x] = (rgb[s + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  return out;
}

const rows = JSON.parse(fs.readFileSync(inPath, "utf-8"));
const feats = [];
const okRows = [];
let done = 0;
const t0 = Date.now();
for (const r of rows) {
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
    okRows.push({ id: r.id, character: r.character, path: r.path });
  } catch (err) {
    console.error(`[bigccip] 跳过 ${r.id}: ${err.message}`);
  }
  done++;
  if (done % 100 === 0) console.error(`[bigccip] ${done}/${rows.length} ${Math.round((Date.now() - t0) / 1000)}s`);
}

// 分块算完整距离矩阵
const n = feats.length;
const mat = [];
const CHUNK = 256;
for (let i = 0; i < n; i += CHUNK) {
  const a = feats.slice(i, i + CHUNK);
  const flat = new Float32Array(a.length * 768);
  a.forEach((v, k) => flat.set(v, k * 768));
  const out = await metricsSession.run({
    [metricsSession.inputNames[0]]: new Tensor("float32", flat, [a.length, 768]),
  });
  const d = out[metricsSession.outputNames[0]];
  for (let r = 0; r < a.length; r++) {
    mat.push(Array.from({ length: n }, (_, c) => d.data[r * n + c]));
  }
  console.error(`[bigccip] 距离矩阵 ${Math.min(i + CHUNK, n)}/${n}`);
}

fs.writeFileSync(
  outPath,
  JSON.stringify({ rows: okRows, mat }),
  )
;
console.error(`[bigccip] 完成 ${n} 张，用时 ${Math.round((Date.now() - t0) / 1000)}s -> ${outPath}`);
