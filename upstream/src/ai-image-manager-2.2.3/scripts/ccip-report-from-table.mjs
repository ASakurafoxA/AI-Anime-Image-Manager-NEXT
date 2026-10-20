/**
 * 从已算好的 CCIP 特征表直接出分组报告（不重算特征，几秒钟）。
 *
 * 与软件里的正式实现（`services/character-cluster.ts`）**同一套算法**：
 *   阈值过滤 → 互近邻 → 连通分量 → **超大组提高阈值递归细分**。
 *
 * 用法：electron.exe scripts/ccip-report-from-table.mjs <vectorsDir> [样本上限]
 */
import fs from "node:fs";
import path from "node:path";
import sqlite3 from "better-sqlite3";
import * as lancedb from "@lancedb/lancedb";

const DB = "F:\\AI Anime Image Manager NEXT\\data\\ai-image-manager.db";
const vectorsDir = process.argv[2];
const LIMIT = Number(process.argv[3] || 0);
const OUT_HTML = path.resolve(
  process.env.AI_CCIP_REPORT || "需求分析\\人脸评测\\ccip分组报告.html"
);
const THRESHOLD = Number(process.env.AI_CCIP_THRESHOLD || 0.85);
const NEIGHBORS = 12;
const MIN_GROUP = 3;
const MAX_GROUP = 60;
const MAX_DEPTH = 6;

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v?.toArray) return Array.from(v.toArray());
  if (ArrayBuffer.isView(v)) return Array.from(v);
  return Array.from(v);
}
function cos(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

// ── 读表里的特征 ───────────────────────────────────────────────
const lance = await lancedb.connect(vectorsDir);
const names = await lance.tableNames();
if (!names.includes("ccip_embeddings")) {
  console.error("向量库里没有 ccip_embeddings，先跑特征生成");
  process.exit(1);
}
const table = await lance.openTable("ccip_embeddings");
let rows = await table.query().select(["photo_id", "vector"]).toArray();
if (LIMIT > 0 && rows.length > LIMIT) rows = rows.slice(0, LIMIT);
console.error(`[table] 读到 ${rows.length} 条特征`);

const features = new Map();
for (const row of rows) {
  const vec = toArray(row.vector);
  if (vec.length > 0) features.set(row.photo_id, vec);
}
const ids = [...features.keys()];
console.error(`[table] 有效特征 ${ids.length} 条`);

// ── 逐张 ANN 建近邻图 ─────────────────────────────────────────
const knn = new Map();
const t0 = Date.now();
let done = 0;
for (const id of ids) {
  const hits = await table
    .vectorSearch(features.get(id))
    .distanceType("l2")
    .limit(NEIGHBORS + 1)
    .toArray();
  knn.set(
    id,
    hits
      .map((r) => ({ id: r.photo_id, similarity: Math.max(0, 1 - Number(r._distance) / 2) }))
      .filter((h) => h.id !== id && h.similarity >= THRESHOLD)
      .slice(0, NEIGHBORS)
  );
  done++;
  if (done % 500 === 0) console.error(`[ann] ${done}/${ids.length}`);
}
console.error(`[ann] 建图完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── 分组：互近邻 + 连通分量 + 超大组递归细分 ────────────────────
function createUf(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  return {
    find,
    union: (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    },
  };
}

function componentsAt(threshold, members) {
  const list = members ?? ids;
  const restrict = members ? new Set(members) : null;
  const idx = new Map(list.map((id, i) => [id, i]));
  const uf = createUf(list.length);
  for (const id of list) {
    const own = (knn.get(id) ?? []).filter(
      (e) => e.similarity >= threshold && (!restrict || restrict.has(e.id))
    );
    const ownSet = new Set(own.map((e) => e.id));
    for (const e of own) {
      if (!ownSet.has(e.id)) continue;
      const j = idx.get(e.id);
      if (j === undefined) continue;
      // 互近邻：对方的邻居里也要有我
      const back = knn.get(e.id) ?? [];
      if (!back.some((b) => b.id === id && b.similarity >= threshold)) continue;
      uf.union(idx.get(id), j);
    }
  }
  const buckets = new Map();
  for (let i = 0; i < list.length; i++) {
    const root = uf.find(i);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(list[i]);
  }
  return [...buckets.values()];
}

function split(members, threshold, depth) {
  if (members.length <= MAX_GROUP) {
    return members.length >= MIN_GROUP ? [members] : [];
  }
  if (depth >= MAX_DEPTH || threshold >= 0.995) {
    return members.length >= MIN_GROUP ? [members] : [];
  }
  const next = Math.min(0.995, threshold + 0.02);
  const parts = componentsAt(next, members);
  if (parts.length <= 1) {
    return split(members, next, depth + 1);
  }
  const out = [];
  for (const part of parts) out.push(...split(part, next, depth + 1));
  return out;
}

const initial = componentsAt(THRESHOLD);
const groups = [];
for (const c of initial) groups.push(...split(c, THRESHOLD, 0));
groups.sort((a, b) => b.length - a.length);
console.error(
  `[group] ${groups.length} 组，覆盖 ${groups.reduce((s, g) => s + g.length, 0)}/${ids.length}`
);

// ── 取缩略图信息 ───────────────────────────────────────────────
const db = new sqlite3(DB, { readonly: true, fileMustExist: true });
const infoById = new Map();
const need = new Set(groups.flatMap((g) => g.slice(0, 24)));
const needArr = [...need];
const CHUNK = 400;
for (let i = 0; i < needArr.length; i += CHUNK) {
  const slice = needArr.slice(i, i + CHUNK);
  const stmt = db.prepare(
    `SELECT id, path, thumbnail_path FROM photos WHERE id IN (${slice.join(",")})`
  );
  for (const row of stmt.all()) infoById.set(row.id, row);
}
db.close();

function fileUrl(p) {
  return `file:///${String(p).replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

// ── 出报告 ─────────────────────────────────────────────────────
const html = [];
html.push(`<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>CCIP 分组报告</title>
<style>
 body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#14161a;color:#e6e6e6;margin:0;padding:18px}
 h1{font-size:18px;margin:0 0 6px}
 .meta{color:#9aa3ad;font-size:12px;margin-bottom:16px;line-height:1.8}
 .group{border:1px solid #2c313a;border-radius:10px;padding:10px 12px;margin-bottom:12px;background:#1a1d23}
 .ghead{font-size:13px;margin-bottom:8px;color:#cfd6de}
 .warn{color:#ffb454}
 .thumbs{display:flex;flex-wrap:wrap;gap:6px}
 .thumbs img{width:104px;height:104px;object-fit:cover;border-radius:6px;background:#000}
 code{background:#22262d;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>CCIP 分组报告</h1>
<div class="meta">
 表内特征：<b>${ids.length}</b> 张｜连边门槛（余弦）≥ <code>${THRESHOLD}</code>｜每组至少 <b>${MIN_GROUP}</b> 张｜
 超过 <b>${MAX_GROUP}</b> 张会提高门槛递归细分<br>
 分组结果：<b>${groups.length}</b> 组，覆盖 <b>${groups.reduce((s, g) => s + g.length, 0)}</b> 张
</div>`);

groups.slice(0, 60).forEach((members, index) => {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length && n < 400; j++) {
      sum += cos(features.get(members[i]), features.get(members[j]));
      n++;
    }
  }
  const mean = n > 0 ? sum / n : 0;
  const flag = mean < 0.5 && members.length > 20 ? ` <span class="warn">← 偏杂，建议再调高门槛</span>` : "";
  html.push(
    `<div class="group"><div class="ghead">第 ${index + 1} 组 · <b>${members.length}</b> 张 · 平均相似度 ${mean.toFixed(3)}${flag}</div><div class="thumbs">`
  );
  for (const id of members.slice(0, 24)) {
    const info = infoById.get(id);
    const src = info?.thumbnail_path || info?.path;
    if (src) html.push(`<img loading="lazy" src="${fileUrl(src)}" title="photo ${id}">`);
  }
  html.push(`</div></div>`);
});
html.push(`</body></html>`);

fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true });
fs.writeFileSync(OUT_HTML, html.join("\n"), "utf-8");
console.log(`报告：${OUT_HTML}`);
console.log(`${groups.length} 组，覆盖 ${groups.reduce((s, g) => s + g.length, 0)}/${ids.length} 张`);
console.log(`组大小：最大 ${groups[0]?.length ?? 0}，中位 ${groups[Math.floor(groups.length / 2)]?.length ?? 0}`);