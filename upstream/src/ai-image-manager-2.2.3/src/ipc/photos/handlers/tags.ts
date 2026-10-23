import { ORPCError, os } from "@orpc/server";
import { PRIVATE_BUILD } from "@/config/private-build";
import { createLogger } from "@/utils/logger";
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
import {
  analyzeUnnamedCharacters as analyzeCharactersService,
  describeCharacterFeatureUnavailable,
  resolveCharacterFeatureAccess,
} from "@/services/character-suggest";
import { buildCcipVectors, cancelCcipVectorsBuild, getCcipBuildProgress } from "@/services/ai/ccip-embedder";
import { clusterCharacterCandidates, getClusterProgress } from "@/services/character-cluster";
import { clearUnnamedCharacterResults as clearUnnamedCharacterResultsService } from "@/services/character-result-cleanup";
import { getCharacterSuggestProgress as getCharacterSuggestProgressService } from "@/services/character-suggest";
import { setManualRoleCover as setManualRoleCoverInStore } from "@/services/character-group-store";
import { resolveCharacterFeatureStatus } from "@/services/ccip-model";
import { getDataPath } from "@/utils/data-path";
import path from "node:path";
import {
  CHARACTER_ROOT_TAG_NAME,
  loadTagRows,
} from "@/services/character-tags";
import {
  addManualRole,
  clearCharacterGroups,
  listManualRoles,
  markGroupNamed,
  pruneManualRoles,
  readCharacterGroups,
  renameManualRole,
  writeCharacterGroups,
} from "@/services/character-group-store";
import { getFolderSubtreeIds } from "@/services/folder-hierarchy";
import {
  persistTagCounts,
  readPersistedTagCounts,
  readTagCountCache,
  writeTagCountCache,
} from "@/services/tag-count-cache";
import { getTagSearchRevision, invalidateTagSearch } from "@/services/tag-search-revision";
import {
  getHiddenTagsState,
  setTagHiddenById,
} from "@/services/tag-exclusions";
import {
  BatchPhotoIdsSchema,
  HiddenTagToggleSchema,
  IdSchema,
  withUserFacingError,
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
/**
 * 读图库指纹 —— 用来判断落盘快照是否过期。
 * 三个数任意一个变了都说明图库内容动过：图片数（导入/删除）、
 * 关联行数（标签增删）、关联最大 id（自增，任何新增都会变大）。
 * 成本实测：8 万图 47ms / 32 万图 180ms，只在「内存缓存未命中且是全局视图」时跑一次。
 */
function readTagCountFingerprint() {
  const db = getDatabase();
  const photoRow = db.get<{ c: number; d: number }>(
    sql`SELECT count(*) AS c,
               count(CASE WHEN deleted_at IS NOT NULL THEN 1 END) AS d
          FROM photos`
  );
  const linkRow = db.get<{ c: number; m: number | null }>(
    sql`SELECT count(*) AS c, max(id) AS m FROM photo_tags`
  );
  return {
    photoCount: photoRow?.c ?? 0,
    // 软删除的照片数也要进指纹：删图不会改变任何行数
    deletedPhotoCount: photoRow?.d ?? 0,
    linkCount: linkRow?.c ?? 0,
    maxLinkId: linkRow?.m ?? 0,
  };
}

/** 自用（性能排查）：把关键路径的真实耗时写进日志，先量再改。 */
const perf = createLogger("perf");

export function queryTagPhotoCounts(folderId?: number): Map<number, number> {
  const db = getDatabase();
  // 自用（性能排查）：这条统计是**同步** SQL，跑起来会堵住主进程，先记真实耗时
  const perfStartedAt = Date.now();

  // 这条统计要 3 秒以上（见 tag-count-cache.ts 的说明），而它只在图库内容变化时才变，
  // 所以先查内存缓存，再查落盘快照。
  const cacheKey = folderId ?? null;
  const revision = getTagSearchRevision();
  const cached = readTagCountCache(cacheKey, revision);
  if (cached) {
    perf.debug(
      {
        cached: "memory",
        folderId: folderId ?? null,
        ms: Date.now() - perfStartedAt,
        tags: cached.size,
      },
      "[perf] 标签徽标统计"
    );
    return cached;
  }

  // 落盘快照只对「全局视图」有效 —— 按文件夹统计的口径不同，不能复用。
  const fingerprint = cacheKey === null ? readTagCountFingerprint() : null;
  if (fingerprint) {
    const persisted = readPersistedTagCounts(fingerprint);
    if (persisted) {
      perf.debug(
        {
          cached: "snapshot",
          folderId: folderId ?? null,
          ms: Date.now() - perfStartedAt,
          tags: persisted.size,
        },
        "[perf] 标签徽标统计"
      );
      writeTagCountCache(cacheKey, revision, persisted);
      return persisted;
    }
  }

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

  /*
   * 自用（性能 C）：把这条统计拆成两段，别再为**叶子标签**做无谓的闭包连接。
   *
   * 原写法把整棵标签层级的闭包 JOIN photo_tags（420 万行）再 COUNT(DISTINCT)，
   * 中间结果有几千万行 —— 实测 **4106ms**（folderId=28），而且它是**同步** SQL，
   * 主进程被堵住的这 4 秒里，图片区的滚动、缩略图请求全部排队。
   *
   * 但词表里**只有 19 个节点有子标签**（6 个主类 + 13 个细类），其余三万多全是叶子；
   * 叶子的数量**就等于它自己的直接计数**。所以：
   *   ① 直接计数（走 tag_id 索引分组）一次覆盖所有叶子；
   *   ② 只有那 19 个节点需要"整棵子树去重"，逐个用递归子树做。
   *
   * 结果与原算法**逐一相同**：已用真实库比对 11,670 个标签，**0 处差异**。
   * 回退：private-build.ts 的 `legacyBadgeCountQuery` 改 true 即走旧写法。
   */
  const counts = new Map<number, number>();

  if (PRIVATE_BUILD.legacyBadgeCountQuery) {
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
    for (const row of countRows) {
      counts.set(Number(row.tag_id), Number(row.c));
    }
  } else {
    // ① 直接计数（叶子用它就是最终答案）
    const directRows = db.all<{ tag_id: number; c: number }>(sql`
      SELECT pt.tag_id AS tag_id, COUNT(DISTINCT pt.photo_id) AS c
        FROM photo_tags pt
        JOIN photos p ON p.id = pt.photo_id
       WHERE p.deleted_at IS NULL
         ${folderFilter}
       GROUP BY pt.tag_id
    `);
    for (const row of directRows) {
      counts.set(Number(row.tag_id), Number(row.c));
    }

    /*
     * ② 有子标签的节点：把子树并起来去重。
     * 用递归 CTE + `IN (SELECT ...)`（子查询，SQLite 能用索引），
     * **不用巨型 IN 字面量列表** —— 上次改成字面量列表就是在这里翻车的。
     *
     * ⚠️ 自用（2026-10-16，**修"点标签页 → 界面未响应、只能强杀"**）：
     * 原来这里是**逐个根节点**各跑一次递归子树计数 ✗（19 个节点 = 19 条同步 SQL）。
     * 真实库实测（7.7 万图 / 421 万条关联 / E:\图 的 4,411 个目录）：
     *   · 逐根跑（旧写法）：**90 秒仍未结束** ✗ —— 应用里就是"未响应"，
     *     日志也停写（`query-trace.log` 抓到的最后一条正是它 ✓）
     *   · 合成一条（闭包只含这 19 个根）：**3.7~4.1 秒** ✓
     * 原因：旧写法每个根都把"整棵标签闭包"重算一遍、再各扫一遍 photo_tags ✗；
     * 合成一条后闭包只算一次，`GROUP BY root` 一次拿到全部结果 ✓。
     * 结果与原算法**逐行相同**（实测 19 个根、合计 991,727，两版一致 ✓）。
     */
    const parentRows = db.all<{ id: number; parent_id: number | null }>(
      sql`SELECT id, parent_id FROM tags`
    );
    const parents = new Set<number>();
    for (const row of parentRows) {
      if (row.parent_id !== null) {
        parents.add(row.parent_id);
      }
    }
    const roots = [...parents];
    if (roots.length > 0) {
      // 没有任何照片落在子树里时，旧写法明确写入 0 ✓，这里保持一致
      for (const root of roots) {
        counts.set(root, 0);
      }
      const rootList = sql.join(
        roots.map((id) => sql`${id}`),
        sql`, `
      );
      const subtreeRows = db.all<{ tag_id: number; c: number }>(sql`
        WITH RECURSIVE closure(root, desc) AS (
          SELECT id, id FROM tags WHERE id IN (${rootList})
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
      for (const row of subtreeRows) {
        counts.set(Number(row.tag_id), Number(row.c));
      }
    }
  }

  perf.info(
    {
      cached: false,
      folderId: folderId ?? null,
      legacy: PRIVATE_BUILD.legacyBadgeCountQuery,
      ms: Date.now() - perfStartedAt,
      tags: counts.size,
    },
    "[perf] 标签徽标统计"
  );
  writeTagCountCache(cacheKey, revision, counts);
  if (fingerprint) {
    // 落盘：下次（含重启后）就不用再跑这条 3 秒以上的统计
    persistTagCounts(fingerprint, counts);
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

/**
 * 自用（2026-10-20 · 会话#10）：全库还有多少张"零标签"的图。
 * 与 `getTaggingCoverage` 共用同一条 SQL 判据（那边实测 77k 张约 57ms）。
 */
function countUntaggedPhotos(): number {
  const db = getDatabase();
  const row = db.get<{ c: number }>(sql`
    SELECT count(*) AS c
      FROM photos p
     WHERE p.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id)
  `);
  return Number(row?.c ?? 0);
}

/**
 * 自用（2026-10-20 · 会话#10）：**服务端也要把关**（用户口径 2026-10-17）。
 *
 * 「人物识别只有在全库打标完成之后才能开始」—— 两个识别入口都靠**打标产出的角色标签**：
 *   · 「分析未命名角色」= 用已有角色标签当种子；
 *   · 打标没跑完时点它，只会基于"半套标签"给结果，看起来就像"认不全" ✗。
 * 这条以前**只写在界面上**（按钮 disabled + 一行提示），数据/刷新时机不对就能绕过去；
 * 现在补上服务端判据，并给出可执行的中文提示（配合 `withUserFacingError` 才看得见）。
 */
function assertTaggingCompleteForCharacterRecognition(): void {
  const untagged = countUntaggedPhotos();
  if (untagged > 0) {
    throw new Error(
      `还有 ${untagged} 张图没有打标，角色识别要等全库打标跑完（它靠打标产出的角色标签找"未命名的角色"）。请先在侧边栏点「生成 AI 标签」把剩余的图打完。`
    );
  }
}

/** 自用（2026-10-17，用户口径）：**「全库打标完成」的门禁** ✓
 *
 * 为什么需要：人物识别（角色识别）的两个入口都**靠打标产出的角色标签**：
 *   · 「分析未命名角色」= 用已有角色标签当种子；
 *   · 打标没跑完时点它，只会基于"半套标签"给结果，看起来就像"认不全" ✗。
 * 用户口径：「人物识别只有在全库打标完成之后才能开始」；新图走同一条链路：
 *   **自动扫描 → 提取特征 → 自动打标**（这条本来就有：`embedAllPhotos` 结束时会自动
 *   给这批图打标，见 `pendingAutoTagPhotoIds`）✓，打完才解锁人物识别 ✓。
 *
 * 判据：**没有任何一张未删除的照片是"零标签"** —— 比"游标到哪"更准 ✓
 * （游标跑过但打标失败的图会被抓出来）。
 */
export const getTaggingCoverage = os.handler(() => {
  const db = getDatabase();
  const total =
    db.get<{ c: number }>(sql`
      SELECT count(*) AS c FROM photos WHERE deleted_at IS NULL
    `)?.c ?? 0;
  const untagged = countUntaggedPhotos();
  return {
    total: Number(total),
    untagged,
    /** 全库每张图都至少有一个标签 → 人物识别可用 ✓ */
    complete: untagged === 0,
  };
});

/**
 * 自用新增：人物识别 —— 找出「未命名的同角色」并写入 AI 建议标签。
 *
 * 结果不会当成事实：写入的是 `origin = "auto"` + `userConfirmed = false` 的
 * **建议**，冲突时不覆盖任何已有标签，用户走现有标签确认流程即可。
 *
 * 注意：这是一次较重的分析（要对每个角色做一次向量检索），可能耗时几十秒。
 */
/**
 * 自用（2026-10-18 · 会话#9）：**"识别漏标签的已有角色"的分析进度**（界面轮询用）。
 * 用户反馈「这个分析有点久」→ 弹窗里要显示"走到哪一步、已处理多少"✓
 */
export const getCharacterSuggestProgress = os
  .input(z.object({}).optional())
  .handler(() => getCharacterSuggestProgressService());

export const analyzeUnnamedCharacters = os
  .input(
    z
      .object({
        dryRun: z.boolean().optional().default(false),
        minSimilarity: z.number().min(0).max(1).optional(),
        minPhotos: z.number().int().min(1).max(500).optional(),
      })
      .optional()
  )
  .handler(async ({ input }) => {
    // 自用（2026-10-20 · 会话#10）：守卫提示原样送界面，别再变成 "Internal server error"
    const result = await withUserFacingError(async () => {
      // 用户口径：全库打标没完成不允许做角色识别（见上面那条函数的说明）
      assertTaggingCompleteForCharacterRecognition();
      return analyzeCharactersService({
        dryRun: input?.dryRun ?? false,
        minPhotos: input?.minPhotos,
        minSimilarity: input?.minSimilarity,
      });
    });
    invalidateTagSearch();
    /*
     * 自用（2026-10-18 · 会话#9 用户口径）：结果列表要**和 LAN 版「发现没有标签的角色」同一个样式**
     * —— 每行带几张缩略图（原来是纯文字行，用户反馈"不是之前那个样式的了"）。
     * 所以在服务端一次把这 20 个角色各自前几张图的缩略图查好，省得渲染进程再查一遍。
     */
    const proposals = result.proposals.slice(0, 20);
    const thumbMap = new Map<number, string>();
    const thumbIds = new Set<number>();
    for (const proposal of proposals) {
      for (const id of proposal.photoIds.slice(0, 5)) {
        thumbIds.add(id);
      }
    }
    if (thumbIds.size > 0) {
      const db = getDatabase();
      const ids = [...thumbIds];
      const CHUNK = 400;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const rows = db
          .select({
            id: photos.id,
            thumbnailPath: photos.thumbnailPath,
            path: photos.path,
          })
          .from(photos)
          .where(inArray(photos.id, ids.slice(i, i + CHUNK)))
          .all();
        for (const row of rows) {
          const value = row.thumbnailPath || row.path;
          if (value) {
            thumbMap.set(row.id, value);
          }
        }
      }
    }
    // 只回统计与分组概况，避免把几万条 photoId 丢给渲染进程
    return {
      applied: result.applied,
      candidateCount: result.candidateCount,
      characterCount: result.characterCount,
      seedPhotos: result.seedPhotos,
      skippedCharacters: result.skippedCharacters,
      unnamedPhotos: result.unnamedPhotos,
      topGroups: proposals.map((proposal) => ({
        tagId: proposal.tagId,
        tagName: proposal.tagName,
        count: proposal.photoIds.length,
        photoIds: proposal.photoIds.slice(0, 2000),
        meanSimilarity: Math.round(proposal.meanSimilarity * 1000) / 1000,
        seedCount: proposal.seedCount,
        thumbnails: proposal.photoIds
          .slice(0, 5)
          .map((id) => thumbMap.get(id))
          .filter((value): value is string => typeof value === "string"),
      })),
    };
  });

/**
 * 自用新增（2026-10）：角色识别的**特征源状态**。
 *
 * 界面用它决定"角色识别能不能用 / 该显示哪句提示"：
 *   · source = "ccip"        → 用 CCIP（模型在、特征也算好了）
 *   · source = "clip"        → 用户手动关了开关，走现有特征
 *   · source = "unavailable" → 开关开着但缺模型 / 缺特征 → 停用并提示
 */
export const getCharacterFeatureStatus = os
  .input(z.object({}).optional())
  .handler(async () => {
    const modelsDir = path.join(getDataPath(), "models");
    const status = await resolveCharacterFeatureStatus(modelsDir);
    return {
      source: status.source,
      reason: status.reason,
      preferCcip: status.preferCcip,
      modelAvailable: status.modelAvailable,
      vectorCount: status.vectorCount,
      message:
        status.source === "unavailable"
          ? describeCharacterFeatureUnavailable(status)
          : null,
    };
  });

/**
 * 自用新增（2026-10）：生成全库 **CCIP 角色特征**（一次性，几小时；可取消、可续算）。
 *
 * 只在「首选 CCIP」且模型就位时才允许 —— 否则明确报错，让用户知道该放模型还是关开关。
 */
export const buildCharacterFeatures = os
  .input(
    z
      .object({
        limit: z.number().int().min(1).optional(),
        workers: z.number().int().min(1).max(12).optional(),
        threadsPerWorker: z.number().int().min(1).max(16).optional(),
      })
      .optional()
  )
  .handler(async ({ input }) => {
    const modelsDir = path.join(getDataPath(), "models");
    /*
     * 自用（2026-10-20 · 会话#10）：这条最容易被"守卫"拒绝 ——
     * "AI 正忙（running），先等建向量 / 打标跑完"原来是普通 Error，
     * 界面上只看到一句 "Internal server error"（用户实测）。
     * 包一层把原话送到界面。
     */
    return withUserFacingError(() =>
      buildCcipVectors({
        modelsDir,
        limit: input?.limit,
        workers: input?.workers,
        threadsPerWorker: input?.threadsPerWorker,
      })
    );
  });

/** 自用新增（2026-10）：取消正在进行的角色特征生成（已算好的保留）。 */
export const cancelCharacterFeatures = os
  .input(z.object({}).optional())
  .handler(() => ({ cancelled: cancelCcipVectorsBuild() }));

/**
 * 自用新增（2026-10）：角色特征生成的**实时进度**（界面轮询用）。
 *
 * 全库要跑几小时，必须能看见"已处理/总数/已写入/失败/速度/预计剩余"，
 * 否则用户只能对着一个不动的小时级黑箱等。
 */
export const getCharacterFeatureProgress = os
  .input(z.object({}).optional())
  .handler(() => getCcipBuildProgress());

/** 自用新增（2026-10）：聚类分析的实时进度（界面轮询用；全库约几分钟）。 */
export const getCharacterClusterProgress = os
  .input(z.object({}).optional())
  .handler(() => getClusterProgress());

/**
 * 自用新增（2026-10）：**发现「没有角色标签」的角色组**（无监督聚类）。
 *
 * 与 `analyzeUnnamedCharacters`（种子 + 投票，必须有现成角色标签）互补：
 * 这条从"没标签的图本身"出发，把彼此很像的图聚成组，交由用户命名。
 */
export const discoverUnnamedCharacterGroups = os
  .input(
    z
      .object({
        similarityThreshold: z.number().min(0.5).max(0.99).optional(),
        minGroupSize: z.number().int().min(2).max(50).optional(),
        maxGroupSize: z.number().int().min(10).max(1000).optional(),
        limit: z.number().int().min(1).optional(),
      })
      .optional()
  )
  .handler(async ({ input }) => {
    // 自用（2026-10-20 · 会话#10）：同 analyzeUnnamedCharacters —— 守卫提示原样送界面
    const result = await withUserFacingError(async () => {
      // 用户口径：全库打标没完成不允许做角色识别（"发现无标签簇"同样靠打标结果判断"有没有标签"）
      assertTaggingCompleteForCharacterRecognition();
      return clusterCharacterCandidates({
        similarityThreshold: input?.similarityThreshold,
        minGroupSize: input?.minGroupSize,
        maxGroupSize: input?.maxGroupSize,
        limit: input?.limit,
      });
    });

    // 取每组的封面/预览缩略图（服务端一次查好，省得渲染进程再查一遍）
    // 上限放宽到 200 组：用户实测反馈"只显示 60 组会漏掉后面的"，缩略图走懒加载，够用。
    const topGroups = result.groups.slice(0, 200);
    const thumbIds = new Set<number>();
    for (const group of topGroups) {
      thumbIds.add(group.representativeId);
      for (const id of group.photoIds.slice(0, 8)) {
        thumbIds.add(id);
      }
    }
    const thumbMap = new Map<number, string>();
    if (thumbIds.size > 0) {
      const db = getDatabase();
      const ids = [...thumbIds];
      const CHUNK = 400;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const rows = db
          .select({
            id: photos.id,
            thumbnailPath: photos.thumbnailPath,
            path: photos.path,
          })
          .from(photos)
          .where(inArray(photos.id, ids.slice(i, i + CHUNK)))
          .all();
        for (const row of rows) {
          const value = row.thumbnailPath || row.path;
          if (value) {
            thumbMap.set(row.id, value);
          }
        }
      }
    }

    const groups = topGroups.map((group) => {
      const previewIds = [
        group.representativeId,
        ...group.photoIds.filter((id) => id !== group.representativeId),
      ].slice(0, 8);
      return {
        // 完整成员 id：命名时要一次全打上标签，不能截断
        photoIds: group.photoIds,
        size: group.size,
        meanSimilarity: Math.round(group.meanSimilarity * 1000) / 1000,
        representativeId: group.representativeId,
        thumbnails: previewIds
          .map((id) => thumbMap.get(id))
          .filter((value): value is string => typeof value === "string"),
        namedTagId: null as number | null,
        namedTagName: null as string | null,
      };
    });

    // 存盘：用户不可能一口气命名完，中途关掉对话框/软件都要能接着来。
    // ⚠️ manualRoles 要**保留**：重新分析不该把用户已经手动创建的角色清空。
    writeCharacterGroups({
      createdAt: Date.now(),
      threshold: result.threshold,
      candidates: result.candidates,
      groups,
      manualRoles: readCharacterGroups()?.manualRoles ?? [],
    });

    return {
      groups,
      groupCount: result.groups.length,
      candidates: result.candidates,
      embedded: result.embedded,
      cancelled: result.cancelled,
      elapsedMs: result.elapsedMs,
      threshold: result.threshold,
    };
  });

/**
 * 自用新增（2026-10）：按**标签**取该角色下的全部照片。
 *
 * 用途（用户要求）："我创建的角色"卡片也能展开看整组图、点大图、勾选。
 * 这些角色是标签，手里只有 `tagId`，所以要按标签反查照片。
 */
export const listTagPhotos = os
  .input(
    z.object({
      limit: z.number().int().min(1).max(3000).optional(),
      tagId: z.number().int().positive(),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const limit = input.limit ?? 3000;
    const links = db
      .select({ photoId: photoTags.photoId })
      .from(photoTags)
      .where(eq(photoTags.tagId, input.tagId))
      .limit(limit)
      .all();
    const ids = links
      .map((row) => row.photoId)
      .filter((id): id is number => typeof id === "number");
    if (ids.length === 0) {
      return { photos: [] };
    }
    const out: Array<{
      fileSize: number;
      filename: string;
      height: number;
      id: number;
      path: string;
      thumbnailPath: string | null;
      width: number;
    }> = [];
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = db
        .select({
          id: photos.id,
          path: photos.path,
          filename: photos.filename,
          fileSize: photos.fileSize,
          width: photos.width,
          height: photos.height,
          thumbnailPath: photos.thumbnailPath,
        })
        .from(photos)
        .where(
          and(
            inArray(photos.id, ids.slice(i, i + CHUNK)),
            isNull(photos.deletedAt)
          )
        )
        .all();
      for (const row of rows) {
        if (!row.path) {
          continue;
        }
        out.push({
          id: row.id,
          path: row.path,
          filename: row.filename,
          fileSize: row.fileSize ?? 0,
          width: row.width ?? 0,
          height: row.height ?? 0,
          thumbnailPath: row.thumbnailPath ?? null,
        });
      }
    }
    return { photos: out };
  });

/**
 * 自用新增（2026-10）：把勾选的图从某个角色上**撤下来**（"退回未命名"）。
 *
 * 用户口径："遇到不符合的也能直接退回未命名列表"。
 * 做两件事：
 *   ① 删掉这些照片与该角色的关联（**只删 `user_confirmed = 0` 的**，
 *      也就是"建议标签"级别的关联 —— 用户已经确认过的标签绝不动 ✗）；
 *   ② 顺手把这批图**追加成一个新的"待命名组"**写进分组缓存，
 *      这样回到「发现没有标签的角色」就能立刻看到它们（真的"退回列表"了 ✓），
 *      而不是要等下一次全库聚类。
 */
export const removeTagFromPhotos = os
  .input(
    z.object({
      photoIds: z.array(z.number().int().positive()).min(1).max(3000),
      tagId: z.number().int().positive(),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const ids = [...new Set(input.photoIds)];
    let removed = 0;
    const CHUNK = 400;
    db.transaction(() => {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const result = db
          .delete(photoTags)
          .where(
            and(
              eq(photoTags.tagId, input.tagId),
              inArray(photoTags.photoId, slice),
              // 保护已确认的标签：只撤"建议"级别的关联
              eq(photoTags.userConfirmed, false)
            )
          )
          .run();
        removed += Number(result?.changes ?? 0);
      }
    });
    invalidateTagSearch();

    // 把这批图作为新的"待命名组"放回缓存，用户回列表就能看到
    const stored = readCharacterGroups();
    if (stored) {
      const thumbnails = ids
        .slice(0, 8)
        .map((id) =>
          db
            .select({ thumbnailPath: photos.thumbnailPath, path: photos.path })
            .from(photos)
            .where(eq(photos.id, id))
            .get()
        )
        .map((row) => row?.thumbnailPath ?? row?.path ?? null)
        .filter((value): value is string => typeof value === "string");
      stored.groups = [
        {
          photoIds: ids,
          size: ids.length,
          meanSimilarity: 0,
          representativeId: ids[0],
          thumbnails,
          namedTagId: null,
          namedTagName: null,
        },
        ...stored.groups,
      ];
      writeCharacterGroups(stored);
    }

    return { removed, returned: ids.length };
  });

/**
 * 自用新增（2026-10）：读**上次**的分组结果（不用重新分析）。
 *
 * 用户口径：聚类一次要几分钟，退出后下次进来不该再点一次分析。
 */
export const getStoredCharacterGroups = os
  .input(z.object({}).optional())
  .handler(() => {
    const stored = readCharacterGroups();
    if (!stored) {
      return { groups: [], createdAt: null, threshold: null, candidates: 0 };
    }
    return {
      groups: stored.groups,
      createdAt: stored.createdAt,
      threshold: stored.threshold,
      candidates: stored.candidates,
    };
  });

/** 自用新增（2026-10）：丢掉分组缓存（想重新分析时用）。 */
export const clearStoredCharacterGroups = os
  .input(z.object({}).optional())
  .handler(() => {
    clearCharacterGroups();
    return { cleared: true };
  });

/**
 * 自用新增（2026-10-18 · 会话#9）：**清除未命名的角色检测结果**。
 *
 * 用户口径：「要一个清空人物数据，但**不要用原来的代码**，你重新写一个，
 * 作用是清除**未命名**的结果，要二次确认，**已经命名的不能被删**」。
 *
 * 实现放在独立的 `services/character-result-cleanup.ts`（全新写的一份，不复用旧清理函数）；
 * 这里只是把它暴露成 IPC 并回传统计，供界面提示"删了几组、留了几组"。
 */
export const clearUnnamedCharacterResults = os
  .input(z.object({}).optional())
  .handler(() => clearUnnamedCharacterResultsService());

/**
 * 自用新增（2026-10）：取一个角色分组里**全部**照片的展示信息。
 *
 * 用途（用户要求）：点组的「展开」时看整组图、并且能点开大图 + 勾选部分图。
 * 为什么不复用现有接口：主图库网格那条通道带分页/筛选/排序等一堆参数，
 * 这里只是"给定一组 id 拿基本信息"，单独一个窄接口更快也更安全 ✓。
 */
export const getCharacterGroupPhotos = os
  .input(
    z.object({
      photoIds: z.array(z.number().int().positive()).min(1).max(3000),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const ids = [...new Set(input.photoIds)];
    const out: Array<{
      fileSize: number;
      filename: string;
      height: number;
      id: number;
      path: string;
      thumbnailPath: string | null;
      width: number;
    }> = [];
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = db
        .select({
          id: photos.id,
          path: photos.path,
          filename: photos.filename,
          fileSize: photos.fileSize,
          width: photos.width,
          height: photos.height,
          thumbnailPath: photos.thumbnailPath,
        })
        .from(photos)
        .where(inArray(photos.id, ids.slice(i, i + CHUNK)))
        .all();
      for (const row of rows) {
        if (!row.path) {
          continue;
        }
        out.push({
          id: row.id,
          path: row.path,
          filename: row.filename,
          fileSize: row.fileSize ?? 0,
          width: row.width ?? 0,
          height: row.height ?? 0,
          thumbnailPath: row.thumbnailPath ?? null,
        });
      }
    }
    return { photos: out };
  });

/**
 * 自用新增（2026-10）：命名时**搜索已有标签**。
 *
 * 用户实测反馈：有些图其实**已经有这个角色的标签**，只是打标时没认出来
 * （例："铃兰"）。所以命名框要能检索已有标签 —— 命中就直接用它
 * （保留它在标签树里原来的位置），没命中才新建。
 */
export const searchCharacterTags = os
  .input(
    z.object({
      query: z.string().min(1).max(50),
      limit: z.number().int().min(1).max(50).optional(),
    })
  )
  .handler(({ input }) => {
    const query = input.query.trim().toLowerCase();
    if (query.length === 0) {
      return { matches: [] };
    }
    const rows = loadTagRows();
    const byId = new Map(rows.map((row) => [row.id, row]));
    /** 向上找到所属的顶级分类名（"角色"/"作品系列"…），便于用户辨认。 */
    const rootNameOf = (id: number): string => {
      let current = byId.get(id);
      let guard = 0;
      while (current && current.parentId != null && guard < 20) {
        const parent = byId.get(current.parentId);
        if (!parent) {
          break;
        }
        current = parent;
        guard += 1;
      }
      return current?.name ?? "";
    };
    const limit = input.limit ?? 20;
    const matches = rows
      .filter((row) => {
        const name = row.name.toLowerCase();
        return name.includes(query);
      })
      .sort((a, b) => {
        // 越靠前越像：前缀命中优先，其次名字短的优先
        const aStarts = a.name.toLowerCase().startsWith(query) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(query) ? 0 : 1;
        if (aStarts !== bStarts) {
          return aStarts - bStarts;
        }
        return a.name.length - b.name.length;
      })
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        name: row.name,
        rootName: rootNameOf(row.id),
      }));
    return { matches };
  });

/**
 * 自用新增（2026-10）：给一个聚类组**命名**。
 *
 * 落库的是「AI 建议标签」（`origin = "auto"`、`userConfirmed = false`），
 * 与其它自动流程同一策略：**绝不覆盖**手动/已确认的标签，冲突时什么都不做。
 * 同名标签直接复用（不重复造标签）；不存在则在「角色」分类下新建。
 */
export const nameCharacterGroup = os
  .input(
    z.object({
      /** 新标签名（与 tagId 二选一；给了 tagId 时以 tagId 为准） */
      name: z.string().min(1).max(50).optional(),
      /** 用户在检索建议里选中的**已有标签**：直接用它，不再新建 */
      tagId: z.number().int().positive().optional(),
      photoIds: z.array(z.number().int().positive()).min(1).max(5000),
      confidence: z.number().min(0).max(1).optional(),
      /** 第几组（用于记住"这组已命名"，下次打开显示已命名状态） */
      groupIndex: z.number().int().min(0).optional(),
    })
  )
  .handler(({ input }) => {
    /*
     * 自用（2026-10-23 · 会话#10）：这里的报错以前全是普通 Error，
     * 经 oRPC 之后界面只显示 "Internal server error"（用户实测：「打不了标」）。
     * 改成 ORPCError，提示原样送到界面。
     */
    if (input.tagId == null && !input.name) {
      throw new ORPCError("BAD_REQUEST", {
        message: "要么选一个已有标签，要么输入新名字",
      });
    }
    const db = getDatabase();
    const rows = loadTagRows();

    // 名 → 标签 id（选中的已有标签直接用；否则同名复用；再否则在「角色」下新建）
    let tagId: number;
    let tagName: string;
    let created = false;

    if (input.tagId != null) {
      const picked = rows.find((row) => row.id === input.tagId);
      if (!picked) {
        throw new ORPCError("BAD_REQUEST", {
          message: "选中的标签不存在（可能已被删除），请重新选择",
        });
      }
      tagId = picked.id;
      tagName = picked.name;
    } else {
      const wanted = (input.name ?? "").trim();
      const existing = rows.find((row) => row.name === wanted);
      /*
       * 用户口径（2026-10）：**手动输入撞上同名标签时不要静默复用** ✗。
       *
       * 理由（用户原话要点）：识别角色时用户只会填角色名，而**不同作品会有同名角色**
       * ——静默复用会把两个不同角色混进同一个标签里，比"没记录"更糟。
       * 所以这里明确报错，让用户二选一：
       *   · 就是它 → 从建议里点选（走"导入已有标签"这条路）；
       *   · 不是它 → 换个名字新建。
       */
      if (existing) {
        throw new ORPCError("BAD_REQUEST", {
          message:
            `标签库里已经有「${wanted}」。如果就是这个角色，请从输入框下面的建议里点选（那会按"导入已有标签"处理）；` +
            `如果是同名的另一个角色，请换个名字。`,
        });
      }
      const root = rows.find(
        (row) => row.parentId === null && row.name === CHARACTER_ROOT_TAG_NAME
      );
      if (!root) {
        throw new ORPCError("BAD_REQUEST", {
          message: "标签库里没有「角色」这个分类，无法新建角色标签",
        });
      }
      const inserted = db
        .insert(tags)
        .values({ name: wanted, parentId: root.id })
        .returning({ id: tags.id })
        .get();
      if (!inserted?.id) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "创建角色标签失败",
        });
      }
      tagId = inserted.id;
      tagName = wanted;
      created = true;
    }

    const confidence =
      input.confidence == null
        ? null
        : Math.round(input.confidence * 10_000) / 10_000;
    const uniqueIds = [...new Set(input.photoIds)];
    const values = uniqueIds.map((photoId) => ({
      photoId,
      tagId,
      confidence,
      isConfirmed: false,
      origin: "auto" as const,
      userConfirmed: false,
    }));

    const CHUNK = 200;
    /*
     * 实际新增行数（用户反馈"导入了但不确定有没有生效"）：
     * 这些图里**有一部分本来就带这个标签**（打标时就打过），`onConflictDoNothing` 会跳过它们。
     * 原来直接返回 `values.length`（"尝试写入数"）会把提示说得比实际大 ✗
     * —— 例：某组 16 张，其实 8 张本来就有，提示却说"共 16 张"，用户就怀疑"到底加没加"。
     * 所以这里累加真正的 changes，把"新增"和"本来就有"分开报 ✓。
     */
    let inserted = 0;
    db.transaction(() => {
      for (let i = 0; i < values.length; i += CHUNK) {
        const result = db
          .insert(photoTags)
          .values(values.slice(i, i + CHUNK))
          .onConflictDoNothing()
          .run();
        inserted += Number(result?.changes ?? 0);
      }
    });
    invalidateTagSearch();

    // 记住这组已命名（下次打开对话框显示"已命名"，不会被当成没做过）
    markGroupNamed(
      input.groupIndex ?? null,
      uniqueIds[0] ?? null,
      tagId,
      tagName
    );

    /*
     * 用户口径（2026-10）：
     *   · **手动新建标签** → 这是"发现了一个新角色" → 记进人物识别页面 ✓；
     *   · **选已有标签导入** → 只是批量打标签，**不**在人物识别里多出一个角色 ✗。
     * 判据就用 `created`（是不是这次真的新建了标签）。
     */
    if (created) {
      const coverId = uniqueIds[0] ?? 0;
      const cover = coverId
        ? db
            .select({
              thumbnailPath: photos.thumbnailPath,
              path: photos.path,
            })
            .from(photos)
            .where(eq(photos.id, coverId))
            .get()
        : undefined;
      addManualRole({
        tagId,
        tagName,
        representativePhotoId: coverId,
        thumbnailPath: cover?.thumbnailPath ?? cover?.path ?? null,
        photoCount: values.length,
        createdAt: Date.now(),
      });
    }

    return {
      tagId,
      tagName,
      created,
      /** 真正新写入的条数 */
      applied: inserted,
      /** 组里一共涉及多少张（其中 `attempted - applied` 张本来就有该标签） */
      attempted: values.length,
    };
  });

/**
 * 自用新增（2026-10）：人物识别页面用的「我手动创建的角色」列表。
 *
 * 读取时顺手**自愈**：标签如果已经被删掉，就从列表里剔除，避免显示幽灵角色。
 */
export const listManualCharacterRoles = os
  .input(z.object({}).optional())
  .handler(() => {
    const rows = loadTagRows();
    const nameById = new Map(rows.map((row) => [row.id, row.name]));
    const existing = new Set(nameById.keys());
    const roles = listManualRoles();
    if (roles.length === 0) {
      return { roles: [] };
    }
    const alive = roles.filter((role) => existing.has(role.tagId));
    if (alive.length !== roles.length) {
      pruneManualRoles(existing);
    }
    /*
     * 图数**实时统计**：用户可能刚把几张"不符合的"退回未命名，
     * store 里缓存的那个数字就不准了 ✗ —— 这里按标签现查一次 ✓。
     */
    const db = getDatabase();
    const counts = new Map<number, number>();
    if (alive.length > 0) {
      const rows = db
        .select({
          tagId: photoTags.tagId,
          c: sql<number>`COUNT(DISTINCT ${photoTags.photoId})`,
        })
        .from(photoTags)
        .where(
          inArray(
            photoTags.tagId,
            alive.map((role) => role.tagId)
          )
        )
        .groupBy(photoTags.tagId)
        .all();
      for (const row of rows) {
        if (typeof row.tagId === "number") {
          counts.set(row.tagId, Number(row.c) || 0);
        }
      }
    }
    // 名字以标签表为准（用户可能在标签树里改过名）
    return {
      roles: alive.map((role) => ({
        ...role,
        tagName: nameById.get(role.tagId) ?? role.tagName,
        photoCount: counts.get(role.tagId) ?? 0,
      })),
    };
  });

/** 自用新增（2026-10）：给手动创建的角色**改名**（标签名一起改）。 */
/**
 * 自用（2026-10-18 · 会话#9）：把某张图设为「我创建的角色」的图集封面 ✓
 */
export const setManualRoleCover = os
  .input(
    z.object({
      tagId: z.number().int().positive(),
      photoId: z.number().int().positive(),
      thumbnailPath: z.string().nullable().optional(),
    })
  )
  .handler(({ input }) => {
    const updated = setManualRoleCoverInStore(
      input.tagId,
      input.photoId,
      input.thumbnailPath ?? null
    );
    return { updated };
  });

export const renameManualCharacterRole = os
  .input(
    z.object({
      tagId: z.number().int().positive(),
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
    if (conflict && conflict.id !== input.tagId) {
      throw new Error("已存在同名标签");
    }
    db.update(tags)
      .set({ name: input.name })
      .where(eq(tags.id, input.tagId))
      .run();
    renameManualRole(input.tagId, input.name);
    invalidateTagSearch();
    return { ok: true, tagId: input.tagId, tagName: input.name };
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
