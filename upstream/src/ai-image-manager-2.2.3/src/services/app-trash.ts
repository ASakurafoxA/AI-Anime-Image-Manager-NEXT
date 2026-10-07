/**
 * 应用内回收站（自用新增）。
 *
 * 为什么不用 Windows 回收站：系统回收站容易被其他清理工具一起清空。
 * 本版把删除的照片**移动**到应用自己的目录，保留 30 天后自动清理。
 *
 * 固定路径：`<dataPath>/回收站/`（不给用户自定义，避免路径漂移导致的老文件失联）
 * 文件命名：`<photoId>_<原文件名>`（避免不同目录的同名图互相覆盖）
 *
 * ⚠️ 两个关键细节：
 *  1. `rename` 会**保留原文件的修改时间**。若直接按 mtime 做 30 天判断，
 *     一张几年前的老照片一移进来就会被立刻清掉。所以移动后必须 `utimes` 把
 *     时间改成"删除时刻"。
 *  2. 跨卷 `rename` 会失败（EXDEV）→ 退回复制 + 删除原文件。
 */
import fs from "node:fs";
import path from "node:path";
import { getDataPath } from "@/utils/data-path";
import { createLogger } from "@/utils/logger";

const log = createLogger("app-trash");

/** 回收站目录名（固定）。 */
const TRASH_DIR_NAME = "回收站";
/** 保留天数：从"删除时刻"算起。 */
const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export function getAppTrashDir(): string {
  return path.join(getDataPath(), TRASH_DIR_NAME);
}

function ensureTrashDir(): string {
  const dir = getAppTrashDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 回收站里的文件名：`<photoId>_<原文件名>__<删除时间戳><扩展名>`。
 *
 * 为什么把删除时间写进**文件名**而不是改文件的 mtime：
 * 本应用的**照片日期是从文件修改时间读出来的**，一旦改了 mtime，
 * 恢复之后如果重新扫描，照片日期就会变成"删除那天"。所以一律不碰文件时间，
 * 30 天清理改为从文件名里解析时间戳。
 *
 * 例：`1234_photo.png` 在 2026-10-06 删除 → `1234_photo__1791300000000.png`
 */
function buildTrashName(
  photoId: number,
  originalPath: string,
  deletedAtMs: number
): string {
  const ext = path.extname(originalPath);
  const base = path.basename(originalPath, ext);
  return `${photoId}_${base}__${deletedAtMs}${ext}`;
}

/** 在回收站目录里找出某张照片对应的文件（按前缀匹配，兼容不同删除时间）。 */
function findTrashFile(photoId: number, originalPath: string): string | null {
  try {
    const dir = getAppTrashDir();
    if (!fs.existsSync(dir)) {
      return null;
    }
    const ext = path.extname(originalPath);
    const prefix = `${photoId}_${path.basename(originalPath, ext)}__`;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name.startsWith(prefix) && entry.name.endsWith(ext)) {
        return path.join(dir, entry.name);
      }
    }
  } catch {
    /* 查询失败当作找不到 */
  }
  return null;
}

/** 从回收站文件名里解析删除时间戳；解析不出来返回 null。 */
function parseTrashTimestamp(fileName: string): number | null {
  const matched = /__(\d{10,})(?:\.[^.]*)?$/.exec(fileName);
  if (!matched) {
    return null;
  }
  const value = Number.parseInt(matched[1], 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 把原文件移进应用回收站。
 *
 * @returns 目标路径（成功）／空串（原文件本就不存在，不阻塞删除）／null（失败）
 *
 * ⚠️ 返回 null 时调用方**必须放弃删除这条记录** —— 否则会出现
 * "库里没了、文件还在原目录"的不一致状态。
 */
export function moveFileToAppTrash(
  photoId: number,
  originalPath: string
): string | null {
  try {
    if (!fs.existsSync(originalPath)) {
      // 文件已经不在了（被外部删了/盘拔了）：不该让用户永远删不掉这条记录
      log.warn({ photoId, originalPath }, "原文件不存在，跳过移动");
      return "";
    }
    const dir = ensureTrashDir();
    // 删除时间戳写进文件名 → 天然唯一：
    //  · 重复删除同一张图不会冲突
    //  · 不同目录同名图也不冲突（再加上 photoId 前缀）
    //  · **完全不用碰文件 mtime**（照片日期是从 mtime 读的，改了会导致恢复后日期变错）
    const target = path.join(
      dir,
      buildTrashName(photoId, originalPath, Date.now())
    );

    try {
      fs.renameSync(originalPath, target);
    } catch {
      // 跨卷（EXDEV）等：退回复制 + 删原文件
      fs.copyFileSync(originalPath, target);
      fs.rmSync(originalPath, { force: true });
    }
    return target;
  } catch (error) {
    log.error(
      {
        photoId,
        originalPath,
        error: error instanceof Error ? error.message : String(error),
      },
      "移入应用回收站失败"
    );
    return null;
  }
}

/**
 * 把回收站里的文件移回原位（用于"从最近删除恢复"）。
 *
 * ⚠️ 这是删除流程的**必备配套**：删除时文件被移走了，恢复时必须移回来，
 * 否则记录会指向一个不存在的路径（恢复逻辑原本只检查原路径是否存在）。
 *
 * @returns 是否成功移回
 */
export function restoreFileFromAppTrash(
  photoId: number,
  originalPath: string
): boolean {
  try {
    const source = findTrashFile(photoId, originalPath);
    if (!source) {
      return false;
    }
    // 原目录可能已被删除，先确保存在
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    if (fs.existsSync(originalPath)) {
      fs.rmSync(originalPath, { force: true });
    }
    try {
      fs.renameSync(source, originalPath);
    } catch {
      fs.copyFileSync(source, originalPath);
      fs.rmSync(source, { force: true });
    }
    return true;
  } catch (error) {
    log.error(
      {
        photoId,
        originalPath,
        error: error instanceof Error ? error.message : String(error),
      },
      "从回收站移回原文件失败"
    );
    return false;
  }
}

/** 删除某张照片在回收站里的文件（用于"彻底删除"或记录被硬删时）。 */
export function removeFromAppTrash(
  photoId: number,
  originalPath: string
): boolean {
  try {
    const target = findTrashFile(photoId, originalPath);
    if (target) {
      fs.rmSync(target, { force: true });
      return true;
    }
  } catch (error) {
    log.warn(
      { photoId, error: error instanceof Error ? error.message : String(error) },
      "清理回收站文件失败"
    );
  }
  return false;
}

/**
 * 清理超过保留期的文件（按文件修改时间判断，而移动时已把时间改成删除时刻）。
 * 启动时调用一次即可 —— 本版不做主动清理 UI，用户想立刻清空直接删目录即可。
 */
export function purgeExpiredAppTrash(): { removed: number; failed: number } {
  let removed = 0;
  let failed = 0;
  try {
    const dir = getAppTrashDir();
    if (!fs.existsSync(dir)) {
      return { removed: 0, failed: 0 };
    }
    const deadline = Date.now() - RETENTION_MS;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      const full = path.join(dir, entry.name);
      try {
        // 优先用**文件名里的删除时间戳**。
        // 不能用 mtime：那是照片自己的保存时间，一张几年前的老图会被立刻误删。
        // 解析不出来（例如用户手动放进来的文件）才退回 mtime。
        const stamped = parseTrashTimestamp(entry.name);
        const reference = stamped ?? fs.statSync(full).mtimeMs;
        if (reference < deadline) {
          fs.rmSync(full, { force: true });
          removed++;
        }
      } catch {
        failed++;
      }
    }
    if (removed > 0 || failed > 0) {
      log.info({ removed, failed, retentionDays: RETENTION_DAYS }, "回收站清理完成");
    }
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "回收站清理失败"
    );
  }
  return { removed, failed };
}

/** 回收站当前占用（给诊断/日志用）。 */
export function getAppTrashStats(): { files: number; bytes: number } {
  try {
    const dir = getAppTrashDir();
    if (!fs.existsSync(dir)) {
      return { files: 0, bytes: 0 };
    }
    let files = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      try {
        bytes += fs.statSync(path.join(dir, entry.name)).size;
        files++;
      } catch {
        /* 忽略单个文件错误 */
      }
    }
    return { files, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}
