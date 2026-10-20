/**
 * Shared pHash index — one engine behind BOTH "以图搜图" and "查重".
 *
 * 为什么要有这个模块：这两个功能以前是两套互不相干的逻辑
 *   - 以图搜图走语义向量（CLIP），回答的是「像不像」，会混入大量同角色图；
 *   - 查重走 pHash，回答的是「是不是同一张」，但没跑出结果。
 * 结果同一个人问「我存过这张图吗」和「库里有重复吗」会得到互相矛盾的答案。
 * 现在两者共用同一索引与同一套阈值语义。
 *
 * 纯逻辑在 `phash-match.ts`（无数据库依赖，可单测/可被脚本调用），
 * 本模块只负责数据库加载、缓存与对外封装。
 */
import { and, isNotNull, isNull, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { BKTree } from "@/services/bk-tree";
import {
  collectPairsFromEntries,
  type PhashEntry,
  type PhashMatch,
} from "@/services/phash-match";

export type { PhashEntry, PhashMatch } from "@/services/phash-match";
// 纯逻辑统一从这里再导出，调用方只需认识一个模块
export {
  buildGroupsFromEntries,
  byDistanceThenId,
  chunkPlan,
  collectPairsFromEntries,
  queryFromEntries,
} from "@/services/phash-match";

interface CachedIndex {
  /**
   * 建索引时用的数据库实例。测试里每个用例都会新建一个内存库，
   * 只靠 key 无法区分（张数/id 可能完全一样）→ 会串数据。
   */
  db: unknown;
  entries: PhashEntry[];
  exact: Map<string, number[]>;
  key: string;
  tree: BKTree;
}

let cache: CachedIndex | null = null;

/**
 * 索引失效判据 —— 必须**便宜**。
 *
 * ⚠️ 两个踩过的坑：
 *  1. 只用「张数 + 最大 id」：phash 值被重新计算后判据不变 → 返回过期索引。
 *  2. 改用 `group_concat(phash)` 做精确指纹：**实测 1308ms**（77,296 行会拼出
 *     1.2MB 字符串），每次查询都付这个代价不可接受。
 * 折中：判据保持便宜（张数 + 最大 id），再叠加「数据库实例」判断（测试/多库
 * 场景靠它保证正确），phash 被改写的生产路径由 `invalidatePhashIndex()` 显式失效
 * （见 indexer 写入 phash 处）。
 */
function currentIndexKey(): string {
  const row = getDatabase()
    .select({
      count: sql<number>`count(*)`,
      maxId: sql<number>`coalesce(max(${photos.id}), 0)`,
    })
    .from(photos)
    .where(and(isNull(photos.deletedAt), isNotNull(photos.phash)))
    .get();
  return `${row?.count ?? 0}:${row?.maxId ?? 0}`;
}

/**
 * 加载（或复用）全库指纹索引。
 * 77k 行只需一次查询；之后单点查询走内存里的 BK 树。
 */
export function getPhashIndex(): CachedIndex {
  const db = getDatabase();
  const key = currentIndexKey();
  if (cache && cache.db === db && cache.key === key) {
    return cache;
  }
  const rows = db
    .select({ id: photos.id, phash: photos.phash })
    .from(photos)
    .where(and(isNull(photos.deletedAt), isNotNull(photos.phash)))
    .all();
  const entries: PhashEntry[] = [];
  const exact = new Map<string, number[]>();
  const tree = new BKTree();
  for (const row of rows) {
    const phash = row.phash;
    if (!phash) {
      continue;
    }
    entries.push({ photoId: row.id, phash });
    tree.insert(row.id, phash);
    const list = exact.get(phash);
    if (list) {
      list.push(row.id);
    } else {
      exact.set(phash, [row.id]);
    }
  }
  cache = { db, entries, exact, key, tree };
  return cache;
}

/** 仅供测试/维护：丢弃缓存，下次访问重新加载。 */
export function invalidatePhashIndex(): void {
  cache = null;
}

/**
 * 在库内查询一个已知指纹（「以图搜图」走这条路）。
 * 单点查询用 BK 树（77k 条约 3ms）。
 */
export function queryPhashIndex(
  phash: string,
  threshold: number,
  limit = 0
): PhashMatch[] {
  const { tree } = getPhashIndex();
  const matches = tree.query(phash, threshold).map((hit) => ({
    photoId: hit.photoId,
    distance: hit.distance,
  }));
  matches.sort((a, b) => a.distance - b.distance || a.photoId - b.photoId);
  return limit > 0 ? matches.slice(0, limit) : matches;
}

/**
 * 查重：整库两两比对，返回「配对 + 距离」。
 *
 * 这是替换原 `bkTree.query(phash, Math.max(threshold, 16))` 逐张查询的入口 ——
 * 原做法在 7.7 万张上永远跑不完（实测 20 分钟未完成），本入口阈值 4 约 2~4 秒。
 *
 * @param maxPairs 安全上限，防止高阈值时候选爆炸（见 phash-match.ts 的说明）
 */
export function collectLibraryPhashPairs(
  threshold: number,
  maxPairs = 200_000
): Array<{ distance: number; photoAId: number; photoBId: number }> {
  return collectPairsFromEntries(getPhashIndex().entries, threshold, maxPairs);
}

