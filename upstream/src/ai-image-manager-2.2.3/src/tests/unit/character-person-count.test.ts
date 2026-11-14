/**
 * 「一张图几个人」的判定口径 + 多人/单人分流（2026-11-14 · 会话#12 新增）。
 *
 * 重点守住用户拍板的第 15 条口径（`开发须知.md` §五）：
 *   **`1girl` + `1boy` 必须算 2 人** —— 库里 10,940 张，按"有单人标签就是单人"会全漏。
 */
import { describe, expect, it } from "vitest";

import {
  groupPhotoIdsByCounts,
  resolvePersonCount,
} from "@/services/character-person-count";

describe("resolvePersonCount", () => {
  it("单人标签各算 1 人", () => {
    expect(resolvePersonCount(["1girl"])).toBe(1);
    expect(resolvePersonCount(["1boy"])).toBe(1);
    expect(resolvePersonCount(["1other"])).toBe(1);
  });

  it("1girl + 1boy 必须算 2 人（用户口径 §五-15）", () => {
    expect(resolvePersonCount(["1girl", "1boy"])).toBe(2);
  });

  it("人数标签按标签数字算", () => {
    expect(resolvePersonCount(["2girls"])).toBe(2);
    expect(resolvePersonCount(["3girls"])).toBe(3);
    expect(resolvePersonCount(["6+girls"])).toBe(6);
    expect(resolvePersonCount(["2boys"])).toBe(2);
  });

  it("multiple_* 只知道多个 → 按 2 算", () => {
    expect(resolvePersonCount(["multiple_girls"])).toBe(2);
    expect(resolvePersonCount(["multiple_boys"])).toBe(2);
    expect(resolvePersonCount(["multiple_others"])).toBe(2);
  });

  it("同一类别重复标签取最大值，不相加（否则 2girls+multiple_girls 会算成 4）", () => {
    expect(resolvePersonCount(["2girls", "multiple_girls"])).toBe(2);
    expect(resolvePersonCount(["2girls", "1girl"])).toBe(2);
  });

  it("不同类别相加", () => {
    expect(resolvePersonCount(["2girls", "2boys"])).toBe(4);
    expect(resolvePersonCount(["1girl", "1boy", "1other"])).toBe(3);
  });

  it("只有 solo → 1 人", () => {
    expect(resolvePersonCount(["solo"])).toBe(1);
  });

  it("没有人数标签 → 0（未知，调用方按单人保守处理）", () => {
    expect(resolvePersonCount([])).toBe(0);
    expect(resolvePersonCount(["long_hair", "smile"])).toBe(0);
  });

  it("大小写与空格不影响判定", () => {
    expect(resolvePersonCount([" 1Girl ", "1BOY"])).toBe(2);
  });
});

describe("groupPhotoIdsByCounts", () => {
  it("按人数分流，并保持原有顺序", () => {
    const counts = new Map([
      [11, 2],
      [12, 1],
      [13, 0],
      [14, 3],
    ]);
    const split = groupPhotoIdsByCounts([11, 12, 13, 14], counts);
    expect(split.multi).toEqual([11, 14]);
    expect(split.single).toEqual([12, 13]);
    expect(split.unknown).toBe(1);
    expect(split.maxPersonCount).toBe(3);
  });

  it("全是单人时 maxPersonCount 至少为 1（界面上限不会是 0）", () => {
    const split = groupPhotoIdsByCounts([1, 2], new Map([[1, 1], [2, 1]]));
    expect(split.multi).toEqual([]);
    expect(split.maxPersonCount).toBe(1);
  });

  it("人数未知按单人处理（宁可不写第二个名字，也不乱写）", () => {
    const split = groupPhotoIdsByCounts([7], new Map());
    expect(split.single).toEqual([7]);
    expect(split.unknown).toBe(1);
  });
});
