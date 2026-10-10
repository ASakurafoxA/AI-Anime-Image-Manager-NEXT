/**
 * 「标签树数字徽标」的统计结果缓存。
 *
 * 为什么需要它（2026-10 在本机真实图库上实测：7.7 万图 / 3.1 万标签 / 420 万条 photo_tags）：
 * `queryTagPhotoCounts` 那条递归 CTE 要把「标签 × 它的所有祖先」和 photo_tags 做 JOIN，
 * 产生约 **1,237 万行**再 `COUNT(DISTINCT photo_id)` 分组 —— **实测 3,380 ms**（真实应用里 4,064ms）。
 * 而这个数字只在「图库内容变化」时才变（导入 / 打标 / 删除 / 改标签），
 * 跟用户「浏览哪一页、选中哪个标签」毫无关系。
 *
 * 所以做两层缓存：
 *   · 内存：按「标签修订号 + 文件夹」缓存，同一次运行内不再重算
 *   · 磁盘：存一份 JSON 快照 + 图库指纹，**重启应用也不用重算**
 * 失效路径：
 *   · 打标 / 改标签 → `invalidateTagSearch()` 会 bump 修订号 → 自动失效
 *   · 导入完成 / 删除照片 → `invalidateCountCache()` 会调 `clearTagCountCache()`
 *   · 重启后指纹对不上（图片数 / 关联行数 / 最大关联 id 变了）→ 自动重算
 *   · 另外还有 TTL 兜底
 */
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { getDataPath } from "@/utils/data-path";

const TTL_MS = 5 * 60_000;

// ── 落盘快照 ─────────────────────────────────────────────────────────
// 内存缓存只能省掉「同一次运行内」的重算；重启应用后它一定是空的，
// 而那条统计在 8 万图上要 3.6 秒、32 万图上要 21 秒 —— 每次启动都卡这么久。
// 所以再存一份到磁盘，并用「图库指纹」判断它是否还新鲜。
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_FILE = "tag-photo-counts.json";

/** 判断快照是否过期的指纹：图库内容一变，这几个数至少有一个会变。 */
export interface TagCountFingerprint {
  /**
   * 已软删除的照片数。
   * ⚠️ 必须有这一项：这个应用删图走的是 `deleted_at` 软删除，
   * **不会**改变 photos 行数、photo_tags 行数或最大 id ——
   * 少了它，删完图重启后会一直显示删除前的旧数字（写测试时踩到过）。
   */
  deletedPhotoCount: number;
  /** photo_tags 行数（标签增删会让它变化） */
  linkCount: number;
  /** photo_tags 的最大 id（自增，任何新增都会让它变大） */
  maxLinkId: number;
  /** photos 行数（导入/彻底删除图片） */
  photoCount: number;
}

interface TagCountSnapshot {
  counts: Record<string, number>;
  fingerprint: TagCountFingerprint;
  version: number;
}

interface TagCountCacheEntry {
  at: number;
  counts: Map<number, number>;
  folderId: number | null;
  revision: number;
}

let entry: TagCountCacheEntry | null = null;

/** 取缓存；命中返回 Map，未命中返回 null（调用方负责重算并写回）。*/
export function readTagCountCache(
  folderId: number | null,
  revision: number
): Map<number, number> | null {
  if (!entry) {
    return null;
  }
  if (entry.folderId !== folderId || entry.revision !== revision) {
    return null;
  }
  if (Date.now() - entry.at > TTL_MS) {
    return null;
  }
  return entry.counts;
}

/** 写回缓存。*/
export function writeTagCountCache(
  folderId: number | null,
  revision: number,
  counts: Map<number, number>
): void {
  entry = { at: Date.now(), counts, folderId, revision };
}

/** 清空内存缓存（图库内容变化时调用）。落盘快照不删 —— 它靠指纹自己失效。*/
export function clearTagCountCache(): void {
  entry = null;
}

function snapshotFilePath(): string {
  return path.join(getDataPath(), SNAPSHOT_FILE);
}

/**
 * 读落盘快照；指纹对得上才返回，否则返回 null（视为过期）。
 * 文件缺失 / 损坏 / 版本不符都当作"没有快照"，绝不影响主流程。
 */
export function readPersistedTagCounts(
  fingerprint: TagCountFingerprint
): Map<number, number> | null {
  try {
    const file = snapshotFilePath();
    if (!existsSync(file)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as TagCountSnapshot;
    if (parsed?.version !== SNAPSHOT_VERSION) {
      return null;
    }
    const saved = parsed.fingerprint;
    if (
      saved?.photoCount !== fingerprint.photoCount ||
      saved?.deletedPhotoCount !== fingerprint.deletedPhotoCount ||
      saved?.linkCount !== fingerprint.linkCount ||
      saved?.maxLinkId !== fingerprint.maxLinkId
    ) {
      return null;
    }
    const counts = new Map<number, number>();
    for (const [key, value] of Object.entries(parsed.counts ?? {})) {
      counts.set(Number(key), Number(value));
    }
    return counts.size > 0 ? counts : null;
  } catch {
    return null;
  }
}

/** 写落盘快照（先写临时文件再改名，避免中途崩溃留下半个 JSON）。*/
export function persistTagCounts(
  fingerprint: TagCountFingerprint,
  counts: Map<number, number>
): void {
  try {
    const file = snapshotFilePath();
    const payload: TagCountSnapshot = {
      version: SNAPSHOT_VERSION,
      fingerprint,
      counts: Object.fromEntries(counts),
    };
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(payload), "utf-8");
    renameSync(temp, file);
  } catch {
    /* 写不进去也不影响使用 */
  }
}
