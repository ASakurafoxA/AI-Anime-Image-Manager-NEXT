/**
 * Isolated DirectML probe for the active SigLIP vision ONNX model.
 *
 * DirectML can terminate the native ONNX Runtime process for an unsupported
 * graph. This worker therefore owns only the probe session; the Electron main
 * process treats an unexpected exit as a normal CPU-fallback result.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function loadOrt() {
  try {
    return require("onnxruntime-node");
  } catch {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    return require(path.join(projectRoot, "node_modules", "onnxruntime-node"));
  }
}

async function handleProbe(message) {
  const startedAt = Date.now();
  if (process.platform !== "win32" || process.arch !== "x64") {
    process.send?.({
      type: "result",
      dmlAvailable: false,
      error: "SigLIP DirectML embedding requires Windows x64",
      probeTimeMs: Date.now() - startedAt,
    });
    process.exit(0);
    return;
  }

  const modelPath = String(message.modelPath || "");
  const inputName = String(message.inputName || "pixel_values");
  const imageSize = Number(message.imageSize || 224);
  const deviceId =
    Number.isInteger(message.deviceId) && message.deviceId >= 0
      ? Number(message.deviceId)
      : null;
  if (!(modelPath && fs.existsSync(modelPath))) {
    process.send?.({
      type: "result",
      dmlAvailable: false,
      error: `Model not found: ${modelPath}`,
      probeTimeMs: Date.now() - startedAt,
    });
    process.exit(0);
    return;
  }

  try {
    const { InferenceSession, Tensor } = loadOrt();
    const provider = deviceId === null ? "dml" : { name: "dml", deviceId };
    const session = await InferenceSession.create(modelPath, {
      executionProviders: [provider],
      enableMemPattern: false,
      executionMode: "sequential",
      // ⚠️ 必须是 "disabled"（2026-10-08 实测）：这个量化过的 SigLIP vision 模型
      // 会让 ORT 1.26 的图优化器在部分环境下**原生崩溃**（0xC0000005，进程直接死），
      // 表现就是"探测失败/超时 → 图像嵌入只好用 CPU"。DML 自己的图融合
      // （DmlGraphFusionTransformer）不受这个开关影响，所以关掉不影响性能
      // （实测 basic 14.1ms/张 vs disabled 14.7ms/张，噪声级）。
      graphOptimizationLevel: "disabled",
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
      logSeverityLevel: 3,
    });

    // Session creation alone is insufficient: run one real inference so a
    // provider/model combination that crashes during execution is rejected.
    const pixels = new Tensor(
      "float32",
      new Float32Array(3 * imageSize * imageSize),
      [1, 3, imageSize, imageSize]
    );
    const output = await session.run({ [inputName]: pixels });
    for (const value of Object.values(output)) {
      value?.dispose?.();
    }
    await session.release?.();

    process.send?.({
      type: "result",
      dmlAvailable: true,
      probeTimeMs: Date.now() - startedAt,
    });
  } catch (error) {
    process.send?.({
      type: "result",
      dmlAvailable: false,
      error: error instanceof Error ? error.message : String(error),
      probeTimeMs: Date.now() - startedAt,
    });
  }
  process.exit(0);
}

process.on("message", (message) => {
  if (message?.type === "probe") {
    handleProbe(message);
  }
});
