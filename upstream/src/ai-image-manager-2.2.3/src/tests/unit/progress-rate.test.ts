import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import {
  computeProgressRate,
  formatProgressRemaining,
  formatProgressSpeed,
  PROGRESS_RATE_STALE_MS,
  PROGRESS_RATE_WINDOW_MS,
} from "@/hooks/use-progress-rate";

/** 与测试环境里的 react-i18next mock 同样规则的极简 t（带插值）。 */
const DICT: Record<string, string> = {
  aiProgressSpeed: "{{value}} 张/秒",
  aiProgressEta: "剩余约 {{time}}",
  aiProgressTimeSeconds: "{{seconds}} 秒",
  aiProgressTimeMinutes: "{{minutes}} 分 {{seconds}} 秒",
  aiProgressTimeHours: "{{hours}} 小时 {{minutes}} 分",
};
const t = ((key: string, options?: Record<string, unknown>) => {
  const template = DICT[key] ?? key;
  if (!options) {
    return template;
  }
  return Object.entries(options).reduce(
    (text, [name, value]) =>
      text.replace(new RegExp(`{{${name}}}`, "g"), String(value)),
    template
  );
}) as unknown as TFunction;

describe("computeProgressRate (自用需求 7)", () => {
  it("returns nothing without enough samples or without a total", () => {
    expect(computeProgressRate([], 100, 1000)).toEqual({
      perSecond: null,
      remainingSeconds: null,
    });
    expect(computeProgressRate([{ at: 0, processed: 1 }], 100, 1000)).toEqual({
      perSecond: null,
      remainingSeconds: null,
    });
    expect(
      computeProgressRate(
        [
          { at: 0, processed: 0 },
          { at: 1000, processed: 5 },
        ],
        0,
        1000
      )
    ).toEqual({ perSecond: null, remainingSeconds: null });
  });

  it("computes speed and remaining time from the newest samples", () => {
    // 10 秒推进 20 张 → 2 张/秒；总 100、已完成 20 → 还剩 40 秒
    const rate = computeProgressRate(
      [
        { at: 0, processed: 0 },
        { at: 10_000, processed: 20 },
      ],
      100,
      10_000
    );
    expect(rate.perSecond).toBeCloseTo(2, 5);
    expect(rate.remainingSeconds).toBeCloseTo(40, 5);
  });

  it("ignores samples older than the sampling window", () => {
    // 25 秒前那条已在窗口外 → 只用 26 秒到 26.5 秒之间的增量（2 张 / 500ms = 4 张/秒）
    const rate = computeProgressRate(
      [
        { at: 0, processed: 0 },
        { at: PROGRESS_RATE_WINDOW_MS + 5_000, processed: 50 },
        { at: PROGRESS_RATE_WINDOW_MS + 5_500, processed: 52 },
      ],
      100,
      PROGRESS_RATE_WINDOW_MS + 5_500
    );
    expect(rate.perSecond).toBeCloseTo(4, 5);
    expect(rate.remainingSeconds).toBeCloseTo(12, 5);
  });

  it("shows no estimate when progress stalls", () => {
    // 最后一条样本已过去超过阈值 → 不显示"还剩很久"，交给界面显示"估算中"
    const rate = computeProgressRate(
      [
        { at: 0, processed: 0 },
        { at: 1_000, processed: 5 },
      ],
      100,
      1_000 + PROGRESS_RATE_STALE_MS + 1
    );
    expect(rate).toEqual({ perSecond: null, remainingSeconds: null });
  });

  it("shows no estimate when nothing advanced", () => {
    expect(
      computeProgressRate(
        [
          { at: 0, processed: 7 },
          { at: 1_000, processed: 7 },
        ],
        100,
        1_000
      )
    ).toEqual({ perSecond: null, remainingSeconds: null });
  });
});

describe("进度文本格式化 (自用需求 7)", () => {
  it("formats the speed with one decimal below 10 per second", () => {
    expect(formatProgressSpeed(t, 2.34)).toBe("2.3 张/秒");
    expect(formatProgressSpeed(t, 12.6)).toBe("13 张/秒");
  });

  it("formats the remaining time by magnitude", () => {
    expect(formatProgressRemaining(t, 9.4)).toBe("剩余约 9 秒");
    expect(formatProgressRemaining(t, 80)).toBe("剩余约 1 分 20 秒");
    expect(formatProgressRemaining(t, 3720)).toBe("剩余约 1 小时 2 分");
  });
});
