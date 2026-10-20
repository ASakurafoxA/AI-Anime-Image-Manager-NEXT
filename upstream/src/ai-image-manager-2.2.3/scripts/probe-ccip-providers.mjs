/**
 * 探针：CCIP 特征抽取的 **CPU vs GPU(DirectML)** 速度实测（只读，不写任何库）。
 *
 * 用法（在 ai-image-manager-2.2.3 目录下）：
 *   node scripts/probe-ccip-providers.mjs --models="<图库>\models" --list="%TEMP%\aim_ccip_paths.json" --limit=60
 *
 * 参数：
 *   --models=<dir>       含 `ccip/model_feat.onnx` 的模型目录（默认 <图库>/models）
 *   --list=<json>        [{id,path}] 的样本清单
 *   --limit=<n>          用前 n 张（默认 60）
 *   --threads=<n>        CPU provider 的 intra-op 线程数（默认 4）
 *   --device=<n>         DirectML 设备号（默认 0）
 *   --batch=<n>          尝试的批大小（默认 1；>1 仅用于探测模型是否支持）
 *
 * 口径与生产 worker 完全一致：384×384 cover + removeAlpha + ImageNet 归一化、L2 归一化输出 768 维。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const SIZE = 384;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const EXPECTED_DIM = 768;

function arg(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const modelsDir = arg("models", path.join("F:\\AI Anime Image Manager NEXT", "models"));
const listPath = arg("list", path.join(process.env.TEMP ?? ".", "aim_ccip_paths.json"));
const limit = Number.parseInt(arg("limit", "60"), 10) || 60;
const threads = Number.parseInt(arg("threads", "4"), 10) || 4;
const deviceId = Number.parseInt(arg("device", "0"), 10) || 0;
const batch = Number.parseInt(arg("batch", "1"), 10) || 1;

const modelPath = path.join(modelsDir, "ccip", "model_feat.onnx");
if (!fs.existsSync(modelPath)) {
  console.error(`[probe] 缺模型：${modelPath}`);
  process.exit(2);
}
const samples = JSON.parse(fs.readFileSync(listPath, "utf-8")).slice(0, limit);
if (samples.length === 0) {
  console.error("[probe] 样本为空");
  process.exit(2);
}

const ort = require("onnxruntime-node");

function toNCHW(rgb) {
  const ppc = SIZE * SIZE;
  const out = new Float32Array(3 * ppc);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const s = (y * SIZE + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[c * ppc + y * SIZE + x] = (rgb[s + c] / 255 - MEAN[c]) / STD[c];
      }
    }
  }
  return out;
}

function l2normalize(data) {
  let norm = 0;
  for (let i = 0; i < data.length; i++) {
    norm += data[i] * data[i];
  }
  norm = Math.sqrt(norm) || 1;
  const out = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = Math.round((data[i] / norm) * 1e6) / 1e6;
  }
  return out;
}

async function preprocess(filePath) {
  const { data } = await sharp(filePath, { failOn: "none" })
    .rotate()
    .resize(SIZE, SIZE, { fit: "cover", position: "center" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return toNCHW(rgb);
}

async function createSession(providers) {
  return ort.InferenceSession.create(modelPath, {
    executionProviders: providers,
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    logSeverityLevel: 3,
  });
}

async function runOne(session, inputName, outputName, tensor, batchSize) {
  const inputs = { [inputName]: tensor };
  const outputs = await session.run(inputs);
  const raw = outputs[outputName]?.data;
  for (const value of Object.values(outputs)) {
    value?.dispose?.();
  }
  if (!raw || raw.length !== EXPECTED_DIM * batchSize) {
    throw new Error(`输出异常：期望 ${EXPECTED_DIM * batchSize} 维，实际 ${raw?.length ?? 0}`);
  }
  return raw;
}

async function bench(label, providers) {
  const session = await createSession(providers);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  // 预热 3 张（不计时）
  const warmup = samples.slice(0, Math.min(3, samples.length));
  for (const sample of warmup) {
    const data = await preprocess(sample.path);
    const tensor = new ort.Tensor("float32", data, [1, 3, SIZE, SIZE]);
    await runOne(session, inputName, outputName, tensor, 1);
  }

  const startedAt = Date.now();
  let firstVector = null;
  let done = 0;
  for (const sample of samples) {
    const data = await preprocess(sample.path);
    const tensor = new ort.Tensor("float32", data, [1, 3, SIZE, SIZE]);
    const raw = await runOne(session, inputName, outputName, tensor, 1);
    firstVector ??= l2normalize(raw);
    done += 1;
  }
  const elapsedMs = Date.now() - startedAt;
  const perSecond = done / (elapsedMs / 1000);
  console.log(
    `[probe] ${label}: ${done} 张 / ${(elapsedMs / 1000).toFixed(1)}s = ${perSecond.toFixed(2)} 张/秒（${(elapsedMs / done).toFixed(1)} ms/张）`
  );
  await session.release?.();
  return { label, done, elapsedMs, perSecond, firstVector };
}

async function tryBatch(label, providers) {
  const session = await createSession(providers);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const picked = samples.slice(0, batch);
  const tensors = [];
  for (const sample of picked) {
    tensors.push(await preprocess(sample.path));
  }
  const merged = new Float32Array(batch * 3 * SIZE * SIZE);
  for (let i = 0; i < batch; i++) {
    merged.set(tensors[i], i * 3 * SIZE * SIZE);
  }
  const tensor = new ort.Tensor("float32", merged, [batch, 3, SIZE, SIZE]);
  try {
    const startedAt = Date.now();
    await runOne(session, inputName, outputName, tensor, batch);
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[probe] ${label} batch=${batch}: 支持 ✓ 一次 ${elapsedMs}ms → ${((batch / elapsedMs) * 1000).toFixed(2)} 张/秒`
    );
  } catch (error) {
    console.log(`[probe] ${label} batch=${batch}: 不支持 ✗（${String(error?.message ?? error).slice(0, 120)}）`);
  }
  await session.release?.();
}

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

console.log(`[probe] 模型=${modelPath}`);
console.log(`[probe] 样本=${samples.length} 张，CPU 线程=${threads}，DML 设备=${deviceId}`);
console.log(`[probe] onnxruntime-node ${require("onnxruntime-node/package.json").version}`);

const cpu = await bench(`CPU(${threads} 线程)`, ["cpu"]);
let dml = null;
try {
  dml = await bench(`DML(设备 ${deviceId})`, [{ name: "dml", deviceId }]);
} catch (error) {
  console.log(`[probe] DML 失败 ✗：${String(error?.message ?? error).slice(0, 200)}`);
}
if (dml) {
  console.log(
    `[probe] 输出一致性：CPU vs DML 首个向量余弦相似度 = ${cosine(cpu.firstVector, dml.firstVector).toFixed(6)}`
  );
}
if (batch > 1) {
  await tryBatch("DML", [{ name: "dml", deviceId }]);
  await tryBatch("CPU", ["cpu"]);
}
