import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHINESE_CLIP_V1_ADAPTER_ID,
  SIGLIP_V1_ADAPTER_ID,
  setActiveEmbeddingAdapter,
} from "@/services/ai/model-adapter";
import { setEmbeddingModel } from "@/services/ai/state";
import {
  _ensureTagEmbeddingsForTest,
  _resetTagEmbeddingCacheForTest,
  CANDIDATE_TAGS,
} from "@/services/ai/tag-suggester";

function vector(value = 1): number[] {
  return Array.from({ length: 768 }, () => value);
}

/*
 * 自用（2026-10 换中文 CLIP）：这套用例描述的是 **SigLIP** 那条路径的行为
 *（它仍保留作回退路线），而默认活动模型已换成 Chinese-CLIP，
 * 所以这里显式切回 SigLIP；用例结束恢复默认，避免影响别的用例。
 */
beforeEach(() => setActiveEmbeddingAdapter(SIGLIP_V1_ADAPTER_ID));
afterEach(() => setActiveEmbeddingAdapter(CHINESE_CLIP_V1_ADAPTER_ID));

describe("tag embedding cache", () => {
  beforeEach(() => {
    vi.stubEnv("AI_EMBEDDING_MODEL", "siglip");
    _resetTagEmbeddingCacheForTest();
  });

  afterEach(() => {
    setEmbeddingModel(null);
    _resetTagEmbeddingCacheForTest();
    vi.unstubAllEnvs();
  });

  it("precomputes candidates in batches of sixteen", async () => {
    const embedTexts = vi.fn(async (texts: string[]) =>
      texts.map(() => vector())
    );
    setEmbeddingModel({
      embedImage: vi.fn(),
      embedText: vi.fn(),
      embedTexts,
    });

    await _ensureTagEmbeddingsForTest();

    expect(embedTexts).toHaveBeenCalledTimes(
      Math.ceil(CANDIDATE_TAGS.length / 16)
    );
    expect(embedTexts.mock.calls.every(([texts]) => texts.length <= 16)).toBe(
      true
    );
  });

  it("shares one precomputation across concurrent callers", async () => {
    const embedTexts = vi.fn(async (texts: string[]) =>
      texts.map(() => vector())
    );
    setEmbeddingModel({
      embedImage: vi.fn(),
      embedText: vi.fn(),
      embedTexts,
    });

    await Promise.all([
      _ensureTagEmbeddingsForTest(),
      _ensureTagEmbeddingsForTest(),
    ]);

    expect(embedTexts).toHaveBeenCalledTimes(
      Math.ceil(CANDIDATE_TAGS.length / 16)
    );
  });

  it("does not publish a partial cache after an invalid vector", async () => {
    let fail = true;
    const embedTexts = vi.fn(async (texts: string[]) =>
      texts.map(() => (fail ? [1] : vector()))
    );
    setEmbeddingModel({
      embedImage: vi.fn(),
      embedText: vi.fn(),
      embedTexts,
    });

    await expect(_ensureTagEmbeddingsForTest()).rejects.toThrow(
      "Invalid SigLIP"
    );
    fail = false;
    await _ensureTagEmbeddingsForTest();

    expect(embedTexts).toHaveBeenCalledTimes(
      1 + Math.ceil(CANDIDATE_TAGS.length / 16)
    );
  });
});
