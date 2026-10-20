import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { BrowserWindow } from "electron";
import { getDatabase } from "@/db";
import { PRIVATE_BUILD } from "@/config/private-build";
import { exifData, folders, photos, photoTags } from "@/db/schema";
import { invalidateCountCache } from "@/ipc/photos/handlers/listing";
import { invalidateIndexStatsCache } from "@/ipc/photos/handlers/stats";
import { getAiControlState } from "@/services/ai/state";
import { deletePhotoVectors, embedAllPhotos } from "@/services/ai-embedder";
import { reloadFolderMatcher } from "@/services/folder-matcher";
import {
  getIndexedRootFolders,
  scanFolder as scanFolderService,
  stopScanning as stopScanningService,
  watchFolder,
} from "@/services/indexer";
import { getSetting, setSetting } from "@/services/settings-manager";
import { deletePhotoThumbnails } from "@/services/thumbnailer";
import { importPathKey, normalizeImportFolderPath } from "@/utils/import-path";

// ── Types ──────────────────────────────────────────────────────────

export type ImportTaskStatus =
  | "queued"
  | "scanning"
  | "embedding"
  | "done"
  | "failed"
  | "cancelled";

export interface ImportTask {
  error?: string;
  /** Processing/write failures, included in skipped for compatibility. */
  failed?: number;
  folderPath: string;
  /** Unique id — timestamp of enqueue. */
  id: number;
  /** Number of photos newly indexed by this task. */
  newPhotoCount?: number;
  /** Result from scanFolderService, set once scanning completes. */
  photoCount?: number;
  /** 1-based position in queue (only meaningful while status === "queued"). */
  position: number;
  /** Number of supported files that could not be indexed. */
  skipped?: number;
  status: ImportTaskStatus;
}

export interface ImportQueueStatus {
  /** The task currently being processed, if any. */
  current: ImportTask | null;
  /** History — all completed / failed / cancelled tasks. */
  history: ImportTask[];
  /** 自用：大图库的开机补扫等用户点「开始扫描」（见 enqueueOrAskForConfirmation）✓ */
  pendingStartupScans: Array<{ folderPath: string; photoCount: number }>;
  pending: ImportTask[];
}

// ── State ───────────────────────────────────────────────────────────

const queue: ImportTask[] = [];
const history: ImportTask[] = [];
let current: ImportTask | null = null;
let running = false;
let nextId = 1;
let aiEmbeddingPending = false;
let aiEmbeddingRunning = false;
let suspending = false;
let recoveryStarted = false;
let activeScan: Promise<boolean> | null = null;
const RECOVERY_KEY = "imports.unfinishedRoots";

function readUnfinishedRoots(): string[] {
  const value = getSetting(RECOVERY_KEY);
  if (value === null) {
    // Upgrade recovery for imports interrupted before the journal existed.
    return getDatabase()
      .select({ path: folders.path })
      .from(folders)
      .where(and(isNull(folders.lastScannedAt), isNull(folders.parentId)))
      .all()
      .map((folder) => folder.path);
  }
  const roots: unknown = JSON.parse(value);
  if (
    !(Array.isArray(roots) && roots.every((root) => typeof root === "string"))
  ) {
    throw new Error("Invalid unfinished import journal");
  }
  return roots;
}

function rememberRoot(folderPath: string, unfinished: boolean): void {
  const roots = readUnfinishedRoots().filter(
    (root) => importPathKey(root) !== importPathKey(folderPath)
  );
  if (unfinished) {
    roots.push(folderPath);
  }
  setSetting(RECOVERY_KEY, JSON.stringify(roots));
}

/** Removing a registered folder must also discard its deferred recovery. */
export function forgetInterruptedImports(folderPaths: string[]): void {
  const removed = new Set(folderPaths.map(importPathKey));
  setSetting(
    RECOVERY_KEY,
    JSON.stringify(
      readUnfinishedRoots().filter((root) => !removed.has(importPathKey(root)))
    )
  );
}

/** Reconcile only interrupted roots, never rescan every library on startup. */
export async function resumeInterruptedImports(): Promise<void> {
  if (suspending) {
    // The registry can restart in-process when the data directory changes.
    // Its stop hook drains the old scan before we restore the new profile.
    suspending = false;
    recoveryStarted = false;
    queue.length = 0;
  }
  if (recoveryStarted) {
    return;
  }
  recoveryStarted = true;
  const roots = readUnfinishedRoots();
  setSetting(RECOVERY_KEY, JSON.stringify(roots));
  /*
   * 自用（2026-10-16）：**被强杀后留下的"未完成导入"也走同一道闸门** ✓。
   * 以前这里一律自动重扫 ✗ —— 反复强杀 → 每次开机都全库重扫一遍 ✗，
   * 正是"开机就未响应、连取消都点不了"的另一半来源 ✓。
   */
  const settings = readStartupScanSettings();
  for (const folderPath of roots) {
    try {
      /*
       * 被中断的导入确实没做完，跟文件夹时间无关 → **不做预检**，直接按大小决定 ✓
       *
       * 自用（2026-10-17 第二轮，**按用户口径回退**）：这里**不**强制"一律先问" ✗。
       * 用户指出：设置里写的就是「≥30000 张才在顶栏二次确认」，小目录直接扫没有影响 ✓
       * —— 保持与设置文案一致，比"一律打扰"更好 ✓。
       */
      await enqueueOrAskForConfirmation(folderPath, settings, false);
    } catch (error) {
      // Keep unavailable roots durable, but try only once per application run.
      history.push({
        id: nextId++,
        folderPath,
        position: 0,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  broadcast();
}

let catchUpTimer: NodeJS.Timeout | null = null;
let watchedAiTimer: NodeJS.Timeout | null = null;

// ── 自用（2026-10-16）：开机补扫的开关与「大图库先问一句」 ────────────────
//
// 背景（用户实测过的坑）✗：
//   开机补扫会把**整个树根重新走一遍**（本机 E:\图 24,723 张 + 推特 1,167 张），
//   而"上次扫描被强杀"还会被记账本记住、**下次开机又自动重扫一遍** ✗
//   → 界面未响应、连「取消」都点不了，只能强杀 ✓。
//
// 现在改成**用户一个开关 + 大图库先问一句** ✓：
//   · `imports.startupCatchUpScan`：总开关（默认沿用 private-build 的值 = 关）✓
//   · 阈值**固定 10000 张**（用户定的：图库只增不减，没必要让他选数字 ✓）
//   · 达到阈值就不自动扫，改为在顶栏问一句 ✓
//   · 被强杀留下的"未完成导入"走同一道闸门 ✓（不再开机自动全库重扫 ✓）

const STARTUP_SCAN_SETTING_KEY = "imports.startupCatchUpScan";
/**
 * 自用（2026-10-16，用户点名要的第二个开关 ✓）：
 *   · 开（默认）= 先做**只读预检**（只看文件夹修改时间，约 3 秒），没变化就跳过 ✓
 *   · 关 = 跳过预检，**每次都全量扫一遍**（约 7~10 秒起，图越大越久）✓
 */
const PRECHECK_SETTING_KEY = "imports.startupScanPrecheck";

/**
 * 自用：多少张算"大图库"→ 先问一句 ✓。
 * **固定 30000**，不给用户选（用户口径：图库只增不减，选数字没意义 ✓）。
 */
const LARGE_RESCAN_THRESHOLD = 30_000;

export interface StartupScanSettings {
  confirmLarge: boolean;
  enabled: boolean;
  largeThreshold: number;
  /** 是否先做"只看文件夹时间"的只读预检（默认 true ✓）。 */
  precheck: boolean;
}

/** 读取开机补扫的开关（读不到就用默认值，绝不抛错）✓。 */
export function readStartupScanSettings(): StartupScanSettings {
  // 注意：private-build 里的值是字面量 `false`，这里必须显式标成 boolean ✗→✓
  let enabled: boolean = PRIVATE_BUILD.startupCatchUpScan;
  let precheck = true;
  try {
    const rawEnabled = getSetting(STARTUP_SCAN_SETTING_KEY);
    if (rawEnabled !== null) {
      enabled = rawEnabled === "true";
    }
    const rawPrecheck = getSetting(PRECHECK_SETTING_KEY);
    if (rawPrecheck !== null) {
      precheck = rawPrecheck === "true";
    }
  } catch {
    /* 读不到就用默认 */
  }
  return {
    confirmLarge: true,
    enabled,
    largeThreshold: LARGE_RESCAN_THRESHOLD,
    precheck,
  };
}

/** 等用户点「开始扫描」的开机补扫（大图库不自动扫 ✓）。 */
const pendingStartupScans: Array<{ folderPath: string; photoCount: number }> = [];

export function getPendingStartupScans(): Array<{
  folderPath: string;
  photoCount: number;
}> {
  return pendingStartupScans.map((item) => ({ ...item }));
}

/** 用户点「开始扫描」→ 把待确认的目录投递进导入队列 ✓。 */
export function confirmPendingStartupScans(): number {
  const items = pendingStartupScans.splice(0, pendingStartupScans.length);
  for (const item of items) {
    try {
      enqueueImport(item.folderPath);
    } catch {
      /* 根目录不可用（离线盘 / 被改名）时跳过 */
    }
  }
  broadcast();
  return items.length;
}

/** 用户点「先跳过」→ 本次开机不再问（下次开机还会问）✓。 */
export function dismissPendingStartupScans(): number {
  const count = pendingStartupScans.length;
  pendingStartupScans.length = 0;
  broadcast();
  return count;
}

/**
 * 某个目录（含整棵子目录）在图库里有几张照片 —— 用来判断"算不算大图库" ✓。
 * 用**一条递归查询**按路径定位目录再数照片，避免把几千个目录 id 塞进语句里 ✗。
 */
function countIndexedPhotosUnderPath(folderPath: string): number {
  try {
    const db = getDatabase();
    const normalized = normalizeImportFolderPath(folderPath);
    const row = db.get<{ c: number }>(sql`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM folders WHERE lower(${folders.path}) = lower(${normalized})
        UNION
        SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
      )
      SELECT count(*) AS c
        FROM photos p
        JOIN subtree s ON p.folder_id = s.id
       WHERE p.deleted_at IS NULL
    `);
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

/**
 * 投递一次扫描：先做"有没有变化"的**只读预检** ✓，再按大小决定要不要问一句 ✓。
 *
 * 预检（B′，2026-10-16 用户实测定型 ✓）：
 *   文件夹的"修改日期"会在它**里面**新增/删除/改名任何东西时更新（系统机制 ✓），
 *   所以只要**整棵树里任何一个文件夹**的时间比"上次扫描时间"新，就说明可能有新图 ✓；
 *   一个都没有 → **静默跳过**，不扫、不写库、不弹提示 ✓。
 *   实测（本机 `E:\图` 4,415 个目录 / 7.6 万个文件）：
 *     · 全量扫一遍（什么都没变）**约 7~10 秒**（走目录 2.5s + 逐张确认 3.9s + 数据库）
 *     · B′ 预检 **约 3 秒**，而且**完全不碰数据库、不碰图片文件** ✓
 *   ⚠️ 覆盖不到的情况：**同名覆盖**已有文件（文件夹时间不变）——
 *   但那种情况本来也不需要重新导入（照片已在库里）✓。
 *
 * @param allowPrecheck 这次调用**是否允许**做预检（调用方决定）。
 *   开机补扫允许 ✓；**被强杀后恢复被中断的导入不允许** ✗
 *   （那次导入确实没做完，跟文件夹时间无关，必须接着做 ✓）。
 *   另外还要看用户开关 `settings.precheck` ✓（关掉 = 每次都全量扫 ✓）。
 * @returns "scanned" = 已投递扫描；"pending" = 放进待确认；"unchanged" = 没变化，跳过
 */
async function enqueueOrAskForConfirmation(
  folderPath: string,
  settings: StartupScanSettings,
  allowPrecheck: boolean
): Promise<"scanned" | "pending" | "unchanged"> {
  if (allowPrecheck && settings.precheck) {
    const changed = await folderTreeChangedSinceLastScan(folderPath);
    if (changed === false) {
      console.log(
        `[ImportQueue] 开机补扫：${folderPath} 目录树没有任何变化（只读预检），跳过 ✓`
      );
      return "unchanged";
    }
  }

  if (!settings.confirmLarge) {
    enqueueImport(folderPath);
    return "scanned";
  }
  const photoCount = countIndexedPhotosUnderPath(folderPath);
  if (photoCount >= settings.largeThreshold) {
    const key = importPathKey(folderPath);
    if (
      !pendingStartupScans.some(
        (item) => importPathKey(item.folderPath) === key
      )
    ) {
      pendingStartupScans.push({ folderPath, photoCount });
    }
    console.log(
      `[ImportQueue] 大图库先问一句：${folderPath} 已有 ${photoCount} 张（阈值 ${settings.largeThreshold}），不自动扫描`
    );
    return "pending";
  }
  enqueueImport(folderPath);
  return "scanned";
}

/** 读某个目录"上次扫描完成"的时间（没有记录就返回 null）✓。 */
function readFolderLastScannedAt(folderPath: string): number | null {
  try {
    const db = getDatabase();
    const normalized = normalizeImportFolderPath(folderPath);
    const row = db.get<{ t: number | null }>(sql`
      SELECT last_scanned_at AS t
        FROM folders
       WHERE lower(${folders.path}) = lower(${normalized})
    `);
    return row?.t ?? null;
  } catch {
    return null;
  }
}

/**
 * 只读预检：整棵目录树里，有没有**任何一个文件夹**的修改时间比"上次扫描"新 ✓。
 * @returns true = 可能有变化（要扫）；false = 一点没变（可跳过）；null = 判断不了（按"有变化"处理）
 */
async function folderTreeChangedSinceLastScan(
  folderPath: string
): Promise<boolean | null> {
  const lastScannedAt = readFolderLastScannedAt(folderPath);
  if (lastScannedAt === null) {
    // 从没扫过 → 判断不了，按"有变化"走原来的逻辑 ✓
    return null;
  }
  let rootStat: fs.Stats;
  try {
    rootStat = await fs.promises.stat(folderPath);
  } catch {
    // 根目录不可用（离线盘 / 被改名）：这一轮跳过，下次启动再试 ✓
    return false;
  }

  const stack = [folderPath];
  let visited = 0;
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      // 根目录已经 stat 过（上面），子目录在这里 stat ✓
      const dirStat = dir === folderPath ? rootStat : await fs.promises.stat(dir);
      if (dirStat.mtimeMs > lastScannedAt) {
        return true;
      }
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name));
      }
    }
    // 让出事件循环，避免几千个目录连续 stat 把主进程占住 ✓
    visited++;
    if (visited % 500 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  // 连根目录一起看过，都没有比"上次扫描"新的 → 确实没变化 ✓
  return false;
}

/**
 * 自用版：软件运行中新增的文件，索引后自动触发 AI 处理（见 private-build.ts 的
 * `autoAiForWatchedFiles`）。用防抖，避免连续存几十张图时反复启动索引。
 */
export function scheduleWatchedFilesAiProcessing(delayMs = 30_000): void {
  if (!PRIVATE_BUILD.autoAiForWatchedFiles) {
    return;
  }
  if (watchedAiTimer) {
    clearTimeout(watchedAiTimer);
  }
  watchedAiTimer = setTimeout(() => {
    watchedAiTimer = null;
    if (suspending) {
      return;
    }
    // 向量库服务是 Optional 级别、可能尚未就绪；未就绪就放弃本轮，
    // 下次再有新文件时重试（不阻塞、不报错）。
    void (async () => {
      try {
        const { isVectorDBInitialized } = await import("@/services/ai/vector-db");
        if (!isVectorDBInitialized()) {
          return;
        }
        await embedAllPhotos((aiProgress) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send("ai-progress", aiProgress);
          }
        });
      } catch (error) {
        console.warn(
          "[ImportQueue] watched-files AI processing failed:",
          error instanceof Error ? error.message : String(error)
        );
      }
    })();
  }, delayMs);
}

/**
 * 自用版：开机增量补扫（见 src/config/private-build.ts 的 `startupCatchUpScan` 说明）。
 *
 * 上游刻意不做这件事 —— `resumeInterruptedImports` 的注释明确写着
 * "never rescan every library on startup"。但本版用户习惯**直接往目录里存图**、
 * 不走导入对话框，而 chokidar 配了 `ignoreInitial: true`（启动时忽略已存在的文件），
 * 于是**关机期间新增的图永远不会入库**。
 *
 * 这里对每个树根投递一个普通导入任务，复用现成的增量扫描、进度广播与后续 AI 处理。
 * 扫描按 `photos.path` 查重，是幂等的，不会产生重复记录。
 *
 * @returns 定时器句柄（便于清理）；未启用时返回 null
 */
export function scheduleStartupCatchUpScan(
  delayMs = 25000
): NodeJS.Timeout | null {
  // 自用（2026-10-16）：默认值来自 private-build，**用户可在「设置 → 应用行为」里改** ✓
  const settings = readStartupScanSettings();
  if (!settings.enabled) {
    return null;
  }
  if (catchUpTimer) {
    return catchUpTimer;
  }
  catchUpTimer = setTimeout(() => {
    catchUpTimer = null;
    void (async () => {
      let roots: { id: number; path: string }[] = [];
      try {
        roots = getIndexedRootFolders();
      } catch {
        return;
      }
      let enqueued = 0;
      let unchanged = 0;
      for (const root of roots) {
        try {
          /*
           * 自用（2026-10-16）：这里先做**只读预检**（B′）✓ ——
           * 整棵树里没有任何文件夹比"上次扫描"新，就静默跳过：
           * 不扫、不写库、不弹提示条 ✓（实测：全量扫约 7~10 秒，预检约 3 秒且不碰数据库 ✓）。
           * 通用做法，不针对某一种目录结构写死 ✓。
           */
          const outcome = await enqueueOrAskForConfirmation(
            root.path,
            settings,
            true
          );
          if (outcome === "scanned") {
            enqueued++;
          } else if (outcome === "unchanged") {
            unchanged++;
          }
        } catch {
          // 根目录不可用（离线盘 / 被改名）时跳过，下次启动再试
        }
      }
      console.log(
        `[ImportQueue] 开机补扫：${roots.length} 个根 → 投递扫描 ${enqueued} 个 / 没变化跳过 ${unchanged} 个 / 待确认 ${pendingStartupScans.length} 个`
      );
      if (pendingStartupScans.length > 0) {
        broadcast();
      }
    })();
  }, delayMs);
  return catchUpTimer;
}

/** Shutdown is suspension, not the user's explicit cancel-and-rollback action. */
export function suspendImportsForShutdown(): void {
  suspending = true;
  if (catchUpTimer) {
    clearTimeout(catchUpTimer);
    catchUpTimer = null;
  }
  if (watchedAiTimer) {
    clearTimeout(watchedAiTimer);
    watchedAiTimer = null;
  }
  stopScanningService();
}

export async function stopImports(): Promise<void> {
  suspendImportsForShutdown();
  await activeScan?.catch(() => undefined);
}

function broadcast(): void {
  const status: ImportQueueStatus = {
    pending: queue.map((t, i) => ({ ...t, position: i + 1 })),
    current: current ? { ...current } : null,
    history: history.slice(-20),
    pendingStartupScans: getPendingStartupScans(),
  };

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("import-queue-status", status);
  }
}

function dequeueTask(): ImportTask | null {
  const task = queue.shift();
  if (!task) {
    return null;
  }
  for (let i = 0; i < queue.length; i++) {
    queue[i].position = i + 1;
  }
  return task;
}

// ── Cancel cleanup ──────────────────────────────────────────────────

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Cancellation cleanup must remove photos, vectors, thumbnails, and folders in one lifecycle path.
function cleanupCancelledImport(
  folderId: number,
  newPhotoIds: number[],
  folderExisted: boolean,
  createdFolderIds: number[]
): void {
  const db = getDatabase();

  if (newPhotoIds.length > 0) {
    const records = db
      .select({ id: photos.id, path: photos.path })
      .from(photos)
      .where(inArray(photos.id, newPhotoIds))
      .all();

    db.transaction(() => {
      db.delete(exifData).where(inArray(exifData.photoId, newPhotoIds)).run();
      db.delete(photoTags).where(inArray(photoTags.photoId, newPhotoIds)).run();
      db.delete(photos).where(inArray(photos.id, newPhotoIds)).run();
    });

    for (const r of records) {
      deletePhotoThumbnails(r.path);
    }
    deletePhotoVectors(newPhotoIds).catch(() => {
      /* best-effort */
    });
  }

  if (!folderExisted) {
    const descendantIds: number[] = [];
    const visited = new Set<number>([folderId]);
    const bfsQueue = [folderId];

    while (bfsQueue.length > 0) {
      const cur = bfsQueue.shift();
      if (cur == null) {
        break;
      }
      const children = db
        .select({ id: folders.id })
        .from(folders)
        .where(eq(folders.parentId, cur))
        .all();
      for (const child of children) {
        if (visited.has(child.id)) {
          continue;
        }
        visited.add(child.id);
        descendantIds.push(child.id);
        bfsQueue.push(child.id);
      }
    }

    for (const fid of descendantIds) {
      db.delete(folders).where(eq(folders.id, fid)).run();
    }
    db.delete(folders).where(eq(folders.id, folderId)).run();
    reloadFolderMatcher();
  } else if (createdFolderIds.length > 0) {
    for (const fid of [...createdFolderIds].reverse()) {
      const hasPhotos = db
        .select({ id: photos.id })
        .from(photos)
        .where(eq(photos.folderId, fid))
        .get();
      if (!hasPhotos) {
        db.delete(folders).where(eq(folders.id, fid)).run();
      }
    }
    reloadFolderMatcher();
  }
}

// ── Phase runners ───────────────────────────────────────────────────

async function runScanPhase(task: ImportTask): Promise<boolean> {
  const result = await scanFolderService(task.folderPath, (progress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("scan-progress", progress);
    }
  });

  if (suspending) {
    return false;
  }
  if (result.cancelled) {
    cleanupCancelledImport(
      result.folderId,
      result.newPhotoIds,
      result.folderExisted,
      result.createdFolderIds
    );
    task.status = "cancelled";
    rememberRoot(task.folderPath, false);
    history.push(task);
    return false;
  }

  task.photoCount = result.photoIds.length;
  task.newPhotoCount = result.newPhotoIds.length;
  task.skipped = result.skipped;
  task.failed = result.failed ?? 0;

  watchFolder(task.folderPath, (photoId, event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("file-change", { type: event, photoId });
    }
  });

  if (result.newPhotoIds.length > 0) {
    aiEmbeddingPending = true;
  }

  return true;
}

async function runEmbedPhase(): Promise<number> {
  try {
    return await embedAllPhotos((aiProgress) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("ai-progress", aiProgress);
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ImportQueue] AI embedding failed: ${message}`);
    return 0;
  } finally {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ai-embedding-done");
      win.webContents.send("ai-status-changed");
    }
  }
}

function runPendingAiEmbedding(): void {
  if (
    suspending ||
    running ||
    current ||
    queue.length > 0 ||
    aiEmbeddingRunning ||
    !aiEmbeddingPending
  ) {
    return;
  }

  // A manual/repair embedding run may already own the worker. Keep this
  // import-triggered request pending and run it after that owner releases it.
  if (getAiControlState() !== "idle") {
    setTimeout(runPendingAiEmbedding, 1000);
    return;
  }

  aiEmbeddingPending = false;
  aiEmbeddingRunning = true;
  runEmbedPhase().then(() => {
    aiEmbeddingRunning = false;
    runPendingAiEmbedding();
  });
}

// ── Consumer ───────────────────────────────────────────────────────

async function processNext(): Promise<void> {
  if (running || suspending) {
    return;
  }

  const task = dequeueTask();
  if (!task) {
    running = false;
    current = null;
    broadcast();
    runPendingAiEmbedding();
    return;
  }

  running = true;
  task.status = "scanning";
  current = task;
  broadcast();

  try {
    activeScan = runScanPhase(task);
    const ok = await activeScan;
    if (!ok) {
      return;
    }
    task.status = "done";
    rememberRoot(task.folderPath, false);
    import("@/services/advanced-exif")
      .then(({ scheduleAdvancedExifEnrichment }) =>
        scheduleAdvancedExifEnrichment(1000)
      )
      .catch(() => undefined);
    history.push(task);
  } catch (err: unknown) {
    if (suspending) {
      return;
    }
    task.status = "failed";
    task.error = err instanceof Error ? err.message : String(err);
    history.push(task);
  } finally {
    // Flush IPC-level COUNT cache so the frontend sees accurate totals
    // immediately after import finishes — no stale counts from before
    // the task started.
    current = null;
    running = false;
    activeScan = null;
    if (!suspending) {
      invalidateCountCache();
      invalidateIndexStatsCache();
      broadcast();
      processNext();
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Enqueue a folder for import.
 * Returns immediately with the queued task — the frontend is unblocked.
 */
export function enqueueImport(folderPath: string): ImportTask {
  if (suspending) {
    throw new Error("Application is shutting down");
  }
  const resolved = normalizeImportFolderPath(folderPath);
  const resolvedKey = importPathKey(resolved);

  const duplicate = queue.find(
    (t) => importPathKey(t.folderPath) === resolvedKey
  );
  if (duplicate) {
    return duplicate;
  }
  if (
    current &&
    importPathKey(current.folderPath) === resolvedKey &&
    current.status === "scanning"
  ) {
    return current;
  }

  const task: ImportTask = {
    id: nextId++,
    folderPath: resolved,
    status: "queued",
    position: queue.length + 1,
  };

  // Persist before acknowledging/enqueuing, including tasks not yet started.
  rememberRoot(resolved, true);
  queue.push(task);
  broadcast();

  if (!running) {
    // 延迟到下一 tick，确保 task 以 "queued" 状态返回给调用者
    setImmediate(() => processNext());
  }

  return task;
}

/** Cancel all queued (not-yet-started) tasks. The currently-running task is not affected. */
export function cancelQueuedImports(): ImportTask[] {
  const cancelled = queue.splice(0, queue.length);
  for (const t of cancelled) {
    rememberRoot(t.folderPath, false);
    t.status = "cancelled";
    history.push(t);
  }
  broadcast();
  return cancelled;
}

/** Cancel the currently-running task and clear the queue. */
export function cancelAllImports(): void {
  cancelQueuedImports();
  if (
    current &&
    (current.status === "scanning" || current.status === "embedding")
  ) {
    stopScanningService();
  }
}

/** Cancel only the currently scanning folder. Pending imports continue. */
export function cancelCurrentImport(): boolean {
  if (!current || current.status !== "scanning") {
    return false;
  }
  stopScanningService();
  return true;
}

/** Get the full queue snapshot. */
export function getImportQueueStatus(): ImportQueueStatus {
  return {
    pending: queue.map((t, i) => ({ ...t, position: i + 1 })),
    current: current ? { ...current } : null,
    history: history.slice(-20),
    pendingStartupScans: getPendingStartupScans(),
  };
}

/** Check whether a folder path is currently being imported or queued. */
export function isFolderImporting(folderPath: string): boolean {
  let resolved: string;
  try {
    resolved = normalizeImportFolderPath(folderPath);
  } catch {
    return false;
  }
  const resolvedKey = importPathKey(resolved);
  if (
    current &&
    importPathKey(current.folderPath) === resolvedKey &&
    (current.status === "queued" ||
      current.status === "scanning" ||
      current.status === "embedding")
  ) {
    return true;
  }
  return queue.some((t) => importPathKey(t.folderPath) === resolvedKey);
}
