/**
 * 语义搜索 A/B 对比：int8 量化 vs 未量化（fp32）Chinese-CLIP
 * ==========================================================
 *
 * 背景：线上图库的语义搜索用 `Xenova/chinese-clip-vit-base-patch16`，但磁盘上
 * 只有 **int8 量化版** `onnx/model_quantized.onnx`（190MB）。同类工具 MaterialSearch
 * 用的是未量化 PyTorch 模型。本脚本用同一批图、同一个查询词，分别跑两套权重，
 * 回答一个问题：**两者只是分数尺度不同，还是排序真的不同？**
 *
 * 严格复刻线上预处理（见 scripts/embed-worker.mjs 的 preprocessImage）：
 *   sharp(file).rotate().resize(224,224,{fit:"cover",position:"center"}).removeAlpha().raw()
 *   → CHW float32，逐通道 (px/255 - mean)/std
 *   mean=[0.48145466,0.4578275,0.40821073]  std=[0.26862954,0.26130258,0.27577711]
 *   → 图像塔输出 image_embeds → L2 归一化
 * 文本塔与线上一致（见 scripts/text-embed-worker.mjs）：
 *   @xenova/transformers 分词（padding=max_length, truncation, max_length=52）
 *   → onnxruntime-node 直接跑合并图，pixel_values 补零
 *   → text_embeds → L2 归一化
 *
 * 约束（严格遵守）：
 *   - SQLite 只读打开（node:sqlite readOnly），绝不写生产库；
 *   - 生产向量库 F:\AI Anime Image Manager NEXT\vectors\ 完全不碰，中间结果只写本脚本的 outDir；
 *   - 推理只用 CPU execution provider（executionProviders:["cpu"]），不占 DirectML/GPU；
 *   - intraOpNumThreads=1，与线上 embedder.ts / search.ts 的 CPU worker 配置一致。
 *
 * 用法：
 *   node scripts/semantic-ab-unquantized.mjs
 *   node scripts/semantic-ab-unquantized.mjs --limit 150
 */

import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const require = createRequire(import.meta.url);

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

/** 图库数据/模型根目录（模型、SQLite 都在这下面）。 */
const GALLERY_ROOT = "F:\\AI Anime Image Manager NEXT";
const DB_PATH = path.join(GALLERY_ROOT, "data", "ai-image-manager.db");
const MODEL_ROOT = path.join(GALLERY_ROOT, "models");
const CLIP_DIR_REL = "Xenova/chinese-clip-vit-base-patch16";

/**
 * DSH 工作区根目录（脚本所在目录往上 4 层）。
 * 中间结果与 HTML 都放这里 —— 图库数据盘保持原样，绝不污染生产目录。
 */
const WORKSPACE_ROOT = path.resolve(HERE, "..", "..", "..", "..");
/** 中间结果目录：新目录，绝不写进生产 vectors\。 */
const OUT_DIR = path.join(WORKSPACE_ROOT, "semantic-ab-out");
/** 用户双击就能看的对比页。 */
const HTML_PATH = path.join(WORKSPACE_ROOT, "语义AB对比.html");

const QUANTIZED_ONNX = path.join(MODEL_ROOT, CLIP_DIR_REL, "onnx", "model_quantized.onnx");
const FP32_ONNX = path.join(MODEL_ROOT, CLIP_DIR_REL, "onnx", "model.onnx");

/** 与 adapter 完全一致的 CLIP 归一化常量。 */
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];
const IMAGE_SIZE = 224;
const DIMENSIONS = 512;
const MAX_LENGTH = 52;

const QUERY = "戴着耳机坐在屋里的少女";
const TOP_K = 15;

/** 取样：按 id 升序全库等距抽取，保证可复现。 */
function parseArgs() {
  const argv = process.argv.slice(2);
  const getNum = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return fallback;
    const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    limit: getNum("limit", 300),
    threads: getNum("threads", 1),
    skipFp32: argv.includes("--skip-fp32"),
    skipQuant: argv.includes("--skip-quant"),
    renderOnly: argv.includes("--render-only"),
  };
}

const ARGS = parseArgs();

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const round = (value, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const l2Normalize = (values) => {
  let sum = 0;
  for (const value of values) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  return Float32Array.from(values, (value) => value / norm);
};

const dot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const median =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return {
    count: values.length,
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    mean: round(mean),
    median: round(median),
    // 标准差（总体）
    std: round(Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length)),
  };
}

/** 平均秩（处理并列），用于 Spearman。 */
function ranks(values) {
  const order = values.map((value, index) => ({ value, index }));
  order.sort((a, b) => a.value - b.value);
  const result = new Array(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j++;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) result[order[k].index] = averageRank;
    i = j + 1;
  }
  return result;
}

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
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
  return num / (Math.sqrt(da) * Math.sqrt(db) || 1);
}

const spearman = (a, b) => pearson(ranks(a), ranks(b));

/** 信息性排序（Kendall 的简化替代：两两一致率，随机抽样 20000 对）。 */
function pairwiseAgreement(a, b) {
  const n = a.length;
  const pairs = 20000;
  let agree = 0;
  let total = 0;
  // 固定种子伪随机，保证可复现
  let seed = 20261016;
  const nextInt = (bound) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % bound;
  };
  for (let t = 0; t < pairs; t++) {
    const i = nextInt(n);
    const j = nextInt(n);
    if (i === j) continue;
    const da = a[i] - a[j];
    const db = b[i] - b[j];
    if (da === 0 || db === 0) continue;
    total++;
    if (Math.sign(da) === Math.sign(db)) agree++;
  }
  return total > 0 ? agree / total : Number.NaN;
}

/* ------------------------------------------------------------------ *
 * 1. 取样（SQLite 只读）
 * ------------------------------------------------------------------ */

function samplePhotos(limit) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    // 固定规则：未删除的照片，按 id 升序，等距抽 limit 张。
    const rows = db
      .prepare(
        `SELECT id, path, filename FROM photos
         WHERE deleted_at IS NULL
         ORDER BY id ASC`
      )
      .all();
    const total = rows.length;
    if (total === 0) throw new Error("photos 表为空");

    const take = Math.min(limit, total);
    const picked = [];
    for (let i = 0; i < take; i++) {
      // 等距步长：i*N/take 向下取整 → 起点必为第 0 条，终点接近末条
      const index = Math.floor((i * total) / take);
      picked.push(rows[index]);
    }
    return {
      total,
      take,
      rule: `photos 表 deleted_at IS NULL，按 id 升序，等距抽取 ${take} 张（index = floor(i * ${total} / ${take}), i=0..${take - 1}）`,
      photos: picked.map((row) => ({ id: row.id, path: row.path, filename: row.filename })),
    };
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ *
 * 2. 图像预处理（与线上 embed-worker.mjs 逐行等价）
 * ------------------------------------------------------------------ */

async function preprocessImage(filePath) {
  const { data, info } = await sharp(filePath, { failOn: "none" })
    .rotate()
    .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "cover", position: "center" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (width !== IMAGE_SIZE || height !== IMAGE_SIZE || channels < 3) {
    throw new Error(`Image resize mismatch: ${width}x${height}x${channels}`);
  }

  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const pixelsPerChannel = IMAGE_SIZE * IMAGE_SIZE;
  const floatData = new Float32Array(3 * pixelsPerChannel);
  for (let y = 0; y < IMAGE_SIZE; y++) {
    for (let x = 0; x < IMAGE_SIZE; x++) {
      const sourceIndex = (y * IMAGE_SIZE + x) * channels;
      for (let c = 0; c < 3; c++) {
        const pixel = rgb[sourceIndex + c] / 255;
        floatData[c * pixelsPerChannel + y * IMAGE_SIZE + x] =
          (pixel - CLIP_MEAN[c]) / CLIP_STD[c];
      }
    }
  }
  return floatData;
}

async function makeThumbnail(filePath) {
  return sharp(filePath, { failOn: "none" })
    .rotate()
    .resize(220, 220, { fit: "cover", position: "center" })
    .jpeg({ quality: 74 })
    .toBuffer();
}

/* ------------------------------------------------------------------ *
 * 3. ONNX 会话与两塔推理
 * ------------------------------------------------------------------ */

/** 合并图要求所有声明输入都在场：只跑一塔时另一塔补零。 */
function buildFeeds(ort, session, provided) {
  const feeds = { ...provided };
  const providedNames = new Set(Object.keys(feeds));
  for (const name of session.inputNames ?? []) {
    if (providedNames.has(name)) continue;
    feeds[name] = /pixel_values$/i.test(name)
      ? new ort.Tensor("float32", new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE), [
          1,
          3,
          IMAGE_SIZE,
          IMAGE_SIZE,
        ])
      : new ort.Tensor("int64", new BigInt64Array(16), [1, 16]);
  }
  return feeds;
}

const toInt64 = (ort, tensor) =>
  new ort.Tensor(
    "int64",
    BigInt64Array.from(tensor.data, (value) => BigInt(value)),
    tensor.dims
  );

async function createSession(ort, onnxPath, label, threads = 1) {
  if (!fs.existsSync(onnxPath)) throw new Error(`${label} 模型不存在：${onnxPath}`);
  const started = Date.now();
  const session = await ort.InferenceSession.create(onnxPath, {
    // 只用 CPU：不和应用抢 DirectML/GPU
    executionProviders: ["cpu"],
    logSeverityLevel: 3,
    graphOptimizationLevel: "all",
    enableCpuMemArena: true,
    executionMode: "sequential",
    interOpNumThreads: 1,
    // 线上 CPU worker 池默认 intraOpNumThreads=4 / 2 workers（见 embed-worker-pool.ts
    // resolveEmbedPoolConfig）；这里默认 1 是为了让两个模型在完全相同的条件下对比。
    intraOpNumThreads: threads,
  });
  return {
    session,
    label,
    onnxPath,
    sizeBytes: fs.statSync(onnxPath).size,
    loadMs: Date.now() - started,
    intraOpNumThreads: threads,
    inputNames: [...(session.inputNames ?? [])],
    outputNames: [...(session.outputNames ?? [])],
  };
}

/** 用给定会话跑完 300 张图的图像塔 + 一次文本塔。 */
async function embedAll(ort, handle, pixelCache, tokenizer, log) {
  const { session, label } = handle;
  const imageVectors = new Float32Array(pixelCache.length * DIMENSIONS);
  const perImageMs = [];

  // 预热 3 张（不计时），避免把首次分配算进耗时
  for (let i = 0; i < Math.min(3, pixelCache.length); i++) {
    const tensor = new ort.Tensor("float32", pixelCache[i], [1, 3, IMAGE_SIZE, IMAGE_SIZE]);
    const output = await session.run(buildFeeds(ort, session, { pixel_values: tensor }));
    for (const value of Object.values(output)) value?.dispose?.();
  }

  for (let i = 0; i < pixelCache.length; i++) {
    const started = Date.now();
    const tensor = new ort.Tensor("float32", pixelCache[i], [1, 3, IMAGE_SIZE, IMAGE_SIZE]);
    const output = await session.run(buildFeeds(ort, session, { pixel_values: tensor }));
    const embeds = output.image_embeds ?? output[handle.outputNames.find((n) => /image/i.test(n))];
    if (!embeds) throw new Error(`${label}: 找不到 image_embeds 输出（实际：${handle.outputNames}）`);
    const normalized = l2Normalize(embeds.data);
    imageVectors.set(normalized, i * DIMENSIONS);
    perImageMs.push(Date.now() - started);
    for (const value of Object.values(output)) value?.dispose?.();
    if ((i + 1) % 25 === 0 || i === pixelCache.length - 1) {
      log(`${label}: 图像塔 ${i + 1}/${pixelCache.length}`);
    }
  }

  // 文本塔
  const inputs = await tokenizer([QUERY], {
    padding: "max_length",
    truncation: true,
    max_length: MAX_LENGTH,
  });
  const textOutput = await session.run(
    buildFeeds(ort, session, {
      input_ids: toInt64(ort, inputs.input_ids),
      ...(inputs.attention_mask ? { attention_mask: toInt64(ort, inputs.attention_mask) } : {}),
    })
  );
  const textEmbeds = textOutput.text_embeds ?? textOutput[handle.outputNames.find((n) => /text/i.test(n))];
  if (!textEmbeds) throw new Error(`${label}: 找不到 text_embeds 输出（实际：${handle.outputNames}）`);
  const textVector = l2Normalize(textEmbeds.data);
  for (const value of Object.values(textOutput)) value?.dispose?.();

  const sorted = [...perImageMs].sort((a, b) => a - b);
  return {
    imageVectors,
    textVector,
    timing: {
      images: perImageMs.length,
      totalMs: perImageMs.reduce((s, v) => s + v, 0),
      meanMsPerImage: round(perImageMs.reduce((s, v) => s + v, 0) / perImageMs.length, 1),
      medianMsPerImage: sorted[Math.floor(sorted.length / 2)],
      minMsPerImage: sorted[0],
      maxMsPerImage: sorted[sorted.length - 1],
    },
  };
}

/** 释放会话：ONNX 会话必须在两模型之间彻底丢弃，否则 fp32 会吃掉数 GB 内存。 */
async function disposeSafely(handle) {
  try {
    await handle?.session?.release?.();
  } catch {
    /* 忽略 */
  }
  if (global.gc) global.gc();
}

/* ------------------------------------------------------------------ *
 * 4. HTML 对比页
 * ------------------------------------------------------------------ */

function esc(text) {
  return String(text).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
}

function buildHtml(payload) {
  const { left, right, query, sampleMeta, overlap, correlation, tagRelevance } = payload;

  // 客观相关度表：用库内 WD14 标签当裁判（由 semantic-ab-tag-relevance.py 生成）
  const tagBlock = !tagRelevance
    ? ""
    : (() => {
        const base = tagRelevance["全样本基线"];
        const q = tagRelevance["int8量化版"];
        const u = tagRelevance["未量化fp32版"];
        const row = (label, a, b, k) => `
        <tr>
          <td>${label}</td>
          <td class="num">${(a["平均相关度"] * 100).toFixed(2)}%</td>
          <td class="num">${(b["平均相关度"] * 100).toFixed(2)}%</td>
          <td class="num">${a["耳机命中数"]}/${k}</td>
          <td class="num">${b["耳机命中数"]}/${k}</td>
          <td class="num">${a["室内命中数"]}/${k}</td>
          <td class="num">${b["室内命中数"]}/${k}</td>
        </tr>`;
        const hp = tagRelevance["带耳机的图在两侧的排名"] ?? [];
        return `
  <div class="summary" style="border-color:#7a5cff">
    <b>客观相关度（用图库自带的 WD14 标签当裁判，不是主观印象）</b><br>
    把查询词拆成「耳机 / 屋里 / 少女」三个可被标签验证的概念，逐个给 Top-K 打分：
    相关度 = 0.55×耳机 + 0.30×室内 + 0.15×少女（各取该家族置信度最高的标签）。<br>
    整批 ${sampleMeta.take} 张的基线：相关度 ${(base["平均相关度"] * 100).toFixed(2)}% ·
    带耳机 ${base["耳机命中数"]} 张 · 室内 ${base["室内命中数"]} 张
    <table>
      <thead><tr><th>Top-K</th><th>量化版相关度</th><th>fp32 相关度</th>
        <th>量化版耳机</th><th>fp32 耳机</th><th>量化版室内</th><th>fp32 室内</th></tr></thead>
      <tbody>
        ${row("Top-5", q["@5"], u["@5"], 5)}
        ${row("Top-10", q["@10"], u["@10"], 10)}
        ${row("Top-15", q["@15"], u["@15"], 15)}
        ${row("Top-30", q["@30"], u["@30"], 30)}
      </tbody>
    </table>
    ${
      hp.length > 0
        ? `<div style="margin-top:8px">全样本里只有 <b>${hp.length}</b> 张图带「耳机」标签，它们各自的排名：
           ${hp.map((h) => `id=${h.id}（耳机 ${(h["耳机置信度"] * 100).toFixed(0)}%）→ 量化版 <b>#${h["int8排名"]}</b> / fp32 <b>#${h["fp32排名"]}</b>`).join("；")}</div>`
        : ""
    }
  </div>`;
      })();

  const column = (side, color) => `
    <div class="col">
      <h2 style="border-color:${color}">${esc(side.title)}</h2>
      <p class="meta">权重：<code>${esc(side.weightFile)}</code>（${(side.sizeBytes / 1024 / 1024).toFixed(0)} MB）<br>
         每张 ${side.timing.meanMsPerImage} ms（CPU ${side.threads} 线程，中位 ${side.timing.medianMsPerImage} ms）<br>
         该模型下这 ${sampleMeta.take} 张的相似度：最高 ${(side.stats.max * 100).toFixed(2)}% ·
         均值 ${(side.stats.mean * 100).toFixed(2)}% ·
         中位 ${(side.stats.median * 100).toFixed(2)}%</p>
      ${side.top
        .map(
          (item, index) => `
        <div class="card">
          <div class="rank">#${index + 1}</div>
          <img src="${item.thumb}" alt="">
          <div class="info">
            <div class="score">${(item.similarity * 100).toFixed(2)}%</div>
            <div class="name" title="${esc(item.path)}">${esc(item.filename)}</div>
            <div class="sub">id=${item.id} · ${item.width}×${item.height}</div>
            <div class="sub">另一侧排名：${item.otherRank === null ? `${sampleMeta.take} 名以外` : `#${item.otherRank}`}（${(item.otherSimilarity * 100).toFixed(2)}%）</div>
          </div>
        </div>`
        )
        .join("")}
    </div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>语义搜索 A/B：int8 量化 vs 未量化 — ${esc(query)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 28px 60px; background:#14161a; color:#e8eaee;
         font:14px/1.55 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
  h1 { font-size:22px; margin:0 0 6px; }
  h1 code { background:#22262e; padding:2px 8px; border-radius:6px; color:#ffd479; font-size:19px; }
  h2 { font-size:16px; margin:0 0 10px; padding-bottom:8px; border-bottom:3px solid; }
  .summary { background:#1c2027; border:1px solid #2b313b; border-radius:10px; padding:14px 18px; margin:14px 0 22px; }
  .summary b { color:#ffd479; }
  .summary ul { margin:8px 0 0; padding-left:20px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:22px; align-items:start; }
  .meta { color:#98a0ae; font-size:12.5px; margin:0 0 12px; }
  .meta code { color:#7fd1ff; }
  .card { display:flex; gap:12px; align-items:center; background:#1a1e24;
          border:1px solid #262c35; border-radius:9px; padding:8px; margin-bottom:8px; }
  .rank { width:34px; text-align:center; font-weight:700; color:#8b93a1; font-size:15px; }
  .card img { width:78px; height:78px; object-fit:cover; border-radius:6px; background:#0e1013; flex:0 0 auto; }
  .info { min-width:0; }
  .score { font-size:18px; font-weight:700; color:#7ee08a; }
  .name { font-size:12.5px; color:#cfd5de; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:330px; }
  .sub { font-size:11.5px; color:#7d8593; }
  table { border-collapse:collapse; margin-top:10px; font-size:12.5px; }
  th, td { border:1px solid #333a45; padding:5px 10px; text-align:left; }
  th { background:#232833; color:#b9c1cc; font-weight:600; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  tbody tr:nth-child(3) { background:#232b1f; }
</style>
</head>
<body>
<h1>语义搜索 A/B 对比 · 查询词 <code>${esc(query)}</code></h1>
<div class="summary">
  <b>同一批 ${sampleMeta.take} 张图、同一个查询词、同一套线上预处理</b>，只换 ONNX 权重：
  左侧 <b>int8 量化版</b>（线上现用），右侧 <b>未量化 fp32 版</b>（MaterialSearch 同类做法）。<br>
  取样规则：${esc(sampleMeta.rule)}（库内共 ${sampleMeta.total} 张）<br>
  <ul>
    <li>两套排序的 <b>Spearman 秩相关 = ${correlation.spearman.toFixed(4)}</b>
        （1.0 = 完全一致，0 = 无关）；两两顺序一致率 = ${(correlation.pairwiseAgreement * 100).toFixed(1)}%</li>
    <li>Top-15 交集 = <b>${overlap.top15}/${15}</b> 张；
        左侧 Top-15 在右侧的平均排名 = <b>${overlap.leftTop15AvgRankRight.toFixed(1)}</b>，
        右侧 Top-15 在左侧的平均排名 = <b>${overlap.rightTop15AvgRankLeft.toFixed(1)}</b></li>
    <li>分数尺度：量化版最高 ${(left.stats.max * 100).toFixed(2)}% · 均值 ${(left.stats.mean * 100).toFixed(2)}%
        　|　未量化版最高 ${(right.stats.max * 100).toFixed(2)}% · 均值 ${(right.stats.mean * 100).toFixed(2)}%
        （差值 ${((left.stats.mean - right.stats.mean) * 100).toFixed(2)} 个百分点）</li>
  </ul>
</div>
${tagBlock}
<div class="grid">
${column(left, "#7fd1ff")}
${column(right, "#ffa94d")}
</div>
</body>
</html>`;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

  log(`Node ${process.version} · CPU 执行提供者 · 取样上限 ${ARGS.limit}`);
  log(`未量化 fp32 权重：${FP32_ONNX} ${fs.existsSync(FP32_ONNX) ? `(${(fs.statSync(FP32_ONNX).size / 1024 / 1024).toFixed(0)} MB)` : "【缺失】"}`);

  /* --- 1. 取样 --- */
  const sample = samplePhotos(ARGS.limit);
  fs.writeFileSync(
    path.join(OUT_DIR, "sample.json"),
    JSON.stringify(
      { rule: sample.rule, total: sample.total, take: sample.take, ids: sample.photos.map((p) => p.id), photos: sample.photos },
      null,
      2
    ),
    "utf8"
  );
  log(`取样完成：${sample.take} 张（库内 ${sample.total} 张），规则已写入 sample.json`);

  /* --- 2. 预处理（两个模型共用同一批张量，保证像素级一致） --- */
  const pixelCache = [];
  const photoMeta = [];
  const preprocessMs = [];
  for (let i = 0; i < sample.photos.length; i++) {
    const photo = sample.photos[i];
    const started = Date.now();
    try {
      const data = await preprocessImage(photo.path);
      pixelCache.push(data);
      photoMeta.push({ ...photo, ok: true });
    } catch (error) {
      photoMeta.push({ ...photo, ok: false, error: String(error.message ?? error) });
    }
    preprocessMs.push(Date.now() - started);
    if ((i + 1) % 50 === 0) log(`预处理 ${i + 1}/${sample.photos.length}`);
  }
  const usableCount = pixelCache.length;
  log(`预处理完成：成功 ${usableCount} 张，失败 ${sample.photos.length - usableCount} 张，平均 ${(preprocessMs.reduce((s, v) => s + v, 0) / preprocessMs.length).toFixed(0)} ms/张`);

  // 失败的照片从取样表里剔除，保持两边索引对齐
  const usablePhotos = photoMeta.filter((p) => p.ok);

  /* --- 3. 加载运行时（顺序关键：先 ORT，再 @xenova/transformers） --- */
  const ort = require("onnxruntime-node");
  const { AutoTokenizer, env } = await import("@xenova/transformers");
  env.localModelPath = MODEL_ROOT;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useFS = true;
  env.useFSCache = true;
  const tokenizer = await AutoTokenizer.from_pretrained(CLIP_DIR_REL);
  log("分词器就绪");

  const runs = {};

  /* --- 4a. 量化版 --- */
  if (!ARGS.skipQuant) {
    const handle = await createSession(ort, QUANTIZED_ONNX, "int8量化版");
    log(`[int8量化版] 会话就绪 ${handle.loadMs} ms · inputs=${handle.inputNames} outputs=${handle.outputNames}`);
    const result = await embedAll(ort, handle, pixelCache, tokenizer, log);
    runs.quantized = { ...result, meta: { label: "int8 量化版", weightFile: path.basename(QUANTIZED_ONNX), sizeBytes: handle.sizeBytes, loadMs: handle.loadMs, inputNames: handle.inputNames, outputNames: handle.outputNames } };
    await disposeSafely(handle);
    log(`[int8量化版] 完成，平均 ${result.timing.meanMsPerImage} ms/张`);
  }

  /* --- 4b. 未量化 fp32 版 --- */
  if (!ARGS.skipFp32) {
    const handle = await createSession(ort, FP32_ONNX, "未量化fp32版");
    log(`[未量化fp32版] 会话就绪 ${handle.loadMs} ms · inputs=${handle.inputNames} outputs=${handle.outputNames}`);
    const result = await embedAll(ort, handle, pixelCache, tokenizer, log);
    runs.unquantized = { ...result, meta: { label: "未量化 fp32 版", weightFile: path.basename(FP32_ONNX), sizeBytes: handle.sizeBytes, loadMs: handle.loadMs, inputNames: handle.inputNames, outputNames: handle.outputNames } };
    await disposeSafely(handle);
    log(`[未量化fp32版] 完成，平均 ${result.timing.meanMsPerImage} ms/张`);
  }

  if (!runs.quantized || !runs.unquantized) {
    log("只跑了一侧，跳过对比与 HTML 生成（需要两侧都有结果）。");
    return;
  }

  const scoreOf = (run) =>
    Array.from({ length: usableCount }, (_, i) =>
      dot(run.imageVectors.subarray(i * DIMENSIONS, (i + 1) * DIMENSIONS), run.textVector)
    );

  await compareAndRender({
    usablePhotos,
    scoresQ: scoreOf(runs.quantized),
    scoresU: scoreOf(runs.unquantized),
    runMeta: { quantized: runs.quantized.meta, unquantized: runs.unquantized.meta },
    timing: { quantized: runs.quantized.timing, unquantized: runs.unquantized.timing },
    sample,
    excluded: photoMeta.filter((p) => !p.ok),
    preprocessAvgMs: round(preprocessMs.reduce((s, v) => s + v, 0) / preprocessMs.length, 1),
    log,
  });
}

/* ------------------------------------------------------------------ *
 * 5+6. 排序对比、HTML、报告
 * ------------------------------------------------------------------ */

async function compareAndRender({
  usablePhotos,
  scoresQ,
  scoresU,
  runMeta,
  timing,
  sample,
  excluded,
  preprocessAvgMs,
  log,
}) {
  const usableCount = usablePhotos.length;
  const order = (scores) =>
    scores
      .map((similarity, index) => ({ index, similarity }))
      .sort((a, b) => b.similarity - a.similarity);

  const orderQ = order(scoresQ);
  const orderU = order(scoresU);
  const rankPosQ = new Array(usableCount);
  const rankPosU = new Array(usableCount);
  orderQ.forEach((entry, position) => {
    rankPosQ[entry.index] = position + 1;
  });
  orderU.forEach((entry, position) => {
    rankPosU[entry.index] = position + 1;
  });

  const topQ = orderQ.slice(0, TOP_K);
  const topU = orderU.slice(0, TOP_K);
  const setQ = new Set(topQ.map((e) => e.index));
  const setU = new Set(topU.map((e) => e.index));
  const overlapTop15 = [...setQ].filter((index) => setU.has(index)).length;

  const correlation = {
    spearman: round(spearman(scoresQ, scoresU), 4),
    pairwiseAgreement: round(pairwiseAgreement(scoresQ, scoresU), 4),
  };

  const overlap = {
    top15: overlapTop15,
    leftTop15AvgRankRight: round(topQ.reduce((s, e) => s + rankPosU[e.index], 0) / TOP_K, 1),
    rightTop15AvgRankLeft: round(topU.reduce((s, e) => s + rankPosQ[e.index], 0) / TOP_K, 1),
  };

  // 缩略图（只做 Top-15 的两侧并集，控制 HTML 体积）
  const needThumbs = [...new Set([...setQ, ...setU])];
  const thumbs = new Map();
  for (const index of needThumbs) {
    try {
      const buffer = await makeThumbnail(usablePhotos[index].path);
      thumbs.set(index, `data:image/jpeg;base64,${buffer.toString("base64")}`);
    } catch {
      thumbs.set(index, "");
    }
  }
  log?.(`缩略图生成完毕：${thumbs.size} 张`);

  const buildSide = (meta, timingInfo, scoreList, orderArr, otherRank, otherScores, title) => ({
    title,
    weightFile: meta.weightFile,
    sizeBytes: meta.sizeBytes,
    threads: meta.intraOpNumThreads ?? 1,
    timing: timingInfo,
    stats: stats(scoreList),
    top: orderArr.map((entry) => ({
      id: usablePhotos[entry.index].id,
      filename: usablePhotos[entry.index].filename,
      path: usablePhotos[entry.index].path,
      width: usablePhotos[entry.index].width ?? "",
      height: usablePhotos[entry.index].height ?? "",
      similarity: round(entry.similarity, 4),
      otherRank: otherRank[entry.index] <= TOP_K ? otherRank[entry.index] : null,
      otherSimilarity: round(otherScores[entry.index], 4),
      thumb: thumbs.get(entry.index) ?? "",
    })),
  });

  const left = buildSide(runMeta.quantized, timing.quantized, scoresQ, topQ, rankPosU, scoresU, "左侧 · int8 量化版（线上现用）");
  const right = buildSide(runMeta.unquantized, timing.unquantized, scoresU, topU, rankPosQ, scoresQ, "右侧 · 未量化 fp32 版");

  // 客观相关度（可选）：由 scripts/semantic-ab-tag-relevance.py 生成
  const tagPath = path.join(OUT_DIR, "tag-relevance.json");
  let tagRelevance = null;
  if (fs.existsSync(tagPath)) {
    try {
      tagRelevance = JSON.parse(fs.readFileSync(tagPath, "utf8"));
      log?.(`已并入 WD14 标签客观相关度：${tagPath}`);
    } catch (error) {
      log?.(`tag-relevance.json 读取失败，跳过客观相关度：${error.message}`);
    }
  }

  const html = buildHtml({
    query: QUERY,
    left,
    right,
    overlap,
    correlation,
    tagRelevance,
    sampleMeta: { take: usableCount, total: sample.total, rule: sample.rule },
  });
  fs.writeFileSync(HTML_PATH, html, "utf8");
  log?.(`对比页已写出：${HTML_PATH}`);

  const report = {
    generatedAt: new Date().toISOString(),
    query: QUERY,
    sampling: {
      rule: sample.rule,
      libraryTotal: sample.total,
      sampled: sample.take,
      usable: usableCount,
      sampledIds: sample.photos.map((p) => p.id),
      excluded: (excluded ?? []).map((p) => ({ id: p.id, path: p.path, error: p.error })),
    },
    preprocessing: {
      pipeline: "sharp.rotate().resize(224,224,{fit:'cover',position:'center'}).removeAlpha().raw() → CHW float32 (px/255-mean)/std",
      mean: CLIP_MEAN,
      std: CLIP_STD,
      imageSize: IMAGE_SIZE,
      avgPreprocessMsPerImage: preprocessAvgMs,
    },
    execution: { provider: "cpu", intraOpNumThreads: runMeta.quantized.intraOpNumThreads ?? 1, graphOptimizationLevel: "all" },
    models: { quantized: runMeta.quantized, unquantized: runMeta.unquantized },
    timing,
    correlation,
    overlap,
    scoreDistribution: { quantized: stats(scoresQ), unquantized: stats(scoresU) },
    top15: {
      quantized: topQ.map((e) => ({ id: usablePhotos[e.index].id, filename: usablePhotos[e.index].filename, path: usablePhotos[e.index].path, similarity: round(e.similarity, 4) })),
      unquantized: topU.map((e) => ({ id: usablePhotos[e.index].id, filename: usablePhotos[e.index].filename, path: usablePhotos[e.index].path, similarity: round(e.similarity, 4) })),
    },
    fullScores: {
      quantized: scoresQ.map((v) => round(v, 4)),
      unquantized: scoresU.map((v) => round(v, 4)),
      photoIds: usablePhotos.map((p) => p.id),
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2), "utf8");

  // 复用中间结果，方便只重跑对比/HTML 时不用再推一遍
  fs.writeFileSync(
    path.join(OUT_DIR, "scores.json"),
    JSON.stringify({ photoIds: usablePhotos.map((p) => p.id), scoresQ, scoresU, query: QUERY }),
    "utf8"
  );

  const line = "=".repeat(74);
  console.log(`\n${line}\n查询词：${QUERY}\n样本：${usableCount} 张（库内共 ${sample.total} 张）\n${line}`);
  for (const [key, title] of [["quantized", "int8 量化版（线上现用）"], ["unquantized", "未量化 fp32 版"]]) {
    const s = key === "quantized" ? stats(scoresQ) : stats(scoresU);
    const t = timing[key];
    console.log(`\n【${title}】 权重=${runMeta[key].weightFile} (${(runMeta[key].sizeBytes / 1024 / 1024).toFixed(0)} MB)  会话加载=${runMeta[key].loadMs} ms`);
    console.log(`  推理耗时：平均 ${t.meanMsPerImage} ms/张，中位 ${t.medianMsPerImage} ms，区间 ${t.minMsPerImage}~${t.maxMsPerImage} ms`);
    console.log(`  相似度分布：max=${(s.max * 100).toFixed(2)}%  mean=${(s.mean * 100).toFixed(2)}%  median=${(s.median * 100).toFixed(2)}%  min=${(s.min * 100).toFixed(2)}%  std=${(s.std * 100).toFixed(2)}%`);
  }
  console.log(`\n【排序相关】Spearman=${correlation.spearman}  两两一致率=${(correlation.pairwiseAgreement * 100).toFixed(1)}%  Top-15 交集=${overlap.top15}/15`);
  console.log(`  左侧 Top-15 在右侧的平均排名=${overlap.leftTop15AvgRankRight}；右侧 Top-15 在左侧的平均排名=${overlap.rightTop15AvgRankLeft}`);
  console.log("\n【Top-15 · int8 量化版】");
  left.top.forEach((item, i) => console.log(`  ${String(i + 1).padStart(2)}. ${(item.similarity * 100).toFixed(2)}%  id=${String(item.id).padStart(6)}  另侧#${item.otherRank ?? "-"}  ${item.filename}`));
  console.log("\n【Top-15 · 未量化 fp32 版】");
  right.top.forEach((item, i) => console.log(`  ${String(i + 1).padStart(2)}. ${(item.similarity * 100).toFixed(2)}%  id=${String(item.id).padStart(6)}  另侧#${item.otherRank ?? "-"}  ${item.filename}`));
  console.log(`\n中间结果：${OUT_DIR}\n对比页：${HTML_PATH}`);
}

/* ------------------------------------------------------------------ *
 * 只重绘模式：读回 report.json + sample.json，不重新推理
 * ------------------------------------------------------------------ */

async function renderOnly() {
  const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
  const report = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "report.json"), "utf8"));
  const sample = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "sample.json"), "utf8"));

  // 尺寸从 SQLite 只读补回来（sample.json 里没存 width/height）
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const sizes = new Map();
  try {
    const ids = report.fullScores.photoIds;
    const placeholders = ids.map(() => "?").join(",");
    for (const row of db.prepare(`SELECT id, width, height FROM photos WHERE id IN (${placeholders})`).all(...ids)) {
      sizes.set(row.id, row);
    }
  } finally {
    db.close();
  }

  const usablePhotos = report.fullScores.photoIds.map((id) => {
    const photo = sample.photos.find((p) => p.id === id) ?? {};
    const size = sizes.get(id) ?? {};
    return { ...photo, id, width: size.width, height: size.height };
  });

  log(`只重绘模式：从 report.json 读回 ${usablePhotos.length} 张的分数，不重新推理`);
  await compareAndRender({
    usablePhotos,
    scoresQ: report.fullScores.quantized,
    scoresU: report.fullScores.unquantized,
    runMeta: report.models,
    timing: report.timing,
    sample: { rule: sample.rule, total: report.sampling.libraryTotal, take: report.sampling.sampled, photos: sample.photos },
    excluded: report.sampling.excluded,
    preprocessAvgMs: report.preprocessing.avgPreprocessMsPerImage,
    log,
  });
}

if (ARGS.renderOnly) {
  renderOnly().catch((error) => {
    console.error("[FATAL]", error);
    process.exitCode = 1;
  });
} else {
  main().catch((error) => {
    console.error("[FATAL]", error);
    process.exitCode = 1;
  });
}
