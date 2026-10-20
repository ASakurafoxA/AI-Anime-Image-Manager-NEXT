/**
 * CCIP 角色区分能力实测（只读，不改任何数据）。
 *
 * 目的：用与 CLIP 完全相同的评估口径，量化 CCIP 的"角色内 vs 角色间"差距，
 * 直接回答"换 CCIP 值不值"（CLIP 实测：角色内 0.858 / 角色间 0.800，只差 0.06）。
 *
 * 用法：electron.exe scripts/verify-ccip-quality.mjs <modelsDir> <roles> <perRole> <threads>
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import sqlite3 from "better-sqlite3";

const require = createRequire(import.meta.url);
const { InferenceSession, Tensor } = require("onnxruntime-node");

const DB = "F:\\AI Anime Image Manager NEXT\\data\\ai-image-manager.db";
const modelsDir = process.argv[2];
const ROLE_COUNT = Number(process.argv[3] || 20);
const PER_ROLE = Number(process.argv[4] || 8);
const THREADS = Number(process.argv[5] || 8);

const SIZE = 384;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

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

function l2(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float64Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

function cos(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

// ── 1) 取角色样本 ──────────────────────────────────────────────
const db = new sqlite3(DB, { readonly: true, fileMustExist: true });
const root = db
  .prepare("SELECT id FROM tags WHERE parent_id IS NULL AND name = '角色'")
  .get();
const tags = db
  .prepare(
    `WITH RECURSIVE sub(id, name) AS (
       SELECT id, name FROM tags WHERE parent_id = ?
       UNION ALL SELECT t.id, t.name FROM tags t JOIN sub s ON t.parent_id = s.id)
     SELECT id, name FROM sub`
  )
  .all(root.id);

const countStmt = db.prepare(
  `SELECT COUNT(DISTINCT pt.photo_id) c FROM photo_tags pt
     JOIN photos p ON p.id = pt.photo_id AND p.deleted_at IS NULL
     WHERE pt.tag_id = ?`
);
const photoStmt = db.prepare(
  `SELECT DISTINCT p.path FROM photo_tags pt
     JOIN photos p ON p.id = pt.photo_id AND p.deleted_at IS NULL
     WHERE pt.tag_id = ? LIMIT ?`
);

const samples = []; // {role, path}
for (const t of tags) {
  if (samples.length >= ROLE_COUNT) break;
  if (countStmt.get(t.id).c < PER_ROLE) continue;
  const photos = photoStmt.all(t.id, PER_ROLE);
  const usable = [];
  for (const p of photos) {
    const file = p.path;
    if (file && fs.existsSync(file)) usable.push(file);
  }
  if (usable.length >= Math.min(4, PER_ROLE)) {
    samples.push({ role: t.name, paths: usable });
  }
}
db.close();

const flatSamples = [];
for (const s of samples) {
  for (const p of s.paths) flatSamples.push({ role: s.role, path: p });
}
console.error(
  `[ccip] 角色 ${samples.length} 个，图片 ${flatSamples.length} 张，线程 ${THREADS}`
);

// ── 2) 抽特征 ──────────────────────────────────────────────────
const session = await InferenceSession.create(
  path.join(modelsDir, "ccip", "model_feat.onnx"),
  {
    executionProviders: ["cpu"],
    intraOpNumThreads: THREADS,
    interOpNumThreads: 1,
    logSeverityLevel: 3,
  }
);
const inputName = session.inputNames[0];
const outputName = session.outputNames[0];

const vectors = [];
let failed = 0;
const t0 = Date.now();
for (let i = 0; i < flatSamples.length; i++) {
  const s = flatSamples[i];
  try {
    const { data } = await sharp(s.path, { failOn: "none" })
      .rotate()
      .resize(SIZE, SIZE, { fit: "cover", position: "center" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const out = await session.run({
      [inputName]: new Tensor("float32", toNCHW(rgb), [1, 3, SIZE, SIZE]),
    });
    vectors.push({ role: s.role, vec: l2(out[outputName].data) });
  } catch {
    failed++;
  }
  if ((i + 1) % 20 === 0) {
    const el = (Date.now() - t0) / 1000;
    console.error(
      `[ccip] ${i + 1}/${flatSamples.length} 失败 ${failed} | ${(i + 1 / Math.max(el, 0.01)).toFixed(1)} 张/秒 | ${el.toFixed(0)}s`
    );
  }
}
console.error(
  `[ccip] 特征完成 ${vectors.length} 条（失败 ${failed}），用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`
);

// ── 3) 角色内 vs 角色间 ────────────────────────────────────────
const same = [];
const diff = [];
for (let i = 0; i < vectors.length; i++) {
  for (let j = i + 1; j < vectors.length; j++) {
    const v = cos(vectors[i].vec, vectors[j].vec);
    if (vectors[i].role === vectors[j].role) same.push(v);
    else diff.push(v);
  }
}
const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
};
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
};

console.log("\n=== CCIP 角色区分能力（与 CLIP 同口径）===");
console.log(`角色数 ${samples.length}，图片 ${vectors.length}`);
console.log(
  `同一角色  N=${same.length}  平均 ${avg(same).toFixed(4)}  中位 ${med(same).toFixed(4)}  p10 ${pct(same, 0.1).toFixed(4)}`
);
console.log(
  `不同角色  N=${diff.length}  平均 ${avg(diff).toFixed(4)}  中位 ${med(diff).toFixed(4)}  p90 ${pct(diff, 0.9).toFixed(4)}`
);
console.log(
  `★ 差距（均值） ${(avg(same) - avg(diff)).toFixed(4)}   （CLIP 基准只有 0.0578）`
);
console.log(
  `★ 差距（中位） ${(med(same) - med(diff)).toFixed(4)}   （CLIP 基准 0.0587）`
);

// ── 4) 贪心聚类纯度（与 CLIP 同口径）────────────────────────────
const MIN_SEED = 3;
function clusterByCentroid(thresh) {
  const clusters = [];
  for (const item of vectors) {
    let best = -1;
    let bestSim = -1;
    for (let ci = 0; ci < clusters.length; ci++) {
      const s = cos(item.vec, clusters[ci].centroid);
      if (s > bestSim) {
        bestSim = s;
        best = ci;
      }
    }
    if (best >= 0 && bestSim >= thresh) {
      const c = clusters[best];
      c.members.push(item);
      const sum = new Float64Array(item.vec.length);
      for (const m of c.members) {
        for (let k = 0; k < sum.length; k++) sum[k] += m.vec[k];
      }
      c.centroid = l2(sum);
    } else {
      clusters.push({ members: [item], centroid: Float64Array.from(item.vec) });
    }
  }
  return clusters.filter((c) => c.members.length >= MIN_SEED);
}

console.log("\n阈值 | 组数 | 覆盖 | 平均纯度 | 纯度>=0.9 占比");
for (const t of [0.7, 0.8, 0.85, 0.9, 0.93, 0.95]) {
  const cs = clusterByCentroid(t);
  let puritySum = 0;
  let good = 0;
  let assigned = 0;
  for (const c of cs) {
    const counts = new Map();
    for (const m of c.members) {
      counts.set(m.role, (counts.get(m.role) || 0) + 1);
    }
    const top = [...counts.values()].sort((a, b) => b - a)[0];
    puritySum += top / c.members.length;
    assigned += c.members.length;
    if (top / c.members.length >= 0.9) good++;
  }
  console.log(
    `${t.toFixed(2)} | ${cs.length} | ${assigned} | ${(puritySum / (cs.length || 1)).toFixed(3)} | ${cs.length ? ((good / cs.length) * 100).toFixed(0) : 0}%`
  );
}