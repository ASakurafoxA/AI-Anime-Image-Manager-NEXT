/**
 * 测「以图搜图」现在这条路（Chinese-CLIP 语义向量）能不能搜到用户的裁剪图。
 * 用生产同款预处理（224 cover + CLIP 均值方差），查 LanceDB 的 photo_embeddings。
 *
 * 用法：electron.exe --experimental-strip-types scripts/match-crop-clip.mjs <outFile>
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { InferenceSession, Tensor } = require("onnxruntime-node");
const lancedb = require("@lancedb/lancedb");
const Database = require("better-sqlite3");

const outFile = process.argv[2] || "crop-clip.txt";
const log = (m) => fs.appendFileSync(outFile, `${m}\n`);
fs.writeFileSync(outFile, "");

const MODELS_DIR = "F:\\AI Anime Image Manager NEXT\\models";
const CLIP_ONNX = path.join(
  MODELS_DIR,
  "Xenova",
  "chinese-clip-vit-base-patch16",
  "onnx",
  "model_quantized.onnx"
);
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const SIZE = 224;

const QUERIES = [
  ["图1 猫耳粉发少女", "d7f93d2fb9599e54e69ce77d1cc3d135bf6a183824199b1c2befd7e005901aa1"],
  ["图2 金发蓝眼女仆", "f85af0e3079783d39df258de832fb2eb8c336f77ea5341c94020fac73f0cff62"],
  ["图3 樱花和服（倒置）", "74f0a5cc55fd06435f3c51f7ea1f1da3026d1f14e1af75222722cfd09f1bebd8"],
  ["图4 粉眼蕾丝边", "31fdba7e1518223b0d5bbc21747b83b690c7b6f266aac9c12e81f093f17cd608"],
].map(([name, sha]) => [
  name,
  `C:\\Users\\Sakura\\.dsh\\attachments\\v1\\objects\\${sha.slice(0, 2)}\\${sha}`,
]);

const session = await InferenceSession.create(CLIP_ONNX, {
  executionProviders: ["cpu"],
  logSeverityLevel: 3,
});

function buildFeeds(provided) {
  const feeds = { ...provided };
  const have = new Set(Object.keys(feeds));
  for (const name of session.inputNames ?? []) {
    if (!have.has(name)) {
      feeds[name] = new Tensor("int64", new BigInt64Array(16), [1, 16]);
    }
  }
  return feeds;
}

function toNCHW(rgb, size) {
  const ppc = size * size;
  const out = new Float32Array(3 * ppc);
  for (let i = 0; i < ppc; i++) {
    for (let c = 0; c < 3; c++) {
      out[c * ppc + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  return out;
}

async function embedImage(file) {
  const { data } = await sharp(file, { failOn: "none" })
    .rotate()
    .resize(SIZE, SIZE, { fit: "cover", position: "center" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const out = await session.run(
    buildFeeds({
      pixel_values: new Tensor("float32", toNCHW(rgb, SIZE), [1, 3, SIZE, SIZE]),
    })
  );
  const key =
    session.outputNames.find((n) => /image_embeds/i.test(n)) ??
    session.outputNames[0];
  const vec = Array.from(out[key].data);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

const db = await lancedb.connect("F:\\AI Anime Image Manager NEXT\\vectors");
const names = await db.tableNames();
log(`向量表: ${JSON.stringify(names)}`);
const table = await db.openTable("photo_embeddings");
log(`photo_embeddings 行数: ${await table.countRows()}\n`);

const sq = new Database(
  "F:\\AI Anime Image Manager NEXT\\data\\ai-image-manager.db",
  { readonly: true, fileMustExist: true }
);
const pathOf = (id) => {
  const r = sq
    .prepare("SELECT path, width, height FROM photos WHERE id = ?")
    .get(Number(id));
  return r ? `${(r.path.split("\\").pop() ?? "").slice(0, 46)}  ${r.width}x${r.height}` : "(找不到)";
};

for (const [name, file] of QUERIES) {
  if (!fs.existsSync(file)) {
    log(`[${name}] 文件不存在\n`);
    continue;
  }
  const vec = await embedImage(file);
  const hits = await table.search(vec).limit(10).toArray();
  log(`[${name}]  Top10 语义相似（余弦 = 1 - 距离/2）：`);
  hits.forEach((h, i) => {
    const d = Number(h._distance ?? 0);
    const cos = 1 - d / 2;
    const id = h.id ?? h.photo_id ?? h.photoId;
    log(`   ${String(i + 1).padStart(2)}. 余弦 ${cos.toFixed(4)}   ${pathOf(id)}`);
  });
  log("");
}
sq.close();
log("DONE");
