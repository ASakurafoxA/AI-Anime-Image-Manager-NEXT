/**
 * 实测 LanceDB 单次 vectorSearch 的耗时（决定聚类实现方案）。
 * 用法：electron.exe scripts/probe-lance-search-timing.mjs <vectorsDir> [queries] [limit]
 */
import * as lancedb from "@lancedb/lancedb";

const vectorsDir = process.argv[2];
const QUERIES = Number(process.argv[3] || 200);
const LIMIT = Number(process.argv[4] || 12);

const db = await lancedb.connect(vectorsDir);
const table = await db.openTable("photo_embeddings");

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v?.toArray) return Array.from(v.toArray());
  if (ArrayBuffer.isView(v)) return Array.from(v);
  return Array.from(v);
}

const rows = await table.query().limit(QUERIES).toArray();
console.log(`取到 ${rows.length} 个查询向量`);

// 单次查询耗时
let t0 = Date.now();
for (const r of rows) {
  await table.vectorSearch(toArray(r.vector)).distanceType("l2").limit(LIMIT).toArray();
}
const per = (Date.now() - t0) / rows.length;
console.log(`★ 单次 vectorSearch(limit=${LIMIT}) 平均 ${per.toFixed(2)} ms`);
console.log(`  按 77296 张推算（单线程）: ${(per * 77296 / 1000 / 60).toFixed(1)} 分钟`);

// 全表读取耗时（备用方案：读进内存自己算）
t0 = Date.now();
const all = await table.query().select(["photo_id", "vector"]).toArray();
const readMs = Date.now() - t0;
console.log(`★ 全表读取 ${all.length} 行耗时 ${(readMs / 1000).toFixed(1)} s`);
const sample = toArray(all[0].vector);
const bytes = all.length * sample.length * 4;
console.log(`  维度 ${sample.length}，估算内存 ${(bytes / 1048576).toFixed(0)} MB（float32）`);

// 内存里自己算相似度的速度（1000 个查询 vs 全部）
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
const q = toArray(all[0].vector);
t0 = Date.now();
const SUBSET = 2000;
for (let i = 0; i < SUBSET; i++) {
  dot(q, toArray(all[i].vector));
}
const bruteMs = Date.now() - t0;
console.log(
  `★ 内存暴力比对：${SUBSET} 次点积 ${bruteMs} ms → 单向量扫全库 ${(bruteMs / SUBSET * all.length / 1000).toFixed(2)} s`
);