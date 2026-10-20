import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHINESE_CLIP_V1_ADAPTER_ID,
  SIGLIP_V1_ADAPTER_ID,
  setActiveEmbeddingAdapter,
} from "@/services/ai/model-adapter";
import {
  getActiveEmbeddingModel,
  getTextSearchMaxCosineDistance,
} from "@/services/ai/model-config";
import {
  applyNegativeSemanticPenalty,
  filterCosineSearchResults,
  type FusedRankedSearchResult,
  fuseRankedSearchEvidence,
  fuseRankedSearchResults,
  isValidEmbeddingVector,
  selectRelevantSemanticResults,
  selectTagScores,
} from "@/services/ai/scoring";
import { CANDIDATE_TAGS } from "@/services/ai/tag-suggester";

const originalModel = process.env.AI_EMBEDDING_MODEL;
const originalPolicy = process.env.AI_SEMANTIC_POLICY;

afterEach(() => {
  if (originalModel === undefined) {
    delete process.env.AI_EMBEDDING_MODEL;
  } else {
    process.env.AI_EMBEDDING_MODEL = originalModel;
  }
  if (originalPolicy === undefined) {
    delete process.env.AI_SEMANTIC_POLICY;
  } else {
    process.env.AI_SEMANTIC_POLICY = originalPolicy;
  }
});

/*
 * 自用（2026-10 换中文 CLIP）：这套用例描述的是 **SigLIP** 那条路径的行为
 *（它仍保留作回退路线），而默认活动模型已换成 Chinese-CLIP，
 * 所以这里显式切回 SigLIP；用例结束恢复默认，避免影响别的用例。
 */
beforeEach(() => setActiveEmbeddingAdapter(SIGLIP_V1_ADAPTER_ID));
afterEach(() => setActiveEmbeddingAdapter(CHINESE_CLIP_V1_ADAPTER_ID));

describe("SigLIP scoring policy", () => {
  it("uses SigLIP-specific text search distances", () => {
    delete process.env.AI_EMBEDDING_MODEL;
    const model = getActiveEmbeddingModel();

    expect(getTextSearchMaxCosineDistance(0, "zh")).toBe(0.98);
    expect(getTextSearchMaxCosineDistance(1, "zh")).toBe(0.98);
    expect(getTextSearchMaxCosineDistance(1, "en")).toBe(0.98);
    expect(model.scoring.duplicateConfirmationSimilarity).toBe(0.95);
  });

  it("keeps the SigLIP distance policy when the removed CLIP selector is set", () => {
    process.env.AI_EMBEDDING_MODEL = "clip";

    expect(getTextSearchMaxCosineDistance(0, "zh")).toBe(0.98);
    expect(getTextSearchMaxCosineDistance(1, "zh")).toBe(0.98);
    expect(getTextSearchMaxCosineDistance(1, "en")).toBe(0.98);
  });

  it("selects separated SigLIP tags, allows category co-occurrence, and calibrates confidence", () => {
    delete process.env.AI_EMBEDDING_MODEL;
    const model = getActiveEmbeddingModel();
    const selected = selectTagScores(
      [
        { category: "activity", displayName: "阅读", similarity: 0.09 },
        { category: "activity", displayName: "学习", similarity: 0.08 },
        { category: "subject", displayName: "人物", similarity: 0.065 },
        { category: "scene", displayName: "户外", similarity: 0.045 },
        { category: "style", displayName: "复古", similarity: 0.005 },
        { category: "color", displayName: "蓝色调", similarity: -0.01 },
        ...Array.from({ length: 20 }, (_, index) => ({
          category: "weather",
          displayName: `低分候选${index}`,
          similarity: -0.02,
        })),
      ],
      5,
      model
    );

    expect(selected.map((tag) => tag.tag)).toEqual(["阅读", "学习", "人物"]);
    expect(selected[0].confidence).toBeLessThan(0.95);
    expect(selected[0].confidence).toBeGreaterThanOrEqual(0.55);
    expect(selected[1].confidence).toBeGreaterThanOrEqual(0.55);
    expect(selected.every((tag) => tag.confidence <= 0.95)).toBe(true);
  });

  it("returns no SigLIP tags when the score distribution is not separated", () => {
    delete process.env.AI_EMBEDDING_MODEL;

    expect(
      selectTagScores(
        [
          { category: "scene", displayName: "室内", similarity: 0.034 },
          { category: "object", displayName: "书籍", similarity: 0.025 },
          { category: "style", displayName: "极简", similarity: 0.02 },
        ],
        5,
        getActiveEmbeddingModel()
      )
    ).toEqual([]);
  });

  it("applies candidate-specific floors before the shared top-five cutoff", () => {
    const selected = selectTagScores(
      [
        {
          id: "anime",
          category: "format",
          displayName: "二次元动漫风格",
          similarity: 0.09,
        },
        {
          id: "illustration",
          category: "format",
          displayName: "插画",
          similarity: 0.064,
        },
        {
          id: "subject:person people human",
          category: "subject",
          displayName: "人物",
          similarity: 0.06,
        },
      ],
      5,
      getActiveEmbeddingModel()
    );

    expect(selected.map((tag) => tag.tag)).toEqual(["插画", "人物"]);
  });

  it("validates active-model vector dimensions and finite values", () => {
    const model = getActiveEmbeddingModel();

    expect(
      isValidEmbeddingVector(
        Array.from({ length: model.vectorDimensions }, () => 0),
        model
      )
    ).toBe(true);
    expect(isValidEmbeddingVector([0, 1], model)).toBe(false);
    expect(
      isValidEmbeddingVector(
        [
          Number.NaN,
          ...Array.from({ length: model.vectorDimensions - 1 }, () => 0),
        ],
        model
      )
    ).toBe(false);
  });
});

describe("embedding prompts and ranked fusion", () => {
  it("provides a curated SigLIP label for every candidate tag", () => {
    const expectedCategoryCounts = {
      format: 21,
      activity: 15,
      animal: 12,
      color: 10,
      lighting: 10,
      object: 20,
      scene: 26,
      style: 18,
      subject: 15,
      weather: 6,
    };
    const actualCategoryCounts = Object.fromEntries(
      Object.keys(expectedCategoryCounts).map((category) => [
        category,
        CANDIDATE_TAGS.filter((tag) => tag.category === category).length,
      ])
    );

    expect(CANDIDATE_TAGS).toHaveLength(153);
    expect(actualCategoryCounts).toEqual(expectedCategoryCounts);
    expect(
      CANDIDATE_TAGS.every((tag) => tag.siglipLabel.trim().length > 0)
    ).toBe(true);
    expect(CANDIDATE_TAGS.every((tag) => tag.id.trim().length > 0)).toBe(true);
    expect(
      CANDIDATE_TAGS.find((tag) => tag.en === "reading studying book learning")
        ?.siglipLabel
    ).toBe("a person reading a book");
  });

  it("sorts by fused rank but exposes the best raw cosine similarity", () => {
    const fused = fuseRankedSearchResults(
      [
        [
          { photoId: 1, similarity: 0.09 },
          { photoId: 2, similarity: 0.08 },
        ],
        [
          { photoId: 2, similarity: 0.11 },
          { photoId: 3, similarity: 0.07 },
        ],
      ],
      3
    );

    expect(fused[0]).toEqual({ photoId: 2, similarity: 0.11 });
    expect(fused.find((result) => result.photoId === 1)?.similarity).toBe(0.09);
  });

  it("filters SigLIP text results at distance 0.98 and keeps raw cosine scores", () => {
    expect(
      filterCosineSearchResults(
        [
          { distance: 0.97, photoId: 1 },
          { distance: 0.98, photoId: 2 },
          { distance: 0.981, photoId: 3 },
        ],
        0.98,
        10
      )
    ).toEqual([
      { photoId: 1, similarity: 0.03 },
      { photoId: 2, similarity: 0.02 },
    ]);
  });

  it("uses the object floor and rejects weak camera-like candidates", () => {
    const selection = selectRelevantSemanticResults(
      [
        {
          photoId: 1,
          primarySimilarity: 0.0916,
          rankScore: 0.03,
          similarity: 0.0916,
          supportingGroups: ["whole-query"],
        },
        {
          photoId: 2,
          primarySimilarity: 0.0527,
          rankScore: 0.02,
          similarity: 0.0527,
          supportingGroups: ["whole-query"],
        },
        {
          photoId: 3,
          primarySimilarity: 0.0482,
          rankScore: 0.01,
          similarity: 0.0482,
          supportingGroups: ["whole-query"],
        },
        {
          photoId: 4,
          primarySimilarity: 0.0427,
          rankScore: 0.005,
          similarity: 0.0427,
          supportingGroups: ["whole-query"],
        },
      ],
      getActiveEmbeddingModel(),
      1,
      100,
      {
        intent: "object",
        primaryScores: [0.0916, 0.08, 0.07, 0.065, 0.06, 0.0527, 0.0482],
      }
    );

    expect(selection.strongCutoff).toBeGreaterThanOrEqual(0.055);
    expect(selection.results.map((result) => result.photoId)).toEqual([1]);
    expect(selection.supportCandidates.map((result) => result.photoId)).toEqual(
      [1, 2, 3]
    );
    expect(selection.supportCutoff).toBeGreaterThan(0.045);
    expect(selection.rejectedWeak).toBe(3);
    expect(selection.hasMoreCandidates).toBe(false);
  });

  it("keeps object results nested from relaxed to standard to precise", () => {
    const results = [0.1, 0.08, 0.07, 0.065, 0.06, 0.05, 0.04].map(
      (similarity, index) => ({
        photoId: index + 1,
        primarySimilarity: similarity,
        rankScore: 0.01,
        similarity,
        supportingGroups: ["whole-query" as const],
      })
    );

    const select = (sensitivity: number) =>
      selectRelevantSemanticResults(
        results,
        getActiveEmbeddingModel(),
        1,
        100,
        { intent: "object", sensitivity }
      );

    const relaxed = select(0.6).results.map(({ photoId }) => photoId);
    const standard = select(1).results.map(({ photoId }) => photoId);
    const precise = select(1.4).results.map(({ photoId }) => photoId);

    expect(relaxed).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(standard).toEqual([1, 2, 3, 4, 5]);
    expect(precise).toEqual([1]);
    expect(new Set(relaxed)).toEqual(new Set([...standard, 6, 7]));
    expect(new Set(standard)).toEqual(new Set([...precise, 2, 3, 4, 5]));
  });

  /*
   * 自用（2026-10-16，**回归测试：修"每次只搜出 1 张"**）：
   *
   * 曾经的做法是"用外部传进来的**原始候选分数**算断层及格线，
   * 却拿去筛**融合后的结果列表**" ✗ —— 两批分数不同源，
   * 于是出现"原始分里前几名都在 0.43 以上、融合后只有 1 张 ≥ 0.43" →
   * **结果被砍到只剩 1 张** ✗（实测日志 top=0.4348 cutoff=0.4315 accepted=1 ✓）。
   *
   * 下面这组用例刻意让两批分数"打架"：原始候选在 0.43 上方有一大簇，
   * 而融合结果里最高只有 0.30 —— 自洽的算法**不应该**因此把结果砍到 1 张 ✓。
   */
  it("断层及格线必须用「要筛的那份分数」算，不能被外来的原始分数带偏", () => {
    const fused = [0.3, 0.29, 0.281, 0.275, 0.27, 0.18, 0.12].map(
      (similarity, index) => ({
        photoId: index + 1,
        primarySimilarity: similarity,
        rankScore: 0.01,
        similarity,
        supportingGroups: ["whole-query" as const],
      })
    );

    const selection = selectRelevantSemanticResults(
      fused,
      getActiveEmbeddingModel(),
      1,
      100,
      {
        intent: "object",
        // 原始候选：0.43 附近一大簇，再往下掉 —— 旧写法会据此把线划到 0.4315 ✗
        primaryScores: [0.4348, 0.4332, 0.4325, 0.4321, 0.4315, 0.38, 0.35, 0.3],
      }
    );

    // 自洽算法：及格线由融合结果的分布决定（≈ 0.3 × 0.6），不会砍到只剩 1 张 ✓
    expect(selection.results.length).toBeGreaterThanOrEqual(3);
    expect(selection.finalCutoff).toBeLessThan(0.3);
    expect(selection.cutoffReason).not.toBe("score-gap");
  });

  it("搜索灵敏度也能影响断层及格线（旧写法里它漏乘了系数）", () => {
    const fused = [0.5, 0.48, 0.47, 0.465, 0.46, 0.3, 0.28, 0.26].map(
      (similarity, index) => ({
        photoId: index + 1,
        primarySimilarity: similarity,
        rankScore: 0.01,
        similarity,
        supportingGroups: ["whole-query" as const],
      })
    );

    const select = (sensitivity: number) =>
      selectRelevantSemanticResults(fused, getActiveEmbeddingModel(), 1, 100, {
        intent: "object",
        sensitivity,
      });

    const relaxed = select(0.6).finalCutoff;
    const standard = select(1).finalCutoff;
    const precise = select(1.4).finalCutoff;

    expect(relaxed).toBeLessThan(standard);
    expect(standard).toBeLessThan(precise);
  });

  /*
   * 自用（2026-10-16，**修"筛选阈值和角标不是一个刻度"**）：
   * 「全部图片」顶栏那条「相似度 ≥ N%」滑杆（IPC: minSimilarity，zod 里早就声明了、
   * 但主进程没有任何地方读它 ✗）最终落到这里的 `userMinSimilarity`。
   *
   * 卡片角标显示的就是**原始余弦相似度**（PhotoCard: `match.score * 100`，
   * 例如「语义匹配 46%」），所以把用户下限当 hard floor 并进 strongCutoff
   * = 滑杆与角标**同一个刻度** ✓（用户原话："筛选阈值和角标不是一个刻度"）：
   * 滑杆拖到 28% 时，primarySimilarity < 0.28 的图必须不再出现 ✓。
   */
  it("滑杆下限比算法及格线高时真正收紧语义结果（与角标同刻度）", () => {
    const fused = [0.3, 0.29, 0.281, 0.275, 0.27, 0.18, 0.12].map(
      (similarity, index) => ({
        photoId: index + 1,
        primarySimilarity: similarity,
        rankScore: 0.01,
        similarity,
        supportingGroups: ["whole-query" as const],
      })
    );
    const select = (userMinSimilarity?: number) =>
      selectRelevantSemanticResults(fused, getActiveEmbeddingModel(), 1, 100, {
        intent: "object",
        userMinSimilarity,
      });

    const withoutSlider = select(undefined);
    const withSlider = select(0.28);

    // 算法自己的及格线 ≈ 0.225（断层 0.27/0.18）→ 5 张；滑杆 0.28 → 只剩 3 张 ✓
    expect(withoutSlider.results).toHaveLength(5);
    expect(withSlider.results.map(({ photoId }) => photoId)).toEqual([1, 2, 3]);
    expect(
      withSlider.results.every(({ primarySimilarity }) => primarySimilarity >= 0.28)
    ).toBe(true);
    // 滑杆成为最终及格线 → 角标（×100 = 28%）与阈值同一个刻度 ✓
    expect(withSlider.finalCutoff).toBeCloseTo(0.28, 6);
    expect(withSlider.acceptedCount).toBeLessThan(withoutSlider.acceptedCount);
  });

  it("滑杆下限比及格线低时不会放宽（默认 0 与不传完全一致）", () => {
    const fused = [0.3, 0.29, 0.281, 0.275, 0.27, 0.18, 0.12].map(
      (similarity, index) => ({
        photoId: index + 1,
        primarySimilarity: similarity,
        rankScore: 0.01,
        similarity,
        supportingGroups: ["whole-query" as const],
      })
    );
    const select = (userMinSimilarity?: number) =>
      selectRelevantSemanticResults(fused, getActiveEmbeddingModel(), 1, 100, {
        intent: "object",
        userMinSimilarity,
      });

    const baseline = select(undefined);
    const explicitZero = select(0);
    const belowCutoff = select(0.05); // 远低于算法及格线 ≈ 0.225

    for (const candidate of [explicitZero, belowCutoff]) {
      expect(candidate.results).toEqual(baseline.results);
      expect(candidate.finalCutoff).toBe(baseline.finalCutoff);
      expect(candidate.strongCutoff).toBe(baseline.strongCutoff);
      expect(candidate.supportCandidates).toEqual(baseline.supportCandidates);
    }
  });

  /*
   * 自用（2026-10-16，**滑杆必须是"硬"下限**）：
   * composed / scene 意图除了主及格线，还有一条"共识放宽通道"
   *（consensusCutoff = strongCutoff × 0.85，需要独立证据支持）。
   * 只提高主及格线的话，滑杆 19% 时这条通道仍会放进 18% 的图 ✗
   * —— 角标 18% < 滑杆 19%，还是"阈值和角标不是一个刻度" ✗。
   */
  it("放宽通道（共识线）也不能放进低于滑杆下限的语义结果", () => {
    const fused: FusedRankedSearchResult[] = [
      {
        photoId: 1,
        primarySimilarity: 0.5,
        rankScore: 0.03,
        similarity: 0.5,
        supportingGroups: ["whole-query"],
      },
      {
        photoId: 2,
        primarySimilarity: 0.18,
        rankScore: 0.02,
        similarity: 0.18,
        supportingGroups: ["whole-query", "subject"],
      },
    ];
    const select = (userMinSimilarity?: number) =>
      selectRelevantSemanticResults(fused, getActiveEmbeddingModel(), 2, 100, {
        intent: "scene",
        userMinSimilarity,
      });

    // scene: strong = 0.5 × 0.4 = 0.2，consensus = 0.2 × 0.85 = 0.17
    // → 0.18 只能靠共识放宽通道进来 ✓
    const baseline = select(undefined);
    expect(baseline.results.map(({ photoId }) => photoId)).toEqual([1, 2]);

    // 滑杆 0.19 时主及格线仍是 0.2（没被抬高），但共识线被顶到 0.19 →
    // 0.18 < 0.19 必须被挡住 ✓
    const withSlider = select(0.19);
    expect(withSlider.strongCutoff).toBeCloseTo(0.2, 6);
    expect(withSlider.consensusCutoff).toBeCloseTo(0.19, 6);
    expect(withSlider.results.map(({ photoId }) => photoId)).toEqual([1]);
  });

  it("legacy 策略下同样把滑杆下限当硬下限", () => {
    process.env.AI_SEMANTIC_POLICY = "legacy";
    const fused = [0.1, 0.09, 0.05, 0.041].map((similarity, index) => ({
      photoId: index + 1,
      primarySimilarity: similarity,
      rankScore: 0.01,
      similarity,
      supportingGroups: ["whole-query" as const],
    }));
    const select = (userMinSimilarity?: number) =>
      selectRelevantSemanticResults(fused, getActiveEmbeddingModel(), 1, 100, {
        intent: "object",
        userMinSimilarity,
      });

    const baseline = select(undefined);
    const withSlider = select(0.095); // 高于 legacy 的及格线 ≈ 0.04，也高于第 2 名 0.09

    expect(baseline.cutoffReason).toBe("legacy");
    expect(baseline.results).toHaveLength(4);
    expect(withSlider.results.map(({ photoId }) => photoId)).toEqual([1]);
    expect(withSlider.strongCutoff).toBeCloseTo(0.095, 6);
    expect(withSlider.results.length).toBeLessThan(baseline.results.length);
  });

  it("continues broad scene retrieval while the primary tail remains eligible", () => {
    const selection = selectRelevantSemanticResults(
      [
        {
          photoId: 1,
          primarySimilarity: 0.1,
          rankScore: 0.03,
          similarity: 0.1,
          supportingGroups: ["whole-query"],
        },
      ],
      getActiveEmbeddingModel(),
      1,
      100,
      {
        candidateTails: [{ evidenceGroup: "whole-query", similarity: 0.05 }],
        intent: "scene",
        primaryScores: [0.1],
      }
    );

    expect(selection.hasMoreCandidates).toBe(true);
  });

  it("does not double-count duplicate prompts in one evidence group", () => {
    const fused = fuseRankedSearchEvidence(
      [[{ photoId: 1, similarity: 0.09 }], [{ photoId: 1, similarity: 0.12 }]],
      10,
      [1, 0.75],
      ["whole-query", "whole-query"]
    );

    expect(fused[0].supportingGroups).toEqual(["whole-query"]);
    expect(fused[0].rankScore).toBeCloseTo(1 / 61);
    expect(fused[0].primarySimilarity).toBe(0.09);
  });

  it("supports the legacy semantic policy rollback switch", () => {
    process.env.AI_SEMANTIC_POLICY = "legacy";
    const selection = selectRelevantSemanticResults(
      [
        {
          photoId: 1,
          primarySimilarity: 0.1,
          rankScore: 0.03,
          similarity: 0.1,
          supportingGroups: ["whole-query"],
        },
        {
          photoId: 2,
          primarySimilarity: 0.041,
          rankScore: 0.02,
          similarity: 0.041,
          supportingGroups: ["whole-query"],
        },
      ],
      getActiveEmbeddingModel(),
      1,
      100
    );

    expect(selection.cutoffReason).toBe("legacy");
    expect(selection.strongCutoff).toBeCloseTo(0.04);
    expect(selection.results.map(({ photoId }) => photoId)).toEqual([1, 2]);
  });

  it("只在正向召回候选上应用 0.25 否定惩罚", () => {
    const positive = fuseRankedSearchEvidence(
      [
        [
          { photoId: 1, similarity: 0.2 },
          { photoId: 2, similarity: 0.19 },
        ],
      ],
      10,
      [1]
    );
    const reranked = applyNegativeSemanticPenalty(
      positive,
      [[{ photoId: 1, similarity: 0.2 }]],
      10
    );

    expect(reranked.map((result) => result.photoId)).toEqual([2, 1]);
    expect(reranked[1].similarity).toBe(0.15);
    expect(reranked).toHaveLength(2);
  });
});
