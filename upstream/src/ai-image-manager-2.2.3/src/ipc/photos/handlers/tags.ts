import { os } from "@orpc/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { folders, photos, photoTags, tags } from "@/db/schema";
import {
  getAiControlState,
  isAutoTaggingActive,
  isAutoTaggingPhoto,
} from "@/services/ai/state";
import { suggestTags as aiSuggestTags } from "@/services/ai-embedder";
import { getFolderSubtreeIds } from "@/services/folder-hierarchy";
import { invalidateTagSearch } from "@/services/tag-search-revision";
import {
  getHiddenTagsState,
  setTagHiddenById,
} from "@/services/tag-exclusions";
import {
  BatchPhotoIdsSchema,
  HiddenTagToggleSchema,
  IdSchema,
} from "./shared";

export const suggestTags = os.input(IdSchema).handler(async ({ input }) => {
  const db = getDatabase();
  const photo = db
    .select({ isAiProcessed: photos.isAiProcessed, path: photos.path })
    .from(photos)
    .where(eq(photos.id, input.id))
    .get();
  if (!photo) {
    return { photoId: input.id, suggestions: [] };
  }
  if (isAutoTaggingPhoto(input.id)) {
    return {
      busy: true,
      photoId: input.id,
      reason: "tagging" as const,
      suggestions: [],
    };
  }
  if (isAutoTaggingActive()) {
    return {
      busy: true,
      photoId: input.id,
      reason: "busy" as const,
      suggestions: [],
    };
  }
  if (getAiControlState() !== "idle") {
    return {
      busy: true,
      photoId: input.id,
      reason: "indexing" as const,
      suggestions: [],
    };
  }
  try {
    const suggestions = await aiSuggestTags(photo.path, 0.25, input.id);
    return { photoId: input.id, suggestions };
  } catch {
    return { photoId: input.id, suggestions: [] };
  }
});

export const getPhotoTagAnalysisStatus = os
  .input(IdSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const photo = db
      .select({ isAiProcessed: photos.isAiProcessed })
      .from(photos)
      .where(eq(photos.id, input.id))
      .get();
    if (!photo) {
      return { state: "unavailable" as const };
    }
    if (isAutoTaggingPhoto(input.id)) {
      return { state: "tagging" as const };
    }
    if (isAutoTaggingActive()) {
      return { state: "busy" as const };
    }
    if (getAiControlState() !== "idle") {
      return { state: "indexing" as const };
    }
    return {
      indexed: photo.isAiProcessed,
      state: "ready" as const,
    };
  });

/**
 * 标签「自身 + 所有后代」的去重照片计数。
 *
 * 自用改动（性能）：把计数下推到 SQLite 的递归 CTE。
 *
 * 原实现把**全表** photo_tags 拉进 JS 内存，为每个标签建一个 Set<photoId>，
 * 再对每个标签递归复制后代集合。做通用标签后 photo_tags 会达到 80 万–320 万行，
 * 实测（合成 1 万标签 / 296 万配对）原实现峰值内存 454 MB、耗时 4.8 s，
 * 而下面的递归 CTE 只需 1.6 MB、1.7 s，且逐标签结果与原实现**完全一致**。
 * getTags 在侧边栏每次刷新标签时都会调用，原实现足以冻住界面。
 *
 * 局域网只读 API 也调用它，所以手机端标签树的数字与桌面一致。
 *
 * @param folderId 给定时只统计该文件夹子树内的照片（桌面侧边栏按文件夹收窄时用）。
 */
export function queryTagPhotoCounts(folderId?: number): Map<number, number> {
  const db = getDatabase();

  const folderIds = folderId
    ? getFolderSubtreeIds(
        db
          .select({ id: folders.id, parentId: folders.parentId })
          .from(folders)
          .all(),
        folderId
      )
    : [];

  const folderFilter = !folderId
    ? sql``
    : folderIds.length > 0
      ? sql`AND p.folder_id IN (${sql.join(
          folderIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      : sql`AND p.folder_id = ${folderId}`;

  const countRows = db.all<{ tag_id: number; c: number }>(sql`
    WITH RECURSIVE closure(root, desc) AS (
      SELECT id, id FROM tags
      UNION
      SELECT c.root, t.id
        FROM closure c
        JOIN tags t ON t.parent_id = c.desc
    )
    SELECT c.root AS tag_id, COUNT(DISTINCT pt.photo_id) AS c
      FROM closure c
      JOIN photo_tags pt ON pt.tag_id = c.desc
      JOIN photos p ON p.id = pt.photo_id
     WHERE p.deleted_at IS NULL
       ${folderFilter}
     GROUP BY c.root
  `);

  const counts = new Map<number, number>();
  for (const row of countRows) {
    counts.set(Number(row.tag_id), Number(row.c));
  }
  return counts;
}

export const getTags = os
  .input(z.object({ folderId: z.number().optional() }).optional())
  .handler(({ input }) => {
    const db = getDatabase();
    const allTags = db.select().from(tags).orderBy(tags.name).all();
    const counts = queryTagPhotoCounts(input?.folderId);

    const result = allTags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      parentId: t.parentId,
      photoCount: counts.get(t.id) ?? 0,
    }));

    result.sort(
      (a, b) => b.photoCount - a.photoCount || a.name.localeCompare(b.name)
    );
    return result;
  });

export const getPhotoTags = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  return db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      confidence: photoTags.confidence,
      isConfirmed: photoTags.isConfirmed,
      origin: photoTags.origin,
      userConfirmed: photoTags.userConfirmed,
    })
    .from(photoTags)
    .innerJoin(tags, eq(photoTags.tagId, tags.id))
    .where(eq(photoTags.photoId, input.id))
    .all();
});

export const addTag = os
  .input(
    z.object({
      name: z.string().min(1).max(50),
      color: z.string().optional(),
      parentId: z.number().optional(),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const existing = db
      .select()
      .from(tags)
      .where(eq(tags.name, input.name))
      .get();
    if (existing) {
      return existing;
    }
    const result = db
      .insert(tags)
      .values({
        name: input.name,
        color: input.color || null,
        parentId: input.parentId || null,
      })
      .returning({ insertedId: tags.id })
      .get();
    return {
      id: result?.insertedId,
      name: input.name,
      color: input.color || null,
      parentId: input.parentId || null,
    };
  });

export const setPhotoTag = os
  .input(z.object({ photoId: z.number(), tagId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    db.insert(photoTags)
      .values({
        photoId: input.photoId,
        tagId: input.tagId,
        confidence: null,
        isConfirmed: true,
        origin: "manual",
        userConfirmed: true,
      })
      .onConflictDoUpdate({
        target: [photoTags.photoId, photoTags.tagId],
        set: {
          confidence: null,
          isConfirmed: true,
          origin: "manual",
          userConfirmed: true,
        },
      })
      .run();
    return { ok: true };
  });

export const removePhotoTag = os
  .input(z.object({ photoId: z.number(), tagId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    db.delete(photoTags)
      .where(
        sql`${photoTags.photoId} = ${input.photoId} AND ${photoTags.tagId} = ${input.tagId}`
      )
      .run();
    invalidateTagSearch();
    return { ok: true };
  });

/**
 * 自用版新增：**批量打标签**。
 *
 * 用途：WD14 tagger 只认得出约 36% 的图，剩下的原创角色 / 冷门角色需要人工补。
 * 在 8 万张规模下逐个点开打标签不可行，所以配合「以图搜图」筛出疑似同一角色的图
 * → 全选 → 一次打上标签。
 *
 * 语义与单张的 `setPhotoTag` **完全一致**：`origin='manual'`、`isConfirmed`/`userConfirmed=true`。
 * 这样后续任何 AI 重新打标签都不会覆盖它 —— `tag-suggester` 只清理
 * `origin='auto' AND user_confirmed=0` 的行。
 */
export const batchSetPhotoTag = os
  .input(BatchPhotoIdsSchema.extend({ tagId: z.number().int().positive() }))
  .handler(({ input }) => {
    const db = getDatabase();
    const rows = input.ids.map((photoId) => ({
      photoId,
      tagId: input.tagId,
      confidence: null,
      isConfirmed: true,
      origin: "manual" as const,
      userConfirmed: true,
    }));

    // 分块多行插入：比逐张快得多，同时避开 SQLite 的单语句参数上限。
    const CHUNK_SIZE = 200;
    let applied = 0;
    db.transaction(() => {
      for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        const chunk = rows.slice(i, i + CHUNK_SIZE);
        db.insert(photoTags)
          .values(chunk)
          .onConflictDoUpdate({
            target: [photoTags.photoId, photoTags.tagId],
            set: {
              confidence: null,
              isConfirmed: true,
              origin: "manual",
              userConfirmed: true,
            },
          })
          .run();
        applied += chunk.length;
      }
    });

    invalidateTagSearch();
    return { ok: true, applied };
  });

/** 自用版新增：**批量移除标签** —— 用于纠正一次误标很多张的情况。 */
export const batchRemovePhotoTag = os
  .input(BatchPhotoIdsSchema.extend({ tagId: z.number().int().positive() }))
  .handler(({ input }) => {
    const db = getDatabase();
    const result = db
      .delete(photoTags)
      .where(
        and(
          inArray(photoTags.photoId, input.ids),
          eq(photoTags.tagId, input.tagId)
        )
      )
      .run();
    invalidateTagSearch();
    return { ok: true, removed: result.changes ?? 0 };
  });

export const confirmPhotoTag = os
  .input(z.object({ photoId: z.number(), tagId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    db.update(photoTags)
      .set({ isConfirmed: true, userConfirmed: true })
      .where(
        sql`${photoTags.photoId} = ${input.photoId} AND ${photoTags.tagId} = ${input.tagId}`
      )
      .run();
    return { ok: true };
  });

export const deleteTag = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  // Re-parent child tags to root
  db.update(tags)
    .set({ parentId: null })
    .where(eq(tags.parentId, input.id))
    .run();
  db.delete(photoTags).where(eq(photoTags.tagId, input.id)).run();
  db.delete(tags).where(eq(tags.id, input.id)).run();
  invalidateTagSearch();
  return { ok: true };
});

/**
 * 自用版新增：重命名标签（含角色标签）。
 *
 * 用途：WD14 只对通用标签有中文来源（覆盖率 95.9%），**角色标签没有**，
 * 所以需要能手动把 `suzuran_(arknights)` 改成「铃兰 (suzuran_(arknights))」。
 *
 * ⚠️ 打标逻辑按**英文基础名**查找标签（见 wd14-tagger.ts 的 baseNameOf），
 * 所以重命名时保留括号里的英文原名最稳妥。
 */
export const renameTag = os
  .input(
    z.object({
      id: z.number().int().positive(),
      name: z.string().trim().min(1).max(100),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const conflict = db
      .select({ id: tags.id })
      .from(tags)
      .where(eq(tags.name, input.name))
      .get();
    if (conflict && conflict.id !== input.id) {
      throw new Error("已存在同名标签");
    }
    db.update(tags).set({ name: input.name }).where(eq(tags.id, input.id)).run();
    invalidateTagSearch();
    return { ok: true };
  });

/**
 * 自用版新增：设置标签小点的颜色。
 *
 * 支持 `#RGB` / `#RRGGBB` / `rgb(r,g,b)` 写法（前端会先归一化成 `#RRGGBB`）。
 * 传 `null` 表示清除自定义颜色，回到按层级分配的默认色。
 */
export const setTagColor = os
  .input(
    z.object({
      id: z.number().int().positive(),
      color: z.string().trim().max(32).nullable(),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    db.update(tags)
      .set({ color: input.color })
      .where(eq(tags.id, input.id))
      .run();
    invalidateTagSearch();
    return { ok: true };
  });

/**
 * 自用版新增：标签黑名单。
 *
 * 只影响侧边栏显示（黑名单标签集中到底部独立区域），
 * **不删标签、不删 photo_tags** —— 标签依然能被搜索到。
 */
export const getHiddenTags = os.handler(() => getHiddenTagsState());

export const setTagHidden = os
  .input(HiddenTagToggleSchema)
  .handler(({ input }) => {
    setTagHiddenById(input.tagId, input.hidden);
    return { ok: true };
  });
