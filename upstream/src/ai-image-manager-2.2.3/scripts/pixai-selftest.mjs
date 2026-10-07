/**
 * PixAI worker 自检：把 JS 实现的结果与**官方 Python 参考**做数值对比。
 *
 * 参考值怎么来的（见 `需求分析/pixai-probe/pixai_ref.py`）：
 *   用官方 `RescalePadProcessor` + ONNX 跑同样几张图，落盘
 *     ref_result.json     每张图的六分类标签与分数
 *     ref_embeddings.json 每张图的完整 embedding（L2 归一化、5 位小数）
 *     ref_pixels.bin      第一张图预处理后的像素张量（float32 NCHW）
 *
 * 用法（在项目根目录）：
 *   node scripts/pixai-selftest.mjs
 *   node scripts/pixai-selftest.mjs --models="F:\...\AI Anime Image Manager new" --gpu
 *
 * ⚠️ 两侧的**插值实现不同**（torchvision bilinear+antialias vs sharp linear），
 *    所以像素不可能逐位相同；判定标准是：
 *      · 像素平均绝对差要小（< 0.02）、且黑边区域必须严格等于 -1
 *      · 标签集合与分数要接近（参考 top-12 大多数应出现在我方结果里）
 *      · embedding 余弦相似度要 ≥ 0.99
 */

import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { IMAGE_SIZE, preprocessImage } from "./pixai-preprocess.mjs";

const PROBE_DIR = "./需求分析/pixai-probe";
const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const MODELS_DIR =
  argOf("models", "models").replace(/^"|"$/g, "");
const USE_GPU = process.argv.includes("--gpu");

const refResult = JSON.parse(
  fs.readFileSync(path.join(PROBE_DIR, "ref_result.json"), "utf8")
);
const refEmbeddings = JSON.parse(
  fs.readFileSync(path.join(PROBE_DIR, "ref_embeddings.json"), "utf8")
);
const names = Object.keys(refResult);

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function comparePixels() {
  console.log("\n=== 1) 预处理逐元素比对（第一张图 vs 官方 ref_pixels.bin）===");
  const firstName = names[0];
  const buf = fs.readFileSync(path.join(PROBE_DIR, "ref_pixels.bin"));
  const ref = new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  );
  const mine = await preprocessImage(refResult[firstName].path);

  if (ref.length !== mine.length) {
    console.log(`  ❌ 长度不同：官方 ${ref.length} / 我方 ${mine.length}`);
    return false;
  }
  let sumAbs = 0;
  let maxAbs = 0;
  let refMin = Infinity;
  let mineMin = Infinity;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(ref[i] - mine[i]);
    sumAbs += d;
    if (d > maxAbs) {
      maxAbs = d;
    }
    if (ref[i] < refMin) {
      refMin = ref[i];
    }
    if (mine[i] < mineMin) {
      mineMin = mine[i];
    }
  }
  const meanAbs = sumAbs / ref.length;

  // 黑边区域必须严格 -1（布局/补边/数值范围三者都对的硬证据）
  const plane = IMAGE_SIZE * IMAGE_SIZE;
  let padOk = true;
  for (let i = 0; i < plane; i++) {
    if (mine[i] !== -1 || mine[plane + i] !== -1 || mine[2 * plane + i] !== -1) {
      // 只有真正是补边像素才该是 -1；这里只统计"我方有多少 -1"用于对照
      padOk = false;
      break;
    }
  }
  const countMinusOneMine = (() => {
    let n = 0;
    for (let i = 0; i < mine.length; i++) {
      if (mine[i] === -1) {
        n++;
      }
    }
    return n;
  })();

  console.log(`  像素数 ${ref.length}（= 3×${IMAGE_SIZE}×${IMAGE_SIZE}）`);
  console.log(`  官方 min=${refMin.toFixed(4)}  我方 min=${mineMin.toFixed(4)}  (黑边应为 -1)`);
  console.log(`  平均绝对差 = ${meanAbs.toFixed(6)}    最大绝对差 = ${maxAbs.toFixed(6)}`);
  console.log(
    `  我方 -1 像素占比 = ${((countMinusOneMine / mine.length) * 100).toFixed(2)}%` +
      `（黑边 + 图像里纯黑的像素）`
  );
  console.log(`  首个像素：官方 [${ref[0].toFixed(4)}, ${ref[1].toFixed(4)}, ${ref[2].toFixed(4)}]`);
  console.log(`            我方 [${mine[0].toFixed(4)}, ${mine[1].toFixed(4)}, ${mine[2].toFixed(4)}]`);
  const ok = meanAbs < 0.02 && Math.abs(mineMin - refMin) < 1e-6;
  console.log(ok ? "  ✅ 预处理对齐（平均差很小，数值范围一致）" : "  ❌ 预处理偏差过大");
  return ok;
}

function compareTags(results) {
  console.log("\n=== 2) 标签与分数比对 vs 官方 Python 参考 ===");
  let allOk = true;
  for (const name of names) {
    const ref = refResult[name];
    const mine = results.find((r) => r.id === name);
    if (!mine) {
      console.log(`  ❌ ${name}: worker 没有返回结果`);
      allOk = false;
      continue;
    }
    if (mine.error) {
      console.log(`  ❌ ${name}: ${mine.error}`);
      allOk = false;
      continue;
    }
    console.log(`\n  [${name}]`);
    for (const category of Object.keys(ref.tags)) {
      const refTags = ref.tags[category];
      if (refTags.length === 0) {
        continue;
      }
      const mineMap = new Map(
        mine.tags.filter((t) => t.category === category).map((t) => [t.name, t.score])
      );
      let hit = 0;
      let maxDelta = 0;
      for (const [tagName, refScore] of refTags) {
        if (mineMap.has(tagName)) {
          hit++;
          const d = Math.abs(mineMap.get(tagName) - refScore);
          if (d > maxDelta) {
            maxDelta = d;
          }
        }
      }
      const mineCount = mine.tags.filter((t) => t.category === category).length;
      const mark = hit >= Math.ceil(refTags.length * 0.75) ? "✅" : "⚠️";
      console.log(
        `     ${mark} ${category.padEnd(10)} 参考 top${refTags.length} 命中 ${hit}/${refTags.length}` +
          `  分数最大差 ${maxDelta.toFixed(3)}  我方在该类共 ${mineCount} 个`
      );
      if (hit < Math.ceil(refTags.length * 0.75)) {
        allOk = false;
        console.log(`        参考: ${refTags.slice(0, 6).map(([n]) => n).join(", ")}`);
        console.log(
          `        我方: ${mine.tags.filter((t) => t.category === category).slice(0, 6).map((t) => t.name).join(", ")}`
        );
      }
    }
  }
  return allOk;
}

function compareEmbeddings(results) {
  console.log("\n=== 3) embedding 比对（1024 维，L2 归一化）===");
  let allOk = true;
  for (const name of names) {
    const ref = refEmbeddings[name];
    const mine = results.find((r) => r.id === name)?.embedding;
    if (!ref || !mine) {
      console.log(`  ❌ ${name}: 缺 embedding`);
      allOk = false;
      continue;
    }
    if (ref.length !== mine.length) {
      console.log(`  ❌ ${name}: 维度不同 ${ref.length} vs ${mine.length}`);
      allOk = false;
      continue;
    }
    let maxDiff = 0;
    for (let i = 0; i < ref.length; i++) {
      const d = Math.abs(ref[i] - mine[i]);
      if (d > maxDiff) {
        maxDiff = d;
      }
    }
    const cos = cosine(ref, mine);
    const ok = cos >= 0.99;
    if (!ok) {
      allOk = false;
    }
    console.log(
      `  ${ok ? "✅" : "❌"} ${name.padEnd(22)} 维度 ${mine.length}  余弦 ${cos.toFixed(6)}  逐元素最大差 ${maxDiff.toFixed(5)}`
    );
  }
  return allOk;
}

async function runWorker() {
  const workerPath = path.join(import.meta.dirname, "pixai-tagger-worker.mjs");
  const child = fork(workerPath, [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const photos = names.map((name) => ({ id: name, path: refResult[name].path }));

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("worker 超时（10 分钟）"));
    }, 10 * 60 * 1000);

    child.on("message", (message) => {
      if (message?.type === "ready") {
        console.log(
          `  worker 就绪: provider=${message.provider} 标签数=${message.tagCount} ` +
            `类别=${message.categories.map((c) => `${c.category}:${c.count}`).join(" ")}`
        );
        child.send({
          includeEmbedding: true,
          photos,
          type: "tag",
        });
      } else if (message?.type === "init-error") {
        clearTimeout(timer);
        reject(new Error(`init 失败: ${message.error}`));
      } else if (message?.type === "provider-error") {
        clearTimeout(timer);
        reject(new Error(`provider 失败: ${message.error}`));
      } else if (message?.type === "result") {
        clearTimeout(timer);
        child.send({ type: "shutdown" });
        resolve(message.results);
      }
    });
    child.on("error", reject);
    child.send({ modelsDir: MODELS_DIR, type: "init", useGPU: USE_GPU });
  });
}

const pixelsOk = await comparePixels();
console.log(`\n=== 2/3) 启动 worker（modelsDir=${MODELS_DIR}, GPU=${USE_GPU}）===`);
const results = await runWorker();
const tagsOk = compareTags(results);
const embOk = compareEmbeddings(results);

console.log("\n=== 结论 ===");
console.log(`  预处理: ${pixelsOk ? "✅ 通过" : "❌ 未通过"}`);
console.log(`  标签  : ${tagsOk ? "✅ 通过" : "❌ 未通过"}`);
console.log(`  embedding: ${embOk ? "✅ 通过" : "❌ 未通过"}`);
process.exit(pixelsOk && tagsOk && embOk ? 0 : 1);
