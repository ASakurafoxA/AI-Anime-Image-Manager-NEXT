// 直接读 PixAI ONNX 的输入/输出接口（只加载 session，不推理）
// 用法：node pixai-io-probe.mjs
import ort from "onnxruntime-node";

const MODEL =
  "./models/pixai-tagger-v1.0/pixai-tagger-v1.0.onnx";

function show(label, meta) {
  console.log(label);
  for (const [name, info] of Object.entries(meta)) {
    console.log(
      `  ${name}: type=${info.type} dims=[${(info.shape ?? info.dims ?? []).join(", ")}]`
    );
  }
}

const t0 = Date.now();
const session = await ort.InferenceSession.create(MODEL, {
  executionProviders: ["cpu"],
  graphOptimizationLevel: "disabled", // ← §2.4：必须 disabled，否则栈溢出崩溃
});
console.log(`session 就绪: ${Date.now() - t0} ms`);
show("inputMetadata:", session.inputMetadata);
show("outputMetadata:", session.outputMetadata);
console.log("inputNames:", session.inputNames);
console.log("outputNames:", session.outputNames);
