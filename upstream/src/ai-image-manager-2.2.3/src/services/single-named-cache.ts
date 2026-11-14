/**
 * 「多人图里只认出一个角色」的候选集缓存（2026-11-14 · 会话#12）。
 *
 * 为什么需要：这个列表的查询要跨 8 万张照片做子查询 + 分组，
 * 实测**每次 1.07 秒**（取组 281ms + 数总数 279ms + 取照片 507ms）。
 * 翻页时还每次都重算一遍 —— 用户点「加载更多」要等 1 秒，很难受。
 *
 * 做法：候选集（约 4,200 张）**只算一次**放内存，翻页直接切片；
 * 任何标签写入都会调用 `invalidateTagSearch()`，这里跟着清缓存。
 * 另加 60 秒 TTL 兜底（防止漏掉的写入路径导致数据陈旧）。
 */
export interface SingleNamedCacheRow {
  path: string;
  personCount: number;
  photoId: number;
  tagId: number;
  thumbnailPath: string | null;
}

const TTL_MS = 60_000;

let cache: { at: number; rows: SingleNamedCacheRow[] } | null = null;

export function readSingleNamedCache(): SingleNamedCacheRow[] | null {
  if (!cache) {
    return null;
  }
  if (Date.now() - cache.at > TTL_MS) {
    cache = null;
    return null;
  }
  return cache.rows;
}

export function writeSingleNamedCache(rows: SingleNamedCacheRow[]): void {
  cache = { at: Date.now(), rows };
}

/** 标签数据一变就清掉（由 `invalidateTagSearch` 调用）。 */
export function bumpSingleNamedCache(): void {
  cache = null;
}
