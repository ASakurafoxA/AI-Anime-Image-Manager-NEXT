/**
 * 实测：pHash 对「裁图」到底有多敏感？顺带验证「多区域指纹」能不能救。
 *
 * 用生产同一份 computePHash（scripts 里直接 import src/services/phash.ts）。
 * 用法：electron.exe --experimental-strip-types scripts/measure-crop-phash.mjs <outFile>
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import sharp from "sharp";
import { hammingDistance } from "../src/services/bk-tree.ts";
import { computePHash } from "../src/services/phash.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const outFile = process.argv[2] || "measure-crop.txt";
const log = (m) => fs.appendFileSync(outFile, `${m}\n`);
fs.writeFileSync(outFile, "");

const db = new Database(
  "F:\\AI Anime Image Manager NEXT\\data\\ai-image-manager.db",
  { readonly: true, fileMustExist: true }
);
// 取若干张真实图片（跳过不存在的文件）
const rows = db
  .prepare(
    `SELECT id, path, width, height FROM photos
     WHERE deleted_at IS NULL AND phash IS NOT NULL
       AND width IS NOT NULL AND width >= 800
     ORDER BY id LIMIT 400`
  )
  .all();
db.close();

const samples = [];
for (const r of rows) {
  if (samples.length >= 6) break;
  if (fs.existsSync(r.path)) samples.push(r);
}
log(`取样 ${samples.length} 张真实图片\n`);

/** 居中裁剪：保留面积比例 keep（keep=0.5 → 宽高各留 sqrt(0.5)） */
async function centerCrop(path, keep) {
  const img = sharp(path);
  const meta = await img.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const scale = Math.sqrt(keep);
  const cw = Math.max(32, Math.round(w * scale));
  const ch = Math.max(32, Math.round(h * scale));
  return sharp(path)
    .extract({
      left: Math.round((w - cw) / 2),
      top: Math.round((h - ch) / 2),
      width: cw,
      height: ch,
    })
    .png()
    .toBuffer();
}

/** 偏心裁剪（从左上角开始） */
async function cornerCrop(path, keep) {
  const meta = await sharp(path).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const scale = Math.sqrt(keep);
  return sharp(path)
    .extract({
      left: 0,
      top: 0,
      width: Math.max(32, Math.round(w * scale)),
      height: Math.max(32, Math.round(h * scale)),
    })
    .png()
    .toBuffer();
}

/** 取图像某个区域（相对坐标 0~1）作为指纹来源 */
async function region(path, x, y, rw, rh) {
  const meta = await sharp(path).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  return sharp(path)
    .extract({
      left: Math.round(w * x),
      top: Math.round(h * y),
      width: Math.max(32, Math.round(w * rw)),
      height: Math.max(32, Math.round(h * rh)),
    })
    .png()
    .toBuffer();
}

const summary = { center: {}, corner: {}, region: {} };

for (const s of samples) {
  const base = await computePHash(s.path);
  log(`[id ${s.id}] ${s.path.split("\\").pop()}  ${s.width}x${s.height}  全图指纹 ${base}`);

  for (const keep of [0.5, 0.25]) {
    const c = await computePHash(await centerCrop(s.path, keep));
    const d = hammingDistance(base, c);
    log(`   居中裁掉 ${Math.round((1 - keep) * 100)}% 面积 → 距离 ${d}`);
    (summary.center[keep] ??= []).push(d);
  }
  for (const keep of [0.5, 0.25]) {
    const c = await computePHash(await cornerCrop(s.path, keep));
    const d = hammingDistance(base, c);
    log(`   从角上裁到 ${Math.round(keep * 100)}% 面积 → 距离 ${d}`);
    (summary.corner[keep] ??= []).push(d);
  }

  // 多区域指纹方案：全图 + 中心 50% + 四角各 50% 面积
  const regions = [
    ["中心50%", await region(s.path, 0.25, 0.25, 0.5, 0.5)],
    ["左上50%", await region(s.path, 0, 0, 0.5, 0.5)],
    ["右上50%", await region(s.path, 0.5, 0, 0.5, 0.5)],
    ["左下50%", await region(s.path, 0, 0.5, 0.5, 0.5)],
    ["右下50%", await region(s.path, 0.5, 0.5, 0.5, 0.5)],
  ];
  const regionHashes = [];
  for (const [name, buf] of regions) {
    regionHashes.push([name, await computePHash(buf)]);
  }

  // 用它自己的「中心 50% 裁剪」当查询图，看能不能对上任一区域指纹
  const queryCrop = await computePHash(await centerCrop(s.path, 0.5));
  const dists = regionHashes.map(([name, h]) => [name, hammingDistance(queryCrop, h)]);
  const best = dists.reduce((a, b) => (b[1] < a[1] ? b : a));
  log(
    `   查询=居中裁 50% 面积 → 与各区域指纹距离: ` +
      dists.map(([n, d]) => `${n}:${d}`).join("  ") +
      `   → 最像「${best[0]}」(${best[1]})`
  );
  (summary.region[best[0]] ??= []).push(best[1]);
  log("");
}

function stat(arr) {
  if (!arr?.length) return "—";
  const s = [...arr].sort((a, b) => a - b);
  const mid = s[Math.floor(s.length / 2)];
  return `中位 ${mid}（范围 ${s[0]}~${s[s.length - 1]}）`;
}

log("=== 汇总 ===");
for (const keep of [0.5, 0.25]) {
  log(
    `居中裁掉 ${Math.round((1 - keep) * 100)}% 面积：距离 ${stat(summary.center[keep])}` +
      `   | 角上裁到 ${Math.round(keep * 100)}%：距离 ${stat(summary.corner[keep])}`
  );
}
const regionBest = Object.values(summary.region).flat();
log(`\n多区域指纹方案：查询图（居中裁 50% 面积）与最匹配区域指纹的距离 ${stat(regionBest)}`);
log("\n对照：阈值 4 = 快档；8 = 生产默认；12 = 细档；不同内容之间实测约 26~40");
log("DONE");
