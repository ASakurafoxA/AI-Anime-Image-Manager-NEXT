import { and, eq, inArray, isNull } from "drizzle-orm";
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
export function resumeInterruptedImports(): void {
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
  for (const folderPath of roots) {
    try {
      enqueueImport(folderPath);
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
  if (!PRIVATE_BUILD.startupCatchUpScan) {
    return null;
  }
  if (catchUpTimer) {
    return catchUpTimer;
  }
  catchUpTimer = setTimeout(() => {
    catchUpTimer = null;
    let roots: { id: number; path: string }[] = [];
    try {
      roots = getIndexedRootFolders();
    } catch {
      return;
    }
    for (const root of roots) {
      try {
        // enqueueImport 内部按路径去重，已在队列/扫描中的根不会被重复投递
        enqueueImport(root.path);
      } catch {
        // 根目录不可用（离线盘 / 被改名）时跳过，下次启动再试
      }
    }
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
