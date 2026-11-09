/**
 * 自用（2026-11-09 · 会话#11 用户口径）：
 * 「很多是 Pixiv 分P保存，导致识别出来的其实是差分」——
 * 同一作品号的不同页（`115115528_p0.jpg`、`_p1`、`_p2`）应当被认作**差分**，
 * 不该当成"重复"去建议删除。
 *
 * 重要边界（用户明确要求的）：
 *   · **只作用于「视觉相似」**：完全相同那一类可能是"作者把同一张图发了两次（pid 不同）"，
 *     或者"同一张图在不同路径各存了一份"——这些恰恰需要人工看，不能自动筛掉 ✓
 *   · 文件名不符合 `作品号_p页号` 的（推特/Danbooru/手工改名）一律返回 false，退回原来的行为 ✓
 *   · 判断只看文件名，不读文件、不查库 → 纯函数、可单测 ✓
 */

const PIXIV_NAME_PATTERN = /^(\d{6,})_p(\d+)(?:_master\d+)?\./i;

export interface PixivWorkPage {
  /** Pixiv 作品号（同作品的多页共享） */
  page: number;
  work: string;
}

export function pixivWorkPage(
  filename: string | undefined | null
): PixivWorkPage | null {
  const match = PIXIV_NAME_PATTERN.exec(filename ?? "");
  if (!match) {
    return null;
  }
  return { page: Number(match[2]), work: match[1] };
}

/** 判断"这一组重复"是不是同一 Pixiv 作品的不同分P（差分） */
export function isPixivPageVariant(group: {
  matchType: string;
  photoCount: number;
  previewPhotos: Array<{ filename?: string | null }>;
}): boolean {
  if (group.matchType !== "similar" || group.photoCount < 2) {
    return false;
  }
  const keys = group.previewPhotos.map((photo) =>
    pixivWorkPage(photo.filename)
  );
  if (keys.some((key) => key === null)) {
    return false;
  }
  const work = keys[0]?.work;
  const pages = new Set<number>();
  for (const key of keys) {
    if (!key || key.work !== work) {
      return false;
    }
    pages.add(key.page);
  }
  return pages.size > 1;
}
