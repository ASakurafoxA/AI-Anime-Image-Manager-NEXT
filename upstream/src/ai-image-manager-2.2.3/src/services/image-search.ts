/**
 * 以图搜图的两段式引擎：pHash 优先，CLIP 兜底。
 *
 * 为什么要两段（都有实测依据，见 需求分析/人脸评测/crop_query.txt 等）：
 *
 *   | 查询类型                     | pHash（阈值 4）      | CLIP 语义            |
 *   |------------------------------|----------------------|----------------------|
 *   | 全图 / 只改了分辨率或格式     | 100% 命中、0 误报     | 也能找到，但要跑模型 |
 *   | 裁过的残图                   | 必然漏（距离 12~16）  | 4 张里找到 2 张      |
 *
 * 两者擅长的范围不重叠，所以：
 *   · 先用 pHash 回答「这张图我存过吗」—— 毫秒级，且实测 1400 次查询零误报；
 *   · pHash 没命中再交给 CLIP 找「看起来像的」（残图/改图）。
 *
 * 注意：CLIP 的排序里会混入同角色的其他图，而且真原图可能排在 7~30 名，
 * 所以不能只看第一名；本模块把 pHash 的命中**放在最前面**，与 CLIP 结果区分开。
 */
import fs from "node:fs";
import { searchByImage as aiSearchByImage } from "@/services/ai";
import { computePHash } from "@/services/phash";
import { queryPhashIndex } from "@/services/phash-index";

/**
 * 判定「同一张图」的汉明距离上限。
 *
 * 实测：阈值 4 在 1,400 次真实裁剪查询中**没有带出任何无关图**；
 * 放宽到 8 会开始混入噪声，所以这里固定用 4（对应「严格」档语义）。
 */
export const EXACT_COPY_PHASH_THRESHOLD = 4;

export interface ImageSearchHit {
  /** true 表示与查询图的指纹几乎完全一致（同一张图，通常只是分辨率/格式不同） */
  isExactCopy: boolean;
  /** 仅 isExactCopy 时有值：指纹汉明距离，0 = 完全相同 */
  phashDistance: number | null;
  photoId: number;
  similarity: number;
}

/**
 * 以图搜图：先查指纹，再（必要时）查语义。
 *
 * @param imagePath 查询图路径（可以是图库外的任意图片）
 * @param limit 语义结果条数上限（指纹命中不受此限制）
 */
export async function searchByImageWithPhash(
  imagePath: string,
  limit = 20
): Promise<ImageSearchHit[]> {
  const exactHits: ImageSearchHit[] = [];
  let queryPhash: string | null = null;

  try {
    if (fs.existsSync(imagePath)) {
      queryPhash = await computePHash(imagePath);
    }
  } catch {
    queryPhash = null;
  }

  if (queryPhash) {
    try {
      // 指纹查询是纯内存检索（77k 条约 3ms），失败也不该影响语义兜底
      for (const match of queryPhashIndex(
        queryPhash,
        EXACT_COPY_PHASH_THRESHOLD
      )) {
        exactHits.push({
          photoId: match.photoId,
          similarity: 1,
          isExactCopy: true,
          phashDistance: match.distance,
        });
      }
    } catch (err) {
      console.warn(
        "[image-search] pHash lookup failed, falling back to AI only:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * 自用（2026-10 用户实测："以图搜图好慢"）：
   * **指纹已经命中"完全一致的图"时，就没必要再跑语义检索了** ✗→✓。
   *
   * 原来的写法是"指纹 + 语义**两条都跑**"，而语义那条是这个功能的耗时大头
   * （要算查询图特征 + 全库向量检索，实测几秒）✗ —— 用户搜一张库里**已经存过**的图时，
   * 明明指纹 3ms 就有答案，却还要白等几秒。
   *
   * 这也正是本函数注释里写的设计意图："先查指纹，**再（必要时）**查语义" ✓。
   * 所以：指纹有结果 → 直接返回（秒答）；指纹没结果（例如裁切/缩放的"残图"）→ 才走语义 ✓。
   */
  let aiHits: ImageSearchHit[] = [];
  if (exactHits.length === 0) {
    const raw = await aiSearchByImage(imagePath, limit);
    aiHits = raw.map((hit) => ({
      photoId: hit.photoId,
      similarity: hit.similarity,
      isExactCopy: false,
      phashDistance: null,
    }));
  }

  return [...exactHits, ...aiHits];
}
