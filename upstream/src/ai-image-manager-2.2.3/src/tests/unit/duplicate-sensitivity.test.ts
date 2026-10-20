import { describe, expect, it } from "vitest";
import { getDuplicateSensitivityConfig } from "@/services/duplicate-sensitivity";

describe("default duplicate detection strategy", () => {
  it("always runs the strict threshold, regardless of legacy preferences", () => {
    // 自用：改成严格档（4）—— 实测阈值 4 只要 2.2 秒且零误报，
    // 阈值 8 要 297 秒（见 duplicate-sensitivity.ts 的说明）。
    for (const value of [null, "strict", "standard", "loose", "unknown"]) {
      expect(getDuplicateSensitivityConfig(value)).toEqual({
        preset: "strict",
        phashThreshold: 4,
        embeddingThreshold: 0.95,
        version: "duplicate-thresholds-v2",
      });
    }
  });
});
