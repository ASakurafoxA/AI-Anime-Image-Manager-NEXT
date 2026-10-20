import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoGrid } from "@/components/PhotoGrid";
import type { Photo } from "@/types/photo";

/*
 * 自用（2026-10-16，用户反馈 ✓）：「全部图片」搜索之后，**搜索结果挤成一列、图片很窄** ✗。
 * 用户原话：「他现在展示是这样的一列下来，改成像主界面一样平铺在界面」✓。
 *
 * 这条用例盯住的就是那个复现条件 ✓：
 *   搜索结果按**相似度**排序 → 相邻照片的月份几乎总不同 → 几乎每张照片自带一个分组标题；
 *   旧代码在「各列被分组标题拉平」之后永远选第 0 列 ✗ → 所有卡片左偏移都是 0（一列到底 ✗）。
 * 这里给容器一个正常宽度（1200px → 5 列 ✓），渲染跨月的搜索结果，
 * 断言**至少出现两个不同的左偏移**（= 真的铺成了多列 ✓）。
 *
 * 注意：不能 mock `@/components/MasonryGrid`（那样就测不到列分配了 ✗），
 * 所以这里连真实的瀑布流一起渲染 ✓；jsdom 没有布局引擎，
 * `clientWidth/clientHeight` 由下面的桩给出 ✓。
 */

vi.mock("@/components/PhotoCard", () => ({
  PhotoCard: ({ id }: { id: number }) => <div data-grid-card={id} />,
}));

vi.mock("@/components/RecentlyViewedBadge", () => ({
  RecentlyViewedBadge: () => null,
}));

// 真实 MasonryGrid 会用到 TanStack Router 的 useLocation，单测里没有 Router ✓。
vi.mock("@/hooks/useRouteScrollRestoration", () => ({
  useRouteScrollRestoration: () => ({
    forceUnlock: () => undefined,
    hasInitialPositionedRef: { current: true },
    initialScrollTop: 0,
  }),
}));

const CONTAINER_WIDTH = 1200;

/** 跨 12 个月各一张：模拟“搜索结果按相似度排序”导致的月份跳变 ✓。 */
const scatteredPhotos = Array.from({ length: 12 }, (_, index) => {
  const id = index + 1;
  return {
    dominantColors: null,
    fileDate: new Date(2025, index, 10).getTime(),
    filename: `${id}.jpg`,
    fileSize: 1000,
    height: 800,
    id,
    isIndexed: true,
    path: `C:/fixture/${id}.jpg`,
    thumbnailPath: null,
    width: 1200,
  } as unknown as Photo;
});

const props = {
  loading: false,
  onContextMenu: vi.fn(),
  onDoubleClick: vi.fn(),
  onSelect: vi.fn(),
  routeKey: "search-multi-column",
  searchQuery: "海边日落",
  selectedIds: new Set<number>(),
};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect() {
        return undefined;
      }
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
    }
  );
  // jsdom 没有布局引擎：给容器一个正常宽度/高度 ✓。
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => CONTAINER_WIDTH,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 800,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("photo grid search results", () => {
  it("lays search results out in multiple columns instead of one narrow column", () => {
    render(
      <PhotoGrid
        {...props}
        columnWidth={220}
        photos={scatteredPhotos}
        // 「设置 → 外观 → 图片按时间分组」打开时的形态 ✓
        showGroupHeaders
      />
    );

    const columns = Array.from(
      document.querySelectorAll<HTMLElement>("[data-grid-card]")
    ).map((card) => (card.parentElement as HTMLElement).style.left);

    expect(columns.length).toBeGreaterThan(1);
    // 旧代码这里全是 "0px"（一列到底 ✗）；修好后至少铺到 2 列 ✓。
    expect(new Set(columns).size).toBeGreaterThan(1);
  });

  it("keeps search results multi-column with date grouping turned off", () => {
    render(
      <PhotoGrid
        {...props}
        columnWidth={220}
        photos={scatteredPhotos}
        showGroupHeaders={false}
      />
    );

    const columns = Array.from(
      document.querySelectorAll<HTMLElement>("[data-grid-card]")
    ).map((card) => (card.parentElement as HTMLElement).style.left);

    expect(new Set(columns).size).toBeGreaterThan(1);
  });
});
