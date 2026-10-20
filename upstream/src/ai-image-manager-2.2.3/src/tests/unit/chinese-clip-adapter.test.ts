import { describe, expect, it } from "vitest";
import {
  CHINESE_CLIP_V1_ADAPTER,
  getActiveEmbeddingAdapter,
} from "@/services/ai/model-adapter";
import { getActiveEmbeddingModel } from "@/services/ai/model-config";
import { getActiveThresholdProfile } from "@/services/ai/threshold-profile";

/**
 * 自用（2026-10 换中文 CLIP）：守住这次换模型的关键契约。
 *
 * 为什么需要这组测试：这次改的是"AI 推理核心"，配置写错（维度、引擎、
 * 产物路径、输出名、阈值档绑定）在界面上的表现都是"搜不到东西"，
 * 极难排查 —— 所以把契约固定下来。
 */
describe("Chinese-CLIP 适配器（2026-10 换模型）", () => {
  it("它就是当前活动适配器", () => {
    const adapter = getActiveEmbeddingAdapter();
    expect(adapter.id).toBe(CHINESE_CLIP_V1_ADAPTER.id);
  });

  it("两塔共用同一个合并 ONNX，且维度是 512", () => {
    const adapter = getActiveEmbeddingAdapter();
    expect(adapter.embeddingSpace.dimensions).toBe(512);
    expect(adapter.embeddingSpace.image.dimensions).toBe(512);
    expect(adapter.embeddingSpace.text.dimensions).toBe(512);
    // 合并模型的关键特征：文本与图像指向同一个文件
    expect(adapter.embeddingSpace.image.modelRelativePath).toBe(
      adapter.embeddingSpace.text.modelRelativePath
    );
    expect(adapter.embeddingSpace.image.modelRelativePath).toContain(
      "chinese-clip-vit-base-patch16/onnx/model_quantized.onnx"
    );
  });

  it("文本塔走 onnxruntime 引擎并声明输入/输出名", () => {
    const text = getActiveEmbeddingAdapter().embeddingSpace.text;
    // v2 的 ChineseCLIPModel 不完整，必须绕开 transformers-js
    expect(text.engine).toBe("onnxruntime-node");
    expect(text.inputNames).toEqual({
      inputIds: "input_ids",
      attentionMask: "attention_mask",
    });
    expect(text.outputName).toBe("text_embeds");
    expect(text.maxLength).toBe(52);
    expect(text.padding).toBe("max_length");
  });

  it("图像塔用 CLIP 标准归一化与 224 输入", () => {
    const image = getActiveEmbeddingAdapter().embeddingSpace.image;
    expect(image.inputName).toBe("pixel_values");
    expect(image.outputName).toBe("image_embeds");
    expect(image.imageSize).toBe(224);
    expect(image.resizeFit).toBe("cover");
    expect(image.mean[0]).toBeCloseTo(0.48145466, 6);
    expect(image.std[0]).toBeCloseTo(0.26862954, 6);
  });

  it("模型 kind 派生为 chinese-clip（查询路径靠它切中文原生）", () => {
    expect(getActiveEmbeddingModel().kind).toBe("chinese-clip");
    expect(getActiveEmbeddingModel().vectorDimensions).toBe(512);
  });

  it("阈值档与新模型绑定，且用的是放大后的分数区间", () => {
    const profile = getActiveThresholdProfile();
    expect(profile.profileId).toBe("chinese-clip-v1-base-patch16-default");
    expect(profile.adapterId).toBe(CHINESE_CLIP_V1_ADAPTER.id);
    // SigLIP 那套是 0.04/0.02/0.035；新模型按量级放大
    expect(profile.semanticSearch.absoluteMinimumSimilarity).toBeGreaterThan(0.04);
    expect(profile.semanticSearch.candidateMinimumSimilarity).toBeGreaterThan(
      0.02
    );
  });
});
