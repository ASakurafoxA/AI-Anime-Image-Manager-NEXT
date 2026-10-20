export const DUPLICATE_SENSITIVITY_PRESETS = [
  "strict",
  "standard",
  "loose",
] as const;

export type DuplicateSensitivity =
  (typeof DUPLICATE_SENSITIVITY_PRESETS)[number];

export interface DuplicateSensitivityConfig {
  embeddingThreshold: number;
  phashThreshold: number;
  preset: DuplicateSensitivity;
  version: string;
}

const CONFIGS: Record<DuplicateSensitivity, DuplicateSensitivityConfig> = {
  strict: {
    // ⚠️ 这里刻意用 0.95 而不是 0.98。实测（2,297 张真实样本）：
    // 指纹判定为「真重复」的图对，语义相似度中位 0.988，但**最低只有 0.844**，
    // 用 0.98 卡会丢掉约 10~20% 的真重复。
    // 另外指纹距离 <= phashThreshold 的配对在 Phase 2 里已直接确认，
    // 不再受这个阈值约束（见 stats.ts），它只用于更宽的候选。
    embeddingThreshold: 0.95,
    phashThreshold: 4,
    preset: "strict",
    version: "duplicate-thresholds-v1",
  },
  standard: {
    embeddingThreshold: 0.95,
    phashThreshold: 8,
    preset: "standard",
    version: "duplicate-thresholds-v1",
  },
  loose: {
    embeddingThreshold: 0.92,
    phashThreshold: 12,
    preset: "loose",
    version: "duplicate-thresholds-v1",
  },
};

export function parseDuplicateSensitivity(
  value: string | null
): DuplicateSensitivity {
  return value && value in CONFIGS
    ? (value as DuplicateSensitivity)
    : "standard";
}

/**
 * 查重一律用**严格档**（phashThreshold 4）。
 *
 * 自用（2026-10）改成 strict 的实测依据（77,296 张真实库）：
 *   · 严格档 阈值 4：23,201 个候选对，**2.2 秒**
 *   · 标准档 阈值 8：34,931 个候选对，**297 秒**（候选组合爆炸式增长）
 *   · 1,400 次真实查询里，阈值 4 **没有带出任何无关图**
 * 而放宽到 8 既慢、又多噪声，且真正「裁过的图」（指纹距离 12~16）它同样
 * 抓不到 —— 那一类要靠以图搜图的语义检索兜底，不是靠放宽指纹阈值。
 *
 * 界面上的灵敏度选择器已被移除，这里的返回值就是唯一生效的配置。
 */
export function getDuplicateSensitivityConfig(
  _value: string | null
): DuplicateSensitivityConfig {
  return { ...CONFIGS.strict, version: "duplicate-thresholds-v2" };
}
