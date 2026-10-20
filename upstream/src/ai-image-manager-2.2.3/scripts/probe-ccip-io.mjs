/**
 * 实测 CCIP model_feat.onnx 的输入/输出维度（不猜）。
 * 用法：electron.exe scripts/probe-ccip-io.mjs <modelsDir>
 */
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { InferenceSession, Tensor } = require("onnxruntime-node");

const dir = process.argv[2];
const modelPath = path.join(dir, "ccip", "model_feat.onnx");
const session = await InferenceSession.create(modelPath, {
  executionProviders: ["cpu"],
  logSeverityLevel: 3,
});

console.log("inputNames:", JSON.stringify(session.inputNames));
console.log("outputNames:", JSON.stringify(session.outputNames));
const meta = session.inputMetadata ?? {};
for (const n of session.inputNames) {
  console.log(`input ${n}:`, JSON.stringify(meta[n] ?? "no-metadata"));
}
const outMeta = session.outputMetadata ?? {};
for (const n of session.outputNames) {
  console.log(`output ${n}:`, JSON.stringify(outMeta[n] ?? "no-metadata"));
}

// 用随机小输入试跑，从实际结果里拿维度
const SIZE = 384;
const input = new Tensor(
  "float32",
  new Float32Array(3 * SIZE * SIZE).fill(0.5),
  [1, 3, SIZE, SIZE]
);
const out = await session.run({ [session.inputNames[0]]: input });
for (const n of session.outputNames) {
  const t = out[n];
  console.log(`run output ${n}: dims=${JSON.stringify(t.dims)} len=${t.data.length}`);
  // 打印前几个值的数量级，判断是否已归一化
  const arr = Array.from(t.data.slice(0, 5));
  console.log(`  head=${JSON.stringify(arr.map((v) => Number(v).toFixed(4)))}`);
}
// 试 768 与 1024 两说 —— 再跑一次 metrics 模型？先只打印维度即可