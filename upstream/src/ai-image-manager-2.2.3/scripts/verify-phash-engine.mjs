/**
 * 在真实库规模上验证共用引擎：
 *   1) BK 树单点查询性能（「以图搜图」路径）
 *   2) 分桶全库聚类（「查重」路径）是否正确且够快
 * 期望与离线 Python 结果一致：阈值 4 → 5,355 个重复簇 / 15,310 张 / 可省 9,955 张。
 *
 * 用法：electron.exe --experimental-strip-types scripts/verify-phash-engine.mjs
 */
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { BKTree } from "../src/services/bk-tree.ts";
import { buildGroupsFromEntries } from "../src/services/phash-match.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const DB_PATH = "F:\\AI Anime Image Manager NEXT\\data\\ai-image-manager.db";
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let t = performance.now();
const rows = db
  .prepare(
    "SELECT id, phash FROM photos WHERE deleted_at IS NULL AND phash IS NOT NULL"
  )
  .all();
db.close();
console.log(
  `[1] 读取 ${rows.length} 条指纹：${((performance.now() - t) / 1000).toFixed(2)}s`
);

const entries = rows.map((r) => ({ photoId: r.id, phash: r.phash }));

// --- BK 树：单点查询（以图搜图）---
t = performance.now();
const tree = new BKTree();
for (const e of entries) {
  tree.insert(e.photoId, e.phash);
}
const tBuild = performance.now() - t;
const probe = entries[1234].phash;
let hits = 0;
t = performance.now();
const N = 300;
for (let i = 0; i < N; i++) {
  hits = tree.query(probe, 4).length;
}
const perQuery = (performance.now() - t) / N;
console.log(
  `[2] BK 树：建树 ${(tBuild / 1000).toFixed(2)}s（${tree.count} 节点）；` +
    `单点查询 ${perQuery.toFixed(2)} ms/次，命中 ${hits} 张`
);

// --- 分桶：全库聚类（查重）---
for (const threshold of [4, 8, 12]) {
  t = performance.now();
  const groups = buildGroupsFromEntries(entries, threshold, 2);
  const elapsed = (performance.now() - t) / 1000;
  const involved = groups.reduce((s, g) => s + g.length, 0);
  const sizes = groups.map((g) => g.length).sort((a, b) => b - a);
  console.log(
    `[3] 分桶聚类 阈值<=${threshold}：${groups.length} 个簇，涉及 ${involved} 张，` +
      `最大簇 ${sizes[0] ?? 0}，可省 ${involved - groups.length} 张 （${elapsed.toFixed(1)}s）`
  );
}

console.log(
  "\n对照（离线 Python 实现，阈值 4）：5,355 个簇 / 15,310 张 / 可省 9,955 张"
);
