import {
  type EmbeddingModelConfig,
  getSemanticPolicyVersion,
} from "./model-config";
import type {
  SemanticEvidenceGroup,
  SemanticQueryIntent,
} from "./semantic-query-plan";
import {
  getActiveThresholdProfile,
  type ThresholdProfile,
} from "./threshold-profile";

export interface TagScore<TCategory extends string = string> {
  category: TCategory;
  displayName: string;
  id?: string;
  similarity: number;
}

export interface SelectedTag<TCategory extends string = string> {
  category: TCategory;
  confidence: number;
  tag: string;
}

// Bump when the tag selection policy changes independently of the model or
// candidate vocabulary. This is also exposed in diagnostics so an audit can
// identify the exact filtering policy that produced its rows.
export const TAG_SELECTION_POLICY_VERSION = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Tag confidence is a fixed score mapping for the active profile. It is a
 * strength indicator for ranking and review, not a calibrated probability.
 * In particular, the highest scoring tag is no longer forced to 0.95.
 */
export function calibrateTagConfidence(
  similarity: number,
  policy: ThresholdProfile["tag"]
): number {
  const span = Math.max(policy.candidateFromTop * 2, 0.001);
  const relative = clamp((similarity - policy.topMinimum) / span, 0, 1);
  return (
    Math.round(
      (policy.confidenceMin +
        relative * (policy.confidenceMax - policy.confidenceMin)) *
        100
    ) / 100
  );
}

function selectSiglipTags<TCategory extends string>(
  scores: TagScore<TCategory>[],
  maxTags: number,
  _model: EmbeddingModelConfig
): SelectedTag<TCategory>[] {
  const policy = getActiveThresholdProfile().tag;
  if (
    getActiveThresholdProfile().calibrationStatus === "uncalibrated" ||
    !(policy && scores.length > 0 && maxTags > 0)
  ) {
    return [];
  }

  const sorted = [...scores]
    .filter((score) => Number.isFinite(score.similarity))
    .sort((left, right) => right.similarity - left.similarity);
  if (sorted.length === 0) {
    return [];
  }

  const top = sorted[0].similarity;
  if (top < policy.topMinimum) {
    return [];
  }

  // Use a score-relative floor. The candidate set can grow over time, so a
  // global median must not silently move the output threshold.
  const cutoff = Math.max(top - policy.candidateFromTop, policy.topMinimum);
  const selected: SelectedTag<TCategory>[] = [];

  for (const score of sorted) {
    const candidateMinimum = score.id
      ? (policy.candidateMinimumById?.[score.id] ?? policy.topMinimum)
      : policy.topMinimum;
    if (score.similarity < cutoff || score.similarity < candidateMinimum) {
      continue;
    }
    selected.push({
      tag: score.displayName,
      confidence: calibrateTagConfidence(score.similarity, policy),
      category: score.category,
    });
    if (selected.length >= maxTags) {
      break;
    }
  }

  return selected;
}

export function selectTagScores<TCategory extends string>(
  scores: TagScore<TCategory>[],
  maxTags: number,
  model: EmbeddingModelConfig
): SelectedTag<TCategory>[] {
  return selectSiglipTags(scores, maxTags, model);
}

export function isValidEmbeddingVector(
  vector: number[],
  model: Pick<EmbeddingModelConfig, "vectorDimensions">
): boolean {
  return (
    vector.length === model.vectorDimensions &&
    vector.every((value) => Number.isFinite(value))
  );
}

export function getTagEmbeddingCacheKey(
  embeddingFingerprint: string,
  promptVersion: number | string
): string {
  const version =
    typeof promptVersion === "number" ? `v${promptVersion}` : promptVersion;
  return `${embeddingFingerprint}:tags-${version}`;
}

/*
 * 自用（2026-10-16，**修"候选深度白扔一半"** ✗→✓）：
 * 实测 LanceDB 的 ivfFlat 检索**对同一条命中会返回 2 行相同 photo_id** ✗
 * （`limit=200` 只兑现约 100 个不同 id ✓；以图搜图 `limit=20` 只剩约 10 张 ✗）。
 * 这里按 `photoId` 去重、**同一张只留距离最小（= 最像）的那行** ✓，
 * 并保持"距离从小到大"的顺序 ✓ —— 与下游 `filterCosineSearchResults` 的预期一致 ✓。
 * 调用方（`search.ts` 的 `searchVector`）会按 2 倍要候选 ✓，去重后再 `slice(0, limit)` ✓
 * → 结果集大小与以前**完全一致** ✓，只是不再白扔一半候选 ✓。
 */
export function dedupeByPhotoId(
  rows: Array<{ distance: number; photoId: number }>
): Array<{ distance: number; photoId: number }> {
  const best = new Map<number, { distance: number; photoId: number }>();
  for (const row of rows) {
    const current = best.get(row.photoId);
    if (!current || row.distance < current.distance) {
      best.set(row.photoId, row);
    }
  }
  return [...best.values()].sort((left, right) => left.distance - right.distance);
}

export function filterCosineSearchResults(
  results: Array<{ distance: number; photoId: number }>,
  maxDistance: number,
  limit: number
): Array<{ photoId: number; similarity: number }> {
  return results
    .filter(
      ({ distance, photoId }) =>
        Number.isFinite(distance) &&
        Number.isFinite(photoId) &&
        distance <= maxDistance
    )
    .slice(0, limit)
    .map(({ distance, photoId }) => ({
      photoId,
      similarity: Math.round((1 - distance) * 10_000) / 10_000,
    }));
}

export interface FusedRankedSearchResult {
  photoId: number;
  primarySimilarity: number;
  rankScore: number;
  similarity: number;
  supportingGroups: SemanticEvidenceGroup[];
}

export function fuseRankedSearchEvidence(
  resultSets: Array<Array<{ photoId: number; similarity: number }>>,
  limit: number,
  weights: number[] = [1, 0.7, 0.5],
  evidenceGroups: SemanticEvidenceGroup[] = resultSets.map(
    (_, index) => `prompt-${index}` as SemanticEvidenceGroup
  ),
  primaryPromptIndex = 0
): FusedRankedSearchResult[] {
  const reciprocalRankConstant = 60;
  const scores = new Map<
    number,
    {
      bestSimilarity: number;
      groups: Map<
        SemanticEvidenceGroup,
        { rankScore: number; similarity: number }
      >;
      primarySimilarity: number;
    }
  >();

  for (let index = 0; index < resultSets.length; index++) {
    const weight = weights[Math.min(index, weights.length - 1)];
    const evidenceGroup = evidenceGroups[index] ?? evidenceGroups[0];
    for (let rank = 0; rank < resultSets[index].length; rank++) {
      const { photoId, similarity } = resultSets[index][rank];
      const current = scores.get(photoId) ?? {
        bestSimilarity: Number.NEGATIVE_INFINITY,
        groups: new Map(),
        primarySimilarity: Number.NEGATIVE_INFINITY,
      };
      const contribution = weight / (reciprocalRankConstant + rank + 1);
      const existingGroup = current.groups.get(evidenceGroup);
      if (
        !existingGroup ||
        contribution > existingGroup.rankScore ||
        (contribution === existingGroup.rankScore &&
          similarity > existingGroup.similarity)
      ) {
        current.groups.set(evidenceGroup, {
          rankScore: contribution,
          similarity,
        });
      }
      current.bestSimilarity = Math.max(current.bestSimilarity, similarity);
      if (index === primaryPromptIndex) {
        current.primarySimilarity = Math.max(
          current.primarySimilarity,
          similarity
        );
      }
      scores.set(photoId, current);
    }
  }

  return [...scores.entries()]
    .sort(
      (left, right) =>
        [...right[1].groups.values()].reduce(
          (sum, group) => sum + group.rankScore,
          0
        ) -
          [...left[1].groups.values()].reduce(
            (sum, group) => sum + group.rankScore,
            0
          ) ||
        right[1].bestSimilarity - left[1].bestSimilarity ||
        left[0] - right[0]
    )
    .slice(0, limit)
    .map(([photoId, score]) => {
      const primarySimilarity = Number.isFinite(score.primarySimilarity)
        ? score.primarySimilarity
        : score.bestSimilarity;
      return {
        photoId,
        primarySimilarity: Math.round(primarySimilarity * 10_000) / 10_000,
        rankScore: [...score.groups.values()].reduce(
          (sum, group) => sum + group.rankScore,
          0
        ),
        similarity: Math.round(score.bestSimilarity * 10_000) / 10_000,
        supportingGroups: [...score.groups.keys()],
      };
    });
}

export function fuseRankedSearchResults(
  resultSets: Array<Array<{ photoId: number; similarity: number }>>,
  limit: number,
  weights: number[] = [1, 0.7, 0.5]
): Array<{ photoId: number; similarity: number }> {
  return fuseRankedSearchEvidence(resultSets, limit, weights).map(
    ({ photoId, similarity }) => ({ photoId, similarity })
  );
}

export function applyNegativeSemanticPenalty(
  positiveResults: FusedRankedSearchResult[],
  negativeResultSets: Array<Array<{ photoId: number; similarity: number }>>,
  limit: number,
  penaltyWeight = 0.25
): FusedRankedSearchResult[] {
  if (negativeResultSets.length === 0) {
    return positiveResults.slice(0, limit);
  }

  const reciprocalRankConstant = 60;
  const negativeSimilarity = new Map<number, number>();
  const negativeRankScore = new Map<number, number>();
  for (const resultSet of negativeResultSets) {
    for (let rank = 0; rank < resultSet.length; rank++) {
      const result = resultSet[rank];
      negativeSimilarity.set(
        result.photoId,
        Math.max(negativeSimilarity.get(result.photoId) ?? 0, result.similarity)
      );
      negativeRankScore.set(
        result.photoId,
        Math.max(
          negativeRankScore.get(result.photoId) ?? 0,
          1 / (reciprocalRankConstant + rank + 1)
        )
      );
    }
  }

  return positiveResults
    .map((result) => ({
      photoId: result.photoId,
      primarySimilarity:
        Math.round(
          Math.max(
            0,
            result.primarySimilarity -
              penaltyWeight * (negativeSimilarity.get(result.photoId) ?? 0)
          ) * 10_000
        ) / 10_000,
      rankScore:
        result.rankScore -
        penaltyWeight * (negativeRankScore.get(result.photoId) ?? 0),
      similarity:
        Math.round(
          Math.max(
            0,
            result.similarity -
              penaltyWeight * (negativeSimilarity.get(result.photoId) ?? 0)
          ) * 10_000
        ) / 10_000,
      supportingGroups: result.supportingGroups,
    }))
    .sort(
      (left, right) =>
        right.rankScore - left.rankScore ||
        right.similarity - left.similarity ||
        left.photoId - right.photoId
    )
    .slice(0, limit);
}

export interface SemanticRelevanceSelection {
  acceptedCount: number;
  canContinue: boolean;
  candidateMinimum: number;
  consensusCutoff: number;
  cutoffReason: string;
  finalCutoff: number;
  hasMoreCandidates: boolean;
  rejectedWeak: number;
  results: FusedRankedSearchResult[];
  strongAccepted: number;
  strongCutoff: number;
  supportCandidates: FusedRankedSearchResult[];
  supportCutoff: number;
  supportedAccepted: number;
  topSimilarity: number;
}

export interface SemanticRelevanceOptions {
  candidateTails?: Array<{
    evidenceGroup: SemanticEvidenceGroup;
    similarity: number;
  }>;
  intent?: SemanticQueryIntent;
  primaryScores?: number[];
  promptGroupCount?: number;
  /** 灵敏度阈值乘数（relaxed<1 / standard=1 / precise>1），作用在最终 cutoffs 上 */
  sensitivity?: number;
  /**
   * 自用（2026-10-16，**修"筛选阈值和角标不是一个刻度"**）：
   * 用户在「全部图片」顶栏拖的那条「相似度 ≥ N%」滑杆（IPC 的 `minSimilarity`）。
   *
   * 它必须是一道**硬下限**：卡片角标显示的就是这里的**原始余弦相似度**
   * （PhotoCard 里 `match.score * 100` →「语义匹配 46%」），所以滑杆拖到 40% 时，
   * 低于 40% 的图就不该再出现 ✓ —— 用户原话"筛选阈值和角标不是一个刻度"。
   *
   * 与 `sensitivity` 的区别：灵敏度是**算法档位**（宽松/标准/精确），它按比例缩放阈值；
   * 用户手动设的下限是绝对值，**不该再被灵敏度放大或缩小** ✓（见下面的 max 里不乘 s）。
   * 默认 undefined → 按 0 处理 = 完全不改变原有行为（滑杆只收紧、不会放宽）✓。
   */
  userMinSimilarity?: number;
}

export function calculateScoreGapCutoff(
  primaryScores: number[]
): number | null {
  const scores = primaryScores
    .filter(Number.isFinite)
    .slice(0, 100)
    .sort((left, right) => right - left);
  if (scores.length < 6) {
    return null;
  }
  const span = scores[0] - (scores.at(-1) ?? scores[0]);
  let largestGap = 0;
  let cutoff: number | null = null;
  for (let index = 4; index < scores.length - 1; index++) {
    const gap = scores[index] - scores[index + 1];
    if (gap > largestGap) {
      largestGap = gap;
      cutoff = (scores[index] + scores[index + 1]) / 2;
    }
  }
  return largestGap >= 0.006 && largestGap >= span * 0.12 ? cutoff : null;
}

function selectLegacySemanticResults(
  results: FusedRankedSearchResult[],
  policy: ThresholdProfile["semanticSearch"],
  promptGroupCount: number,
  limit: number,
  options: SemanticRelevanceOptions
): SemanticRelevanceSelection {
  const s = options.sensitivity ?? 1;
  const topSimilarity = Math.max(...results.map((result) => result.similarity));
  /*
   * 自用（2026-10-16，**修"筛选阈值和角标不是一个刻度"**）：
   * 把顶栏滑杆的用户下限并进 strongCutoff 的 max 里 ✓ —— 它因此成为一道硬下限：
   * 角标（原始余弦相似度 × 100）低于滑杆值的图，角标与滑杆同一刻度，直接不出现 ✓。
   * **不乘 s**：s 是算法档位系数，用户手动设的下限是绝对值，不该被它放大/缩小 ✓；
   * 默认 0 → max 结果不变 = 滑杆只收紧、绝不会放宽现状 ✓。
   */
  const strongCutoff = Math.max(
    policy.absoluteMinimumSimilarity * s,
    topSimilarity * policy.relativeToTopRatio * s,
    options.userMinSimilarity ?? 0
  );
  const consensusCutoff = Math.max(
    policy.candidateMinimumSimilarity * s,
    strongCutoff * policy.consensusThresholdRatio,
    /*
     * 自用（2026-10-16，**滑杆必须是"硬"下限**）：
     * 下面 promptGroupCount > 1 时还有一条共识放宽通道，只改 strongCutoff 会让它
     * 放进低于滑杆值的图 ✗（角标 < 滑杆 = 用户说的"不是一个刻度"）→ 这里也取 max 用户下限 ✓。
     * 默认 0 → 与改动前逐位相同 ✓。
     */
    options.userMinSimilarity ?? 0
  );
  const relevant = results.filter(
    (result) =>
      result.similarity >= strongCutoff ||
      (promptGroupCount > 1 &&
        result.supportingGroups.length >= 2 &&
        result.similarity >= consensusCutoff)
  );
  const tails = options.candidateTails ?? [];
  const strongTail = tails.some(({ similarity }) => similarity >= strongCutoff);
  const consensusTailGroups = new Set(
    tails
      .filter(({ similarity }) => similarity >= consensusCutoff)
      .map(({ evidenceGroup }) => evidenceGroup)
  );
  const canContinue =
    strongTail || (promptGroupCount > 1 && consensusTailGroups.size >= 2);
  const strongAccepted = relevant.filter(
    (result) => result.similarity >= strongCutoff
  ).length;
  return {
    acceptedCount: relevant.length,
    candidateMinimum: policy.candidateMinimumSimilarity,
    canContinue,
    consensusCutoff,
    cutoffReason: "legacy",
    finalCutoff: strongCutoff,
    hasMoreCandidates: relevant.length > limit || canContinue,
    rejectedWeak: results.length - relevant.length,
    results: relevant.slice(0, limit),
    supportCandidates: relevant.slice(0, limit),
    supportCutoff: consensusCutoff,
    strongAccepted,
    strongCutoff,
    supportedAccepted: relevant.length - strongAccepted,
    topSimilarity,
  };
}

interface IntentCutoffPolicy {
  base: number;
  ratio: number;
  supportFloor?: number;
  supportRatio?: number;
}

const INTENT_CUTOFF_POLICIES: Record<SemanticQueryIntent, IntentCutoffPolicy> =
  {
    object: { base: 0.055, ratio: 0.6 },
    composed: {
      base: 0.045,
      ratio: 0.5,
      supportFloor: 0.04,
      supportRatio: 0.9,
    },
    scene: {
      base: 0.035,
      ratio: 0.4,
      supportFloor: 0.03,
      supportRatio: 0.85,
    },
    unknown: { base: 0.05, ratio: 0.55 },
  };

function getCutoffReason(
  gapCutoff: number | null,
  base: number,
  relativeCutoff: number
): string {
  if (gapCutoff !== null && gapCutoff >= base && gapCutoff >= relativeCutoff) {
    return "score-gap";
  }
  return relativeCutoff >= base ? "relative-to-top" : "intent-floor";
}

function hasIndependentSupport(result: FusedRankedSearchResult): boolean {
  return (
    result.supportingGroups.includes("whole-query") &&
    new Set(result.supportingGroups).size >= 2
  );
}

function selectV2SemanticResults(
  results: FusedRankedSearchResult[],
  policy: ThresholdProfile["semanticSearch"],
  limit: number,
  options: SemanticRelevanceOptions
): SemanticRelevanceSelection {
  const intent = options.intent ?? "unknown";
  const cutoffPolicy = INTENT_CUTOFF_POLICIES[intent];
  const s = options.sensitivity ?? 1;
  const primaryScores = options.primaryScores?.length
    ? options.primaryScores
    : results.map((result) => result.primarySimilarity);
  const topSimilarity = Math.max(...primaryScores);
  /*
   * 自用（2026-10-16，**修"每次只搜出 1 张"**）：
   *
   * 旧写法用**外部传进来的原始候选分数**（`options.primaryScores`，最多 400 条原始召回）
   * 算"断层及格线"，却拿它去筛**融合后的结果列表** ✗ —— 两批分数不是同一批人：
   * 原始分里前 5 名都在 0.43 以上（断层落在 0.4315），
   * 但融合后的列表里可能只有 1 张 ≥ 0.4315 → **结果被砍到只剩 1 张** ✗
   * （实测日志：top=0.4348 cutoff=0.4315 accepted=1 rejectedWeak=80 ✓）。
   *
   * 现在改成**用它自己要筛的那份分数**（融合后结果的 primarySimilarity）✓，
   * 及格线与被筛对象自洽 ✓；列表太短（< 6 条）时本来也算不出有意义的断层 → 不启用 ✓。
   *
   * 另外：`gapCutoff` **以前没有乘灵敏度系数** ✗（base 与 relative 都乘了），
   * 于是把「搜索灵敏度」调成"宽松"对这条线毫无作用 ✗ —— 现在也乘上 ✓。
   */
  const gapCutoff =
    intent === "object" || intent === "unknown"
      ? calculateScoreGapCutoff(results.map((result) => result.primarySimilarity))
      : null;
  const relativeCutoff = topSimilarity * cutoffPolicy.ratio * s;
  const scaledGapCutoff = (gapCutoff ?? 0) * s;
  /*
   * 自用（2026-10-16，**修"筛选阈值和角标不是一个刻度"**）：
   * 顶栏「相似度 ≥ N%」滑杆收在这里 —— 用户下限是**第四项**，与其他三项取 max = 硬下限：
   * 卡片角标显示的就是这份原始余弦相似度（PhotoCard: `match.score * 100`），
   * 所以滑杆拖到 40% 时，primarySimilarity < 40% 的图不会再进 results ✓
   * —— 这正是用户说的"筛选阈值和角标不是一个刻度"要的效果 ✓。
   *
   * 逐项说明：base 是意图地板、relative 是相对 top 的比例、gap 是分数断层，
   * 三者都会被灵敏度 s 缩放；**用户下限不乘 s** ✓（绝对阈值不该被档位改动）。
   * 默认 0 → max 结果与改动前逐位相同 = 只收紧、不放宽 ✓。
   */
  const strongCutoff = Math.max(
    cutoffPolicy.base * s,
    relativeCutoff,
    scaledGapCutoff,
    options.userMinSimilarity ?? 0
  );
  const supportsRelaxation =
    cutoffPolicy.supportFloor !== undefined &&
    cutoffPolicy.supportRatio !== undefined;
  const supportFloorScaled =
    cutoffPolicy.supportFloor === undefined
      ? strongCutoff
      : cutoffPolicy.supportFloor * s;
  /*
   * 自用（2026-10-16，**滑杆必须是"硬"下限**）：
   * 上面那条 strongCutoff 只是**主通道**；composed / scene 意图还有一条**放宽通道**
   * （`hasIndependentSupport` 的共识线 consensusCutoff = strongCutoff × 0.85/0.9）。
   * 只改 strongCutoff 的话，滑杆 40% 时这条通道仍会放进 34%~36% 的图 ✗
   * —— 角标还是低于滑杆值，用户看到的就是"阈值和角标不是一个刻度" ✗。
   * 所以共识线也取 max(用户下限)：用户手动设的下限对所有**语义**入选项都成立 ✓；
   * 默认 0 → 与改动前逐位相同 ✓。
   */
  const consensusCutoff = supportsRelaxation
    ? Math.max(
        supportFloorScaled,
        strongCutoff * (cutoffPolicy.supportRatio ?? 1),
        options.userMinSimilarity ?? 0
      )
    : strongCutoff;
  const supportCutoff =
    intent === "object" || intent === "unknown"
      ? Math.max(0.045 * s, strongCutoff * 0.85)
      : consensusCutoff;
  const relevant = results.filter(
    (result) =>
      result.primarySimilarity >= strongCutoff ||
      (supportsRelaxation &&
        result.primarySimilarity >= consensusCutoff &&
        hasIndependentSupport(result))
  );
  const strongAccepted = relevant.filter(
    (result) => result.primarySimilarity >= strongCutoff
  ).length;
  const tails = options.candidateTails ?? [];
  const primaryTail =
    tails.find(({ evidenceGroup }) => evidenceGroup === "whole-query")
      ?.similarity ?? 0;
  const supportedTailGroups = new Set(
    tails
      .filter(({ similarity }) => similarity >= consensusCutoff)
      .map(({ evidenceGroup }) => evidenceGroup)
  );
  const canContinue =
    primaryTail >= supportCutoff ||
    (supportsRelaxation &&
      primaryTail >= consensusCutoff &&
      supportedTailGroups.size >= 2);

  return {
    acceptedCount: relevant.length,
    candidateMinimum: policy.candidateMinimumSimilarity,
    canContinue,
    consensusCutoff,
    cutoffReason: getCutoffReason(
      gapCutoff === null ? null : scaledGapCutoff,
      cutoffPolicy.base * s,
      relativeCutoff
    ),
    finalCutoff: strongCutoff,
    hasMoreCandidates: relevant.length > limit || canContinue,
    rejectedWeak: results.length - relevant.length,
    results: relevant.slice(0, limit),
    supportCandidates: results
      .filter((result) => result.primarySimilarity >= supportCutoff)
      .slice(0, limit),
    supportCutoff,
    strongAccepted,
    strongCutoff,
    supportedAccepted: relevant.length - strongAccepted,
    topSimilarity,
  };
}

export function selectRelevantSemanticResults(
  results: FusedRankedSearchResult[],
  _model: EmbeddingModelConfig,
  promptGroupCount: number,
  limit: number,
  options: SemanticRelevanceOptions = {}
): SemanticRelevanceSelection {
  const policy = getActiveThresholdProfile().semanticSearch;
  if (results.length === 0) {
    return {
      acceptedCount: results.length,
      candidateMinimum: Number.NEGATIVE_INFINITY,
      canContinue: false,
      cutoffReason: "model-without-policy",
      consensusCutoff: Number.NEGATIVE_INFINITY,
      finalCutoff: Number.NEGATIVE_INFINITY,
      hasMoreCandidates: results.length > limit,
      rejectedWeak: 0,
      results: results.slice(0, limit),
      supportCandidates: results.slice(0, limit),
      supportCutoff: 0,
      strongAccepted: results.length,
      strongCutoff: Number.NEGATIVE_INFINITY,
      supportedAccepted: 0,
      topSimilarity: results[0]?.similarity ?? 0,
    };
  }

  if (getActiveThresholdProfile().calibrationStatus === "uncalibrated") {
    return {
      acceptedCount: results.length,
      candidateMinimum: Number.NEGATIVE_INFINITY,
      canContinue: false,
      consensusCutoff: Number.NEGATIVE_INFINITY,
      cutoffReason: "uncalibrated",
      finalCutoff: Number.NEGATIVE_INFINITY,
      hasMoreCandidates: false,
      rejectedWeak: 0,
      results: results.slice(0, limit),
      supportCandidates: results.slice(0, limit),
      supportCutoff: Number.NEGATIVE_INFINITY,
      strongAccepted: 0,
      strongCutoff: Number.NEGATIVE_INFINITY,
      supportedAccepted: 0,
      topSimilarity: Math.max(...results.map((result) => result.similarity)),
    };
  }

  if (getSemanticPolicyVersion() === "legacy") {
    return selectLegacySemanticResults(
      results,
      policy,
      promptGroupCount,
      limit,
      options
    );
  }
  return selectV2SemanticResults(results, policy, limit, options);
}
