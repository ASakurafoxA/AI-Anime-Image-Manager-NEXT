/**
 * 只读检查向量库：库里到底存了多少条 CLIP 向量（决定「复用已有向量」是否真的零成本）。
 */
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lancedb = require("@lancedb/lancedb");

const dir = process.argv[2] || "F:\\AI Anime Image Manager NEXT\\vectors";
const db = await lancedb.connect(dir);
const names = await db.tableNames();
console.log("表:", JSON.stringify(names));

for (const name of names) {
  try {
    const t = await db.openTable(name);
    const n = await t.countRows();
    const schema = await t.schema();
    const fields = schema.fields.map((f) => `${f.name}:${f.type}${f.type === "fixed_size_list" || String(f.type).includes("list") ? `[${JSON.stringify(f.children ?? "")}]` : ""}`);
    console.log(`\n=== ${name} ===`);
    console.log("  行数:", n);
    console.log("  字段:", fields.join(", "));
    const rows = await t.query().limit(1).toArray();
    if (rows[0]) {
      const r = rows[0];
      const keys = Object.keys(r);
      console.log("  样例行键:", keys.join(", "));
      for (const k of keys) {
        const v = r[k];
        if (Array.isArray(v) || (v && typeof v === "object" && "length" in v)) {
          console.log(`    ${k}: 长度 ${v.length}, 前3值 ${Array.from(v).slice(0, 3).map((x) => Number(x).toFixed(4)).join(", ")}`);
        } else {
          console.log(`    ${k}: ${String(v).slice(0, 60)}`);
        }
      }
    }
  } catch (err) {
    console.log(`\n=== ${name} === 读取失败: ${err.message}`);
  }
}
