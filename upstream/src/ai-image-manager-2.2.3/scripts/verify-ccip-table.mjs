/**
 * CCIP 特征表端到端验证（**临时目录，完全不碰真实向量库**）。
 *
 * 验证链条：抽特征 → 按应用同样的 schema 建表写入 → vectorSearch 检索 →
 * 相似度换算（1 - d/2）是否等于余弦 → 同角色是否比不同角色更像。
 *
 * 用法：electron.exe scripts/verify-ccip-table.mjs <modelsDir> <tmpVectorsDir>
 */
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import sqlite3 from "better-sqlite3";
import * as lancedb from "@lancedb/lancedb";
import {
  Field,
  FixedSizeList,
  Float32,
  Int32,
  Schema,
} from "apache-arrow";

const require = createRequire(import.meta.url);
const { InferenceSession, Tensor } = require("onnxruntime-node");

const DB = "F:\\AI Anime Image Manager NEXT\\data\\ai-image-manager.db";
const modelsDir = process.argv[2];
const tmpDir = process.argv[3] || path.join(os.tmpdir(), "ccip-table-verify");
const SIZE = 384;
const DIM = 768;
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
function l2normalize(data) {
  let norm = 0;
  for (let i = 0; i < data.length; i++) norm += data[i] * data[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.round((data[i] / norm) * 1e6) / 1e6;
  return out;
}
function cos(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}
function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v?.toArray) return Array.from(v.toArray());
  if (ArrayBuffer.isView(v)) return Array.from(v);
  return Array.from(v);
}

// ── 取 3 个角色各 4 张 ────────────────────────────────────────
const db = new sqlite3(DB, { readonly: true, fileMustExist: true });
const root = db.prepare("SELECT id FROM tags WHERE parent_id IS NULL AND name = '角色'").get();
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
     JOIN photos p ON p.id = pt.photo_id AND p.deleted_at IS NULL WHERE pt.tag_id = ?`
);
const photoStmt = db.prepare(
  `SELECT DISTINCT p.id, p.path FROM photo_tags pt
     JOIN photos p ON p.id = pt.photo_id AND p.deleted_at IS NULL
     WHERE pt.tag_id = ? LIMIT 6`
);

const samples = [];
for (const t of tags) {
  if (samples.length >= 3) break;
  if (countStmt.get(t.id).c < 6) continue;
  const rows = photoStmt.all(t.id).filter((r) => r.path && fs.existsSync(r.path));
  if (rows.length >= 4) samples.push({ role: t.name, rows: rows.slice(0, 4) });
}
db.close();
const flat = [];
for (const s of samples) for (const r of s.rows) flat.push({ role: s.role, id: r.id, path: r.path });
console.error(`[verify] 角色 ${samples.length} 个，图片 ${flat.length} 张`);

// ── 抽特征 ────────────────────────────────────────────────────
const session = await InferenceSession.create(path.join(modelsDir, "ccip", "model_feat.onnx"), {
  executionProviders: ["cpu"],
  intraOpNumThreads: 8,
  logSeverityLevel: 3,
});
const vectors = [];
for (const item of flat) {
  const { data } = await sharp(item.path, { failOn: "none" })
    .rotate()
    .resize(SIZE, SIZE, { fit: "cover", position: "center" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const out = await session.run({
    [session.inputNames[0]]: new Tensor("float32", toNCHW(rgb), [1, 3, SIZE, SIZE]),
  });
  const vec = l2normalize(out[session.outputNames[0]].data);
  if (vec.length !== DIM) throw new Error(`维度异常 ${vec.length}`);
  vectors.push({ role: item.role, id: item.id, vec });
}
console.error(`[verify] 特征 ${vectors.length} 条，维度 ${vectors[0].vec.length}`);

// ── 建临时表（与应用同样的 schema）并写入 ──────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });
const lance = await lancedb.connect(tmpDir);
const schema = new Schema([
  new Field("photo_id", new Int32()),
  new Field("vector", new FixedSizeList(DIM, new Field("item", new Float32()))),
]);
const table = await lance.createEmptyTable("ccip_embeddings", schema);
await table.add(vectors.map((v) => ({ photo_id: v.id, vector: v.vec })));
const count = await table.countRows();
console.error(`[verify] 写入 ${count} 行`);

// ── 检索验证 ──────────────────────────────────────────────────
const probe = vectors[0];
const hits = await table.vectorSearch(probe.vec).distanceType("l2").limit(6).toArray();
console.log("\n=== LanceDB 检索验证（用第 1 张当查询）===");
console.log(`查询图：photo ${probe.id}（角色「${probe.role}」）`);
for (const row of hits) {
  const pid = row.photo_id;
  const d = Number(row._distance);
  const simFromLance = Math.max(0, 1 - d / 2);
  const other = vectors.find((v) => v.id === pid);
  const trueCos = other ? cos(probe.vec, other.vec) : NaN;
  const sameRole = other ? other.role === probe.role : false;
  console.log(
    `  photo ${String(pid).padStart(6)} | 距离 ${d.toFixed(4)} | 换算相似度 ${simFromLance.toFixed(4)} | 真实余弦 ${trueCos.toFixed(4)} | ${sameRole ? "同角色 ✓" : "不同角色 ✗"}`
  );
}

// 换算是否与余弦一致（关键）
let maxDiff = 0;
for (const row of hits) {
  const other = vectors.find((v) => v.id === row.photo_id);
  if (!other) continue;
  const sim = Math.max(0, 1 - Number(row._distance) / 2);
  maxDiff = Math.max(maxDiff, Math.abs(sim - cos(probe.vec, other.vec)));
}
console.log(`\n换算误差最大 ${maxDiff.toFixed(6)}（应接近 0）`);

// 同角色 vs 不同角色（表里的数据）
const same = [];
const diff = [];
for (let i = 0; i < vectors.length; i++) {
  for (let j = i + 1; j < vectors.length; j++) {
    const c = cos(vectors[i].vec, vectors[j].vec);
    (vectors[i].role === vectors[j].role ? same : diff).push(c);
  }
}
const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
console.log(
  `同角色 平均 ${avg(same).toFixed(4)}（n=${same.length}） | 不同角色 平均 ${avg(diff).toFixed(4)}（n=${diff.length}）`
);
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n临时库已清理：${tmpDir}`);