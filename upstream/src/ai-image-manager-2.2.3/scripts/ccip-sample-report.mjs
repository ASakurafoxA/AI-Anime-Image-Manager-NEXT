/**
 * CCIP 小批量试跑 + 分组报告（只写 ccip_embeddings 这一张新表）。
 *
 * 流程：抽 N 张「没有角色标签」的图 → 用 worker 池算 CCIP 特征 → 写入向量库
 *      → 读回特征、逐张 ANN → 互近邻分组 → 生成带缩略图的 HTML 报告。
 *
 * 用法（应用必须关闭）：
 *   electron.exe scripts/ccip-sample-report.mjs <modelsDir> <vectorsDir> [样本数] [worker数] [线程/worker]
 */
import fs from "node:fs";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import sqlite3 from "better-sqlite3";
import sharp from "sharp";
import * as lancedb from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Int32, Schema } from "apache-arrow";

const require = createRequire(import.meta.url);
const { InferenceSession, Tensor } = require("onnxruntime-node");

const DB = "F:\\AI Anime Image Manager NEXT\\data\\ai-image-manager.db";
const modelsDir = process.argv[2];
const vectorsDir = process.argv[3];
const SAMPLE = Number(process.argv[4] || 2000);
const WORKERS = Number(process.argv[5] || 4);
const THREADS = Number(process.argv[6] || 4);
const OUT_HTML = path.resolve(
  process.env.AI_CCIP_REPORT || "需求分析\\人脸评测\\ccip分组试跑报告.html"
);

const SIZE = 384;
const DIM = 768;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const THRESHOLD = 0.85;
const NEIGHBORS = 12;
const MIN_GROUP = 3;

// ── 1) 抽样：没有角色标签、且图片存在的照片 ─────────────────────
const db = new sqlite3(DB, { readonly: true, fileMustExist: true });
const rows = db
  .prepare(
    `WITH RECURSIVE char_tags(id) AS (
       SELECT id FROM tags
        WHERE parent_id = (SELECT id FROM tags WHERE parent_id IS NULL AND name = '角色')
       UNION ALL
       SELECT t.id FROM tags t JOIN char_tags c ON t.parent_id = c.id
     ),
     named(id) AS (
       SELECT DISTINCT pt.photo_id FROM photo_tags pt
        WHERE pt.tag_id IN (SELECT id FROM char_tags) AND pt.photo_id IS NOT NULL
     )
     SELECT p.id, p.path, p.thumbnail_path
       FROM photos p
      WHERE p.deleted_at IS NULL
        AND p.path IS NOT NULL
        AND p.id NOT IN (SELECT id FROM named)
      ORDER BY RANDOM()
      LIMIT ?`
  )
  .all(SAMPLE * 2)
  .filter((r) => r.path && fs.existsSync(r.path))
  .slice(0, SAMPLE);
db.close();
console.error(`[sample] 候选 ${rows.length} 张（无角色标签、文件存在）`);
if (rows.length === 0) {
  console.error("没有可用的样本，退出");
  process.exit(1);
}

// ── 2) 算特征（worker 池，与正式实现同一套 worker 脚本）─────────
const workerScript = path.join(import.meta.dirname, "ccip-embed-worker.mjs");
const BATCH = 8;
const batches = [];
for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));

let nextBatch = 0;
let doneCount = 0;
const features = new Map(); // photoId -> vector
const t0 = Date.now();

function spawnWorker() {
  const child = fork(workerScript, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stderr?.on("data", (c) => {
    const text = c.toString().trim();
    if (text) console.error(`[worker] ${text}`);
  });
  return child;
}

function waitReady(child) {
  return new Promise((resolve, reject) => {
    const onMsg = (m) => {
      if (m?.type === "ready") {
        child.off("message", onMsg);
        resolve();
      } else if (m?.type === "init-error") {
        child.off("message", onMsg);
        reject(new Error(m.error));
      }
    };
    child.on("message", onMsg);
    child.once("exit", (code) => reject(new Error(`worker 退出 code=${code}`)));
    child.send({ type: "init", modelsDir, threads: THREADS });
  });
}

function embedBatch(child, photos) {
  return new Promise((resolve, reject) => {
    const onMsg = (m) => {
      if (m?.type === "result") {
        child.off("message", onMsg);
        resolve(m.results ?? []);
      }
    };
    child.on("message", onMsg);
    child.once("exit", (code) => reject(new Error(`worker 中途退出 code=${code}`)));
    child.send({ type: "embed", photos: photos.map((r) => ({ id: r.id, path: r.path })) });
  });
}

async function runWorker() {
  const child = spawnWorker();
  try {
    await waitReady(child);
    for (;;) {
      const index = nextBatch++;
      if (index >= batches.length) break;
      const batch = batches[index];
      const results = await embedBatch(child, batch);
      for (const item of results) {
        if (item.vector?.length === DIM) features.set(item.id, item.vector);
      }
      doneCount += batch.length;
      const el = (Date.now() - t0) / 1000;
      console.error(
        `[embed] ${doneCount}/${rows.length} 已算 ${features.size} | ${(doneCount / Math.max(el, 0.01)).toFixed(1)} 张/秒 | ${el.toFixed(0)}s`
      );
    }
  } finally {
    try {
      child.send({ type: "shutdown" });
    } catch {
      /* ignore */
    }
  }
}

await Promise.all(Array.from({ length: WORKERS }, () => runWorker()));
console.error(
  `[embed] 完成 ${features.size} 条特征，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`
);

// ── 3) 写入 ccip_embeddings（只写这一张新表，先删后插）───────────
const lance = await lancedb.connect(vectorsDir);
const names = await lance.tableNames();
let table;
if (names.includes("ccip_embeddings")) {
  table = await lance.openTable("ccip_embeddings");
} else {
  const schema = new Schema([
    new Field("photo_id", new Int32()),
    new Field("vector", new FixedSizeList(DIM, new Field("item", new Float32()))),
  ]);
  table = await lance.createEmptyTable("ccip_embeddings", schema);
  console.error("[table] 已创建 ccip_embeddings（768 维）");
}
const entries = [...features.entries()].map(([photoId, vector]) => ({ photo_id: photoId, vector }));
const CHUNK = 500;
for (let i = 0; i < entries.length; i += CHUNK) {
  const chunk = entries.slice(i, i + CHUNK);
  await table.delete(`photo_id IN (${chunk.map((e) => e.photo_id).join(",")})`);
  await table.add(chunk);
}
const totalRows = await table.countRows();
console.error(`[table] 写入完成，表内共 ${totalRows} 行`);

// ── 4) 读回并逐张 ANN（与正式聚类同一条路）──────────────────────
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

const ids = [...features.keys()];
const knn = new Map();
const t1 = Date.now();
let searched = 0;
for (const id of ids) {
  const vec = features.get(id);
  const hits = await table.vectorSearch(vec).distanceType("l2").limit(NEIGHBORS + 1).toArray();
  knn.set(
    id,
    hits
      .map((r) => ({
        id: r.photo_id,
        similarity: Math.max(0, 1 - Number(r._distance) / 2),
      }))
      .filter((h) => h.id !== id && h.similarity >= THRESHOLD)
      .slice(0, NEIGHBORS)
  );
  searched++;
  if (searched % 200 === 0) {
    console.error(
      `[ann] ${searched}/${ids.length} | ${((Date.now() - t1) / 1000).toFixed(0)}s`
    );
  }
}
console.error(`[ann] 建图完成，用时 ${((Date.now() - t1) / 1000).toFixed(0)}s`);

// ── 5) 互近邻 + 连通分量（与 character-cluster.ts 同一算法）──────
const indexOf = new Map(ids.map((id, i) => [id, i]));
const parent = ids.map((_, i) => i);
const find = (a) => {
  while (parent[a] !== a) {
    parent[a] = parent[parent[a]];
    a = parent[a];
  }
  return a;
};
const union = (a, b) => {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) parent[rb] = ra;
};
for (const id of ids) {
  const own = (knn.get(id) ?? []).filter((e) => e.similarity >= THRESHOLD);
  const ownSet = new Set(own.map((e) => e.id));
  for (const e of own) {
    if (!ownSet.has(e.id)) continue;
    const j = indexOf.get(e.id);
    if (j === undefined) continue;
    const back = knn.get(e.id) ?? [];
    if (!back.some((b) => b.id === id && b.similarity >= THRESHOLD)) continue;
    union(indexOf.get(id), j);
  }
}
const buckets = new Map();
for (let i = 0; i < ids.length; i++) {
  const root = find(i);
  if (!buckets.has(root)) buckets.set(root, []);
  buckets.get(root).push(ids[i]);
}
const groups = [...buckets.values()]
  .filter((g) => g.length >= MIN_GROUP)
  .sort((a, b) => b.length - a.length);

// ── 6) HTML 报告（缩略图 + 组信息）──────────────────────────────
const infoById = new Map(rows.map((r) => [r.id, r]));
function fileUrl(p) {
  return `file:///${String(p).replace(/\\/g, "/").replace(/^\/+/, "")}`;
}
const html = [];
html.push(`<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>CCIP 分组试跑报告</title>
<style>
 body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#14161a;color:#e6e6e6;margin:0;padding:18px}
 h1{font-size:18px;margin:0 0 6px}
 .meta{color:#9aa3ad;font-size:12px;margin-bottom:16px;line-height:1.7}
 .group{border:1px solid #2c313a;border-radius:10px;padding:10px 12px;margin-bottom:12px;background:#1a1d23}
 .ghead{font-size:13px;margin-bottom:8px;color:#cfd6de}
 .thumbs{display:flex;flex-wrap:wrap;gap:6px}
 .thumbs img{width:104px;height:104px;object-fit:cover;border-radius:6px;background:#000}
 .none{color:#9aa3ad}
 code{background:#22262d;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>CCIP 分组试跑报告</h1>
<div class="meta">
 样本：<b>${rows.length}</b> 张（都是「没有角色标签」的图）｜
 算出特征：<b>${features.size}</b> 张｜
 参与建图：<b>${ids.length}</b> 张<br>
 连边门槛（余弦）≥ <code>${THRESHOLD}</code>｜每组至少 <b>${MIN_GROUP}</b> 张｜
 互近邻 + 连通分量<br>
 分组结果：<b>${groups.length}</b> 组，覆盖 <b>${groups.reduce((s, g) => s + g.length, 0)}</b> 张
</div>`);

if (groups.length === 0) {
  html.push(
    `<p class="none">这个样本量下没有形成明显的组。这不代表方法无效 —— 同一个角色的图如果散落在 6.7 万张里，随机抽 2000 张往往只抽到它一两张，自然聚不起来。全库跑完再看。</p>`
  );
}
groups.slice(0, 40).forEach((members, index) => {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length && n < 400; j++) {
      sum += cos(features.get(members[i]), features.get(members[j]));
      n++;
    }
  }
  const mean = n > 0 ? (sum / n).toFixed(3) : "-";
  html.push(
    `<div class="group"><div class="ghead">第 ${index + 1} 组 · <b>${members.length}</b> 张 · 平均相似度 ${mean}</div><div class="thumbs">`
  );
  for (const id of members.slice(0, 24)) {
    const info = infoById.get(id);
    const src = info?.thumbnail_path || info?.path;
    if (src) {
      html.push(`<img loading="lazy" src="${fileUrl(src)}" title="photo ${id}">`);
    }
  }
  html.push(`</div></div>`);
});
html.push(`</body></html>`);

fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true });
fs.writeFileSync(OUT_HTML, html.join("\n"), "utf-8");
console.log(`\n报告已生成：${OUT_HTML}`);
console.log(`分组：${groups.length} 组，覆盖 ${groups.reduce((s, g) => s + g.length, 0)} 张（样本 ${rows.length}）`);