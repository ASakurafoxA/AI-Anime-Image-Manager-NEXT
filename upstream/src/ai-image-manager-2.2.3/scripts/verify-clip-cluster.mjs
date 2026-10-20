/**
 * 可行性验证（只读）：现有 Chinese-CLIP 向量能否把"同一角色"聚成一类？
 *
 * 做法：
 *   1. 从 SQLite 取若干"高置信度、图数足"的角色标签作为标准答案；
 *   2. 读它们在 photo_embeddings 里的向量；
 *   3. 贪心聚类（簇中心法，模拟应用内现有思路），只保留未命名图（此处无命名概念，
 *      直接用全部样本）；
 *   4. 用"外部调换检验"评估：同一个角色内部的成对相似度，是否明显高于不同角色之间。
 *      同时给出一个简单阈值聚类下的分组纯度（同组内角色一致性）。
 *
 * 只读：不改 SQLite、不改 LanceDB。全程进程内计算，不碰应用进程。
 *
 * 用法（electron-as-node）：
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   node_modules\electron\dist\electron.exe scripts/verify-clip-cluster.mjs <out.json> <outDir>
 */
import fs from "node:fs";
import path from "node:path";
import sqlite3 from "better-sqlite3";
import * as lancedb from "@lancedb/lancedb";

const DB = "F:\\AI Anime Image Manager NEXT\\data\\ai-image-manager.db";
const VECTORS = "F:\\AI Anime Image Manager NEXT\\vectors";

const K_GROUPS = 60; // 取多少个角色当标准答案
const MIN_PHOTOS_PER_ROLE = 8; // 每个角色至少多少张才参与
const MIN_SEED = 8; // 聚类里至少多少张才算一个"会分出来的组"
const THRESHOLDS = [0.8, 0.85, 0.9, 0.935, 0.95, 0.965, 0.98];

function cos(a, b) {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
}

async function main() {
  const outJson = path.basename(process.argv[2] || "clip-cluster.json");
  const outDir = process.argv[3] || ".";
  const db = new sqlite3(DB, { readonly: true, fileMustExist: true });

  // 1) 收集角色标签样本：角色根 (id=2) 的后代 + 每角色图片数
  const charRoot = db
    .prepare("SELECT id FROM tags WHERE parent_id IS NULL AND name = '角色'")
    .get();
  const descendants = db
    .prepare(
      `WITH RECURSIVE sub(id, name) AS (
         SELECT id, name FROM tags WHERE parent_id = ?
         UNION ALL SELECT t.id, t.name FROM tags t JOIN sub s ON t.parent_id = s.id)
       SELECT id, name FROM sub`
    )
    .all(charRoot.id);

  // 统计每个角色的有向量图片数（只在 photo_embeddings 里有向量的）
  const namedByTag = new Map(); // tagName -> {tagId, photoIds:[]}
  const CHUNK = 500;
  const photoCountStmt = db.prepare(
    `SELECT COUNT(DISTINCT pt.photo_id) c FROM photo_tags pt
       JOIN photos p ON p.id = pt.photo_id AND p.deleted_at IS NULL
       WHERE pt.tag_id = ?`
  );
  const photosByTagStmt = db.prepare(
    `SELECT DISTINCT pt.photo_id FROM photo_tags pt
       JOIN photos p ON p.id = pt.photo_id AND p.deleted_at IS NULL
       WHERE pt.tag_id = ? LIMIT ?`
  );
  for (const d of descendants) {
    if (namedByTag.size >= K_GROUPS) break;
    const c = photoCountStmt.get(d.id).c;
    if (c < MIN_PHOTOS_PER_ROLE) continue;
    const ph = photosByTagStmt.all(d.id, 20).map((r) => r.photo_id);
    if (ph.length < MIN_PHOTOS_PER_ROLE) continue;
    namedByTag.set(d.name, { tagId: d.id, photoIds: ph });
  }
  const cn = namedByTag.size;
  console.error(`[char] collected ${cn} roles with >=${MIN_PHOTOS_PER_ROLE} photos`);

  // 2) 按角色读向量（从 LanceDB photo_embeddings）
  const vec = await lancedb.connect(VECTORS);
  const table = await vec.openTable("photo_embeddings");
  const vectorByPhoto = new Map();
  const photoToRole = new Map(); // photoId -> roleName (first tagged)
  for (const [roleName, info] of namedByTag) {
    const ids = info.photoIds;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const filt = `photo_id IN (${slice.join(",")})`;
      const rows = await table.query().where(filt).toArray();
      for (const row of rows) {
        if (row.vector == null) continue;
        let v;
        if (Array.isArray(row.vector)) v = row.vector;
        else if (row.vector.toArray) v = Array.from(row.vector.toArray());
        else if (ArrayBuffer.isView(row.vector)) v = Array.from(row.vector);
        else continue;
        if (v.length === 0) continue;
        vectorByPhoto.set(row.photo_id, v);
        if (!photoToRole.has(row.photo_id)) photoToRole.set(row.photo_id, roleName);
      }
    }
  }
  const photoIds = [...vectorByPhoto.keys()];
  const n = photoIds.length;
  console.error(`[vec] loaded ${n} vectors (dim ${vectorByPhoto.get(photoIds[0])?.length})`);

  // 3) 成对相似度（反应角色内 vs 角色间）
  const samePairs = [];
  const diffPairs = [];
  const saved = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = photoIds[i], b = photoIds[j];
      const s = cos(vectorByPhoto.get(a), vectorByPhoto.get(b));
      if (photoToRole.get(a) === photoToRole.get(b)) samePairs.push(s);
      else diffPairs.push(s);
      if (saved.length < 800000) saved.push({ a, b, s, same: photoToRole.get(a) === photoToRole.get(b) });
    }
  }
  const avg = (arr) => arr.reduce((x, y) => x + y, 0) / (arr.length || 1);
  const median = (arr) => { const s = [...arr].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.error(`[pair] same N=${samePairs.length} avg=${avg(samePairs).toFixed(4)} med=${median(samePairs).toFixed(4)}`);
  console.error(`[pair] diff N=${diffPairs.length} avg=${avg(diffPairs).toFixed(4)} med=${median(diffPairs).toFixed(4)}`);

  // 4) 贪心簇聚类（簇中心法），看各阈值下的分组纯度
  function clusterByCentroid(ids, thresh) {
    const clusters = [];
    const assign = new Map();
    for (const id of ids) {
      const v = vectorByPhoto.get(id);
      let best = -1, bestSim = -1;
      for (let ci = 0; ci < clusters.length; ci++) {
        const s = cos(v, clusters[ci].centroid);
        if (s > bestSim) { bestSim = s; best = ci; }
      }
      if (best >= 0 && bestSim >= thresh) {
        const c = clusters[best];
        c.members.push(id);
        const newC = new Float64Array(v.length);
        for (const m of c.members) { const mv = vectorByPhoto.get(m); for (let k = 0; k < v.length; k++) newC[k] += mv[k]; }
        for (let k = 0; k < v.length; k++) newC[k] /= c.members.length;
        // renormalize
        let norm = 0; for (let k = 0; k < v.length; k++) norm += newC[k] * newC[k];
        norm = Math.sqrt(norm) || 1; for (let k = 0; k < v.length; k++) newC[k] /= norm;
        c.centroid = newC;
      } else {
        clusters.push({ members: [id], centroid: Float64Array.from(v) });
      }
    }
    return clusters.filter((c) => c.members.length >= MIN_SEED);
  }

  const thresholdResults = [];
  for (const t of THRESHOLDS) {
    const clusters = clusterByCentroid(photoIds, t);
    let puritySum = 0;
    let good = 0;
    let assigned = 0;
    for (const c of clusters) {
      const counts = new Map();
      for (const m of c.members) {
        const r = photoToRole.get(m);
        counts.set(r, (counts.get(r) || 0) + 1);
      }
      const topRole = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const purity = topRole[1] / c.members.length;
      puritySum += purity;
      assigned += c.members.length;
      if (purity >= 0.9) good++;
    }
    const avgPurity = puritySum / (clusters.length || 1);
    const purity = assigned ? good / clusters.length : 0;
    console.error(
      `[t=${t}] clusters>=${MIN_SEED}: ${clusters.length}, assigned ${assigned}, avgPurity=${avgPurity.toFixed(3)}, ${(purity * 100).toFixed(0)}% clusters purity>=0.9`
    );
    thresholdResults.push({ t, nClusters: clusters.length, assigned, avgPurity: +avgPurity.toFixed(3), goodPct: +(purity * 100).toFixed(0) });
  }

  // 5) 导出给报告：抽样某个阈值下的分组
  fs.writeFileSync(
    path.join(outDir, outJson),
    JSON.stringify({
      scope: { totalPhotos: n, roles: cn, minPhotoPerRole: MIN_PHOTOS_PER_ROLE },
      pairwise: {
        same: { n: samePairs.length, avg: +avg(samePairs).toFixed(4), med: +median(samePairs).toFixed(4) },
        diff: { n: diffPairs.length, avg: +avg(diffPairs).toFixed(4), med: +median(diffPairs).toFixed(4) },
      },
      thresholds: thresholdResults,
      roleNames: [...namedByTag.keys()],
    }, null, 2)
  );
  console.error(`[done] wrote ${path.join(outDir, outJson)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });