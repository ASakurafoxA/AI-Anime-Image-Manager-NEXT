/**
 * 以图搜图的**特征来源**：建向量时读缩略图还是原图（自用新增 2026-10-09）。
 *
 * 为什么默认缩略图：SigLIP 只要 224×224，喂原图等于"为了缩小先解码一张 3MB+ 的大图"。
 * 实测（RTX 4070 Ti SUPER + DirectML，同一模型、同一批图）：
 *   · 原图（平均 3.3MB）  : 读图+缩放 47.5ms + 推理 16.2ms = 63.9ms/张 → 15.6 张/秒
 *   · 缩略图（平均 114KB）: 读图+缩放  8.7ms + 推理 15.9ms = 24.8ms/张 → 40.3 张/秒
 * 项目缩略图是 512px（比 224 还大），所以质量上并不是"用了小图就变糊"，
 * 只是"缩略图本身已经是有损压缩过的"。想要极致保真可选原图。
 *
 * ⚠️ 历史：这个模块原来和"占用限制"同住在 `services/ai/throttle.ts`。
 * 占用限制已按用户要求**整体删除**（PWM 式限速对"偶发高负载"场景没用），
 * 但"特征来源"是用户单独要的功能，所以拆到这里保留。
 */
import fs from "node:fs";
import path from "node:path";
import { getSetting, setSetting } from "@/services/settings-manager";
import { getDataPath } from "@/utils/data-path";

/** 建向量（以图搜图特征）时用哪种图。 */
export type SearchImageSource = "thumbnail" | "original";

export const SEARCH_IMAGE_SOURCE_KEY = "ai.searchImageSource";
export const DEFAULT_SEARCH_IMAGE_SOURCE: SearchImageSource = "thumbnail";

/**
 * 当前设置值（非法或未设置 → 默认"缩略图"）。
 */
export function getSearchImageSource(): SearchImageSource {
  const raw = getSetting(SEARCH_IMAGE_SOURCE_KEY);
  return raw === "original" ? "original" : DEFAULT_SEARCH_IMAGE_SOURCE;
}

export function setSearchImageSource(value: SearchImageSource): void {
  setSetting(
    SEARCH_IMAGE_SOURCE_KEY,
    value === "original" ? "original" : "thumbnail"
  );
}

/** 缩略图是否真的在磁盘上（库里可能留着已删除/未生成的路径）。 */
function thumbnailOnDisk(thumbnailPath: string): boolean {
  try {
    if (fs.existsSync(thumbnailPath)) {
      return true;
    }
    // 库里存的可能是相对路径（历史数据）→ 相对数据目录再试一次
    const resolved = path.isAbsolute(thumbnailPath)
      ? thumbnailPath
      : path.join(getDataPath(), thumbnailPath);
    return fs.existsSync(resolved);
  } catch {
    return false;
  }
}

/**
 * 按当前设置决定这一张图片用哪个文件建向量。
 *
 * · `thumbnail`（默认）：缩略图在磁盘上就用它，否则回退原图（不会因为缺缩略图而漏图）；
 * · `original`：一律用原图（更保真、更慢）。
 */
export function resolveEmbeddingImagePath(photo: {
  path: string;
  thumbnailPath?: string | null;
}): string {
  if (getSearchImageSource() === "original") {
    return photo.path;
  }
  const thumbnail = photo.thumbnailPath;
  if (thumbnail && thumbnailOnDisk(thumbnail)) {
    return thumbnail;
  }
  return photo.path;
}
