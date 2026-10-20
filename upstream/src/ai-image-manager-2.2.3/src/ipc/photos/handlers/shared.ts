import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
  FOLDER_APPEARANCE_ICONS,
  HEX_COLOR_PATTERN,
} from "@/lib/folder-appearance";
import type { ScoringOptions } from "@/services/ai/query-parser";

/**
 * 自用（2026-10-20 · 会话#10）：把服务层的**中文提示原样送到界面**。
 *
 * 起因（用户实测）：角色识别页点按钮只弹一句英文 `Internal server error`。
 * 根因：oRPC 对"普通 Error"有兜底 —— `@orpc/client` 的 `toORPCError()` 会换成
 * `new ORPCError("INTERNAL_SERVER_ERROR", { message: "Internal server error", cause })`，
 * **原始 message 被丢掉**，只留在 cause 里。而角色识别那几条守卫提示
 * （"请先获取全库角色特征"、"AI 正忙，先等建向量跑完"）都是 `new Error(…)`，
 * 于是全变成了那句英文。
 *
 * 用法：只包**出错时想让用户看到原话**的调用（角色识别这类"守卫式"拒绝），
 * 不要无脑包全部 —— 数据库/系统错误原样抛给界面没有意义。
 * （`handlers/listing.ts` 的 scanFolder 早就是这么做的，这里抽成公用。）
 */
export async function withUserFacingError<T>(
  task: () => Promise<T> | T
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof ORPCError) {
      throw error;
    }
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
}

export const FolderSchema = z.object({ path: z.string().min(1) });
export const SearchSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().optional().default(50),
});
export const ImageSearchSchema = z.object({
  imagePath: z.string().min(1),
  limit: z.number().optional().default(20),
});

/** 自用新增：在软件里重命名文件夹（同步改磁盘 + 图库记录）。 */
export const RenameFolderSchema = z.object({
  id: z.number().int().positive(),
  newName: z.string().min(1).max(200),
});
export const ImageSearchPreviewSchema = ImageSearchSchema.pick({
  imagePath: true,
});
export const ListSchema = z.object({
  folderId: z.number().optional(),
  /** Only return active photos that are not members of any sequence. */
  ungroupedOnly: z.boolean().optional(),
  tagId: z.number().optional(),
  tagIds: z.number().array().optional(),
  tagMode: z.enum(["and", "or"]).optional().default("or"),
  search: z.string().optional(),
  favoriteOnly: z.boolean().optional(),
  /**
   * 自用：为 true 时**按标签检索也排除隐藏文件夹**（默认只排除浏览视图）。
   * 由主界面搜索栏右侧那个「隐藏文件夹」开关控制。
   */
  excludeHiddenFolders: z.boolean().optional(),
  sort: z.enum(["date", "name", "size"]).optional().default("date"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
  offset: z.number().optional().default(0),
  limit: z.number().optional().default(100),
});
export const IdSchema = z.object({ id: z.number() });
export const BatchPhotoIdsSchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(1000)
    .transform((ids) => [...new Set(ids)]),
});
export const TrashListSchema = z.object({
  cursor: z
    .object({
      id: z.number().int().positive(),
      value: z.union([z.number(), z.string()]),
    })
    .nullish()
    .default(null),
  limit: z.number().int().min(1).max(200).optional().default(100),
  query: z.string().trim().max(200).optional().default(""),
  sort: z.enum(["deletedAt", "name", "size"]).optional().default("deletedAt"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
});
export const FolderAppearanceSchema = z.object({
  id: z.number(),
  color: z.string().regex(HEX_COLOR_PATTERN).nullable(),
  icon: z.enum(FOLDER_APPEARANCE_ICONS).nullable(),
});
/** 自用精简版：把某个文件夹加入 / 移出黑名单。 */
export const HiddenFolderToggleSchema = z.object({
  folderId: z.number().int().positive(),
  hidden: z.boolean(),
});
/** 自用版：把某个标签加入 / 移出标签黑名单（只影响显示，不删数据）。 */
export const HiddenTagToggleSchema = z.object({
  tagId: z.number().int().positive(),
  hidden: z.boolean(),
});

export function deferSearchBranch<T>(
  task: () => T | PromiseLike<T>
): Promise<T> {
  return Promise.resolve().then(task);
}

export function applyTimeDecay<
  T extends { similarity: number; fileDate?: number | null },
>(results: T[], options?: ScoringOptions): Array<T & { score: number }> {
  const scored = results.map((r) => {
    let score = r.similarity;

    if (options?.timeDecay?.enabled && r.fileDate != null) {
      const age = Math.max(0, Date.now() - r.fileDate);
      const recency = Math.max(0, 1 - age / options.timeDecay.maxAgeMs);
      score *= 1 + options.timeDecay.alpha * recency;
    }

    if (options?.temporalBoost && r.fileDate != null) {
      const { targetFrom, targetTo, factor } = options.temporalBoost;
      if (r.fileDate >= targetFrom && r.fileDate <= targetTo) {
        score *= factor;
      }
    }

    return { ...r, score: Math.round(score * 10_000) / 10_000 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export const CompoundSearchSchema = z.object({
  /**
   * 自用（2026-10）：语义相似度下限（0~1）。搜索栏的「相似度 ≥ N%」滑条用它。
   * 只筛**带语义证据**的结果；标签 / 文件名 / 人名命中的不按相似度砍。
   */
  minSimilarity: z.number().min(0).max(1).optional(),
  query: z.string().optional(),
  colorHex: z.string().optional(),
  dateFrom: z.number().optional(),
  dateMonth: z.number().int().min(1).max(12).optional(),
  dateHour: z.number().int().min(0).max(23).optional(),
  dateTo: z.number().optional(),
  cameraModel: z.string().optional(),
  lensModel: z.string().optional(),
  creator: z.string().optional(),
  advancedField: z
    .enum([
      "vendor",
      "captureMode",
      "exposureProgram",
      "meteringMode",
      "whiteBalance",
      "focusMode",
      "subjectTarget",
      "driveMode",
      "stabilizationMode",
      "computationalMode",
      "inCameraLook",
      "provenanceStatus",
    ])
    .optional(),
  advancedValue: z.string().optional(),
  focalMin: z.number().optional(),
  focalMax: z.number().optional(),
  apertureMin: z.number().optional(),
  apertureMax: z.number().optional(),
  isoMin: z.number().optional(),
  isoMax: z.number().optional(),
  shutterMin: z.number().optional(),
  shutterMax: z.number().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(300).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
});
