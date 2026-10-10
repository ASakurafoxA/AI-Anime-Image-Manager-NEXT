import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRateMeter } from "@/services/rate-meter";

/**
 * 自用（多卡）：界面上的"每张卡实时速度"用的速率计。
 *
 * 关键性质：
 *  · 用**最近一个窗口**的增量算，而不是累计平均 —— 否则拖了占用限制也看不出变化；
 *  · 样本跨度不足 1 秒时返回 0（避免"刚跑两张就显示 500 张/秒"这种假数字）；
 *  · 窗口外的旧样本会被丢掉（速度能回落，而不是只升不降）。
 */
describe("createRateMeter（每张卡实时速度）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("没有数据时返回 0", () => {
    const meter = createRateMeter(4000);
    expect(meter.perSecond()).toBe(0);
  });

  it("样本跨度不足 1 秒时先不给数字（避免虚高）", () => {
    const meter = createRateMeter(4000);
    meter.add(10);
    vi.advanceTimersByTime(300);
    expect(meter.perSecond()).toBe(0);
  });

  it("按窗口内增量算出张/秒", () => {
    const meter = createRateMeter(4000);
    // 4 秒内完成 40 张 → 10 张/秒
    for (let i = 0; i < 4; i++) {
      meter.add(10);
      vi.advanceTimersByTime(1000);
    }
    expect(meter.perSecond()).toBeCloseTo(10, 0);
  });

  it("速度能回落（窗口外的旧样本被丢掉）", () => {
    const meter = createRateMeter(4000);
    for (let i = 0; i < 4; i++) {
      meter.add(10);
      vi.advanceTimersByTime(1000);
    }
    const fast = meter.perSecond();
    // 之后 6 秒只完成 6 张 → 速度应明显下降
    for (let i = 0; i < 6; i++) {
      meter.add(1);
      vi.advanceTimersByTime(1000);
    }
    const slow = meter.perSecond();
    expect(slow).toBeLessThan(fast);
  });

  it("reset 之后回到 0", () => {
    const meter = createRateMeter(4000);
    for (let i = 0; i < 4; i++) {
      meter.add(10);
      vi.advanceTimersByTime(1000);
    }
    expect(meter.perSecond()).toBeGreaterThan(0);
    meter.reset();
    expect(meter.perSecond()).toBe(0);
  });

  it("忽略非法数量（0 / 负数 / NaN）", () => {
    const meter = createRateMeter(4000);
    meter.add(0);
    meter.add(-5);
    meter.add(Number.NaN);
    expect(meter.windowTotal()).toBe(0);
  });
});
