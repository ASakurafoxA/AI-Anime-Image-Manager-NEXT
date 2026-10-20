/**
 * 引擎规模基准（77k 张真实库）。
 *
 * 说明：这里**内联**了 phash-match.ts 的分桶聚类逻辑 —— Node 直接跑 .ts 时
 * 无法解析 `@/` 别名，而带 .ts 扩展名的相对导入 TS 编译器又不允许。
 * 该模块本身的正确性由 src/tests/unit/phash-index.test.ts（17 项）覆盖，
 * 本脚本只负责量「同一算法在真实规模下的耗时与结果」。
 *
 * 用法：electron.exe --experimental-strip-types scripts/bench-phash-engine.mjs <outFile>
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { BKTree, hammingDistance } from "../src/services/bk-tree.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const outFile = process.argv[2] || "bench-phash-engine.txt";
const log = (m) => fs.appendFileSync(outFile, `${m}\n`);
fs.writeFileSync(outFile, "");

const db = new Database(
  "F:\\AI Anime Image Manager NEXT\\data\\ai-image-manager.db",
  { readonly: true, fileMustExist: true }
);
let t = performance.now();
const rows = db
  .prepare(
    "SELECT id, phash FROM photos WHERE deleted_at IS NULL AND phash IS NOT NULL"
  )
  .all();
db.close();
log(`读取 ${rows.length} 条指纹：${((performance.now() - t) / 1000).toFixed(2)}s`);

// ── 与 phash-match.ts 完全一致的分桶方案 ──
function chunkPlan(threshold) {
  const chunks = Math.max(1, Math.floor(threshold) + 1);
  const total = 16;
  const plan = [];
  let start = 0;
  for (let i = 0; i < chunks; i++) {
    const size = Math.max(
      1,
      Math.floor((total - start) / (chunks - i))
    );
    plan.push([start, Math.min(total, start + size)]);
    start += size;
  }
  return plan.filter(([f, to]) => f < to && to <= total);
}

function buildGroups(entries, threshold, minSize = 2) {
  const n = entries.length;
  const plan = chunkPlan(threshold);
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const p = entries[i].phash;
    for (let c = 0; c < plan.length; c++) {
      const [from, to] = plan[c];
      const key = `${c}:${p.slice(from, to)}`;
      const list = buckets.get(key);
      if (list) {
        list.push(i);
      } else {
        buckets.set(key, [i]);
      }
    }
  }
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    parent[i] = i;
  }
  const find = (a) => {
    let r = a;
    while (parent[r] !== r) {
      r = parent[r];
    }
    let c = a;
    while (parent[c] !== r) {
      const nx = parent[c];
      parent[c] = r;
      c = nx;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent[rb] = ra;
    }
  };
  for (const list of buckets.values()) {
    if (list.length < 2) {
      continue;
    }
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a];
        const j = list[b];
        if (hammingDistance(entries[i].phash, entries[j].phash) <= threshold) {
          union(i, j);
        }
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) {
      list.push(entries[i].photoId);
    } else {
      groups.set(root, [entries[i].photoId]);
    }
  }
  return [...groups.values()].filter((g) => g.length >= minSize);
}

const entries = rows.map((r) => ({ photoId: r.id, phash: r.phash }));

// BK 树建树（以图搜图的首屏索引）
t = performance.now();
const tree = new BKTree();
for (let i = 0; i < entries.length; i++) {
  tree.insert(entries[i].photoId, entries[i].phash);
  if ((i + 1) % 20000 === 0) {
    log(`  建树 ${i + 1}/${entries.length}：${((performance.now() - t) / 1000).toFixed(1)}s`);
  }
}
log(`建 BK 树完成（${tree.count} 节点）：${((performance.now() - t) / 1000).toFixed(2)}s`);

const probe = entries[1234].phash;
t = performance.now();
let hits = 0;
for (let i = 0; i < 200; i++) {
  hits = tree.query(probe, 4).length;
}
log(`单点查询：${((performance.now() - t) / 200).toFixed(2)} ms/次，命中 ${hits} 张`);

for (const threshold of [4, 8]) {
  t = performance.now();
  const groups = buildGroups(entries, threshold, 2);
  const involved = groups.reduce((s, g) => s + g.length, 0);
  log(
    `分桶聚类 阈值<=${threshold}：${groups.length} 个簇，涉及 ${involved} 张，` +
      `可省 ${involved - groups.length} 张（${((performance.now() - t) / 1000).toFixed(1)}s）`
  );
}
log("DONE");
