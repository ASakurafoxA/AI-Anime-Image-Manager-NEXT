import { useMemo, useRef } from "react";
import { recordGalleryPerf } from "@/utils/gallery-perf";
import { buildMasonryVisibilityIndex } from "@/utils/masonry-utils";

export interface MasonryItem {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface HeaderPosition {
  label: string;
  top: number;
}

export interface MasonryLayout {
  headerPositions: HeaderPosition[];
  positions: MasonryItem[];
  totalHeight: number;
  visibilityIndex: number[];
}

export interface GroupHeaderInput {
  beforeIndex: number;
  label: string;
}

export interface MasonryLayoutInput {
  fullWidth?: boolean;
  height: number;
  id: number;
  width: number;
}

interface MasonryLayoutInputSnapshot {
  fullWidth?: boolean;
  height: number;
  id: number;
  width: number;
}

interface MasonryLayoutCache {
  columnCount: number;
  columnHeights: number[];
  colWidth: number;
  groupHeaders: GroupHeaderInput[];
  headerPositions: HeaderPosition[];
  inputSnapshot: MasonryLayoutInputSnapshot[];
  itemCount: number;
  layoutKey: string;
  /**
   * 自用：续页（`canReuse`）是从半途接着排的 —— 「层内轮转」的进度必须一起带过去 ✓，
   * 否则续页那一段又会从第 0 列重新开始 ✗（详见 computeLayout 上方的长注释 ✓）。
   */
  levelFlattened: boolean;
  levelPick: number;
  levelTop: number | null;
  positions: MasonryItem[];
  showGroupHeaders: boolean;
  visibilityIndex: number[];
}

function snapshotLayoutInputs(
  items: MasonryLayoutInput[]
): MasonryLayoutInputSnapshot[] {
  return items.map(({ fullWidth, height, id, width }) => ({
    fullWidth,
    height,
    id,
    width,
  }));
}

function hasMatchingLayoutPrefix(
  snapshot: MasonryLayoutInputSnapshot[],
  items: MasonryLayoutInput[]
): boolean {
  if (snapshot.length > items.length) {
    return false;
  }
  for (let i = 0; i < snapshot.length; i++) {
    const previous = snapshot[i];
    const current = items[i];
    if (
      previous.id !== current.id ||
      previous.fullWidth !== current.fullWidth ||
      previous.width !== current.width ||
      previous.height !== current.height
    ) {
      return false;
    }
  }
  return true;
}

function hasMatchingHeaderPrefix(
  previousHeaders: GroupHeaderInput[],
  currentHeaders: GroupHeaderInput[] | undefined,
  itemCount: number
): boolean {
  const currentPrefix = (currentHeaders ?? []).filter(
    (header) => header.beforeIndex < itemCount
  );
  if (previousHeaders.length !== currentPrefix.length) {
    return false;
  }
  return previousHeaders.every(
    (header, index) =>
      header.beforeIndex === currentPrefix[index].beforeIndex &&
      header.label === currentPrefix[index].label
  );
}

/*
 * 自用（2026-10-16，用户反馈 ✓）：「全部图片」搜索之后，**结果挤成一列、图片很窄** ✗。
 * 用户原话：「他现在展示是这样的一列下来，改成像主界面一样平铺在界面」✓。
 *
 * 真因不在列数（列数下限本来就是 2 ✗），而在**分组标题把照片全塞进第 0 列** ✗：
 *   ① 搜索结果是**按相似度**排序的（`ipc/photos/handlers/search.ts` 里
 *      `combined.sort(...)`），相邻两张的拍摄月份几乎总不同 ✗；
 *      而主图库按要求是**按日期**排序的，同一个月的照片连成一片 ✓。
 *   ② `buildPhotoGroupHeaders` 一遇到「月份变化」就插一个标题 → 搜索结果里
 *      **几乎每张照片自带一个分组标题** ✗
 *      （实测：12 张跨月照片 → 12 个标题；12 张同月 → 1 个标题 ✓）。
 *   ③ 分组边界会把**各列拉到同一高度**（`columnHeights.fill(newBase)` ✓，
 *      标题要横盖整行，这一步本身是对的 ✓）；但紧接着选列用的是
 *      「谁比第 0 列更矮」（`columnHeights[column] < columnHeights[shortestColumn]`，
 *      **相等不成立** ✗）→ 各列等高时**永远返回第 0 列** ✗；
 *      放下第一张后，下一个分组标题又把它拉平、又回到第 0 列……
 *      **一整列到底** ✗。实测（jsdom，容器 1200px → 5 列）：12 张 230px 宽的卡片
 *      左偏移全是 `0px`，竖着排成一条 —— 正是用户截图里那副"一列、很窄、挤在左边" ✗。
 * 所以「搜索（相似度序 → 一堆标题）塌成一列」而「主图库（日期序 → 少数标题）正常平铺」✓。
 *
 * 修法：**只改“落到哪一列”**，列数 / 列宽 / 分组标题的语义全都不动 ✓。
 *   ① 分组边界照旧把各列对齐到同一高度（标题横盖整行 ✓）；
 *   ② 但各列**等高**时不再一律选第 0 列：用「层内轮转」挑列 ✓——
 *      这一层上一次放到第 N 列，下一次就放到第 N+1 列 ✓，
 *      于是每个分组标题的照片会依次铺到第 1、2、3…列，不再叠成一列 ✓；
 *   ③ 判断“等高”只看**当前最短的那一档**（带 0.5px 容差 ✓）：
 *      同一分组里后续照片会自然落到更高的列上，于是走原来的“谁最短谁接” ✓——
 *      分组内的多张照片行为、以及主图库的观感都保持不变 ✓。
 */
/** Core masonry calculation. `groupHeaders` always use global item indexes. */
function computeLayout(
  items: Array<{ fullWidth?: boolean; width: number; height: number }>,
  colWidth: number,
  columnCount: number,
  gap: number,
  groupHeaders: GroupHeaderInput[] | undefined,
  startIndex: number,
  showGroupHeaders: boolean,
  initialColumnHeights?: number[],
  existingHeaders?: HeaderPosition[],
  existingVisibilityIndex?: number[],
  levelResume: {
    levelFlattened: boolean;
    levelPick: number;
    levelTop: number | null;
  } = { levelFlattened: false, levelPick: 0, levelTop: null }
): {
  positions: MasonryItem[];
  columnHeights: number[];
  headerPositions: HeaderPosition[];
  visibilityIndex: number[];
  levelFlattened: boolean;
  levelPick: number;
  levelTop: number | null;
} {
  const headerHeight = 36;
  const positions: MasonryItem[] = [];
  const columnHeights = initialColumnHeights
    ? [...initialColumnHeights]
    : new Array(columnCount).fill(0);
  const headerPositions: HeaderPosition[] = [];
  const headerMap = new Map(
    (groupHeaders ?? []).map((header) => [header.beforeIndex, header.label])
  );
  // 自用：分组边界把各列对齐出来的那个高度叫“一层”✓；
  // 同一层里按列轮转放 ✓ —— 多如牛毛的分组标题就是这么被摊到各列的 ✓。
  // `levelTop === null` 表示这一层已经排满（每列都在这一高度放过一张 ✓）。
  let levelTop: number | null = levelResume.levelTop;
  let levelPick = levelResume.levelPick;
  // 自用：本层是否有列真的被“对齐”过 —— 只有对齐过才需要轮转 ✓。
  //（没有分组标题时首屏各列本来都是 0，那不是“层”，不能轮转 ✓。）
  let levelFlattened = levelResume.levelFlattened;

  for (let i = 0; i < items.length; i++) {
    const globalIndex = startIndex + i;
    const headerLabel = headerMap.get(globalIndex);
    if (headerLabel !== undefined) {
      const maxHeight = Math.max(...columnHeights);
      headerPositions.push({ label: headerLabel, top: maxHeight });
      if (showGroupHeaders) {
        /*
         * 自用（2026-10-16，**修"搜索结果向右下走成台阶"** ✗→✓）：
         *
         * 只有**真的会画出月份标题**时，才需要"把各列拉平" ✓（标题要横盖整行 ✓）。
         * 关掉分组时标题根本不显示 ✗ —— 但这里以前**照样** fill + 开新层 ✗，
         * 而搜索结果（按相似度排序 ✓）的月份边界**几乎每张一个** ✓
         * → 每张都被当成"新的一层" ✓ → 一张一列地往右下走 → **台阶** ✗（用户截图 ✓）。
         *
         * 所以：关掉分组时**完全不碰布局** ✓ —— 回到普通的"谁最短谁接"瀑布流 ✓，
         * 也就是用户要的"和主界面一样平铺" ✓。
         * （打开分组时行为不变 ✓：拉平 + 层内轮转，标题才会被摊到各列 ✓。）
         */
        const newBase = maxHeight + headerHeight + gap;
        columnHeights.fill(newBase);
        // 自用：记住这一层的高度 ✓；轮转进度（levelPick）跨分组保留 ✓ ——
        // 否则每个分组都从第 0 列重新开始，搜索结果还是会全挤在第 0 列 ✗。
        levelTop = newBase;
        levelFlattened = true;
      }
    }

    const item = items[i];
    if (item.fullWidth) {
      const top = Math.max(...columnHeights);
      const width = colWidth * columnCount + gap * (columnCount - 1);
      positions.push({
        height: item.height,
        left: 0,
        top,
        width,
      });
      columnHeights.fill(top + item.height + gap);
      // 整行卡片之后所有列又对齐了，等价于新的一层 ✓。
      levelTop = top + item.height + gap;
      levelPick = 0;
      levelFlattened = true;
      continue;
    }
    const rawAspect =
      item.width && item.height ? item.width / item.height : 4 / 3;
    const aspect = Math.max(0.6, Math.min(rawAspect, 3));
    const itemHeight = colWidth / aspect;

    let shortestColumn = 0;
    for (let column = 1; column < columnCount; column++) {
      if (columnHeights[column] < columnHeights[shortestColumn]) {
        shortestColumn = column;
      }
    }
    let targetColumn = shortestColumn;
    // 自用：① 各列与“最短列”等高（刚过分组标题的那种情况 ✓）→ 按层内轮转挑列 ✓；
    //       ② 否则一律走原来的「最短列」✓（分组内多张 / 主图库的观感不变 ✓）。
    if (
      levelFlattened &&
      levelTop !== null &&
      Math.abs(columnHeights[shortestColumn] - levelTop) < 0.5
    ) {
      const start = levelPick % columnCount;
      for (let offset = 0; offset < columnCount; offset++) {
        const column = (start + offset) % columnCount;
        if (Math.abs(columnHeights[column] - levelTop) < 0.5) {
          targetColumn = column;
          break;
        }
      }
      // 只有真按轮转放下去了，才把轮转推进一格 ✓（否则本层就此排满 ✓）。
      if (targetColumn === start) {
        levelPick++;
      }
      // 自用：本层还有空列吗？没有就把 `levelTop` 置空，
      // 之后重新回到原来的「最短列」（正常往下堆 ✓）。
      let levelFree = false;
      for (let column = 0; column < columnCount; column++) {
        if (Math.abs(columnHeights[column] - levelTop) < 0.5) {
          levelFree = true;
          break;
        }
      }
      if (!levelFree) {
        levelTop = null;
      }
    }

    positions.push({
      height: itemHeight,
      left: targetColumn * (colWidth + gap),
      top: columnHeights[targetColumn],
      width: colWidth,
    });
    columnHeights[targetColumn] += itemHeight + gap;
  }

  return {
    positions,
    columnHeights,
    headerPositions: existingHeaders
      ? [...existingHeaders, ...headerPositions]
      : headerPositions,
    visibilityIndex: buildMasonryVisibilityIndex(
      positions,
      existingVisibilityIndex
    ),
    levelFlattened,
    levelPick,
    levelTop,
  };
}

function getTotalHeight(columnHeights: number[]): number {
  return columnHeights.length > 0 ? Math.max(...columnHeights) : 0;
}

function createCache(
  items: MasonryLayoutInput[],
  groupHeaders: GroupHeaderInput[] | undefined,
  layoutKey: string,
  colWidth: number,
  columnCount: number,
  showGroupHeaders: boolean,
  result: {
    positions: MasonryItem[];
    columnHeights: number[];
    headerPositions: HeaderPosition[];
    visibilityIndex: number[];
    levelFlattened: boolean;
    levelPick: number;
    levelTop: number | null;
  }
): MasonryLayoutCache {
  return {
    colWidth,
    columnCount,
    columnHeights: result.columnHeights,
    groupHeaders: (groupHeaders ?? []).map((header) => ({ ...header })),
    headerPositions: result.headerPositions,
    inputSnapshot: snapshotLayoutInputs(items),
    itemCount: items.length,
    layoutKey,
    levelFlattened: result.levelFlattened,
    levelPick: result.levelPick,
    levelTop: result.levelTop,
    positions: result.positions,
    showGroupHeaders,
    visibilityIndex: result.visibilityIndex,
  };
}

export function useMasonryLayout(
  items: MasonryLayoutInput[],
  containerWidth: number,
  columnCount: number,
  gap: number,
  groupHeaders?: GroupHeaderInput[],
  layoutKey = "default",
  showGroupHeaders = true
): MasonryLayout {
  const previousRef = useRef<MasonryLayoutCache | null>(null);

  return useMemo(() => {
    const start = performance.now();
    if (containerWidth <= 0 || columnCount <= 0 || items.length === 0) {
      previousRef.current = null;
      recordGalleryPerf("masonryLayoutMs", performance.now() - start);
      return {
        headerPositions: [],
        positions: [],
        totalHeight: 0,
        visibilityIndex: [],
      };
    }

    const colWidth = (containerWidth - (columnCount - 1) * gap) / columnCount;
    const previous = previousRef.current;
    const canReuse =
      previous !== null &&
      layoutKey === previous.layoutKey &&
      previous.columnCount === columnCount &&
      Math.abs(previous.colWidth - colWidth) < 0.5 &&
      previous.showGroupHeaders === showGroupHeaders &&
      items.length > previous.itemCount &&
      hasMatchingLayoutPrefix(previous.inputSnapshot, items) &&
      hasMatchingHeaderPrefix(
        previous.groupHeaders,
        groupHeaders,
        previous.itemCount
      );

    if (canReuse) {
      const appendedHeaders = groupHeaders?.filter(
        (header) =>
          header.beforeIndex >= previous.itemCount &&
          header.beforeIndex < items.length
      );
      const appended = computeLayout(
        items.slice(previous.itemCount),
        colWidth,
        columnCount,
        gap,
        appendedHeaders,
        previous.itemCount,
        showGroupHeaders,
        previous.columnHeights,
        previous.headerPositions,
        previous.visibilityIndex,
        // 自用：接着上一轮的“层内轮转”继续排 ✓。
        // 丢了它，续页（无限滚动）那一段又会从第 0 列重新开始 ✗。
        {
          levelFlattened: previous.levelFlattened,
          levelPick: previous.levelPick,
          levelTop: previous.levelTop,
        }
      );
      const result = {
        ...appended,
        positions: [...previous.positions, ...appended.positions],
      };
      previousRef.current = createCache(
        items,
        groupHeaders,
        layoutKey,
        colWidth,
        columnCount,
        showGroupHeaders,
        result
      );
      const layout = {
        headerPositions: result.headerPositions,
        positions: result.positions,
        totalHeight: getTotalHeight(result.columnHeights),
        visibilityIndex: result.visibilityIndex,
      };
      recordGalleryPerf("masonryLayoutMs", performance.now() - start);
      return layout;
    }

    const result = computeLayout(
      items,
      colWidth,
      columnCount,
      gap,
      groupHeaders,
      0,
      showGroupHeaders
    );
    previousRef.current = createCache(
      items,
      groupHeaders,
      layoutKey,
      colWidth,
      columnCount,
      showGroupHeaders,
      result
    );
    const layout = {
      headerPositions: result.headerPositions,
      positions: result.positions,
      totalHeight: getTotalHeight(result.columnHeights),
      visibilityIndex: result.visibilityIndex,
    };
    recordGalleryPerf("masonryLayoutMs", performance.now() - start);
    return layout;
  }, [
    items,
    containerWidth,
    columnCount,
    gap,
    groupHeaders,
    layoutKey,
    showGroupHeaders,
  ]);
}
