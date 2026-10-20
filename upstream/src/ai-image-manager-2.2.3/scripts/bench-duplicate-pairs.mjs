/**
 * 量生产路径的两档候选检索在 77k 真实库上的耗时与产出。
 * 内联了 phash-match.ts 的分桶逻辑（Node 直接跑 .ts 无法解析 @/ 别名）。
 * 用法：electron.exe --experimental-strip-types scripts/bench-duplicate-pairs.mjs <outFile>
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { hammingDistance } from "../src/services/bk-tree.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const outFile = process.argv[2] || "bench-dup.txt";
const log = (m) => fs.appendFileSync(outFile, `${m}\n`);
fs.writeFileSync(outFile, "");

const db = new Database("F:\\AI Anime Image Manager NEXT\\data\\ai-image-manager.db", {
  readonly: true,
  fileMustExist: true,
});

// 1) 索引失效判据（group_concat 精确指纹）的成本
let t = performance.now();
const keyRow = db
  .prepare(
    `SELECT count(*) n, coalesce(max(id),0) mx,
            coalesce(group_concat(phash,''),'') dg
     FROM photos WHERE deleted_at IS NULL AND phash IS NOT NULL`
  )
  .get();
log(
  `失效判据（count+maxId+group_concat）耗时：${(performance.now() - t).toFixed(1)}ms` +
    `（${keyRow.n} 行，指纹串长 ${keyRow.dg.length}）`
);

t = performance.now();
const rows = db
  .prepare(
    "SELECT id, phash FROM photos WHERE deleted_at IS NULL AND phash IS NOT NULL"
  )
  .all();
log(`读取指纹：${(performance.now() - t).toFixed(1)}ms`);
db.close();
const entries = rows.map((r) => ({ photoId: r.id, phash: r.phash }));

function chunkPlan(threshold) {
  const chunks = Math.max(1, Math.floor(threshold) + 1);
  const total = 16;
  const plan = [];
  let start = 0;
  for (let i = 0; i < chunks; i++) {
    const size = Math.max(1, Math.floor((total - start) / (chunks - i)));
    plan.push([start, Math.min(total, start + size)]);
    start += size;
  }
  return plan.filter(([f, to]) => f < to && to <= total);
}

function collectPairs(list, threshold, maxPairs) {
  const n = list.length;
  const plan = chunkPlan(threshold);
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const p = list[i].phash;
    for (let c = 0; c < plan.length; c++) {
      const [from, to] = plan[c];
      const key = `${c}:${p.slice(from, to)}`;
      const b = buckets.get(key);
      if (b) {
        b.push(i);
      } else {
        buckets.set(key, [i]);
      }
    }
  }
  const out = [];
  const seen = new Set();
  for (const b of buckets.values()) {
    if (b.length < 2) {
      continue;
    }
    for (let a = 0; a < b.length; a++) {
      for (let d = a + 1; d < b.length; d++) {
        const i = b[a];
        const j = b[d];
        const pk = i * n + j;
        if (seen.has(pk)) {
          continue;
        }
        const dist = hammingDistance(list[i].phash, list[j].phash);
        if (dist > threshold) {
          continue;
        }
        seen.add(pk);
        out.push({ distance: dist, a: list[i].photoId, b: list[j].photoId });
        if (maxPairs > 0 && out.length >= maxPairs) {
          return { pairs: out, truncated: true, bucketCount: buckets.size };
        }
      }
    }
  }
  return { pairs: out, truncated: false, bucketCount: buckets.size };
}

const CAP = 200000;
// 生产默认档 = standard，phashThreshold 8；加宽档 16
for (const precise of [4, 8]) {
  t = performance.now();
  const first = collectPairs(entries, precise, CAP);
  const t1 = performance.now() - t;
  const remaining = Math.max(0, CAP - first.pairs.length);
  t = performance.now();
  const wide = collectPairs(entries, Math.max(precise, 16), remaining);
  const t2 = performance.now() - t;
  const all = [...first.pairs, ...wide.pairs];
  const byDist = new Map();
  for (const p of all) {
    byDist.set(p.distance, (byDist.get(p.distance) ?? 0) + 1);
  }
  const dist = [...byDist.entries()].sort((x, y) => x[0] - y[0]);
  log(
    `\n精确档阈值 ${precise}：${first.pairs.length} 对${first.truncated ? "（已达上限）" : ""}` +
      ` ${t1.toFixed(1)}ms / ${first.bucketCount} 桶`
  );
  log(
    `加宽档阈值 ${Math.max(precise, 16)}：+${wide.pairs.length} 对${wide.truncated ? "（已达上限）" : ""}` +
      ` ${t2.toFixed(1)}ms`
  );
  log(
    `合计候选 ${all.length} 对，总耗时 ${(t1 + t2).toFixed(0)}ms；` +
      `距离分布 ${dist.map(([d, c]) => `${d}:${c}`).join(" ")}`
  );
  const uniq = new Set();
  for (const p of all) {
    uniq.add(p.a);
    uniq.add(p.b);
  }
  log(`涉及图片 ${uniq.size} 张（Phase 2 要给这些取向量做 AI 确认）`);
}
log("DONE");
