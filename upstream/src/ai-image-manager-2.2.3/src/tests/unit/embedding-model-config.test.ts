import { afterEach, describe, expect, it } from "vitest";
import {
  getActiveEmbeddingModel,
  getEmbeddingModelFile,
} from "@/services/ai/model-config";

const originalModel = process.env.AI_EMBEDDING_MODEL;

afterEach(() => {
  if (originalModel === undefined) {
    delete process.env.AI_EMBEDDING_MODEL;
  } else {
    process.env.AI_EMBEDDING_MODEL = originalModel;
  }
});

describe("embedding model configuration", () => {
  /*
   * 自用（2026-10 换模型）：默认模型从 SigLIP 换成 Chinese-CLIP。
   * 依据：同一句话 + 同一张图，SigLIP（经英译）相似度 13%，Chinese-CLIP 35%；
   * 而且中文原生，不再需要翻译那一步。SigLIP 适配器仍保留（可回退）。
   */
  it("uses Chinese-CLIP as the default model", () => {
    delete process.env.AI_EMBEDDING_MODEL;

    expect(getActiveEmbeddingModel()).toMatchObject({
      kind: "chinese-clip",
      modelId: "Xenova/chinese-clip-vit-base-patch16",
      vectorDimensions: 512,
    });
  });

  it("ignores the removed CLIP selector and keeps the default active", () => {
    process.env.AI_EMBEDDING_MODEL = "clip";

    expect(getActiveEmbeddingModel()).toMatchObject({
      kind: "chinese-clip",
      modelId: "Xenova/chinese-clip-vit-base-patch16",
      vectorDimensions: 512,
    });
  });

  it("resolves the active model marker under the supplied model root", () => {
    delete process.env.AI_EMBEDDING_MODEL;

    // 新模型的视觉塔与文本塔在**同一个文件**里
    expect(
      getEmbeddingModelFile("D:\\models", "model_quantized.onnx")
    ).toContain(
      "Xenova\\chinese-clip-vit-base-patch16\\onnx\\model_quantized.onnx"
    );
  });
});
