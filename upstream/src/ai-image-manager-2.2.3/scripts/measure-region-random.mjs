/**
 * 局部指纹方案在「随机位置/随机比例裁切」下的真实命中率（上次那 100% 是理想情况）。
 *
 * 对比三种存储方案：
 *   现状   ：只存整图指纹
 *   方案B  ：整图 + 中心2档 + 四象限2档 = 11 个指纹
 *   方案C  ：整图 + 3×3 网格 × 2 档（0.7 / 0.5）= 19 个指纹
 * 查询：随机位置、裁掉 50% / 75% 面积，看能否找回原图，并统计误报。
 *
 * 用法：electron.exe --experimental-strip-types scripts/measure-region-random.mjs <outFile>
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import sharp from "sharp";
import { hammingDistance } from "../src/services/bk-tree.ts";
import { computePHash } from "../src/services/phash.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const outFile = process.argv[2] || "region-random.txt";
const log = (m) => fs.appendFileSync(outFile, `${m}\n`);
fs.writeFileSync(outFile, "");

const B_REGIONS = [
  [0.146, 0.146, 0.707, 0.707],
  [0.25, 0.25, 0.5, 0.5],
  [0, 0, 0.707, 0.707],
  [0.293, 0, 0.707, 0.707],
  [0, 0.293, 0.707, 0.707],
  [0.293, 0.293, 0.707, 0.707],
  [0, 0, 0.5, 0.5],
  [0.5, 0, 0.5, 0.5],
  [0, 0.5, 0.5, 0.5],
  [0.5, 0.5, 0.5, 0.5],
];

function gridRegions(scale) {
  const out = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      // 3×3 网格、每块占整图 scale 比例，位置均分
      const x = (gx / 2) * (1 - scale);
      const y = (gy / 2) * (1 - scale);
      out.push([x, y, scale, scale]);
    }
  }
  return out;
}
const C_REGIONS = [...gridRegions(0.7), ...gridRegions(0.5)];

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
     ORDER BY id LIMIT 2000`
  )
  .all();
db.close();

const N = 100;
const samples = [];
for (const r of rows) {
  if (samples.length >= N) break;
  if (fs.existsSync(r.path)) samples.push(r);
}
log(`取样 ${samples.length} 张；每张额外算 方案B ${B_REGIONS.length} 个 / 方案C ${C_REGIONS.length} 个局部指纹\n`);

const t0 = Date.now();
const idx = { A: new Map(), B: new Map(), C: new Map() };
const add = (map, hash, id) => {
  if (!map.has(hash)) map.set(hash, []);
  map.get(hash).push(id);
};
for (const s of samples) {
  try {
    const full = await computePHash(s.path);
    if (!full) continue;
    add(idx.A, full, s.id);
    add(idx.B, full, s.id);
    add(idx.C, full, s.id);
    for (const [x, y, w, h] of B_REGIONS) {
      const hp = await computePHash(await cropBuf(s.path, x, y, w, h));
      if (hp) add(idx.B, hp, s.id);
    }
    for (const [x, y, w, h] of C_REGIONS) {
      const hp = await computePHash(await cropBuf(s.path, x, y, w, h));
      if (hp) add(idx.C, hp, s.id);
    }
  } catch {
    /* ignore */
  }
}
log(
  `索引：A ${idx.A.size} / B ${idx.B.size} / C ${idx.C.size} 条指纹；建索引 ${((Date.now() - t0) / 1000).toFixed(0)}s\n`
);

function query(map, q) {
  const hits = new Set();
  for (const [h, ids] of map) {
    if (hammingDistance(h, q) <= 4) {
      for (const id of ids) hits.add(id);
    }
  }
  return hits;
}

// 随机裁切：面积保留 keep，位置随机
function randCrop(keep, seed) {
  const s = Math.sqrt(keep);
  // 简单可复现的伪随机
  const r1 = ((seed * 9301 + 49297) % 233280) / 233280;
  const r2 = ((seed * 4909 + 12347) % 233281) / 233281;
  const x = r1 * (1 - s);
  const y = r2 * (1 - s);
  return [x, y, s, s];
}

const cases = [
  ["随机裁掉50%面积", 0.5],
  ["随机裁掉75%面积", 0.25],
];
const res = {};
for (const [name] of cases) {
  res[name] = {
    A: { hit: 0, n: 0, fp: 0 },
    B: { hit: 0, n: 0, fp: 0 },
    C: { hit: 0, n: 0, fp: 0 },
  };
}

let seed = 1;
for (const s of samples) {
  for (const [name, keep] of cases) {
    for (let k = 0; k < 3; k++) {
      const [x, y, w, h] = randCrop(keep, seed++);
      let q;
      try {
        q = await computePHash(await cropBuf(s.path, x, y, w, h));
      } catch {
        continue;
      }
      if (!q) continue;
      for (const key of ["A", "B", "C"]) {
        const hits = query(idx[key], q);
        const r = res[name][key];
        r.n++;
        if (hits.has(s.id)) r.hit++;
        r.fp += Math.max(0, hits.size - (hits.has(s.id) ? 1 : 0));
      }
    }
  }
}

log("=== 随机位置裁切：找回原图的命中率（阈值 4）===");
for (const [name] of cases) {
  log(`\n${name}`);
  for (const [label, key] of [
    ["现状（只存整图）", "A"],
    ["方案B（11 个指纹）", "B"],
    ["方案C（19 个指纹）", "C"],
  ]) {
    const r = res[name][key];
    const pct = r.n ? ((r.hit / r.n) * 100).toFixed(1) : "0";
    log(
      `   ${label.padEnd(20)} 命中 ${pct}%  (${r.hit}/${r.n})   带出无关图 ${r.fp} 张`
    );
  }
}
log("\n判读：命中率高且无关图少才有实用价值");
log("DONE");
