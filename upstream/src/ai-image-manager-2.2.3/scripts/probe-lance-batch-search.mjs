/**
 * 探测 LanceDB 是否支持**批量** vectorSearch（一次传多个查询向量）。
 *
 * 为什么要问这个：全库角色聚类需要给 7.7 万张各找 top-K 近邻。
 * 逐张查（每次 ~10-30ms）要几十分钟；若支持批量，可一次几百个，快得多。
 *
 * 用法：electron.exe scripts/probe-lance-batch-search.mjs <vectorsDir>
 */
import * as lancedb from "@lancedb/lancedb";

const vectorsDir = process.argv[2];
const db = await lancedb.connect(vectorsDir);
const names = await db.tableNames();
console.log("tables:", JSON.stringify(names));

const table = await db.openTable("photo_embeddings");
const rows = await table.query().limit(6).toArray();
console.log("sample rows:", rows.length, "keys:", JSON.stringify(Object.keys(rows[0] ?? {})));

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v?.toArray) return Array.from(v.toArray());
  if (ArrayBuffer.isView(v)) return Array.from(v);
  return Array.from(v);
}

const vectors = rows.map((r) => toArray(r.vector));
console.log("queries:", vectors.length, "dim:", vectors[0]?.length);

// 单个查询（基线）
try {
  const one = await table.vectorSearch(vectors[0]).distanceType("l2").limit(5).toArray();
  console.log(`单向量查询 OK：返回 ${one.length} 行，首行 distance=${one[0]?._distance}`);
} catch (err) {
  console.log("单向量查询失败:", err.message);
}

// 批量查询（关键）
try {
  const many = await table
    .vectorSearch(vectors)
    .distanceType("l2")
    .limit(5)
    .toArray();
  console.log(`★ 批量查询 OK：${vectors.length} 个查询返回 ${many.length} 行`);
  const keys = new Set(many.map((r) => String(r._query_index ?? "?")));
  console.log("  返回行里的 _query_index 取值:", JSON.stringify([...keys]));
  console.log("  首行 keys:", JSON.stringify(Object.keys(many[0] ?? {})));
} catch (err) {
  console.log("★ 批量查询失败（说明只能逐个查）:", err.message);
}

// 也试一下 add 多条（确认写入形态）
try {
  const cnt = await table.countRows();
  console.log("photo_embeddings 行数:", cnt);
} catch (err) {
  console.log("countRows 失败:", err.message);
}