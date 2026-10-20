/**
 * 强化版模板匹配：纯 JS 双线性采样（不再逐点调用 sharp），
 * 候选池扩大到 CLIP 前 40 名，并测 0°/90°/180°/270° 四种朝向。
 *
 * 目的：判定「以图搜图（CLIP）」在裁图场景下到底能不能找到原图；
 * 同时给出裁剪比例（占原图多少）。
 *
 * 用法：electron.exe --experimental-strip-types scripts/verify-crop-source2.mjs <outFile>
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { InferenceSession, Tensor } = require("onnxruntime-node");
const lancedb = require("@lancedb/lancedb");
const Database = require("better-sqlite3");

const outFile = process.argv[2] || "crop-source2.txt";
const log = (m) => fs.appendFileSync(outFile, `${m}\n`);
fs.writeFileSync(outFile, "");

const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const SIZE = 224;
const PATCH = 24;

const QUERIES = [
  ["图1 猫耳粉发少女", "d7f93d2fb9599e54e69ce77d1cc3d135bf6a183824199b1c2befd7e005901aa1"],
  ["图2 金发蓝眼女仆", "f85af0e3079783d39df258de832fb2eb8c336f77ea5341c94020fac73f0cff62"],
  ["图3 樱花和服（倒置）", "74f0a5cc55fd06435f3c51f7ea1f1da3026d1f14e1af75222722cfd09f1bebd8"],
  ["图4 粉眼蕾丝边", "31fdba7e1518223b0d5bbc21747b83b690c7b6f266aac9c12e81f093f17cd608"],
].map(([name, sha]) => [
  name,
  `C:\\Users\\Sakura\\.dsh\\attachments\\v1\\objects\\${sha.slice(0, 2)}\\${sha}`,
]);

const session = await InferenceSession.create(
  path.join(
    "F:\\AI Anime Image Manager NEXT\\models",
    "Xenova",
    "chinese-clip-vit-base-patch16",
    "onnx",
    "model_quantized.onnx"
  ),
  { executionProviders: ["cpu"], logSeverityLevel: 3 }
);
function feeds(p) {
  const f = { ...p };
  const have = new Set(Object.keys(f));
  for (const n of session.inputNames ?? []) {
    if (!have.has(n)) {
      f[n] = new Tensor("int64", new BigInt64Array(16), [1, 16]);
    }
  }
  return f;
}
async function embedImage(file) {
  const { data } = await sharp(file, { failOn: "none" })
    .rotate()
    .resize(SIZE, SIZE, { fit: "cover", position: "center" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const ppc = SIZE * SIZE;
  const t = new Float32Array(3 * ppc);
  for (let i = 0; i < ppc; i++) {
    for (let c = 0; c < 3; c++) {
      t[c * ppc + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  const out = await session.run(
    feeds({ pixel_values: new Tensor("float32", t, [1, 3, SIZE, SIZE]) })
  );
  const key =
    session.outputNames.find((n) => /image_embeds/i.test(n)) ??
    session.outputNames[0];
  const v = Array.from(out[key].data);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

async function gray(file, width) {
  const { data, info } = await sharp(file, { failOn: "none" })
    .rotate()
    .resize({ width })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { px: new Uint8Array(data), w: info.width, h: info.height };
}

/** 把查询图（含旋转）采成 PATCH×PATCH 灰度块 */
async function queryPatch(file, rotate) {
  let img = sharp(file, { failOn: "none" }).rotate();
  if (rotate) {
    img = img.rotate(rotate);
  }
  const { data } = await img
    .resize(PATCH, PATCH, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const a = new Float64Array(PATCH * PATCH);
  for (let i = 0; i < a.length; i++) {
    a[i] = data[i];
  }
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    a[i] -= m;
    d += a[i] * a[i];
  }
  const norm = Math.sqrt(d) || 1;
  for (let i = 0; i < a.length; i++) {
    a[i] /= norm;
  }
  return a;
}

function znccNormalized(cand, x0, y0, w, h, qNorm) {
  // 双线性采样 PATCH×PATCH，并做与 queryPatch 相同的零均值归一化
  const a = new Float64Array(PATCH * PATCH);
  let sum = 0;
  for (let py = 0; py < PATCH; py++) {
    for (let px = 0; px < PATCH; px++) {
      const sx = x0 + ((px + 0.5) * w) / PATCH;
      const sy = y0 + ((py + 0.5) * h) / PATCH;
      const x1 = Math.min(cand.w - 1, Math.max(0, Math.floor(sx)));
      const y1 = Math.min(cand.h - 1, Math.max(0, Math.floor(sy)));
      const x2 = Math.min(cand.w - 1, x1 + 1);
      const y2 = Math.min(cand.h - 1, y1 + 1);
      const fx = sx - x1;
      const fy = sy - y1;
      const v =
        cand.px[y1 * cand.w + x1] * (1 - fx) * (1 - fy) +
        cand.px[y1 * cand.w + x2] * fx * (1 - fy) +
        cand.px[y2 * cand.w + x1] * (1 - fx) * fy +
        cand.px[y2 * cand.w + x2] * fx * fy;
      a[py * PATCH + px] = v;
      sum += v;
    }
  }
  const mean = sum / a.length;
  let dot = 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    a[i] -= mean;
    d += a[i] * a[i];
    dot += a[i] * qNorm[i];
  }
  return dot / (Math.sqrt(d) || 1); // qNorm 已归一化
}

/** 在候选图里找查询图（可多朝向）的最佳位置与比例 */
function bestMatch(cand, patches) {
  let best = { score: -1, scale: 0, x: 0, y: 0, rotate: 0 };
  for (const { rotate, q } of patches) {
    for (let s = 20; s <= 100; s += 5) {
      const scale = s / 100;
      const w = cand.w * scale;
      // 朝向 90/270 时长宽互换：这里按「查询块」的实际内容比例处理 —
      // 对 0/180 用原比例，对 90/270 用倒数
      const qMeta = rotate === 90 || rotate === 270 ? 1 / (q.aspect || 1) : q.aspect;
      const h = w / (qMeta || 1);
      if (h > cand.h || w < 10 || h < 10) {
        continue;
      }
      const stepX = Math.max(2, Math.round((cand.w - w) / 12));
      const stepY = Math.max(2, Math.round((cand.h - h) / 12));
      for (let y = 0; y + h <= cand.h + 1; y += stepY) {
        for (let x = 0; x + w <= cand.w + 1; x += stepX) {
          const score = znccNormalized(cand, x, y, w, h, q);
          if (score > best.score) {
            best = { score, scale, x, y, rotate };
          }
        }
      }
    }
  }
  return best;
}

const db = await lancedb.connect("F:\\AI Anime Image Manager NEXT\\vectors");
const table = await db.openTable("photo_embeddings");
const sq = new Database(
  "F:\\AI Anime Image Manager NEXT\\data\\ai-image-manager.db",
  { readonly: true, fileMustExist: true }
);
const info = (id) =>
  sq.prepare("SELECT path, width, height FROM photos WHERE id = ?").get(Number(id));

const summary = [];

for (const [name, file] of QUERIES) {
  if (!fs.existsSync(file)) {
    continue;
  }
  const qm = await sharp(file, { failOn: "none" }).metadata();
  const aspect = (qm.width ?? 1) / (qm.height ?? 1);
  const patches = [];
  for (const rotate of [0, 90, 180, 270]) {
    patches.push({ rotate, q: await queryPatch(file, rotate), aspect });
  }

  const vec = await embedImage(file);
  const hits = await table.search(vec).limit(60).toArray();
  const seen = new Set();
  const cands = [];
  for (const h of hits) {
    const id = Number(h.id ?? h.photo_id ?? h.photoId);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const r = info(id);
    if (r?.path && fs.existsSync(r.path)) {
      cands.push({ id, ...r });
    }
    if (cands.length >= 40) {
      break;
    }
  }

  let best = { score: -1 };
  for (const c of cands) {
    let cand;
    try {
      cand = await gray(c.path, 320);
    } catch {
      continue;
    }
    const m = bestMatch(cand, patches);
    if (m.score > best.score) {
      best = { ...m, ...c };
    }
  }
  const croppedPct =
    best.scale > 0 ? Math.round((1 - best.scale * best.scale) * 100) : null;
  log(
    `[${name}] 候选 ${cands.length} 张（CLIP 前 40）→ 最佳匹配 ${best.score.toFixed(3)}  ` +
      `${best.score >= 0.8 ? "★找到原图" : best.score >= 0.65 ? "可能" : "没找到"}  ` +
      `${(best.path?.split("\\").pop() ?? "—").slice(0, 40)} ${best.width}x${best.height}  ` +
      `位置(${best.x},${best.y}) 占比 ${(best.scale * 100).toFixed(0)}%宽 旋转${best.rotate}° ` +
      (croppedPct != null ? `≈裁掉${croppedPct}%面积` : "")
  );
  summary.push({ name, score: best.score, path: best.path, rotate: best.rotate });
}

log("\n=== 汇总 ===");
for (const s of summary) {
  log(
    `  ${s.name}: 最佳 ${s.score.toFixed(3)} ${s.score >= 0.8 ? "→ CLIP 能搜到原图" : "→ CLIP 搜不到原图"}`
  );
}
log("DONE");
