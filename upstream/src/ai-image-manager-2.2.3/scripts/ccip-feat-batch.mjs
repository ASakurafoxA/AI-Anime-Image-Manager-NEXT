/**
 * CCIP 特征批量抽取（全库测试用，分片）。
 *
 * 用法：electron.exe scripts/ccip-feat-batch.mjs <chunk.json> <out.json> <modelsDir> [线程数]
 * 每 200 张落盘一次，避免中途意外丢进度。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { InferenceSession, Tensor } = require("onnxruntime-node");

const [chunkPath, outPath, modelDir, threadsArg] = process.argv.slice(2, 6);
const THREADS = Math.max(1, Number(threadsArg || 1));
const SIZE = 384;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const TAG = path.basename(chunkPath).replace(".json", "");

const session = await InferenceSession.create(path.join(modelDir, "ccip", "model_feat.onnx"), {
  executionProviders: ["cpu"],
  intraOpNumThreads: THREADS,
  interOpNumThreads: 1,
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

const input = JSON.parse(fs.readFileSync(chunkPath, "utf-8"));
const rows = [];
const feats = [];
let done = 0;
let failed = 0;
const t0 = Date.now();

function save() {
  fs.writeFileSync(outPath, JSON.stringify({ rows, feats, done, failed, threads: THREADS }));
}

// 支持断点续跑
if (fs.existsSync(outPath)) {
  try {
    const prev = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    if (prev.rows?.length) {
      rows.push(...prev.rows);
      feats.push(...prev.feats);
      done = prev.done ?? rows.length;
      failed = prev.failed ?? 0;
      console.error(`[${TAG}] 续跑：已有 ${rows.length} 条`);
    }
  } catch {
    /* 忽略损坏的中间文件 */
  }
}
const startAt = rows.length;

for (let i = startAt; i < input.length; i++) {
  const r = input[i];
  try {
    const { data } = await sharp(r.path, { failOn: "none" })
      .rotate()
      .resize(SIZE, SIZE, { fit: "cover", position: "center" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const out = await session.run({
      [session.inputNames[0]]: new Tensor("float32", toNCHW(rgb), [1, 3, SIZE, SIZE]),
    });
    feats.push(Array.from(out[session.outputNames[0]].data));
    rows.push({ id: r.id, path: r.path });
  } catch {
    failed++;
  }
  done++;
  if (done % 200 === 0) {
    save();
    const el = (Date.now() - t0) / 1000;
    const rate = (done - startAt) / Math.max(1, el);
    console.error(
      `[${TAG}] ${done}/${input.length} 已存 ${rows.length} 失败 ${failed} | ${rate.toFixed(2)} 张/秒 | 预计剩余 ${Math.round((input.length - done) / Math.max(0.01, rate) / 60)} 分钟`
    );
  }
}
save();
console.error(`[${TAG}] 完成 ${rows.length} 条（失败 ${failed}），用时 ${Math.round((Date.now() - t0) / 1000)}s -> ${outPath}`);
