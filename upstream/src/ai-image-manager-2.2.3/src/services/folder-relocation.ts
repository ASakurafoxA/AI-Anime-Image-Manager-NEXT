/**
 * 2026-11-18（会话#14）：**"同名、只换了路径"的文件夹自动找回**。
 *
 * 用户口径：文件夹改名请在软件里改（软件会同时改系统文件）；但**名字不变、只挪了位置**
 * 这种情况希望软件能自己把数据找回来。
 *
 * 做法（保守优先）：
 *   1. 找数据库里"路径已不存在"的文件夹记录；
 *   2. 在**现存库根目录**范围内找**同名目录**（不在数据库里的）；
 *   3. 用「文件名 + 大小 + 修改时间（±5 秒）」算匹配率，≥80% 且至少命中 1 张才算；
 *   4. 只有候选**唯一**时才迁移：把该文件夹及其子文件夹、以及所有照片的路径做前缀替换
 *      （标签 / 相册 / 收藏 / 向量全部不动）。
 *
 * 找不到、匹配率不够、或有多个候选 → **什么都不做**，保持"缺失"，交给用户手动重扫。
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { folders, photos } from "@/db/schema";
import { createLogger } from "@/utils/logger";
import { ORPHAN_MISSING_BATCH_ID } from "./orphan-missing-marker";

const log = createLogger("folder-relocation");

const FILE_DATE_TOLERANCE_MS = 5000;
const MATCH_RATIO_THRESHOLD = 0.8;
/** 每个缺失文件夹最多核对多少张照片（避免大文件夹匹配太慢）。 */
const MAX_PHOTOS_PER_FOLDER = 40;
/** 遍历目录时的深度上限。 */
const MAX_WALK_DEPTH = 6;

type Database = ReturnType<typeof getDatabase>;

interface FolderRow {
  id: number;
  parentId: number | null;
  path: string;
  displayName: string;
}

interface Candidate {
  path: string;
  hits: number;
  total: number;
}

function listDirectoryDirs(root: string, budget: { left: number }): string[] {
  const found: string[] = [];
  if (budget.left <= 0) {
    return found;
  }
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  while (queue.length > 0 && budget.left > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    budget.left -= 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const full = path.join(current.dir, entry.name);
      found.push(full);
      if (current.depth + 1 < MAX_WALK_DEPTH) {
        queue.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }
  return found;
}

function sameName(a: string, b: string): boolean {
  // Windows 文件系统大小写不敏感
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 尝试把"同名、只换了路径"的文件夹认回来。
 * 返回迁移了哪些文件夹（用于日志/测试），没有可迁移的返回空数组。
 */
export function relocateSameNameFolders(db: Database): Array<{
  from: string;
  to: string;
}> {
  let allFolders: FolderRow[];
  try {
    allFolders = db
      .select({
        id: folders.id,
        parentId: folders.parentId,
        path: folders.path,
        displayName: folders.displayName,
      })
      .from(folders)
      .all() as FolderRow[];
  } catch {
    return [];
  }

  const missing = allFolders.filter(
    (folder) => folder.path && !fs.existsSync(folder.path)
  );
  if (missing.length === 0) {
    return [];
  }

  const roots = allFolders.filter(
    (folder) =>
      folder.parentId === null &&
      folder.path &&
      fs.existsSync(folder.path) &&
      !missing.some((item) => item.id === folder.id)
  );
  if (roots.length === 0) {
    return [];
  }

  const existingFolderPaths = new Set(
    allFolders.map((folder) => folder.path.toLowerCase())
  );
  // 遍历所有现存根，收集目录（限制总量，避免大图库卡太久）
  const budget = { left: 20_000 };
  const existingDirs: string[] = [];
  for (const root of roots) {
    existingDirs.push(...listDirectoryDirs(root.path, budget));
    if (budget.left <= 0) {
      break;
    }
  }

  const migrated: Array<{ from: string; to: string }> = [];

  for (const folder of missing) {
    const name = path.basename(folder.path);
    const candidates = existingDirs.filter((dir) => {
      if (!sameName(path.basename(dir), name)) {
        return false;
      }
      // 已经是数据库里某个文件夹的路径 → 不是"新位置"
      if (existingFolderPaths.has(dir.toLowerCase())) {
        return false;
      }
      return fs.existsSync(dir);
    });
    if (candidates.length === 0) {
      continue;
    }

    const folderPhotos = db
      .select({
        filename: photos.filename,
        fileSize: photos.fileSize,
        fileDate: photos.fileDate,
      })
      .from(photos)
      .where(eq(photos.folderId, folder.id))
      .all() as Array<{
      filename: string;
      fileSize: number | null;
      fileDate: number | null;
    }>;
    if (folderPhotos.length === 0) {
      continue;
    }
    const sample = folderPhotos.slice(0, MAX_PHOTOS_PER_FOLDER);

    const matched: Candidate[] = [];
    for (const candidate of candidates) {
      let hits = 0;
      for (const photo of sample) {
        const target = path.join(candidate, photo.filename);
        try {
          const stat = fs.statSync(target);
          if (!stat.isFile()) {
            continue;
          }
          if (photo.fileSize !== null && stat.size !== photo.fileSize) {
            continue;
          }
          if (
            photo.fileDate !== null &&
            Math.abs(stat.mtimeMs - photo.fileDate) > FILE_DATE_TOLERANCE_MS
          ) {
            continue;
          }
          hits += 1;
        } catch {
          /* 这张没有，继续 */
        }
      }
      /*
       * 2026-11-18：**小文件夹要求 100% 命中**。
       * 只有 1~4 张的小文件夹，80% 阈值等于"命中 1 张就算"，误判代价太高；
       * 小样本必须全中才认，大文件夹才用 80%。
       */
      const needed =
        sample.length < 5
          ? sample.length
          : Math.ceil(sample.length * MATCH_RATIO_THRESHOLD);
      if (hits > 0 && hits >= needed) {
        matched.push({ path: candidate, hits, total: sample.length });
      }
    }

    if (matched.length !== 1) {
      if (matched.length > 1) {
        log.warn(
          { from: folder.path, candidates: matched.map((item) => item.path) },
          "同名文件夹有多个候选，无法确定是哪一个 → 本次不迁移"
        );
      }
      continue;
    }

    const target = matched[0].path;
    const oldPrefix = folder.path;
    try {
      db.transaction(() => {
        /*
         * 前缀替换：该文件夹自己 + 所有以它开头的子文件夹 + 所有照片路径。
         * 用 LIKE 前缀匹配（SQL 里做，避免把整库路径读进内存）。
         */
        const prefix = `${oldPrefix}${path.sep}`;
        const escapeLike = (value: string) =>
          value.replace(/[\\%_]/g, (char) => `\\${char}`);

        db.run?.(sql`PRAGMA foreign_keys = ON`);
        const folderRows = db
          .select({ id: folders.id, path: folders.path })
          .from(folders)
          .where(
            sql`${folders.path} = ${oldPrefix} OR ${folders.path} LIKE ${`${escapeLike(prefix)}%`} ESCAPE '\\'`
          )
          .all() as Array<{ id: number; path: string }>;
        for (const row of folderRows) {
          const nextPath = target + row.path.slice(oldPrefix.length);
          db.update(folders)
            .set({ path: nextPath })
            .where(eq(folders.id, row.id))
            .run();
        }

        const photoRows = db
          .select({ id: photos.id, path: photos.path })
          .from(photos)
          .where(
            sql`${photos.path} = ${oldPrefix} OR ${photos.path} LIKE ${`${escapeLike(prefix)}%`} ESCAPE '\\'`
          )
          .all() as Array<{ id: number; path: string }>;
        for (const row of photoRows) {
          db.update(photos)
            .set({ path: target + row.path.slice(oldPrefix.length) })
            .where(eq(photos.id, row.id))
            .run();
        }
        /*
         * 2026-11-18：**顺手恢复"被标成缺失"的记录**。
         * 如果上一次对账已经把这条文件夹下的照片标成缺失（图库里看不见），
         * 只改路径是不够的 —— 必须把标记清掉，否则路径对了、图还是隐藏的。
         * 只清"缺失"这个批次；真正进回收站的记录（用户删的）绝不碰。
         */
        const photoIds = photoRows.map((row) => row.id);
        if (photoIds.length > 0) {
          db.update(photos)
            .set({ deletedAt: null, deletionBatchId: null })
            .where(
              and(
                inArray(photos.id, photoIds),
                sql`${photos.deletionBatchId} = ${ORPHAN_MISSING_BATCH_ID}`
              )
            )
            .run();
        }
        /*
         * 文件夹张数重算：标记缺失时扣过数，恢复后要加回来。
         * 只重算"这次动过的文件夹"（前缀范围内的那些）。
         */
        for (const row of folderRows) {
          db.update(folders)
            .set({
              photoCount: sql`(select count(*) from photos where folder_id = ${row.id} and deleted_at is null)`,
            })
            .where(eq(folders.id, row.id))
            .run();
        }
        log.info(
          {
            from: oldPrefix,
            to: target,
            folders: folderRows.length,
            photos: photoRows.length,
            matched: `${matched[0].hits}/${matched[0].total}`,
          },
          "同名文件夹换了路径：已自动迁移（标签/相册/收藏保留）"
        );
      });
      migrated.push({ from: oldPrefix, to: target });
    } catch (error) {
      log.warn(
        { from: oldPrefix, to: target, err: error },
        "同名文件夹迁移失败（保持原状，可手动重扫）"
      );
    }
  }

  return migrated;
}

/**
 * 2026-11-18（会话#14，用户口径）：**"重新拖入/重新扫描"时把旧记录认回来**。
 *
 * 场景：文件夹挪到了库外（例如 `...\NEXT\截图` → `F:\截图`），库根范围内根本搜不到，
 * 所以"自动搜索"这条路走不通。用户的操作是**重新把这个文件夹加进来**。
 *
 * 于是在扫描开始前先试一次：如果存在一条"路径已不存在"的文件夹记录，且
 *   · **文件夹名相同**；
 *   · 新目录里的文件与旧记录下的照片**几乎一样**（按相对路径 + 大小比对：
 *     小于 5 张要求全中，否则要求 ≥50% 命中）；
 * 就把那条记录（以及子文件夹、照片）的路径**前缀替换**到新位置，标签/相册/收藏全部保留。
 * 之后正常扫描会发现这些路径已经存在，不会重复插入。
 *
 * 返回 true = 已认回（扫描继续用旧记录）；false = 跟普通新增一样处理。
 */
export function adoptRelocatedFolderPath(
  db: Database,
  newPathRaw: string
): boolean {
  const newPath = path.resolve(newPathRaw);
  if (!fs.existsSync(newPath)) {
    return false;
  }
  try {
    const existing = db
      .select({ id: folders.id })
      .from(folders)
      .where(eq(folders.path, newPath))
      .get();
    if (existing) {
      return false;
    }
    const allFolders = db
      .select({ id: folders.id, path: folders.path })
      .from(folders)
      .all() as Array<{ id: number; path: string }>;
    const name = path.basename(newPath);
    const candidates = allFolders.filter(
      (folder) =>
        folder.path &&
        !fs.existsSync(folder.path) &&
        sameName(path.basename(folder.path), name)
    );
    for (const candidate of candidates) {
      const oldPrefix = candidate.path;
      const prefix = `${oldPrefix}${path.sep}`;
      const escapeLike = (value: string) =>
        value.replace(/[\\%_]/g, (char) => `\\${char}`);
      const photoRows = db
        .select({
          path: photos.path,
          fileSize: photos.fileSize,
        })
        .from(photos)
        .where(
          sql`${photos.path} LIKE ${`${escapeLike(prefix)}%`} ESCAPE '\\'`
        )
        .all() as Array<{ path: string; fileSize: number | null }>;
      if (photoRows.length === 0) {
        continue;
      }
      const sample = photoRows.slice(0, MAX_PHOTOS_PER_FOLDER);
      let hits = 0;
      for (const photo of sample) {
        const relative = photo.path.slice(oldPrefix.length + 1);
        const target = path.join(newPath, relative);
        try {
          const stat = fs.statSync(target);
          if (!stat.isFile()) {
            continue;
          }
          if (photo.fileSize !== null && stat.size !== photo.fileSize) {
            continue;
          }
          hits += 1;
        } catch {
          /* 这张不在，继续 */
        }
      }
      // "几乎一样"：小文件夹全中；大文件夹 ≥50%
      const needed =
        sample.length < 5 ? sample.length : Math.ceil(sample.length * 0.5);
      if (hits < needed) {
        continue;
      }
      migrateFolderPrefix(db, oldPrefix, newPath);
      log.info(
        {
          from: oldPrefix,
          to: newPath,
          photos: photoRows.length,
          matched: `${hits}/${sample.length}`,
        },
        "重新添加的文件夹与旧记录同名且内容一致：已认回（标签/相册/收藏保留）"
      );
      return true;
    }
  } catch (error) {
    log.warn({ err: error, newPath }, "重新添加时的认回检查失败（按新文件夹处理）");
  }
  return false;
}

/** 把 from 前缀下的文件夹 / 照片路径整体换成 to（标签等关联不动）。 */
function migrateFolderPrefix(db: Database, from: string, to: string): void {
  const prefix = `${from}${path.sep}`;
  const escapeLike = (value: string) =>
    value.replace(/[\\%_]/g, (char) => `\\${char}`);
  db.transaction(() => {
    const folderRows = db
      .select({ id: folders.id, path: folders.path })
      .from(folders)
      .where(
        sql`${folders.path} = ${from} OR ${folders.path} LIKE ${`${escapeLike(prefix)}%`} ESCAPE '\\'`
      )
      .all() as Array<{ id: number; path: string }>;
    for (const row of folderRows) {
      db.update(folders)
        .set({ path: to + row.path.slice(from.length) })
        .where(eq(folders.id, row.id))
        .run();
    }
    const photoRows = db
      .select({ id: photos.id, path: photos.path })
      .from(photos)
      .where(
        sql`${photos.path} = ${from} OR ${photos.path} LIKE ${`${escapeLike(prefix)}%`} ESCAPE '\\'`
      )
      .all() as Array<{ id: number; path: string }>;
    for (const row of photoRows) {
      db.update(photos)
        .set({ path: to + row.path.slice(from.length) })
        .where(eq(photos.id, row.id))
        .run();
    }
    const photoIds = photoRows.map((row) => row.id);
    if (photoIds.length > 0) {
      db.update(photos)
        .set({ deletedAt: null, deletionBatchId: null })
        .where(
          and(
            inArray(photos.id, photoIds),
            sql`${photos.deletionBatchId} = ${ORPHAN_MISSING_BATCH_ID}`
          )
        )
        .run();
    }
    for (const row of folderRows) {
      db.update(folders)
        .set({
          photoCount: sql`(select count(*) from photos where folder_id = ${row.id} and deleted_at is null)`,
        })
        .where(eq(folders.id, row.id))
        .run();
    }
  });
}