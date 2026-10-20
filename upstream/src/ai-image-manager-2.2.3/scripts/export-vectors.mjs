/**
 * 从图库现成的向量库里，按 photo_id 导出 CLIP 向量（证明「零成本复用」）。
 * 只读，不修改任何数据。
 *
 * 用法：electron.exe scripts/export-vectors.mjs <ids.json> <out.json> <vectorsDir>
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lancedb = require("@lancedb/lancedb");

const [idPath, outPath, vecDir] = process.argv.slice(2, 5);
const ids = JSON.parse(fs.readFileSync(idPath, "utf-8"));
const idList = Array.isArray(ids) ? ids : ids.ids;

const db = await lancedb.connect(vecDir);
const t = await db.openTable("photo_embeddings");

const out = {};
const CHUNK = 400;
for (let i = 0; i < idList.length; i += CHUNK) {
  const chunk = idList.slice(i, i + CHUNK);
  const rows = await t.query().where(`photo_id IN (${chunk.join(",")})`).toArray();
  for (const r of rows) {
    out[r.photo_id] = Array.from(r.vector);
  }
  console.error(`[dump] ${Math.min(i + CHUNK, idList.length)}/${idList.length} 已取 ${Object.keys(out).length}`);
}

fs.writeFileSync(outPath, JSON.stringify(out));
console.error(`[dump] 导出 ${Object.keys(out).length} 条向量 -> ${outPath}`);
