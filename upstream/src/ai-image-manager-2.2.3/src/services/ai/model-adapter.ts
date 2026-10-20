import path from "node:path";

export type EmbeddingAdapterFamily = "siglip" | "chinese-clip";
export type EmbeddingAdapterId = string;
export type EmbeddingNormalization = "l2";
export type WorkerExecutionProvider = "cpu" | "directml";

export interface ModelArtifactSpec {
  relativePath: string;
  required: boolean;
  sha256: string;
  sizeBytes: number;
}

export interface ImageEmbeddingSpec {
  dimensions: number;
  imageSize: number;
  inputName: string;
  mean: readonly [number, number, number];
  modelRelativePath: string;
  outputName: string;
  resizeFit: "fill" | "contain" | "cover";
  std: readonly [number, number, number];
}

export interface TextEmbeddingSpec {
  dimensions: number;
  engine: "transformers-js" | "onnxruntime-node";
  inputNames?: {
    inputIds?: string;
    attentionMask?: string;
  };
  maxLength: number;
  modelRelativePath: string;
  outputName: string;
  padding: "max_length";
  tokenizerRelativePath?: string;
}

export interface EmbeddingAdapterDescriptor {
  artifacts: ModelArtifactSpec[];
  capabilities: {
    imageToImage: boolean;
    textToImage: boolean;
    tagging: boolean;
    duplicateDetection: boolean;
  };
  displayName: string;
  embeddingSpace: {
    dimensions: number;
    normalization: EmbeddingNormalization;
    image: ImageEmbeddingSpec;
    text: TextEmbeddingSpec;
  };
  family: EmbeddingAdapterFamily;
  id: EmbeddingAdapterId;
  legacyKind?: "siglip";
  modelId: string;
  revision: string;
  schemaVersion: 1;
  thresholdProfileId: string;
}

export interface SerializedWorkerAdapter {
  adapterId: EmbeddingAdapterId;
  fingerprint: string;
  image: ImageEmbeddingSpec;
  modelId: string;
  modelRoot: string;
  normalization: EmbeddingNormalization;
  protocolVersion: 1;
  text: TextEmbeddingSpec;
}

const V1_ARTIFACTS: ModelArtifactSpec[] = [
  {
    relativePath:
      "Xenova/siglip-base-patch16-224/onnx/vision_model_quantized.onnx",
    sha256: "ef14a954f3d57e1806666432bd9785004c1dc27100aa260eee0cb0f10a5de058",
    sizeBytes: 99_499_129,
    required: true,
  },
  {
    relativePath:
      "Xenova/siglip-base-patch16-224/onnx/text_model_quantized.onnx",
    sha256: "ad0329b1f35acc66d8953ff2559ce358da8eb0a7011794cf951523d63a4dbce2",
    sizeBytes: 111_475_220,
    required: true,
  },
  {
    relativePath: "Xenova/siglip-base-patch16-224/config.json",
    sha256: "e6de71291f181b0b81adc93098787bb4597a79dc18f59737feda8f41671fb6a2",
    sizeBytes: 457,
    required: true,
  },
  {
    relativePath: "Xenova/siglip-base-patch16-224/preprocessor_config.json",
    sha256: "21ee046a8a52a65e5f9c177bf840bfb39ea66c9c54cf2760630efd58e0a3ec80",
    sizeBytes: 368,
    required: true,
  },
  {
    relativePath: "Xenova/siglip-base-patch16-224/special_tokens_map.json",
    sha256: "22f82d1c19654c9552ff1368c2c236ebb34f457dbdbc7510d304cebfeb96f3bf",
    sizeBytes: 406,
    required: true,
  },
  {
    relativePath: "Xenova/siglip-base-patch16-224/spiece.model",
    sha256: "1e5036bed065526c3c212dfbe288752391797c4bb1a284aa18c9a0b23fcaf8ec",
    sizeBytes: 798_330,
    required: true,
  },
  {
    relativePath: "Xenova/siglip-base-patch16-224/tokenizer.json",
    sha256: "4a17c975210be5ab4c36b47d8dae4eefb866dbfb1e676e394aad85dc30a3ae08",
    sizeBytes: 2_398_744,
    required: true,
  },
  {
    relativePath: "Xenova/siglip-base-patch16-224/tokenizer_config.json",
    sha256: "9a38d3c6b5e26fe5dcc607eda95e38d78d30d9291835bb9e8116e8174c1d4ba2",
    sizeBytes: 739,
    required: true,
  },
];

export const SIGLIP_V1_ADAPTER_ID = "siglip-v1-base-patch16-224";

export const SIGLIP_V1_ADAPTER: EmbeddingAdapterDescriptor = {
  schemaVersion: 1,
  id: SIGLIP_V1_ADAPTER_ID,
  legacyKind: "siglip",
  family: "siglip",
  displayName: "SigLIP Base Patch16-224",
  modelId: "Xenova/siglip-base-patch16-224",
  revision: "main",
  artifacts: V1_ARTIFACTS,
  embeddingSpace: {
    dimensions: 768,
    normalization: "l2",
    image: {
      modelRelativePath:
        "Xenova/siglip-base-patch16-224/onnx/vision_model_quantized.onnx",
      inputName: "pixel_values",
      outputName: "pooler_output",
      dimensions: 768,
      imageSize: 224,
      resizeFit: "fill",
      mean: [0.5, 0.5, 0.5],
      std: [0.5, 0.5, 0.5],
    },
    text: {
      engine: "transformers-js",
      modelRelativePath:
        "Xenova/siglip-base-patch16-224/onnx/text_model_quantized.onnx",
      tokenizerRelativePath: "Xenova/siglip-base-patch16-224/tokenizer.json",
      outputName: "pooler_output",
      dimensions: 768,
      maxLength: 64,
      padding: "max_length",
    },
  },
  capabilities: {
    imageToImage: true,
    textToImage: true,
    tagging: true,
    duplicateDetection: true,
  },
  thresholdProfileId: "siglip-v1-base-patch16-224-default",
};

/** 自用（2026-10）：Chinese-CLIP 的产物清单（两塔合并在同一个 ONNX 里）。 */
const CHINESE_CLIP_ARTIFACTS: ModelArtifactSpec[] = [
  {
    relativePath: "Xenova/chinese-clip-vit-base-patch16/onnx/model_quantized.onnx",
    sha256: "a2c2849329eafb24100acec5a9421a39f8cb445296444c5c98855b69e5e7a751",
    sizeBytes: 190_842_404,
    required: true,
  },
  {
    relativePath: "Xenova/chinese-clip-vit-base-patch16/config.json",
    sha256: "19447ad8c20d274f0644a6663af56286be98bd2d0e5f9472fcb318e04fcd6961",
    sizeBytes: 844,
    required: true,
  },
  {
    relativePath: "Xenova/chinese-clip-vit-base-patch16/preprocessor_config.json",
    sha256: "61a78fdd2c7ac17b54b6190c0f4cb23423192c535003d52528d01e318a47608b",
    sizeBytes: 546,
    required: true,
  },
  {
    relativePath: "Xenova/chinese-clip-vit-base-patch16/special_tokens_map.json",
    sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
    sizeBytes: 125,
    required: true,
  },
  {
    relativePath: "Xenova/chinese-clip-vit-base-patch16/tokenizer.json",
    sha256: "7dfbf1966ebf99d471c3796e9b457329d2b2182b817e144f1e904b957745c839",
    sizeBytes: 439_124,
    required: true,
  },
  {
    relativePath: "Xenova/chinese-clip-vit-base-patch16/tokenizer_config.json",
    sha256: "38fbc894183595cc1168e36150251b2fb658197b3a49f6908cce88ae22acd52a",
    sizeBytes: 1_315,
    required: true,
  },
  {
    relativePath: "Xenova/chinese-clip-vit-base-patch16/vocab.txt",
    sha256: "45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c",
    sizeBytes: 109_540,
    required: true,
  },
];

export const CHINESE_CLIP_V1_ADAPTER_ID = "chinese-clip-v1-base-patch16";

/**
 * 自用（2026-10 换模型）：中文 CLIP（`Xenova/chinese-clip-vit-base-patch16`）。
 *
 * 为什么换：同一句话 + 同一张图，SigLIP（英文翻译后）相似度只有 **13%**，
 * 而这个模型是 **35%** —— 中文原生编码，不需要翻译那一步。
 *
 * ⚠️ 两个关键差异（都已用独立脚本验证）：
 *   1. ONNX 是**两塔合并**的一张图（`onnx/model_quantized.onnx`），声明了
 *      `input_ids` / `attention_mask` / `pixel_values` 三个输入 → worker 会给
 *      "没主动提供"的输入补零张量（只跑一塔时另一塔喂零，实测互不干扰）。
 *   2. `@xenova/transformers` v2 的 ChineseCLIPModel **不完整**（没有
 *      get_text_features、也不暴露子塔）→ 文本塔走 `engine: "onnxruntime-node"`，
 *      只用它的 tokenizer，推理自己用 onnxruntime 跑。
 */
export const CHINESE_CLIP_V1_ADAPTER: EmbeddingAdapterDescriptor = {
  schemaVersion: 1,
  id: CHINESE_CLIP_V1_ADAPTER_ID,
  family: "chinese-clip",
  displayName: "Chinese-CLIP Base Patch16-224",
  modelId: "Xenova/chinese-clip-vit-base-patch16",
  revision: "main",
  artifacts: CHINESE_CLIP_ARTIFACTS,
  embeddingSpace: {
    dimensions: 512,
    normalization: "l2",
    image: {
      modelRelativePath:
        "Xenova/chinese-clip-vit-base-patch16/onnx/model_quantized.onnx",
      inputName: "pixel_values",
      outputName: "image_embeds",
      dimensions: 512,
      imageSize: 224,
      resizeFit: "cover",
      // CLIP 系标准归一化（与 SigLIP 的 0.5/0.5 不同）
      mean: [0.48145466, 0.4578275, 0.40821073],
      std: [0.26862954, 0.26130258, 0.27577711],
    },
    text: {
      engine: "onnxruntime-node",
      modelRelativePath:
        "Xenova/chinese-clip-vit-base-patch16/onnx/model_quantized.onnx",
      tokenizerRelativePath:
        "Xenova/chinese-clip-vit-base-patch16/tokenizer.json",
      inputNames: { inputIds: "input_ids", attentionMask: "attention_mask" },
      outputName: "text_embeds",
      dimensions: 512,
      maxLength: 52,
      padding: "max_length",
    },
  },
  capabilities: {
    imageToImage: true,
    textToImage: true,
    tagging: false,
    duplicateDetection: true,
  },
  thresholdProfileId: "chinese-clip-v1-base-patch16-default",
};


const adapterRegistry = new Map<EmbeddingAdapterId, EmbeddingAdapterDescriptor>([
  [SIGLIP_V1_ADAPTER.id, SIGLIP_V1_ADAPTER],
  [CHINESE_CLIP_V1_ADAPTER.id, CHINESE_CLIP_V1_ADAPTER],
]);

/*
 * 自用（2026-10 换模型）：活动模型已换成 **Chinese-CLIP**。
 * 理由：同一句话 + 同一张图，SigLIP（经英译）相似度只有 13%，它是 35%；
 * 而且中文原生 → 不再需要 opus-mt 翻译那一步。
 * 需要回退时把下面这行改回 SIGLIP_V1_ADAPTER_ID 即可（两个适配器都还注册着）。
 */
let activeAdapterId = CHINESE_CLIP_V1_ADAPTER_ID;

export function registerEmbeddingAdapter(
  adapter: EmbeddingAdapterDescriptor
): void {
  if (adapter.schemaVersion !== 1) {
    throw new Error(
      `Unsupported embedding adapter schema: ${adapter.schemaVersion}`
    );
  }
  if (!adapter.id.trim()) {
    throw new Error("Embedding adapter id must not be empty");
  }
  if (
    adapter.embeddingSpace.dimensions !==
      adapter.embeddingSpace.image.dimensions ||
    adapter.embeddingSpace.dimensions !== adapter.embeddingSpace.text.dimensions
  ) {
    throw new Error(
      `Embedding adapter ${adapter.id} has inconsistent dimensions`
    );
  }
  adapterRegistry.set(adapter.id, adapter);
}

export function getEmbeddingAdapter(
  id: EmbeddingAdapterId
): EmbeddingAdapterDescriptor {
  const adapter = adapterRegistry.get(id);
  if (!adapter) {
    throw new Error(`Unknown embedding adapter: ${id}`);
  }
  return adapter;
}

export function getActiveEmbeddingAdapter(): EmbeddingAdapterDescriptor {
  return getEmbeddingAdapter(activeAdapterId);
}

export function getActiveEmbeddingAdapterInfo(): {
  adapterId: string;
  displayName: string;
  modelId: string;
  revision: string;
} {
  const adapter = getActiveEmbeddingAdapter();
  return {
    adapterId: adapter.id,
    displayName: adapter.displayName,
    modelId: adapter.modelId,
    revision: adapter.revision,
  };
}

export function setActiveEmbeddingAdapter(id: EmbeddingAdapterId): void {
  getEmbeddingAdapter(id);
  activeAdapterId = id;
}

export function serializeEmbeddingAdapter(
  adapter: EmbeddingAdapterDescriptor,
  fingerprint: string,
  modelRoot: string
): SerializedWorkerAdapter {
  return {
    protocolVersion: 1,
    adapterId: adapter.id,
    fingerprint,
    modelRoot: path.resolve(modelRoot),
    modelId: adapter.modelId,
    image: { ...adapter.embeddingSpace.image },
    text: { ...adapter.embeddingSpace.text },
    normalization: adapter.embeddingSpace.normalization,
  };
}
