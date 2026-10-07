/**
 * 局域网只读 API（自用新增）。
 *
 * 三条铁律（用户明确要求，改这个文件前请先读一遍）：
 *  1. **只有读**。这里不出现任何写操作，所以"通过网络访问时禁用删除和标签编辑"
 *     是**服务端天然成立**的 —— 不是靠前端藏按钮。
 *  2. **不回吐配置**。端口 / 口令 / 开关（`lan-access.ts` 的任何字段）
 *     一律不出现在任何返回值里。用户要求"局域网不给看端口设置这边的任何内容"。
 *  3. **不回吐文件系统路径**。返回值里只有**相对 URL**（如 `/api/photo/12/thumb`），
 *     由服务端自己按 id 去查磁盘路径。这样手机端既看不到你的目录结构，
 *     也没法构造任意路径的请求。
 *
 * 范围（用户 2026-10 明确收窄）：**只服务"全部照片"那一屏** ——
 * 照片网格（含月份分组所需的日期）、搜索框、排序、点开大图、下载。
 * 收藏 / 文件夹树 / 标签树 / 以图搜图 / 网格密度 / 仪表盘 / 相册 / 设置
 * **一律不提供**，相关接口与函数都不在这里（不是藏起来，是根本没有）。
 *
 * 列表查询直接复用桌面的 `queryPhotos()`，因此"隐藏文件夹黑名单""标签子树展开"
 * 这类规则不会两边跑偏。
 */
import { and, inArray, isNull } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos, tags } from "@/db/schema";
import {
  queryFolders,
  queryPhotoById,
  queryPhotos,
} from "@/ipc/photos/handlers/listing";
import { queryTagPhotoCounts } from "@/ipc/photos/handlers/tags";
import { isAiSearchReady, searchByText } from "@/services/ai/search";
import { resolveExcludedFolderIds } from "@/services/folder-exclusions";
import { expandHiddenTagIds } from "@/services/tag-exclusions";

/** 手机端一页最多能拿多少张（防止有人一次把整库拉走）。*/
export const LAN_LIST_LIMIT_MAX = 100;
/** 默认每页张数。*/
export const LAN_LIST_LIMIT_DEFAULT = 60;
/** 语义搜索最多召回多少条（再往后翻没有意义，且向量检索本身有上限）。*/
export const LAN_SEMANTIC_MAX_RESULTS = 200;

export interface LanMediaUrls {
  /** 下载原图（带 `Content-Disposition: attachment`，支持 Range 续传）。*/
  download: string;
  /** 原图（浏览器直接显示）。*/
  image: string;
  /** 缩略图（webp，三档尺寸 `sm` / `md` / `lg`）。*/
  thumb: string;
}

/** 手机端看到的单张照片信息 —— **刻意不含任何磁盘路径**。*/
export interface LanPhotoSummary {
  /** 照片日期（毫秒时间戳），手机端用它做月份分组。*/
  fileDate: number | null;
  filename: string;
  height: number | null;
  id: number;
  urls: LanMediaUrls;
  width: number | null;
}

export interface LanListResult {
  hasMore: boolean;
  items: LanPhotoSummary[];
  limit: number;
  /**
   * 这一页是怎么来的：
   *  · `list`      —— 普通列表（SQL 分页，`total` 是精确总数）
   *  · `semantic`  —— 语义搜索命中（`total` 是**召回条数**，不是全库命中数）
   *  · `filename`  —— 语义不可用时的文件名包含匹配（`total` 是精确总数）
   */
  mode: "filename" | "list" | "semantic";
  offset: number;
  total: number;
}

export interface LanListParams {
  /** 只看收藏。*/
  favoriteOnly?: boolean;
  /** 只看某个文件夹（**含其子孙**，与桌面点文件夹的行为一致）。*/
  folderId?: number;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
  /** 搜索词（中文自然语言 / 标签名 / 文件名都能吃）。*/
  search?: string;
  sort?: "date" | "name" | "size";
  /** 只看某个标签（**含其子孙**，与桌面点标签的行为一致）。*/
  tagId?: number;
}

/** 左侧栏「文件夹」树的一个节点 —— **不含磁盘路径**，只有显示名。*/
export interface LanFolderNode {
  /**
   * 是否在黑名单里（含黑名单文件夹的子孙）。
   *
   * 手机端会把这些节点渲染到**单独的「已隐藏」一段**里，而不是混在普通文件夹中间，
   * 也不会假装它们不存在 —— 用户（2026-10 要求）希望手机上同样能主动点进去。
   */
  hidden: boolean;
  id: number;
  name: string;
  parentId: number | null;
  photoCount: number;
}

/** 左侧栏「标签」树的一个节点。*/
export interface LanTagNode {
  id: number;
  name: string;
  parentId: number | null;
  photoCount: number;
}

/**
 * 把"有些节点被过滤掉了"的扁平列表修成合法森林。
 *
 * 被过滤掉的父节点会让子节点变成悬挂引用（`parentId` 指向不存在的节点），
 * 手机端建树时就会把这条分支整根丢掉。这里把它挂到**最近的存活祖先**上，
 * 找不到就变成根节点 —— 客户端因此不需要处理任何特殊情况。
 */
function reparentToSurvivors<T extends { id: number; parentId: number | null }>(
  survivors: T[],
  parentOf: Map<number, number | null>
): T[] {
  const present = new Set(survivors.map((item) => item.id));
  return survivors.map((item) => {
    let parentId = item.parentId;
    const guard = new Set<number>([item.id]);
    while (parentId !== null && !present.has(parentId) && !guard.has(parentId)) {
      guard.add(parentId);
      parentId = parentOf.get(parentId) ?? null;
    }
    return parentId === item.parentId ? item : { ...item, parentId };
  });
}

/** `queryPhotos()` 返回行里我们真正用得到的字段。*/
interface PhotoQueryRow {
  fileDate: number | null;
  filename: string;
  height: number | null;
  id: number;
  width: number | null;
}

const PHOTO_COLUMNS = {
  fileDate: photos.fileDate,
  filename: photos.filename,
  height: photos.height,
  id: photos.id,
  width: photos.width,
};

function mediaUrls(id: number): LanMediaUrls {
  return {
    download: `/api/photo/${id}/download`,
    image: `/api/photo/${id}/image`,
    thumb: `/api/photo/${id}/thumb?size=md`,
  };
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return LAN_LIST_LIMIT_DEFAULT;
  }
  const value = Math.trunc(limit as number);
  if (value <= 0) {
    return LAN_LIST_LIMIT_DEFAULT;
  }
  return Math.min(value, LAN_LIST_LIMIT_MAX);
}

function clampOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(0, Math.trunc(offset as number));
}

function toSummary(row: PhotoQueryRow): LanPhotoSummary {
  return {
    fileDate: row.fileDate ?? null,
    filename: row.filename,
    height: row.height ?? null,
    id: row.id,
    urls: mediaUrls(row.id),
    width: row.width ?? null,
  };
}

/** 按 id 批量取（保持传入顺序），用于语义搜索结果的补全。*/
function loadSummariesInOrder(ids: number[]): LanPhotoSummary[] {
  if (ids.length === 0) {
    return [];
  }
  const db = getDatabase();
  const rows = db
    .select(PHOTO_COLUMNS)
    .from(photos)
    .where(and(inArray(photos.id, ids), isNull(photos.deletedAt)))
    .all();
  const byId = new Map<number, PhotoQueryRow>();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  const out: LanPhotoSummary[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) {
      out.push(toSummary(row));
    }
  }
  return out;
}

/**
 * 语义搜索分页。
 *
 * @returns 命中结果；AI 未就绪或检索失败时返回 null（调用方回退到文件名匹配）。
 */
async function listBySemanticSearch(
  query: string,
  offset: number,
  limit: number
): Promise<LanListResult | null> {
  if (!isAiSearchReady()) {
    return null;
  }
  try {
    // 语义检索只能"要前 N 条"，所以要翻到 offset+limit 就得按需多要一点。
    const wanted = Math.min(offset + limit, LAN_SEMANTIC_MAX_RESULTS);
    const hits = await searchByText(query, wanted);
    const pageIds = hits.slice(offset, offset + limit).map((hit) => hit.photoId);
    return {
      hasMore: hits.length >= wanted && wanted < LAN_SEMANTIC_MAX_RESULTS,
      items: loadSummariesInOrder(pageIds),
      limit,
      mode: "semantic",
      offset,
      // ⚠️ 语义搜索的 total 是"召回条数"，不是全库命中数 —— 前端不要当成总数显示
      total: hits.length,
    };
  } catch (error) {
    // 不静默吞错：说清楚失败了，然后明确回退。
    console.warn(
      `[LAN] 语义搜索失败，回退到文件名匹配：${(error as Error)?.message ?? String(error)}`
    );
    return null;
  }
}

/**
 * 「全部照片」列表（分页 / 排序 / 搜索）。
 *
 * 搜索与桌面同一优先级：**语义优先，AI 未就绪时回退文件名包含匹配**。
 * ⚠️ 与桌面保持一致：**搜索不套用文件夹黑名单** —— 用户要的就是
 * "R-18 目录不进主界面但仍可搜索"；而不带搜索词的普通列表是套黑名单的。
 */
export async function listLanPhotos(
  params: LanListParams
): Promise<LanListResult> {
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);
  const query = params.search?.trim();

  if (query) {
    const semantic = await listBySemanticSearch(query, offset, limit);
    if (semantic) {
      return semantic;
    }
  }

  const result = queryPhotos({
    favoriteOnly: params.favoriteOnly,
    folderId: params.folderId,
    limit,
    offset,
    order: params.order ?? "desc",
    search: query || undefined,
    sort: params.sort ?? "date",
    tagId: params.tagId,
    tagMode: "or",
  });
  const items = result.items.map((row) => toSummary(row));
  return {
    hasMore: offset + items.length < result.total,
    items,
    limit,
    mode: query ? "filename" : "list",
    offset,
    total: result.total,
  };
}

/**
 * 左侧栏「文件夹」树。
 *
 * 黑名单（隐藏）文件夹：**打 `hidden` 标记后照常返回**，由手机端渲染到单独的
 * 「已隐藏」一段里。用户明确要求给它们"单独放一个位置"——桌面侧边栏也是列出来的，
 * 只是它们的照片不进聚合视图；手机端保持一致，用户仍可主动点进去看。
 *
 * 仍然只发 `displayName`（显示名），**不发 `path`** —— 路径属于文件系统信息。
 */
export function listLanFolders(): LanFolderNode[] {
  const rows = queryFolders();
  const excluded = new Set(resolveExcludedFolderIds());
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));

  const nodes = rows
    .map((row) => ({
      hidden: excluded.has(row.id),
      id: row.id,
      name: row.displayName,
      parentId: row.parentId,
      photoCount: row.totalPhotoCount,
    }))
    // 普通文件夹没照片就不发（点进去只会是空列表，纯噪声）；
    // 但**隐藏的**即使没照片也要发，否则手机上就看不出"这里有东西被隐藏了"。
    .filter((row) => row.photoCount > 0 || row.hidden);

  const fixed = reparentToSurvivors(nodes, parentOf);
  fixed.sort(
    (a, b) => b.photoCount - a.photoCount || a.name.localeCompare(b.name)
  );
  return fixed;
}

/**
 * 左侧栏「标签」树。
 *
 * 与桌面完全同一套规则：
 *  · 排除标签黑名单及其子孙（`expandHiddenTagIds`）
 *  · **只发有图的标签**（自用版"10,933 个标签里只有 551 个有照片"）
 *  · 计数用同一个递归 CTE（`queryTagPhotoCounts`），所以数字与桌面一致
 *  · 显示名用**原始名**（`少女 (1girl)`）—— 桌面侧边栏就是这么显示的，
 *    英文留在括号里也顺便让树内搜索能按英文匹配
 */
export function listLanTags(): LanTagNode[] {
  const db = getDatabase();
  const all = db
    .select({ id: tags.id, name: tags.name, parentId: tags.parentId })
    .from(tags)
    .all();
  const hidden = expandHiddenTagIds(all);
  const counts = queryTagPhotoCounts();
  const parentOf = new Map(all.map((tag) => [tag.id, tag.parentId]));

  const survivors = all
    .filter((tag) => !hidden.has(tag.id) && (counts.get(tag.id) ?? 0) > 0)
    .map((tag) => ({
      id: tag.id,
      name: tag.name,
      parentId: tag.parentId,
      photoCount: counts.get(tag.id) ?? 0,
    }));

  const fixed = reparentToSurvivors(survivors, parentOf);
  fixed.sort(
    (a, b) => b.photoCount - a.photoCount || a.name.localeCompare(b.name)
  );
  return fixed;
}

/** 按外部给的一批 id 取照片（识图结果用），保持传入顺序。*/
export function listLanPhotosByIds(
  ids: number[],
  limit = LAN_LIST_LIMIT_MAX
): LanPhotoSummary[] {
  return loadSummariesInOrder(
    ids.slice(0, Math.max(1, Math.trunc(limit)))
  );
}

/**
 * ⚠️ **仅供服务端内部使用**：把照片 id 换成磁盘路径。
 *
 * 返回值**绝对不许**序列化进任何 HTTP 响应 —— 见文件头第 3 条。
 */
export function getLanPhotoFilePath(
  id: number
): { filename: string; path: string } | null {
  const row = queryPhotoById(id);
  if (!(row && row.path) || row.deletedAt) {
    return null;
  }
  return { filename: row.filename, path: row.path };
}
