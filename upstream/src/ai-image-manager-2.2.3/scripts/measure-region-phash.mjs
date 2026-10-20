/**
 * 实测「局部指纹」能不能救裁图：
 *   方案 A（现状）：只存整图指纹
 *   方案 B（新增）：整图 + 2 个中心缩放 + 8 个象限 = 11 个指纹
 *
 * 对同一批真实图片，裁出不同比例/位置的查询图，看能不能找回原图，
 * 并统计误报（除了原图还命中多少张别的图）。
 *
 * 用法：electron.exe --experimental-strip-types scripts/measure-region-phash.mjs <outFile>
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import sharp from "sharp";
import { hammingDistance } from "../src/services/bk-tree.ts";
import { computePHash } from "../src/services/phash.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const outFile = process.argv[2] || "region-phash.txt";
const log = (m) => fs.appendFileSync(outFile, `${m}\n`);
fs.writeFileSync(outFile, "");

/** 相对区域定义：[名称, x, y, w, h]（占整图比例） */
const REGIONS = [
  ["中心71%", 0.146, 0.146, 0.707, 0.707],
  ["中心50%", 0.25, 0.25, 0.5, 0.5],
  ["左上71%", 0, 0, 0.707, 0.707],
  ["右上71%", 0.293, 0, 0.707, 0.707],
  ["左下71%", 0, 0.293, 0.707, 0.707],
  ["右下71%", 0.293, 0.293, 0.707, 0.707],
  ["左上50%", 0, 0, 0.5, 0.5],
  ["右上50%", 0.5, 0, 0.5, 0.5],
  ["左下50%", 0, 0.5, 0.5, 0.5],
  ["右下50%", 0.5, 0.5, 0.5, 0.5],
];

async function cropBuf(file, x, y, w, h) {
  const meta = await sharp(file).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const cw = Math.max(32, Math.round(W * w));
  const ch = Math.max(32, Math.round(H * h));
  const left = Math.max(0, Math.min(W - cw, Math.round(W * x)));
  const top = Math.max(0, Math.min(H - ch, Math.round(H * y)));
  return sharp(file)
    .extract({ left, top, width: cw, height: ch })
    .png()
    .toBuffer();
}

const db = new Database(
  "F:\\AI Anime Image Manager NEXT\\data\\ai-image-manager.db",
  { readonly: true, fileMustExist: true }
);
const rows = db
  .prepare(
    `SELECT id, path FROM photos
     WHERE deleted_at IS NULL AND phash IS NOT NULL AND width >= 900 AND height >= 900
     ORDER BY id LIMIT 3000`
  )
  .all();
db.close();

const N = 200;
const samples = [];
for (const r of rows) {
  if (samples.length >= N) break;
  if (fs.existsSync(r.path)) samples.push(r);
}
log(`取样 ${samples.length} 张真实图片（每张额外算 1 整图 + ${REGIONS.length} 个局部指纹）\n`);

// 建索引：方案 A = 整图指纹；方案 B = 整图 + 局部指纹
const t0 = Date.now();
const indexA = new Map(); // phash -> [photoId]
const indexB = new Map();
for (const s of samples) {
  try {
    const full = await computePHash(s.path);
    if (!full) continue;
    if (!indexA.has(full)) indexA.set(full, []);
    indexA.get(full).push(s.id);
    if (!indexB.has(full)) indexB.set(full, []);
    indexB.get(full).push(s.id);
    for (const [, x, y, w, h] of REGIONS) {
      const hp = await computePHash(await cropBuf(s.path, x, y, w, h));
      if (!hp) continue;
      if (!indexB.has(hp)) indexB.set(hp, []);
      indexB.get(hp).push(s.id);
    }
  } catch {
    /* 跳过读不了的文件 */
  }
}
log(
  `索引规模：方案 A ${indexA.size} 个指纹 / 方案 B ${indexB.size} 个指纹；` +
    `耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s\n`
);

function query(index, phash, threshold) {
  const hits = new Set();
  for (const [h, ids] of index) {
    if (hammingDistance(h, phash) <= threshold) {
      for (const id of ids) hits.add(id);
    }
  }
  return hits;
}

/** 查询组合：[裁剪保留面积, 位置描述, x, y, w, h] */
const CROPS = [
  ["居中留50%", 0.25, 0.25, 0.5, 0.5],
  ["居中留25%", 0.375, 0.375, 0.25, 0.25],
  ["留50%偏左上", 0, 0, 0.5, 0.5],
  ["留50%偏右下", 0.5, 0.5, 0.5, 0.5],
  ["留25%偏左上", 0, 0, 0.25, 0.25],
  ["裁成竖条(留50%宽)", 0.25, 0, 0.5, 1],
  ["裁成横条(留50%高)", 0, 0.25, 1, 0.5],
];

const stat = { A: {}, B: {} };
for (const [cname, x, y, w, h] of CROPS) {
  stat.A[cname] = { hit: 0, total: 0, falsePos: 0 };
  stat.B[cname] = { hit: 0, total: 0, falsePos: 0 };
}
for (const s of samples) {
  for (const [cname, x, y, w, h] of CROPS) {
    let q;
    try {
      q = await computePHash(await cropBuf(s.path, x, y, w, h));
    } catch {
      continue;
    }
    if (!q) continue;
    for (const [key, index] of [
      ["A", indexA],
      ["B", indexB],
    ]) {
      const hits = query(index, q, 4);
      stat[key][cname].total++;
      if (hits.has(s.id)) stat[key][cname].hit++;
      stat[key][cname].falsePos += Math.max(0, hits.size - (hits.has(s.id) ? 1 : 0));
    }
  }
  if (stat.A[CROPS[0][0]].total % 25 === 0) {
    log(`  …已处理 ${stat.A[CROPS[0][0]].total} 张`);
  }
}

log("\n=== 找到原图的命中率（阈值 4 = 快档）===");
log("裁剪方式".padEnd(22) + "方案A(只存整图)".padEnd(20) + "方案B(加局部指纹)");
for (const [cname] of CROPS) {
  const a = stat.A[cname];
  const b = stat.B[cname];
  const pa = a.total ? (a.hit / a.total) * 100 : 0;
  const pb = b.total ? (b.hit / b.total) * 100 : 0;
  log(
    cname.padEnd(22) +
      `${pa.toFixed(1)}% (${a.hit}/${a.total})`.padEnd(20) +
      `${pb.toFixed(1)}% (${b.hit}/${b.total})`
  );
}
const fa = Object.values(stat.A).reduce((s, v) => s + v.falsePos, 0);
const fb = Object.values(stat.B).reduce((s, v) => s + v.falsePos, 0);
const ta = Object.values(stat.A).reduce((s, v) => s + v.total, 0);
log(`\n误报（命中原图之外还带出多少无关图）：方案A 共 ${fa} 张 / ${ta} 次查询；方案B 共 ${fb} 张`);
log(`索引体积：方案A ${indexA.size} 条；方案B ${indexB.size} 条（约 ${(indexB.size / indexA.size).toFixed(1)} 倍）`);
log("DONE");
