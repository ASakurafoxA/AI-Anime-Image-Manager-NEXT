/**
 * 探测 CCIP model_metrics.onnx 输出的距离到底是哪种度量（不猜）。
 *
 * 做法：造 N 个确定性的伪随机 768 维特征 → 喂 metrics 得到矩阵 D →
 * 同时手算「欧氏距离 / 平方欧氏 / 余弦距离 / 归一化欧氏」→ 对比找出对应关系。
 *
 * 用法：electron.exe scripts/probe-ccip-metrics.mjs <modelsDir>
 */
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { InferenceSession, Tensor } = require("onnxruntime-node");

const dir = process.argv[2];
const DIM = 768;
const N = 6;

// 确定性伪随机（LCG），保证可复现
let seed = 12345;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648 - 0.5;
}

const feats = [];
for (let i = 0; i < N; i++) {
  const v = new Float32Array(DIM);
  for (let d = 0; d < DIM; d++) v[d] = rnd();
  feats.push(v);
}

const flat = new Float32Array(N * DIM);
feats.forEach((v, i) => flat.set(v, i * DIM));

const session = await InferenceSession.create(
  path.join(dir, "ccip", "model_metrics.onnx"),
  { executionProviders: ["cpu"], logSeverityLevel: 3 }
);
console.log("inputNames:", JSON.stringify(session.inputNames));
console.log("outputNames:", JSON.stringify(session.outputNames));

const out = await session.run({
  [session.inputNames[0]]: new Tensor("float32", flat, [N, DIM]),
});
const t = out[session.outputNames[0]];
console.log(`输出 dims=${JSON.stringify(t.dims)}`);
const D = t.data;

// 手算各种度量
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function norm(a) {
  return Math.sqrt(dot(a, a));
}
function euclid(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

console.log("\n idx | metrics D | euclid | euclid^2 | 1-cos | normEuclid | D/euc^2 | D/(1-cos)");
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    if (i === j) continue;
    if (i > 1) continue; // 只打印前两行，够看规律
    const d = D[i * N + j];
    const e = euclid(feats[i], feats[j]);
    const e2 = e * e;
    const cos = dot(feats[i], feats[j]) / (norm(feats[i]) * norm(feats[j]));
    const oneMinusCos = 1 - cos;
    // 归一化欧氏距离 == sqrt(2*(1-cos))
    const normE = Math.sqrt(2 * oneMinusCos);
    console.log(
      ` ${i},${j} | ${d.toFixed(6)} | ${e.toFixed(6)} | ${e2.toFixed(6)} | ${oneMinusCos.toFixed(6)} | ${normE.toFixed(6)} | ${(d / e2).toFixed(4)} | ${(d / oneMinusCos).toFixed(4)}`
    );
  }
}

// 对角线与对称性
let diag = [];
for (let i = 0; i < N; i++) diag.push(D[i * N + i]);
console.log("\n对角线:", JSON.stringify(diag.map((v) => Number(v).toFixed(6))));
let asym = 0;
for (let i = 0; i < N; i++)
  for (let j = 0; j < N; j++)
    if (Math.abs(D[i * N + j] - D[j * N + i]) > 1e-5) asym++;
console.log("不对称对数:", asym);