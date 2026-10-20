/**
 * 探测新模型的真实输入输出形状（评测用）：先打印元数据，再用假张量试跑。
 */
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { InferenceSession, Tensor } = require("onnxruntime-node");

const dir = process.argv[2];
const targets = [
  { file: "anime_face_detect\\model.onnx", tries: [[1, 3, 640, 640], [1, 3, 800, 800], [1, 3, 512, 512]] },
  { file: "ccip\\model_feat.onnx", tries: [[1, 3, 224, 224], [1, 3, 384, 384], [1, 3, 448, 448]] },
  { file: "ccip\\model_metrics.onnx", tries: [[1, 1024], [1, 2048], [1, 2, 1024]] },
];

for (const t of targets) {
  const p = path.join(dir, t.file);
  console.log(`\n=== ${t.file} ===`);
  let s;
  try {
    s = await InferenceSession.create(p, { executionProviders: ["cpu"], logSeverityLevel: 3 });
  } catch (err) {
    console.log("  加载失败:", err.message);
    continue;
  }
  console.log("  inputMetadata:", JSON.stringify(s.inputMetadata));
  console.log("  outputMetadata:", JSON.stringify(s.outputMetadata));
  for (const shape of t.tries) {
    const n = shape.reduce((a, b) => a * b, 1);
    try {
      const out = await s.run({ [s.inputNames[0]]: new Tensor("float32", new Float32Array(n), shape) });
      const info = {};
      for (const k of s.outputNames) {
        const d = out[k];
        info[k] = `${d.type} [${d.dims.join(",")}] 样例值 ${Array.from(d.data.slice(0, 3)).map((x) => Number(x).toFixed(3)).join(", ")}`;
      }
      console.log(`  试跑 ${JSON.stringify(shape)} 成功 ->`, JSON.stringify(info));
      break;
    } catch (err) {
      console.log(`  试跑 ${JSON.stringify(shape)} 失败: ${err.message.split("\n")[0].slice(0, 120)}`);
    }
  }
}
