/**
 * 判定裁剪图的「真原图」：在候选图里做模板匹配（零均值归一化互相关 ZNCC）。
 *
 * 为什么需要它：CLIP 余弦 0.96~0.98 看起来很高，但同角色不同作品也能到 0.87+，
 * 光看相似度无法区分「这是原图」和「只是同一个角色」。模板匹配能找到裁剪区域
 * 在候选图中的位置与比例 → 同时得到「裁掉了多少」。
 *
 * 用法：electron.exe --experimental-strip-types scripts/verify-crop-source.mjs <outFile>
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { InferenceSession, Tensor } = require("onnxruntime-node");
const lancedb = require("@lancedb/lancedb");
const Database = require("better-sqlite3");

const outFile = process.argv[2] || "crop-source.txt";
const log = (m) => fs.appendFileSync(outFile, `${m}\n`);
fs.writeFileSync(outFile, "");

const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const SIZE = 224;
const CLIP_ONNX = path.join(
  "F:\\AI Anime Image Manager NEXT\\models",
  "Xenova",
  "chinese-clip-vit-base-patch16",
  "onnx",
  "model_quantized.onnx"
);

const QUERIES = [
  ["图1 猫耳粉发少女", "d7f93d2fb9599e54e69ce77d1cc3d135bf6a183824199b1c2befd7e005901aa1"],
  ["图2 金发蓝眼女仆", "f85af0e3079783d39df258de832fb2eb8c336f77ea5341c94020fac73f0cff62"],
  ["图3 樱花和服（倒置）", "74f0a5cc55fd06435f3c51f7ea1f1da3026d1f14e1af75222722cfd09f1bebd8"],
  ["图4 粉眼蕾丝边", "31fdba7e1518223b0d5bbc21747b83b690c7b6f266aac9c12e81f093f17cd608"],
].map(([name, sha]) => [
  name,
  `C:\\Users\\Sakura\\.dsh\\attachments\\v1\\objects\\${sha.slice(0, 2)}\\${sha}`,
]);

// ---- CLIP 查询 ----
const session = await InferenceSession.create(CLIP_ONNX, {
  executionProviders: ["cpu"],
  logSeverityLevel: 3,
});
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

// ---- 模板匹配 ----
const PATCH = 16; // 比对用的灰度块边长
async function grayRaw(file, width) {
  const { data, info } = await sharp(file, { failOn: "none" })
    .rotate()
    .resize({ width })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { px: new Uint8Array(data), w: info.width, h: info.height };
}
/** 从灰度大图里取 (x,y,w,h) 区域并重采样成 PATCH×PATCH */
async function sampleRegion(img, x, y, w, h) {
  const left = Math.max(0, Math.min(img.w - 1, Math.round(x)));
  const top = Math.max(0, Math.min(img.h - 1, Math.round(y)));
  const width = Math.max(2, Math.min(img.w - left, Math.round(w)));
  const height = Math.max(2, Math.min(img.h - top, Math.round(h)));
  const { data } = await sharp(Buffer.from(img.px), {
    raw: { channels: 1, width: img.w, height: img.h },
  })
    .extract({ left, top, width, height })
    .resize(PATCH, PATCH, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Float64Array(data);
}
function zncc(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / (Math.sqrt(da * db) || 1);
}

/** 在候选图里找查询图的最佳位置与比例 */
async function bestTemplateMatch(candidatePath, queryPath) {
  const cand = await grayRaw(candidatePath, 192);
  const qMeta = await sharp(queryPath, { failOn: "none" }).metadata();
  const qAspect = (qMeta.width ?? 1) / (qMeta.height ?? 1);
  let best = { score: -1, scale: 0, x: 0, y: 0 };
  for (let s = 20; s <= 100; s += 6) {
    const scale = s / 100;
    const w = cand.w * scale;
    const h = w / qAspect;
    if (h > cand.h || w < 8 || h < 8) {
      continue;
    }
    const q = await sampleRegion(
      await (async () => {
        const { data, info } = await sharp(queryPath, { failOn: "none" })
          .rotate()
          .resize(PATCH, PATCH, { fit: "fill" })
          .grayscale()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { px: new Uint8Array(data), w: info.width, h: info.height };
      })(),
      0,
      0,
      PATCH,
      PATCH
    );
    const stepX = Math.max(2, Math.round((cand.w - w) / 8)) || 2;
    const stepY = Math.max(2, Math.round((cand.h - h) / 8)) || 2;
    for (let y = 0; y + h <= cand.h; y += stepY) {
      for (let x = 0; x + w <= cand.w; x += stepX) {
        const region = await sampleRegion(cand, x, y, w, h);
        const score = zncc(q, region);
        if (score > best.score) {
          best = { score, scale, x, y };
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

for (const [name, file] of QUERIES) {
  if (!fs.existsSync(file)) {
    continue;
  }
  const vec = await embedImage(file);
  const hits = await table.search(vec).limit(12).toArray();
  const seen = new Set();
  const cands = [];
  for (const h of hits) {
    const id = Number(h.id ?? h.photo_id ?? h.photoId);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const r = info(id);
    if (r) {
      cands.push({ id, ...r });
    }
    if (cands.length >= 6) {
      break;
    }
  }
  log(`[${name}]`);
  log(`   CLIP 前 6 名候选做模板匹配（1.0 = 完全吻合；<0.5 基本无关）：`);
  let bestAny = { score: -1 };
  for (const c of cands) {
    let m;
    try {
      m = await bestTemplateMatch(c.path, file);
    } catch (err) {
      log(`     ${(c.path.split("\\").pop() ?? "").slice(0, 40)}  匹配失败 ${err.message}`);
      continue;
    }
    const verdict =
      m.score >= 0.8 ? "★强吻合（几乎确定是原图）" : m.score >= 0.6 ? "中等" : "不吻合";
    log(
      `     ${m.score.toFixed(3)}  ${verdict}  位置(${m.x},${m.y}) 占原图 ${(m.scale * 100).toFixed(0)}%宽  ` +
        `${(c.path.split("\\").pop() ?? "").slice(0, 34)} ${c.width}x${c.height}`
    );
    if (m.score > bestAny.score) {
      bestAny = { score: m.score, ...c, ...m };
    }
  }
  log(
    `   → 最吻合 ${bestAny.score?.toFixed?.(3) ?? "—"}，` +
      `裁掉约 ${bestAny.scale ? Math.round((1 - bestAny.scale * bestAny.scale) * 100) : "?"}% 面积`
  );
  log("");
}
sq.close();
log("DONE");
