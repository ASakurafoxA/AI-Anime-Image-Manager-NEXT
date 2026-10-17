import fs from "node:fs";
import path from "node:path";
import { ORPCError, os } from "@orpc/server";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  like,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { app } from "electron";
import type { z } from "zod";
import { getDatabase } from "@/db";
import {
  advancedExifData,
  exifData,
  faceIdentities,
  faceIdentityMembers,
  folders,
  photoSequenceMembers,
  photos,
  photoTags,
  tags,
} from "@/db/schema";

const GLOB_WILDCARD_RE = /[*?[]/;

import { deletePhotoVectors } from "@/services/ai-embedder";
import { getFolderSubtreeIds, getFolderTotalPhotoCounts } from "@/services/folder-hierarchy";
import { clearTagCountCache } from "@/services/tag-count-cache";
import { addRemovedFolderPath } from "@/services/folder-exclusions";
import {
  getAllFolderPathItems,
  getHiddenFoldersState,
  getHiddenFolderPaths,
  resolveExcludedFolderIds,
  setFolderHiddenById,
} from "@/services/folder-exclusions";
import { normalizeFolderPath } from "@/utils/folder-exclusions";
import { resolveTagDotColor } from "@/utils/tag-dot-color";
import { reloadFolderMatcher } from "@/services/folder-matcher";
import {
  cancelAllImports,
  cancelCurrentImport,
  cancelQueuedImports,
  enqueueImport,
  getImportQueueStatus,
} from "@/services/import-queue";
import { unwatchFolder } from "@/services/indexer";
import { deletePhotoThumbnails } from "@/services/thumbnailer";
import {
  FolderAppearanceSchema,
  FolderSchema,
  HiddenFolderToggleSchema,
  IdSchema,
  ListSchema,
} from "./shared";

function logIpcError(handlerName: string, err: unknown): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const e = err as { message?: string; stack?: string };
    const detail = e?.stack ?? e?.message ?? String(err);
    fs.writeFileSync(
      path.join(logDir, "ipc-error.log"),
      `${new Date().toISOString()} [${handlerName}] ${detail}\n\n`,
      { flag: "a" }
    );
  } catch {
    /* best-effort */
  }
}

// ── Import Queue — sequential folder import ───────────────────────

/**
 * Enqueue a folder for import. Returns immediately so the frontend
 * is not blocked while scanning and AI embedding run in the background.
 */
export const scanFolder = os.input(FolderSchema).handler(({ input }) => {
  try {
    const resolved = path.resolve(input.path);
    if (!(fs.existsSync(resolved) && fs.statSync(resolved).isDirectory())) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Folder does not exist or is not a directory: ${resolved}`,
      });
    }

    const task = enqueueImport(resolved);
    return { status: task.status, position: task.position, id: task.id };
  } catch (err) {
    logIpcError("scanFolder", err);
    const message = (err as Error)?.message ?? String(err);
    if (err instanceof ORPCError) {
      throw err;
    }
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
  }
});

export const stopScanning = os.handler(() => {
  return { stopped: cancelCurrentImport() };
});

export const cancelAllImports_h = os.handler(() => {
  cancelAllImports();
  return { stopped: true };
});

/** Get current import queue status (pending, running, history). */
export const getImportQueueStatus_h = os.handler(() => {
  return getImportQueueStatus();
});

/** Cancel all queued (not-yet-started) imports without affecting the running one. */
export const cancelQueuedImports_h = os.handler(() => {
  const cancelled = cancelQueuedImports();
  return { cancelled: cancelled.length };
});

/**
 * 文件夹列表的可复用核心（含"黑名单文件夹的照片不计入其祖先"的计数调整）。
 *
 * 局域网只读 API 与 IPC 共用它 —— 手机端文件夹树的数字因此与桌面完全一致。
 * ⚠️ 返回行里带 `path`，局域网侧**必须**再映射一遍（只发 id / 显示名 / 计数）。
 */
export function queryFolders() {
  const db = getDatabase();
  const allFolders = db
    .select()
    .from(folders)
    .orderBy(desc(folders.lastScannedAt))
    .all();

  const totalPhotoCounts = getFolderTotalPhotoCounts(allFolders);

  // 自用精简版：黑名单文件夹的照片数不计入它的祖先，使左侧树的数字与
  // 右侧网格实际显示的数量一致；黑名单文件夹自身及其子孙仍保留真实计数，
  // 这样用户主动点进去时看到的数字是对的。
  const hiddenPaths = getHiddenFolderPaths();
  if (hiddenPaths.length > 0) {
    const hiddenPathSet = new Set(hiddenPaths.map(normalizeFolderPath));
    const parentOf = new Map(allFolders.map((f) => [f.id, f.parentId]));
    for (const folder of allFolders) {
      if (!hiddenPathSet.has(normalizeFolderPath(folder.path))) {
        continue;
      }
      const hiddenTotal = totalPhotoCounts.get(folder.id) ?? 0;
      const guard = new Set<number>([folder.id]);
      let ancestorId = folder.parentId;
      while (ancestorId !== null && !guard.has(ancestorId)) {
        guard.add(ancestorId);
        const current = totalPhotoCounts.get(ancestorId) ?? 0;
        totalPhotoCounts.set(ancestorId, Math.max(0, current - hiddenTotal));
        ancestorId = parentOf.get(ancestorId) ?? null;
      }
    }
  }

  return allFolders.map((f) => ({
    ...f,
    totalPhotoCount: totalPhotoCounts.get(f.id) ?? f.photoCount,
  }));
}

export const getFolders = os.handler(() => queryFolders());

// ── 自用精简版：文件夹黑名单（视图级过滤，不取消索引）────────────────────
/** 读取黑名单状态。 */
export const getHiddenFolders = os.handler(() => getHiddenFoldersState());

/** 把某个文件夹加入 / 移出黑名单（按 folderId，路径由主进程反查）。 */
export const setFolderHidden = os
  .input(HiddenFolderToggleSchema)
  .handler(({ input }) => {
    const state = setFolderHiddenById(input.folderId, input.hidden);
    invalidateCountCache();
    return state;
  });

export const updateFolderAppearance = os
  .input(FolderAppearanceSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const updated = db
      .update(folders)
      .set({ appearanceColor: input.color, appearanceIcon: input.icon })
      .where(eq(folders.id, input.id))
      .returning({
        appearanceColor: folders.appearanceColor,
        appearanceIcon: folders.appearanceIcon,
        id: folders.id,
      })
      .get();
    if (!updated) {
      throw new Error("Folder not found");
    }
    return updated;
  });

export const deleteFolder = os.input(IdSchema).handler(async ({ input }) => {
  const db = getDatabase();
  const folder = db
    .select({ id: folders.id, path: folders.path })
    .from(folders)
    .where(eq(folders.id, input.id))
    .get();
  if (!folder) {
    return { success: true };
  }

  await unwatchFolder(folder.path);

  // 1) Recursively collect all descendant folder IDs with cycle detection.
  const folderHierarchy = db
    .select({ id: folders.id, parentId: folders.parentId, path: folders.path })
    .from(folders)
    .all();
  const allFolderIds = getFolderSubtreeIds(folderHierarchy, input.id);
  const descendantIds = allFolderIds.filter((id) => id !== input.id);

  // 2) Collect all photos belonging to any of these folders.
  //    This includes both active and soft-deleted photos — when the original
  //    Active photos are removed with the folder. Soft-deleted photos keep
  //    their retention period and become unassigned through the folder FK.
  const folderPhotos = db
    .select({ id: photos.id, path: photos.path, deletedAt: photos.deletedAt })
    .from(photos)
    .where(inArray(photos.folderId, allFolderIds))
    .all();
  // 3) Also catch orphan photos under the folder path that have no valid folderId
  const escapedPath = folder.path.replace(/'/g, "''");
  const normalizedPath = escapedPath.replace(/\\/g, "/");
  const orphanPhotos = db
    .select({ id: photos.id, path: photos.path, deletedAt: photos.deletedAt })
    .from(photos)
    .where(
      sql`(${photos.folderId} IS NULL OR ${photos.folderId} NOT IN (
        SELECT id FROM folders
      )) AND REPLACE(${photos.path}, '\\', '/') LIKE ${`${normalizedPath}/%`}`
    )
    .all();
  const photosById = new Map(
    [...folderPhotos, ...orphanPhotos].map((photo) => [photo.id, photo])
  );
  // Active photos leave the catalog with the folder. Soft-deleted photos stay
  // in Recently Deleted; deleting the folder sets their folderId to NULL via FK.
  const activePhotos = [...photosById.values()].filter(
    (photo) => photo.deletedAt === null
  );
  const allPhotoIds = activePhotos.map((photo) => photo.id);
  const allPhotoPaths = activePhotos.map((photo) => photo.path);

  // 4) Execute deletions in a transaction
  // parent_id FK uses ON DELETE SET NULL, so deletion order is safe in any direction
  const { forgetInterruptedImports } = await import("@/services/import-queue");
  db.transaction(() => {
    forgetInterruptedImports(
      folderHierarchy
        .filter((entry) => allFolderIds.includes(entry.id))
        .map((entry) => entry.path)
    );
    if (allPhotoIds.length > 0) {
      db.delete(exifData).where(inArray(exifData.photoId, allPhotoIds)).run();
      db.delete(photoTags).where(inArray(photoTags.photoId, allPhotoIds)).run();
      db.delete(photos).where(inArray(photos.id, allPhotoIds)).run();
    }

    for (const fid of descendantIds) {
      db.delete(folders).where(eq(folders.id, fid)).run();
    }

    db.delete(folders).where(eq(folders.id, input.id)).run();
  });

  // 4b) Clean up face identities orphaned by cascade deletion
  if (allPhotoIds.length > 0) {
    // Delete identities that no longer have any members
    const emptyIds = db
      .select({ id: faceIdentities.id })
      .from(faceIdentities)
      .leftJoin(
        faceIdentityMembers,
        eq(faceIdentityMembers.identityId, faceIdentities.id)
      )
      .where(sql`${faceIdentityMembers.faceVectorId} IS NULL`)
      .all()
      .map((r) => r.id);
    if (emptyIds.length > 0) {
      db.delete(faceIdentities)
        .where(inArray(faceIdentities.id, emptyIds))
        .run();
    }
    // Recalculate faceCount for identities that still have members
    db.run(
      sql`UPDATE face_identities SET face_count = (
        SELECT COUNT(DISTINCT fv.photo_id) FROM face_identity_members fim
        JOIN face_vectors fv ON fv.id = fim.face_vector_id
        WHERE fim.identity_id = face_identities.id
      )`
    );
  }

  // 5) Clean up thumbnails, AI vectors (outside transaction, best-effort)
  for (const p of allPhotoPaths) {
    deletePhotoThumbnails(p);
  }
  if (allPhotoIds.length > 0) {
    try {
      await deletePhotoVectors(allPhotoIds);
    } catch (err) {
      console.error("[AI] deleteFolder vector cleanup failed:", err);
    }
  }

  // 6) Reload folder matcher so watchers pick up the change
  reloadFolderMatcher();

  // 6b) 记下这个路径「已被用户移除」。
  // 否则开机增量补扫（scheduleStartupCatchUpScan）重扫树根时，
  // scanFolder 的 auto-discover 会把"含图片的子目录"重新建成文件夹记录 ——
  // 用户明明删掉的文件夹下次开软件又回来了（实测用户反馈）。
  // 用户以后**主动重新导入**这个路径时，scanFolder 会忘掉这条记录。
  addRemovedFolderPath(folder.path);

  // 7) Flush COUNT cache so the frontend sees the updated total immediately
  invalidateCountCache();

  return { success: true };
});

// ── Total COUNT cache ───────────────────────────────────────────────
// 避免每次翻页在数十万行表上执行 COUNT(*)，TTL 10 秒内复用上次结果。
// 大规模导入完成后应调用 invalidateCountCache() 立即刷新。
const COUNT_CACHE_TTL = 10_000;
const MAX_COUNT_CACHE = 50;

/** 清空 COUNT 缓存，在导入/删除大批量照片后调用以确保计数即时准确。 */
export function invalidateCountCache(): void {
  totalCache.clear();
  // 标签树徽标统计（3 秒以上的递归 CTE）也跟着失效：
  // 导入完成、删除照片、改文件夹黑名单都会走到这里。
  clearTagCountCache();
}
const totalCache = new Map<string, { value: number; timestamp: number }>();

// Photo listing
/** 列表查询的输入类型（与 IPC 的 `ListSchema` 完全一致）。*/
export type ListPhotosInput = z.infer<typeof ListSchema>;

// ── 标签子树过滤用的临时表 ────────────────────────────────────────────
// 为什么需要它（2026-10 在本机真实图库上实测：7.7 万图 / 3.1 万标签 / 420 万条 photo_tags，
// 每张图平均挂 54.5 个标签）：
//
//   原写法 `photos.id IN (SELECT pt.photo_id FROM photo_tags pt WHERE pt.tag_id IN (…))`
//   会被 SQLite 当作 LIST SUBQUERY **整体物化**。点根分类「通用」（子树 15,057 个标签、
//   几乎命中全部图片）时，这一步要物化约 420 万行 → **首页要等 10.2 秒**。
//   多标签 AND 更糟：实测「角色 AND 画风」的计数要 **57 秒**、首页 2.9 秒。
//
//   换成「逐图去探临时表的主键索引」后（EXISTS + 带主键的临时表）：
//     首页最坏 10ms（原 10,233ms），计数最坏 0.63 秒（原 57,395ms），
//     而且 6 个根分类**没有一个变差**（命中数逐项与原写法一致）。
//
// ⚠️ 临时表是**连接级**的。`getDatabase()` 返回的是模块级单例连接，
//    并且本函数全程同步、不递归，所以两次查询不会交错、不会互相覆盖。
const TAG_FILTER_TABLE = "_aim_tag_filter";

/**
 * 把「选中的标签子树」灌进临时表。
 *
 * @param groups OR 模式传 1 组（合并后的全部后代标签 id）；
 *               AND 模式每个所选标签一组，组号按数组下标。
 */
function fillTagFilterTable(groups: number[][]): void {
  const db = getDatabase();
  // ⚠️ 每次都执行 `CREATE TEMP TABLE IF NOT EXISTS`（幂等、开销可忽略），
  //    不要用「建过了就跳过」的模块级标志：临时表是连接级的，
  //    一旦连接被 closeDatabase() 重建，标志还在但表已经没了 → 直接报错。
  db.run(
    sql.raw(
      `CREATE TEMP TABLE IF NOT EXISTS ${TAG_FILTER_TABLE} (
         group_id INTEGER NOT NULL,
         tag_id INTEGER NOT NULL,
         PRIMARY KEY (group_id, tag_id)
       ) WITHOUT ROWID`
    )
  );
  db.run(sql.raw(`DELETE FROM ${TAG_FILTER_TABLE}`));

  const rows: { groupId: number; tagId: number }[] = [];
  groups.forEach((ids, groupId) => {
    for (const tagId of ids) {
      rows.push({ groupId, tagId });
    }
  });

  // 分批 INSERT：一次 2000 行（4000 个参数），远低于 SQLite 的 32766 上限，
  // 也避免上万次单独执行带来的开销。
  const CHUNK = 2000;
  for (let index = 0; index < rows.length; index += CHUNK) {
    const chunk = rows.slice(index, index + CHUNK);
    const values = sql.join(
      chunk.map((row) => sql`(${row.groupId}, ${row.tagId})`),
      sql`, `
    );
    db.run(
      sql`INSERT OR IGNORE INTO ${sql.raw(TAG_FILTER_TABLE)} (group_id, tag_id) VALUES ${values}`
    );
  }
}

/**
 * 生成「这张图是否命中第 `groupId` 组标签」的 EXISTS 条件。
 *
 * 写成两层 EXISTS 是**性能关键**：内层让 SQLite 用临时表的
 * `PRIMARY KEY (group_id, tag_id)` 做成员判断（计划里显示 `SEARCH f USING PRIMARY KEY`），
 * 而不是像 `IN (SELECT …)` 那样退化成整表扫描（实测「角色」会因此慢 80 倍）。
 */
function tagGroupCondition(groupId: number): SQL {
  return sql`EXISTS (
    SELECT 1 FROM photo_tags pt
    WHERE pt.photo_id = ${photos.id}
      AND EXISTS (
        SELECT 1 FROM ${sql.raw(TAG_FILTER_TABLE)} f
        WHERE f.group_id = ${groupId} AND f.tag_id = pt.tag_id
      )
  )`;
}

/**
 * 有界探针：第 `groupId` 组标签命中的**关联行数**（最多数到 `limit` 就停）。
 *
 * 为什么需要：AND 模式的计数想「从更窄的那一组出发」，但必须先知道哪一组窄。
 * 真正的行数要全表扫，所以这里只数到上限为止 —— 命中上限就说明这一组"很宽"。
 * 实测成本 3~6 ms（数 5 万条索引条目），完全可以每次查询都跑。
 */
function countGroupRowsUpTo(groupId: number, limit: number): number {
  const db = getDatabase();
  const row = db.get<{ c: number }>(
    sql`SELECT count(*) AS c FROM (
          SELECT 1 FROM photo_tags pt
           WHERE pt.tag_id IN (
             SELECT tag_id FROM ${sql.raw(TAG_FILTER_TABLE)} WHERE group_id = ${groupId}
           )
           LIMIT ${limit}
        )`
  );
  return row?.c ?? 0;
}

/**
 * 探针上限。实测（8 万图 / 32 万图两档、4 种标签组合）：
 *   · 一组 ≤ 4.8 万行时，从它出发明显更快（32 万图：3315ms → 332~716ms）
 *   · 一组 ≥ 7.7 万行时，从它出发反而**灾难性变慢**（实测 111 秒 / 54 秒）
 * 所以 5 万是一个既能吃到收益、又留了安全边界的阈值。
 */
const TAG_GROUP_PROBE_LIMIT = 50_000;
/**
 * AND 模式的「计数」专用条件（返回 null 表示沿用列表那套写法）。
 *
 * 为什么单独做：AND 的结果 = 交集。逐图核对每一组标签的成本 ≈ **图片总数**
 * （与命中的图有多少无关），实测 32 万图要 3.3 秒、且随图片数线性增长。
 *
 * 做法：**只有每一组都够窄时**，才改成在标签侧直接求交集
 * （`SELECT photo_id … WHERE tag_id IN (第0组) INTERSECT …`），
 * 只扫这几组标签命中的关联行，不扫全库图片。实测 32 万图 3,170ms → 388ms。
 *
 * 为什么不做「只有一组窄时从它出发」：实测那种写法**依赖 SQLite 的规划器选择**，
 * 在真实数据上很快（332ms），但在另一种数据形状下会退化成 16 秒甚至 610 秒。
 * 计数缓存只有 10 秒，宁可稳一点：**只要有一组很宽，就老实沿用原写法**。
 */
export function buildAndCountConditions(
  groupCount: number,
  // 只给测试用来缩小阈值（生产走 TAG_GROUP_PROBE_LIMIT）
  probeLimit: number = TAG_GROUP_PROBE_LIMIT
): SQL[] | null {
  if (groupCount < 2) {
    return null;
  }
  const allNarrow = Array.from({ length: groupCount }, (_, groupId) =>
    countGroupRowsUpTo(groupId, probeLimit)
  ).every((count) => count < probeLimit);

  if (!allNarrow) {
    // 有任意一组很宽 → 沿用原写法（可预测、且这种情况本来就快）
    return null;
  }

  const selects = Array.from(
    { length: groupCount },
    (_, groupId) => sql`SELECT pt.photo_id AS pid FROM photo_tags pt
                         WHERE pt.tag_id IN (
                           SELECT tag_id FROM ${sql.raw(TAG_FILTER_TABLE)} WHERE group_id = ${groupId}
                         )`
  );
  return [
    sql`${photos.id} IN (SELECT pid FROM (${sql.join(selects, sql` INTERSECT `)}))`,
  ];
}

/**
 * 列表查询的可复用核心。
 *
 * 局域网只读 API（`src/services/lan-api.ts`）与 IPC 的 `listPhotos` **共用这一个函数**，
 * 所以"隐藏文件夹黑名单""标签子树展开""COUNT 缓存"这些规则不会两边跑偏 ——
 * 手机看到的列表与桌面完全一致，没有第二套过滤逻辑需要同步维护。
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Listing keeps filter, count-cache, and pagination behavior in one route.
export function queryPhotos(input: ListPhotosInput) {
  const db = getDatabase();
  const {
    folderId,
    ungroupedOnly,
    tagId,
    tagIds,
    tagMode,
    search,
    favoriteOnly,
    sort,
    order,
    offset,
    limit,
  } = input;

  // 显式字段选择：排除 phash / contentHash / vectorId 等瀑布流不用的重型字段，
  // 每条照片节省约 116+ bytes 的结构化克隆传输
  let query = db
    .select({
      id: photos.id,
      path: photos.path,
      folderId: photos.folderId,
      filename: photos.filename,
      fileSize: photos.fileSize,
      fileDate: photos.fileDate,
      width: photos.width,
      height: photos.height,
      format: photos.format,
      thumbnailPath: photos.thumbnailPath,
      dominantColors: photos.dominantColors,
      isFavorite: photos.isFavorite,
      isIndexed: photos.isIndexed,
      isAiProcessed: photos.isAiProcessed,
      isFaceProcessed: photos.isFaceProcessed,
    })
    .from(photos)
    .$dynamic();

  // Always exclude soft-deleted photos
  const conditions: SQL[] = [isNull(photos.deletedAt)];
  let ungroupedCondition: SQL | null = null;

  // ── 自用精简版：文件夹黑名单（视图级过滤，绝不取消索引）──────────────
  // 黑名单里的照片/缩略图/向量/人脸/phash 全部保留，搜索链路不做过滤，
  // 因此用户仍然可以搜到它们；这里只是不让它们出现在浏览视图里。
  //
  // ⚠️ 2026-10 用户口径（NEXT）：**按标签检索时不做这个过滤**——
  //    「浏览文件夹的时候不显示，按标签检索的时候正常显示」。
  //    起因：树上徽章是**全局统计**（含黑名单文件夹），而相册口径排除了它们，
  //    于是"点标签却 0 张"看起来像 bug（实测那 5 个标签命中的照片全在 NSFW 目录里）。
  //    显式的标签检索应当返回全部命中；只有"按文件夹浏览"才隐藏。
  const hasTagFilter = Boolean((tagIds && tagIds.length > 0) || tagId != null);
  const folderRows = getAllFolderPathItems();
  const hiddenPaths = getHiddenFolderPaths();
  const excludedFolderIds = hasTagFilter
    ? []
    : resolveExcludedFolderIds(folderRows);
  const excludedIdSet = new Set(excludedFolderIds);

  if (folderId) {
    const subtreeIds = getFolderSubtreeIds(folderRows, folderId);
    // 若当前选中的文件夹本身就在黑名单子树内，说明用户是主动点进去的 → 放行；
    // 否则（选中父目录或「全部照片」）把黑名单子树从可见集合里剔除。
    const visibleIds = excludedIdSet.has(folderId)
      ? subtreeIds
      : subtreeIds.filter((id) => !excludedIdSet.has(id));
    conditions.push(
      visibleIds.length > 0
        ? inArray(photos.folderId, visibleIds)
        : eq(photos.folderId, folderId)
    );
  } else if (excludedFolderIds.length > 0) {
    // 「全部照片」等不带文件夹条件的视图同样要过滤。
    // 必须包 or(isNull(...))：SQL 里 `NULL NOT IN (...)` 的结果是 NULL 而非 true，
    // 不加这一层会让 folderId 为 NULL 的孤儿照片从「全部照片」里凭空消失。
    conditions.push(
      or(
        isNull(photos.folderId),
        notInArray(photos.folderId, excludedFolderIds)
      ) as SQL
    );
  }

  // Multi-tag filtering with AND/OR support
  // Backward compat: if tagId is provided without tagIds, treat as single-tag OR
  let effectiveTagIds: number[] | null = null;
  let effectiveTagMode: "and" | "or" = "or";
  if (tagIds && tagIds.length > 0) {
    effectiveTagIds = tagIds;
    effectiveTagMode = tagMode ?? "or";
  } else if (tagId != null) {
    effectiveTagIds = [tagId];
  }
  let selectedDescendantIds: number[] = [];
  // 标签条件在 `conditions` 里的范围；以及 AND 模式给「计数」单独选出来的条件
  // （null = 沿用列表那套写法）。
  let tagConditionStart = 0;
  let tagConditionEnd = 0;
  let tagCountConditions: SQL[] | null = null;

  if (effectiveTagIds && effectiveTagIds.length > 0) {
    // Collect all descendant tag IDs for each root tag
    const allTags = db.select().from(tags).all();
    const childrenMap = new Map<number, number[]>();
    for (const t of allTags) {
      if (t.parentId != null) {
        const list = childrenMap.get(t.parentId);
        if (list) {
          list.push(t.id);
        } else {
          childrenMap.set(t.parentId, [t.id]);
        }
      }
    }

    // Collect descendants for each root tag ID
    const rootDescendantSets: Set<number>[] = [];
    for (const rootId of effectiveTagIds) {
      const descendantIds = new Set<number>();
      const visited = new Set<number>();
      (function collect(pid: number) {
        if (visited.has(pid)) {
          return;
        }
        visited.add(pid);
        descendantIds.add(pid);
        const kids = childrenMap.get(pid);
        if (kids) {
          for (const kid of kids) {
            collect(kid);
          }
        }
      })(rootId);
      rootDescendantSets.push(descendantIds);
    }

    if (effectiveTagMode === "or") {
      // OR 模式：命中「合并后的全部后代标签」中的任意一个即可
      const allDescendantIds = new Set<number>();
      for (const set of rootDescendantSets) {
        for (const id of set) {
          allDescendantIds.add(id);
        }
      }
      const idArray = [...allDescendantIds];
      selectedDescendantIds = idArray;
      if (idArray.length > 0) {
        // 全部后代标签合并成第 0 组
        fillTagFilterTable([idArray]);
        conditions.push(tagGroupCondition(0));
      }
    } else {
      // AND 模式：每个所选标签各要命中一个（组号 = 数组下标）
      selectedDescendantIds = [
        ...new Set(rootDescendantSets.flatMap((set) => [...set])),
      ];
      const groups = rootDescendantSets
        .map((set) => [...set])
        .filter((ids) => ids.length > 0);
      if (groups.length > 0) {
        fillTagFilterTable(groups);
        tagConditionStart = conditions.length;
        groups.forEach((_, groupId) => {
          conditions.push(tagGroupCondition(groupId));
        });
        tagConditionEnd = conditions.length;
        // 计数单独选型（只有 AND 且 ≥2 组才可能换写法）
        tagCountConditions = buildAndCountConditions(groups.length);
      }
    }
  }
  if (search) {
    if (GLOB_WILDCARD_RE.test(search)) {
      conditions.push(sql`LOWER(${photos.filename}) GLOB LOWER(${search})`);
    } else {
      conditions.push(like(photos.filename, `%${search}%`));
    }
  }
  if (favoriteOnly) {
    conditions.push(eq(photos.isFavorite, true));
  }
  if (ungroupedOnly) {
    ungroupedCondition = sql`NOT EXISTS (SELECT 1 FROM ${photoSequenceMembers} WHERE ${photoSequenceMembers.photoId} = ${photos.id})`;
    conditions.push(ungroupedCondition);
  }

  query = query.where(and(...conditions));

  let sortCol:
    | typeof photos.fileDate
    | typeof photos.filename
    | typeof photos.fileSize = photos.fileDate;
  if (sort === "name") {
    sortCol = photos.filename;
  } else if (sort === "size") {
    sortCol = photos.fileSize;
  }
  query = query.orderBy(order === "asc" ? sortCol : desc(sortCol));

  // Build cache key from filter-relevant params (excluding sort/order/offset/limit)
  const countCacheKey = JSON.stringify({
    folderId: folderId ?? null,
    tagId: tagId ?? null,
    tagIds: effectiveTagIds ?? null,
    tagMode: effectiveTagMode,
    search: search ?? null,
    favoriteOnly: favoriteOnly ?? null,
    ungroupedOnly: ungroupedOnly ?? false,
    // 自用精简版：黑名单变化必须使计数缓存失效，否则切换后 10 秒内数字不动
    hiddenPaths: hiddenPaths.join("|"),
  });

  let total: number;
  const cachedTotal = totalCache.get(countCacheKey);
  if (cachedTotal && Date.now() - cachedTotal.timestamp < COUNT_CACHE_TTL) {
    total = cachedTotal.value;
  } else {
    // 计数用的条件：AND 模式可能换成「从窄的那一组出发」的写法（见 buildAndCountConditions）。
    // 标签条件在 conditions 里是连续的一段 [tagConditionStart, tagConditionEnd)，
    // 所以只要把那一段替换掉即可，文件夹/搜索/收藏等条件原样保留。
    const countConditions = tagCountConditions
      ? [
          ...conditions.slice(0, tagConditionStart),
          ...tagCountConditions,
          ...conditions.slice(tagConditionEnd),
        ]
      : conditions;
    let countQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(photos)
      .$dynamic();
    countQuery = countQuery.where(and(...countConditions));
    total = countQuery.get()?.count || 0;

    // Evict oldest entry if at capacity, then store
    if (totalCache.size >= MAX_COUNT_CACHE) {
      const lru = totalCache.keys().next().value;
      if (lru !== undefined) {
        totalCache.delete(lru);
      }
    }
    totalCache.set(countCacheKey, { value: total, timestamp: Date.now() });
  }
  let items = query
    .limit(limit)
    .offset(offset)
    .all()
    .map((photo) => ({
      ...photo,
      thumbnailSmallPath: null,
    }));
  if (items.length > 0 && selectedDescendantIds.length > 0) {
    const selectedPhotoIds = items.map((photo) => photo.id);
    const matchingTagSources = db
      .select({
        origin: photoTags.origin,
        photoId: photoTags.photoId,
        userConfirmed: photoTags.userConfirmed,
        tagName: tags.name,
      })
      .from(photoTags)
      .innerJoin(tags, eq(tags.id, photoTags.tagId))
      .where(
        and(
          inArray(photoTags.photoId, selectedPhotoIds),
          inArray(photoTags.tagId, selectedDescendantIds)
        )
      )
      .all();
    const trustedPhotoIds = new Set(
      matchingTagSources
        .filter((row) => row.origin === "manual" || Boolean(row.userConfirmed))
        .map((row) => row.photoId)
    );
    // 自用：缩略图角标要显示"这张图命中了你所选标签中的哪几个"（最多 3 个），
    // 所以在同一次查询里把命中的标签名也带上 —— 不额外增加查询。
    //
    // 自用（问题 2）：角标颜色也要**按所属主类**来（与标签树/顶部 chips 同一套规则），
    // 所以这里顺带把每个命中标签的颜色也算出来（一次性读小表 tags，成本可忽略）。
    const colorTagRows = db
      .select({
        color: tags.color,
        id: tags.id,
        name: tags.name,
        parentId: tags.parentId,
      })
      .from(tags)
      .all();
    const colorTagByName = new Map(colorTagRows.map((row) => [row.name, row]));
    const colorTagById = new Map(colorTagRows.map((row) => [row.id, row]));
    const namesByPhoto = new Map<number, string[]>();
    const colorsByPhoto = new Map<number, string[]>();
    for (const row of matchingTagSources) {
      // photo_tags.photo_id 在 schema 里可空，这里必须挡住 null
      if (!row.tagName || row.photoId === null) {
        continue;
      }
      const photoId = row.photoId;
      const list = namesByPhoto.get(photoId);
      if (!list) {
        namesByPhoto.set(photoId, [row.tagName]);
      } else if (list.length < 3 && !list.includes(row.tagName)) {
        list.push(row.tagName);
      } else {
        // 名字已满 3 个（或重复）→ 颜色也保持一一对应
        continue;
      }
      const tagRow = colorTagByName.get(row.tagName);
      if (tagRow) {
        const colors = colorsByPhoto.get(photoId) ?? [];
        colors.push(resolveTagDotColor(tagRow, colorTagById));
        colorsByPhoto.set(photoId, colors);
      }
    }
    items = items.map((photo) => ({
      ...photo,
      match: {
        kind: "tagFilter" as const,
        origin: trustedPhotoIds.has(photo.id)
          ? ("manual" as const)
          : ("auto" as const),
        tagColors: colorsByPhoto.get(photo.id) ?? [],
        tagNames: namesByPhoto.get(photo.id) ?? [],
      },
    }));
  }

  let totalAll: number | undefined;
  if (ungroupedCondition) {
    const allCountQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(photos)
      .$dynamic();
    const filteredAllCountQuery = allCountQuery.where(
      and(...conditions.filter((condition) => condition !== ungroupedCondition))
    );
    totalAll = filteredAllCountQuery.get()?.count || 0;
  }

  return {
    items,
    total,
    ...(totalAll === undefined ? {} : { totalAll }),
    offset,
    limit,
  };
}

export const listPhotos = os.input(ListSchema).handler(({ input }) =>
  queryPhotos(input)
);

// Photo detail
/** 按 id 取整行照片记录（含 `path`）。局域网 API 用它再映射成不含路径的安全结构。*/
export function queryPhotoById(id: number) {
  const db = getDatabase();
  return db.select().from(photos).where(eq(photos.id, id)).get() ?? null;
}

export const getPhotoDetail = os.input(IdSchema).handler(({ input }) =>
  queryPhotoById(input.id)
);

export const getPhotoExif = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  const basic = db
    .select()
    .from(exifData)
    .where(eq(exifData.photoId, input.id))
    .get();
  if (!basic) {
    return null;
  }
  const advancedRow = db
    .select()
    .from(advancedExifData)
    .where(eq(advancedExifData.photoId, input.id))
    .get();
  if (!advancedRow) {
    return { ...basic, advanced: null };
  }
  try {
    const normalized = advancedRow.normalizedJson
      ? JSON.parse(advancedRow.normalizedJson)
      : null;
    const vendorRaw = advancedRow.vendorRawJson
      ? JSON.parse(advancedRow.vendorRawJson)
      : {};
    return {
      ...basic,
      advanced: normalized ? { ...normalized, vendorRaw } : null,
      advancedStatus: advancedRow.status,
    };
  } catch {
    return { ...basic, advanced: null, advancedStatus: advancedRow.status };
  }
});
