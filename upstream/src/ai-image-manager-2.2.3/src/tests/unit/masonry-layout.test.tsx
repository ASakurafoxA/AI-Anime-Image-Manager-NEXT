import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type GroupHeaderInput,
  type MasonryLayoutInput,
  useMasonryLayout,
} from "@/hooks/useMasonryLayout";

interface HookProps {
  headers?: GroupHeaderInput[];
  items: MasonryLayoutInput[];
  layoutKey: string;
  showGroupHeaders?: boolean;
}

function renderLayout(initialProps: HookProps) {
  return renderHook(
    ({ headers, items, layoutKey, showGroupHeaders }: HookProps) =>
      useMasonryLayout(items, 208, 2, 8, headers, layoutKey, showGroupHeaders),
    { initialProps }
  );
}

const baseItems: MasonryLayoutInput[] = [
  { height: 100, id: 1, width: 100 },
  { height: 100, id: 2, width: 200 },
];

describe("useMasonryLayout cache safety", () => {
  it("recomputes when a larger list has the same first id but a different prefix", () => {
    const { result, rerender } = renderLayout({
      items: baseItems,
      layoutKey: "folder-1",
    });
    expect(result.current.positions[1].height).toBe(50);

    rerender({
      items: [
        baseItems[0],
        { height: 200, id: 3, width: 100 },
        { height: 100, id: 4, width: 100 },
      ],
      layoutKey: "folder-1",
    });

    expect(result.current.positions[1].height).toBeCloseTo(100 / 0.6);
    expect(result.current.positions).toHaveLength(3);
    expect(result.current.visibilityIndex).toHaveLength(3);
  });

  it("recomputes when an existing item's dimensions change during append", () => {
    const { result, rerender } = renderLayout({
      items: baseItems,
      layoutKey: "all",
    });
    expect(result.current.positions[0].height).toBe(100);

    rerender({
      items: [
        { height: 200, id: 1, width: 100 },
        baseItems[1],
        { height: 100, id: 3, width: 100 },
      ],
      layoutKey: "all",
    });

    expect(result.current.positions[0].height).toBeCloseTo(100 / 0.6);
  });

  it("does not reuse cached positions after the layout key changes", () => {
    const { result, rerender } = renderLayout({
      items: baseItems,
      layoutKey: "folder-1",
    });
    result.current.positions[0].top = 999;

    rerender({
      items: [...baseItems, { height: 100, id: 3, width: 100 }],
      layoutKey: "all",
    });

    expect(result.current.positions[0].top).toBe(0);
  });

  it("preserves cached positions for a genuine tail append", () => {
    const { result, rerender } = renderLayout({
      items: baseItems,
      layoutKey: "all",
    });
    const firstPosition = result.current.positions[0];

    rerender({
      items: [...baseItems, { height: 100, id: 3, width: 100 }],
      layoutKey: "all",
    });

    expect(result.current.positions[0]).toBe(firstPosition);
    expect(result.current.positions[2].top).toBe(58);
    expect(result.current.positions).toHaveLength(3);
    expect(result.current.visibilityIndex).toHaveLength(3);
  });

  it("inserts an appended group header using its global item index", () => {
    const { result, rerender } = renderLayout({
      headers: [{ beforeIndex: 0, label: "January" }],
      items: baseItems,
      layoutKey: "all",
    });

    rerender({
      headers: [
        { beforeIndex: 0, label: "January" },
        { beforeIndex: 2, label: "February" },
      ],
      items: [...baseItems, { height: 100, id: 3, width: 100 }],
      layoutKey: "all",
    });

    expect(result.current.headerPositions).toEqual([
      { label: "January", top: 0 },
      { label: "February", top: 152 },
    ]);
    expect(result.current.positions[2].top).toBe(196);
    expect(result.current.positions).toHaveLength(3);
    expect(result.current.visibilityIndex).toHaveLength(3);
  });

  /*
   * 自用（2026-10-16，**意图变更** ✓ —— 用户要求"搜索结果要像主界面一样平铺" ✓）：
   *
   * 紧凑模式（`showGroupHeaders=false`，标题不画 ✗）**不再**把各列强行对齐到同一高度 ✗→✓。
   * 原因：搜索结果是按**相似度**排的 ✓ → 几乎每张照片各自构成一个"月份分组" ✓ →
   * 每个边界都对齐会把照片推到上一批下面 ✗；更早的版本更糟：各列被拉平后，
   * "谁最短谁接"那行比较在各列相等时永远命中第 0 列 ✗ → **全部挤成一列** ✗（用户截图 ✓）。
   * 现在紧凑模式直接走普通瀑布流 ✓ → 第 3 张贴着最短的列排（top 由 108 变为 **58** ✓）。
   * 分组标题的位置（`headerPositions`）**不受影响** ✓ —— 仍记在当时的最高点上 ✓。
   */
  it("keeps compact group boundaries while retaining date marker positions", () => {
    const { result } = renderLayout({
      headers: [
        { beforeIndex: 0, label: "January" },
        { beforeIndex: 2, label: "February" },
      ],
      items: [...baseItems, { height: 100, id: 3, width: 100 }],
      layoutKey: "compact",
      showGroupHeaders: false,
    });

    expect(result.current.headerPositions).toEqual([
      { label: "January", top: 0 },
      { label: "February", top: 108 },
    ]);
    expect(result.current.positions[0].top).toBe(0);
    // 同上：紧凑模式下不再为分组边界留出对齐高度 ✓（108 → 58 ✓）
    expect(result.current.positions[2].top).toBe(58);
  });

  it("recomputes appended positions when group header spacing mode changes", () => {
    const { result, rerender } = renderLayout({
      headers: [{ beforeIndex: 0, label: "January" }],
      items: baseItems,
      layoutKey: "compact-toggle",
      showGroupHeaders: true,
    });

    rerender({
      headers: [
        { beforeIndex: 0, label: "January" },
        { beforeIndex: 2, label: "February" },
      ],
      items: [...baseItems, { height: 100, id: 3, width: 100 }],
      layoutKey: "compact-toggle",
      showGroupHeaders: false,
    });

    expect(result.current.positions[0].top).toBe(0);
    // 切到紧凑模式后重算的位置 ✓（同样不再被分组边界下推：108 → 58 ✓）
    expect(result.current.positions[2].top).toBe(58);
  });
});
