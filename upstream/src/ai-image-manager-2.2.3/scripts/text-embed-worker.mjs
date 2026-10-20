/**
 * Configurable text embedding worker.
 *
 * The first adapter uses transformers-js. The protocol carries an engine field
 * so an ONNX Runtime text implementation can be added later without changing
 * the client contract.
 */

import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

let activeAdapter = null;
let textModel = null;
let tokenizer = null;
// 自用：ONNX Runtime 文本路径（合并模型用），与 transformers-js 路径二选一
let ortSession = null;
let _ort = null;
const PATH_SPLIT_RE = /[\\/]/u;
const QUANTIZED_ONNX_RE = /_quantized\.onnx$/iu;
const ONNX_RE = /\.onnx$/iu;


function loadOrt() {
  if (_ort) {
    return _ort;
  }
  try {
    _ort = require("onnxruntime-node");
  } catch {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    _ort = require(path.join(projectRoot, "node_modules", "onnxruntime-node"));
  }
  return _ort;
}

function resolveRelativeModelPath(root, relativePath) {
  return path.isAbsolute(relativePath)
    ? relativePath
    : path.join(root, ...relativePath.split(PATH_SPLIT_RE));
}

/** 合并图要求所有声明输入都在场：给没提供的补零（只跑文本塔时 pixel_values 填零）。 */
function buildOrtFeeds(ort, session, provided) {
  const feeds = { ...provided };
  const providedNames = new Set(Object.keys(feeds));
  for (const name of session.inputNames ?? []) {
    if (providedNames.has(name)) {
      continue;
    }
    feeds[name] = /pixel_values$/i.test(name)
      ? new ort.Tensor(
          "float32",
          new Float32Array(3 * (activeAdapter.text.imageSize ?? 224) ** 2),
          [1, 3, activeAdapter.text.imageSize ?? 224, activeAdapter.text.imageSize ?? 224]
        )
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

function validateAdapter(adapter) {
  if (!adapter || adapter.protocolVersion !== 1) {
    throw new Error("Unsupported or missing text worker adapter protocol");
  }
  const text = adapter.text;
  if (
    typeof adapter.adapterId !== "string" ||
    typeof adapter.fingerprint !== "string" ||
    typeof adapter.modelRoot !== "string" ||
    typeof adapter.modelId !== "string" ||
    !text ||
    typeof text.modelRelativePath !== "string" ||
    !Number.isInteger(text.dimensions) ||
    text.dimensions <= 0 ||
    typeof text.outputName !== "string" ||
    !Number.isInteger(text.maxLength) ||
    text.maxLength <= 0 ||
    text.padding !== "max_length" ||
    adapter.normalization !== "l2"
  ) {
    throw new Error("Invalid text worker adapter configuration");
  }
  if (text.engine !== "transformers-js" && text.engine !== "onnxruntime-node") {
    throw new Error(`Unsupported text engine: ${text.engine}`);
  }
  return adapter;
}

function disposeOutput(output) {
  for (const value of Object.values(output ?? {})) {
    value?.dispose?.();
  }
}

async function initialize(message) {
  activeAdapter = validateAdapter(message.adapter);
  /*
   * 自用（2026-10 换中文 CLIP，**顺序很关键**）：
   * 必须**先加载 onnxruntime、再加载 @xenova/transformers**。
   *
   * 反过来的话，`require("onnxruntime-node")` 会失败：
   *   ERR_DLOPEN_FAILED: The operating system cannot run %1.
   *   …\onnxruntime-node\bin\napi-v6\win32\x64\onnxruntime_binding.node
   * 已用独立探针逐一验证：先 ORT 后 transformers → 两塔推理都正常（text_embeds 1x512）。
   * （视觉 worker 不受影响——它只加载 sharp + ORT，不加载 transformers。）
   */
  if (activeAdapter.text.engine === "onnxruntime-node") {
    loadOrt();
  }
  const { AutoModel, AutoTokenizer, env } = await import(
    "@xenova/transformers"
  );
  env.localModelPath = activeAdapter.modelRoot;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useFS = true;
  env.useFSCache = true;

  tokenizer = await AutoTokenizer.from_pretrained(activeAdapter.modelId);
  /*
   * 自用（2026-10 换中文 CLIP）：@xenova/transformers v2 的 ChineseCLIPModel 不完整
   *（没有 get_text_features、也不暴露两个子塔），所以这条路径**直接用 onnxruntime**
   * 跑合并模型 —— 分词仍用上面的 tokenizer，推理自己来。
   */
  if (activeAdapter.text.engine === "onnxruntime-node") {
    const ort = loadOrt();
    ortSession = await ort.InferenceSession.create(
      resolveRelativeModelPath(
        activeAdapter.modelRoot,
        activeAdapter.text.modelRelativePath
      )
    );
    process.send?.({
      type: "ready",
      adapterId: activeAdapter.adapterId,
      fingerprint: activeAdapter.fingerprint,
    });
    return;
  }
  textModel = await AutoModel.from_pretrained(activeAdapter.modelId, {
    model_file_name: activeAdapter.text.modelRelativePath
      .split(PATH_SPLIT_RE)
      .at(-1)
      .replace(QUANTIZED_ONNX_RE, "")
      .replace(ONNX_RE, ""),
    quantized: true,
  });
  process.send?.({
    type: "ready",
    adapterId: activeAdapter.adapterId,
    fingerprint: activeAdapter.fingerprint,
  });
}

function normalizeVector(vector) {
  if (
    vector.length !== activeAdapter.text.dimensions ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(
      `Invalid text vector: expected ${activeAdapter.text.dimensions} finite values`
    );
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  const normalized = vector.map((value) => value / (norm || 1));
  if (normalized.some((value) => !Number.isFinite(value))) {
    throw new Error("Text vector normalization produced non-finite values");
  }
  return normalized;
}

async function embed(message) {
  if (!(tokenizer && activeAdapter && (textModel || ortSession))) {
    throw new Error("Text embedding model is not initialized");
  }
  const texts = Array.isArray(message.texts) ? message.texts : [];
  if (texts.length === 0) {
    process.send?.({
      type: "result",
      requestId: message.requestId,
      adapterId: activeAdapter.adapterId,
      fingerprint: activeAdapter.fingerprint,
      vectors: [],
    });
    return;
  }

  const inputs = await tokenizer(texts, {
    padding: activeAdapter.text.padding,
    truncation: true,
    max_length: activeAdapter.text.maxLength,
  });
  if (activeAdapter.text.engine === "onnxruntime-node") {
    const ort = loadOrt();
    const feeds = buildOrtFeeds(ort, ortSession, {
      input_ids: toInt64(ort, inputs.input_ids),
      ...(inputs.attention_mask
        ? { attention_mask: toInt64(ort, inputs.attention_mask) }
        : {}),
      ...(inputs.token_type_ids
        ? { token_type_ids: toInt64(ort, inputs.token_type_ids) }
        : {}),
    });
    const ortOutput = await ortSession.run(feeds);
    const embeddings = ortOutput[activeAdapter.text.outputName];
    if (!embeddings) {
      throw new Error(`Output "${activeAdapter.text.outputName}" missing`);
    }
    const data = Array.from(embeddings.data);
    const vectorSize = data.length / texts.length;
    if (
      !Number.isInteger(vectorSize) ||
      vectorSize !== activeAdapter.text.dimensions
    ) {
      throw new Error(
        `Text vector size mismatch: expected=${activeAdapter.text.dimensions} actual=${vectorSize}`
      );
    }
    const vectors = texts.map((_, index) =>
      normalizeVector(data.slice(index * vectorSize, (index + 1) * vectorSize))
    );
    for (const value of Object.values(ortOutput)) {
      value?.dispose?.();
    }
    process.send?.({
      type: "result",
      requestId: message.requestId,
      adapterId: activeAdapter.adapterId,
      fingerprint: activeAdapter.fingerprint,
      vectors,
    });
    return;
  }
  const output = await textModel(inputs);
  try {
    const embeddings = output[activeAdapter.text.outputName];
    if (!embeddings) {
      throw new Error(`Output "${activeAdapter.text.outputName}" missing`);
    }
    const data = Array.from(embeddings.data);
    const vectorSize = data.length / texts.length;
    if (
      !Number.isInteger(vectorSize) ||
      vectorSize !== activeAdapter.text.dimensions
    ) {
      throw new Error(
        `Text vector size mismatch: expected=${activeAdapter.text.dimensions} actual=${vectorSize}`
      );
    }
    const vectors = texts.map((_, index) =>
      normalizeVector(data.slice(index * vectorSize, (index + 1) * vectorSize))
    );
    process.send?.({
      type: "result",
      requestId: message.requestId,
      adapterId: activeAdapter.adapterId,
      fingerprint: activeAdapter.fingerprint,
      vectors,
    });
  } finally {
    disposeOutput(output);
  }
}

async function handleMessage(message) {
  try {
    if (message?.type === "init") {
      await initialize(message);
      return;
    }
    if (message?.type === "embed") {
      await embed(message);
      return;
    }
    if (message?.type === "shutdown") {
      process.exit(0);
    }
  } catch (error) {
    process.send?.({
      type: message?.type === "init" ? "init-error" : "error",
      requestId: message?.requestId,
      adapterId: activeAdapter?.adapterId,
      fingerprint: activeAdapter?.fingerprint,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let operationQueue = Promise.resolve();
process.on("message", (message) => {
  if (message?.type === "shutdown") {
    process.exit(0);
  }
  operationQueue = operationQueue.then(() => handleMessage(message));
});
