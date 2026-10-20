/**
 * 检查新下载模型的输入输出规格（评测用）。
 */
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { InferenceSession } = require("onnxruntime-node");

const dir = process.argv[2];
for (const f of ["anime_face_detect\\model.onnx", "ccip\\model_feat.onnx", "ccip\\model_metrics.onnx"]) {
  const p = path.join(dir, f);
  try {
    const s = await InferenceSession.create(p, { executionProviders: ["cpu"], logSeverityLevel: 3 });
    console.log(`\n=== ${f} ===`);
    console.log("  输入:");
    for (const n of s.inputNames) {
      const m = s.inputMetadata?.[n];
      console.log(`    ${n}  type=${m?.type ?? "?"}  dims=${JSON.stringify(m?.dimensions ?? m?.shape ?? "?")}`);
    }
    console.log("  输出:");
    for (const n of s.outputNames) {
      const m = s.outputMetadata?.[n];
      console.log(`    ${n}  type=${m?.type ?? "?"}  dims=${JSON.stringify(m?.dimensions ?? m?.shape ?? "?")}`);
    }
  } catch (err) {
    console.log(`\n=== ${f} === 加载失败: ${err.message}`);
  }
}
