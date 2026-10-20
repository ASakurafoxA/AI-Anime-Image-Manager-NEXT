import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import PQueue from "p-queue";
import sharp from "sharp";
import { getDatabase } from "@/db";
import { exifData, folders, photos } from "@/db/schema";
import { PRIVATE_BUILD } from "@/config/private-build";
import { createLogger } from "@/utils/logger";
import { deletePhotoVectors } from "./ai-embedder";
import { extractDominantColors } from "./color-extractor";
import { checkNewPhotoDuplicates } from "./dedup-service";
import { getFolderMatcher, reloadFolderMatcher } from "./folder-matcher";
import {
  forgetRemovedPath,
  getRemovedFolderPaths,
  isPathRemoved,
} from "./folder-exclusions";
import {
  type ExifOrientation,
  getOrientedDimensions,
  resolveImageOrientation,
} from "./image-orientation";
import { extractRawPreview, isRawFile, readRawDimensions } from "./raw-preview";
import { computePHash } from "./phash";
import { invalidatePhashIndex } from "./phash-index";
import { deletePhotoThumbnails, generateThumbnail } from "./thumbnailer";

const log = createLogger("indexer");
const FOCAL_RANGE_RE = /^\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?$/;
const FOCAL_SPLIT_RE = /\s*-\s*/;
const SHUTTER_FRACTION_RE = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/;
const WATCHER_IGNORED_PATTERNS = [/\.thumbnails/, /\.cache/];

const SUPPORTED_EXTENSIONS = new Set([
  // Common image formats
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".tiff",
  ".tif",
  ".heic",
  ".heif",
  ".gif",
  ".bmp",
  ".ico",
  // RAW camera formats
  ".cr2", // Canon
  ".cr3", // Canon
  ".nef", // Nikon
  ".nrw", // Nikon
  ".arw", // Sony
  ".srf", // Sony
  ".sr2", // Sony
  ".dng", // Adobe Digital Negative
  ".orf", // Olympus / OM System
  ".rw2", // Panasonic
  ".raf", // Fujifilm
  ".pef", // Pentax
  ".rwl", // Leica
  ".3fr", // Hasselblad
  ".raw", // Generic RAW
]);

const SKIP_PATTERNS = [/node_modules/, /\.git/, /\.thumbnails/, /\.cache/];

const WATCHER_CONCURRENCY = 2;
const watcherQueue = new PQueue({ concurrency: WATCHER_CONCURRENCY });

let watcherStats = {
  addEvents: 0,
  unlinkEvents: 0,
  processed: 0,
  skipped: 0,
  errors: 0,
};

export function getWatcherStats() {
  return {
    ...watcherStats,
    queueSize: watcherQueue.size,
    queuePending: watcherQueue.pending,
  };
}

interface IndexProgress {
  currentFile: string;
  phase: "scanning" | "indexing" | "complete";
  scanned: number;
  total: number;
}

type ProgressCallback = (progress: IndexProgress) => void;
let activeScanToken: { cancelled: boolean } | null = null;

/**
 * 自用（2026-10-16）：扫描进度**写进 app.log** ✓。
 *
 * 原来进度只发给界面（`scan-progress` / `import-queue-status`），出事时日志里什么都看不到 ✗
 *（实测：卡住之后只能强杀进程，事后完全无法判断卡在哪个阶段、扫到哪 ✓）。
 * 这里做**节流**：同一阶段最多每 5 秒记一条，避免刷爆日志 ✓。
 */
const SCAN_LOG_INTERVAL_MS = 5000;

interface WatcherContext {
  db: ReturnType<typeof getDatabase>;
  folderId: number | null;
  folderPath: string;
  key: string;
  watcher: FSWatcher;
}

const watchers = new Map<string, WatcherContext>();

type WatcherStateContext = Pick<
  WatcherContext,
  "db" | "folderId" | "folderPath"
>;

type WatcherFailurePhase = "close" | "create" | "error" | "state";

function getWatcherErrorField(
  error: unknown,
  field: "code" | "syscall"
): string | undefined {
  if (typeof error !== "object" || error === null || !(field in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[field];
  return value === undefined || value === null ? undefined : String(value);
}

function logWatcherFailure(
  context: Pick<WatcherContext, "folderId" | "folderPath">,
  error: unknown,
  phase: WatcherFailurePhase,
  message: string
): void {
  log.error(
    {
      folderId: context.folderId,
      folderPath: context.folderPath,
      code: getWatcherErrorField(error, "code"),
      syscall: getWatcherErrorField(error, "syscall"),
      phase,
      err: error,
    },
    message
  );
}

function isCurrentWatcher(context: WatcherContext): boolean {
  return watchers.get(context.key) === context;
}

function removeCurrentWatcher(context: WatcherContext): void {
  if (isCurrentWatcher(context)) {
    watchers.delete(context.key);
  }
}

function updateWatcherState(
  context: WatcherStateContext,
  isWatching: boolean
): boolean {
  try {
    const update = context.db.update(folders).set({
      isWatching,
      watcherStartedAt: isWatching ? Date.now() : null,
    });
    let condition = eq(folders.path, context.folderPath);
    if (context.folderId !== null) {
      condition = eq(folders.id, context.folderId);
    } else if (process.platform === "win32") {
      condition = sql`lower(${folders.path}) = lower(${context.folderPath})`;
    }
    update.where(condition).run();
    return true;
  } catch (error) {
    logWatcherFailure(
      context,
      error,
      "state",
      `Watcher: Failed to update state (${isWatching ? "started" : "stopped"})`
    );
    watcherStats.errors++;
    return false;
  }
}

async function closeWatcherSafely(
  context: Pick<WatcherContext, "folderId" | "folderPath" | "watcher">,
  phase: WatcherFailurePhase = "close"
): Promise<void> {
  let closeResult: Promise<void> | undefined;
  try {
    closeResult = context.watcher.close();
  } catch (error) {
    watcherStats.errors++;
    logWatcherFailure(context, error, phase, "Watcher: Failed to close");
    context.watcher.on("error", () => undefined);
    return;
  }

  // chokidar removes every listener synchronously inside close(). Keep a
  // retired watcher's late native errors from becoming an unhandled error
  // event while its close promise settles (or after a rejected close).
  context.watcher.on("error", () => undefined);
  try {
    await closeResult;
  } catch (error) {
    watcherStats.errors++;
    logWatcherFailure(context, error, phase, "Watcher: Failed to close");
  }
}

function handleWatcherError(context: WatcherContext, error: unknown): void {
  if (!isCurrentWatcher(context)) {
    return;
  }
  removeCurrentWatcher(context);
  watcherStats.errors++;

  logWatcherFailure(context, error, "error", "Watcher: File system error");
  updateWatcherState(context, false);
  closeWatcherSafely(context).catch(() => undefined);
}

function failWatcherSetup(
  context: WatcherContext,
  error: unknown,
  phase: WatcherFailurePhase
): void {
  removeCurrentWatcher(context);
  logWatcherFailure(context, error, phase, "Watcher: Failed to start");
  updateWatcherState(context, false);
  closeWatcherSafely(context, phase === "create" ? "close" : phase).catch(
    () => undefined
  );
}

function findFolderId(
  db: ReturnType<typeof getDatabase>,
  folderPath: string
): number | null {
  try {
    const folder = db
      .select({ id: folders.id })
      .from(folders)
      .where(
        process.platform === "win32"
          ? sql`lower(${folders.path}) = lower(${folderPath})`
          : eq(folders.path, folderPath)
      )
      .get();
    return folder?.id ?? null;
  } catch {
    return null;
  }
}

function createWatcher(
  db: ReturnType<typeof getDatabase>,
  folderPath: string,
  folderId: number | null
): WatcherContext | null {
  const key = watcherPathKey(folderPath);
  let watcher: FSWatcher;
  try {
    watcher = chokidar.watch(folderPath, {
      ignored: WATCHER_IGNORED_PATTERNS,
      ignorePermissionErrors: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
      depth: 10,
    });
  } catch (error) {
    watcherStats.errors++;
    updateWatcherState({ db, folderId, folderPath }, false);
    logWatcherFailure(
      { folderId, folderPath },
      error,
      "create",
      "Watcher: Failed to create"
    );
    return null;
  }

  const context: WatcherContext = {
    db,
    folderId,
    folderPath,
    key,
    watcher,
  };
  watchers.set(key, context);
  try {
    // Bind this before any event-specific handlers so native async errors
    // cannot escape during watcher startup.
    watcher.on("error", (error) => handleWatcherError(context, error));
  } catch (error) {
    failWatcherSetup(context, error, "create");
    return null;
  }
  return context;
}

function watcherPathKey(folderPath: string): string {
  const normalized = path.normalize(folderPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * 自用新增（2026-10，用户要求"在软件里重命名文件夹"）：
 * **改名/移动文件夹期间的"事件屏蔽窗口"**。
 *
 * 为什么需要：chokidar **没有 rename 事件** —— 把一个文件夹改名，它看到的是
 * "旧路径下每个文件 unlink + 新路径下每个文件 add"。而 `unlink` 的处理是
 * `db.delete(photos)`（**硬删**），于是照片的标签/相册/收藏关联全被级联删掉 ✗。
 *
 * 所以软件自己改名时：改名前把**旧路径、新路径**（及其父目录）登记进来，
 * 这段时间内这些路径上的 watcher 事件一律忽略 ✓ ——
 * 数据库由 `renameFolder` 自己按前缀迁移，关联一张不丢 ✓。
 *
 * 用"带到期时间的窗口"而不是"改完再取消"：即使改名过程中抛错/进程重启，
 * 也只影响这一小段时间，不会把监听**永久**弄坏 ✓。
 */
const suppressedWatcherPaths = new Map<string, number>();

/** 登记要屏蔽的路径（默认 15 秒；覆盖 rename + 数据库迁移 + chokidar 的延迟投递）。 */
export function suppressWatcherPaths(
  paths: string[],
  durationMs = 15_000
): void {
  const until = Date.now() + durationMs;
  for (const target of paths) {
    if (!target) {
      continue;
    }
    suppressedWatcherPaths.set(watcherPathKey(target), until);
    // 父目录也屏蔽：某些系统上目录本身的增删会产生父级事件
    const parent = path.dirname(target);
    if (parent && parent !== target) {
      suppressedWatcherPaths.set(watcherPathKey(parent), until);
    }
  }
}

/** 这个路径当前是否处于屏蔽窗口内（含其子孙）。 */
export function isWatcherPathSuppressed(filePath: string): boolean {
  if (suppressedWatcherPaths.size === 0) {
    return false;
  }
  const now = Date.now();
  for (const [key, until] of suppressedWatcherPaths) {
    if (until <= now) {
      suppressedWatcherPaths.delete(key);
    }
  }
  if (suppressedWatcherPaths.size === 0) {
    return false;
  }
  const key = watcherPathKey(filePath);
  for (const suppressed of suppressedWatcherPaths.keys()) {
    if (key === suppressed || key.startsWith(`${suppressed}${path.sep}`)) {
      return true;
    }
  }
  return false;
}

export function isIndexing(): boolean {
  return activeScanToken !== null;
}

export function getSupportedExtensions(): string[] {
  return Array.from(SUPPORTED_EXTENSIONS);
}

function getFolderDepth(folderPath: string): number {
  return folderPath.split(path.sep).filter(Boolean).length;
}

function shouldIndex(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return false;
  }

  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(filePath)) {
      return false;
    }
  }

  return true;
}

// --- pHash (Perceptual Hash) — DCT-based ---
// 算法已抽到 `@/services/phash`，与「以图搜图」「查重」共用同一份实现
// （算法一字未改，库里已有的 phash-v1 指纹继续有效）。

async function readBasicMeta(filePath: string): Promise<{
  width: number;
  height: number;
  format: string;
  colorSpace: string;
  hasAlpha: boolean;
  orientation: ExifOrientation;
  thumbnailInput?: Buffer;
} | null> {
  try {
    const raw = isRawFile(filePath);
    // For RAW files, use the embedded JPEG only for decoder metadata and
    // thumbnail generation. Capture dimensions come from ExifTool below.
    let input: string | Buffer = filePath;
    let thumbnailInput: Buffer | undefined;
    if (raw) {
      const preview = await extractRawPreview(filePath);
      if (preview) {
        input = preview;
        thumbnailInput = preview;
      }
    }
    const meta = await sharp(input).metadata();
    const orientation = await resolveImageOrientation(filePath, meta);
    const dimensions = raw
      ? await readRawDimensions(filePath)
      : getOrientedDimensions(meta.width, meta.height, orientation);
    if (!dimensions) {
      return null;
    }
    const { width, height } = raw
      ? getOrientedDimensions(dimensions.width, dimensions.height, orientation)
      : dimensions;
    // RAW files: use file extension as format (sharp returns "jpeg" from embedded preview)
    const format = raw
      ? path.extname(filePath).toLowerCase().replace(".", "")
      : meta.format || "";
    return {
      width,
      height,
      format,
      colorSpace: meta.space || "",
      hasAlpha: meta.hasAlpha,
      orientation,
      thumbnailInput,
    };
  } catch {
    return null;
  }
}

interface PhotoRecord {
  colorBucket: number | null;
  colorSpace: string;
  dominantColors: string | null;
  duelPreviewPath: string | null;
  fileDate: number;
  filename: string;
  fileSize: number;
  folderId: number | null;
  format: string;
  hasAlpha: boolean;
  height: number;
  isIndexed: boolean;
  path: string;
  phash: string | null;
  thumbnailPath: string | null;
  thumbnailSize: string;
  width: number;
}

// ── Hue bucket helper ────────────────────────────────────────────────────
// Maps the primary hue (0–359) from dominant_colors JSON to a 36-bucket
// integer (0–35) for color-search pre-filtering. Returns null if no color data.
function computeHueBucket(dominantColorsJson: string | null): number | null {
  if (!dominantColorsJson) {
    return null;
  }
  try {
    const palette = JSON.parse(dominantColorsJson) as Array<{
      hue?: number;
      weight: number;
    }>;
    if (palette.length === 0 || palette[0].hue == null) {
      return null;
    }
    return Math.floor(palette[0].hue / 10) % 36;
  } catch {
    return null;
  }
}

function queuePrimaryColorVectorUpsert(
  photoId: number,
  dominantColors: string | null
): void {
  if (!dominantColors) {
    return;
  }

  try {
    const palette = JSON.parse(dominantColors) as Array<{
      b: number;
      g: number;
      r: number;
      weight: number;
    }>;
    const primary = palette[0];
    if (!primary) {
      return;
    }

    import("./ai/vector-db")
      .then(({ upsertColorVector }) =>
        upsertColorVector(photoId, primary.r, primary.g, primary.b)
      )
      .catch(() => {
        /* best-effort */
      });
  } catch {
    // Invalid palette JSON should not block indexing.
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Photo preparation combines metadata, thumbnail, RAW preview, EXIF, and color extraction for one indexed file.
async function preparePhotoRecord(
  filePath: string,
  folderId: number | null
): Promise<{
  photoRecord: PhotoRecord;
  stat: fs.Stats;
  phash: string | null;
} | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    log.warn({ filePath }, "File disappeared before indexing");
    return null;
  }

  const meta = await readBasicMeta(filePath);
  if (!meta) {
    log.warn({ filePath }, "Skipped unreadable file (sharp metadata failed)");
    return null;
  }

  // Generate thumbnail (md=320px for crisp display in grid)
  let thumb: Awaited<ReturnType<typeof generateThumbnail>>;
  try {
    thumb = await generateThumbnail(filePath, "md", {
      input: meta.thumbnailInput,
      orientation: meta.orientation,
    });
  } catch {
    log.warn({ filePath }, "Thumbnail generation failed");
    thumb = { thumbnailPath: "", width: 0, height: 0 };
  }

  // Duel previews are generated lazily by cull.ensureDuelPreview.
  const duelPreviewPath: string | null = null;

  // Reuse the in-memory thumbnail for pHash instead of decoding the original
  // image a second time. pHash normalizes to 32x32, so the 512px thumbnail has
  // ample detail while substantially reducing import I/O and CPU cost.
  let phash: string | null = null;
  const phashInput = thumb.buffer ?? thumb.thumbnailPath ?? filePath;
  try {
    phash = await computePHash(phashInput);
  } catch (err) {
    // pHash computation failed — photo can still be indexed and browsed;
    // it simply won't participate in pHash-based dedup.
    log.warn(
      { filePath, err },
      "pHash computation failed, photo will be indexed without dedup hash"
    );
    phash = null;
  }

  // 提取主色调（使用缩略图，3-8ms/张）
  let dominantColors: string | null = null;
  if (thumb.thumbnailPath) {
    try {
      dominantColors = await extractDominantColors(
        thumb.buffer ?? thumb.thumbnailPath
      );
    } catch (err) {
      // 颜色提取失败不阻塞索引
      console.warn(`[Indexer] Color extraction failed for ${filePath}:`, err);
    }
  }
  const colorBucket = computeHueBucket(dominantColors);

  const photoRecord: PhotoRecord = {
    path: filePath,
    folderId,
    filename: path.basename(filePath),
    fileSize: stat.size,
    fileDate: Math.floor(Math.min(stat.birthtimeMs, stat.mtimeMs)),
    width: meta.width,
    height: meta.height,
    format: meta.format,
    colorSpace: meta.colorSpace,
    colorBucket,
    hasAlpha: meta.hasAlpha,
    thumbnailPath: thumb.thumbnailPath,
    thumbnailSize: `${thumb.width}x${thumb.height}`,
    duelPreviewPath,
    isIndexed: true,
    phash,
    dominantColors,
  };

  /*
   * 自用（2026-10-17，用户口径）：**导入不再解析 EXIF** ✓
   *
   * 用户原话：「数据导入那步，不要 exif 了，原项目留下来的残留，用不上」——
   * 每张图都要跑一次 exifr（读文件头 + 解析），而插画/截图几乎全是空结果，
   * 白花时间还制造一堆"没有 EXIF"的日志 ✗。
   *
   * 现在这里**直接返回 null**：`exifData` 表结构、`getPhotoExif` 接口、
   * 详情页的读取逻辑都保留（老数据还能看），只是**导入不再写入** ✓
   */
  return { photoRecord, stat, phash };
}

async function indexSingleFile(
  filePath: string,
  folderId: number | null
): Promise<number | null> {
  const db = getDatabase();

  // Check if already indexed — update folderId to the more specific (deeper) folder
  const existing = db
    .select({ id: photos.id, folderId: photos.folderId })
    .from(photos)
    .where(eq(photos.path, filePath))
    .get();
  if (existing) {
    if (folderId !== null && existing.folderId !== folderId) {
      // Only reassign if the new folder is more specific (deeper path) than the current one
      const existingFolder = existing.folderId
        ? db
            .select({ path: folders.path })
            .from(folders)
            .where(eq(folders.id, existing.folderId))
            .get()
        : null;
      const newFolder = db
        .select({ path: folders.path })
        .from(folders)
        .where(eq(folders.id, folderId))
        .get();
      if (
        newFolder &&
        (!existingFolder ||
          getFolderDepth(newFolder.path) > getFolderDepth(existingFolder.path))
      ) {
        db.update(photos)
          .set({ folderId })
          .where(eq(photos.id, existing.id))
          .run();
      }
    }
    return existing.id;
  }

  const prepared = await preparePhotoRecord(filePath, folderId);
  if (!prepared) {
    return null;
  }

  const { photoRecord, stat, phash } = prepared;

  // A scan or another overlapping watcher may have inserted this path while
  // metadata/thumbnail preparation yielded. Reuse its row instead of racing it.
  const indexedDuringPreparation = db
    .select({ id: photos.id })
    .from(photos)
    .where(eq(photos.path, filePath))
    .get();
  if (indexedDuringPreparation) {
    return indexedDuringPreparation.id;
  }

  // Insert photo record
  const result = db
    .insert(photos)
    .values(photoRecord)
    .returning({ insertedId: photos.id })
    .get();

  if (!result) {
    return null;
  }
  const photoId = result.insertedId;

  // Incremental duplicate detection
  checkNewPhotoDuplicates(photoId, phash, filePath, stat.size);

  // 新图入索引 → 共用 pHash 索引（以图搜图 / 查重）必须失效重建。
  // 它的变更判据只有「张数 + 最大 id」，这里插入新行刚好会被它发现；
  // 但 phash 被**改写**（重新计算）时判据不变，所以显式失效更稳妥。
  invalidatePhashIndex();


  queuePrimaryColorVectorUpsert(photoId, photoRecord.dominantColors);

  return photoId;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Folder scanning preserves cancellation, batching, duplicate handling, and progress lifecycle in one public operation.
export async function scanFolder(
  folderPath: string,
  onProgress?: ProgressCallback
): Promise<{
  createdFolderIds: number[];
  folderId: number;
  photoIds: number[];
  newPhotoIds: number[];
  skipped: number;
  failed: number;
  cancelled: boolean;
  folderExisted: boolean;
}> {
  const db = getDatabase();
  if (activeScanToken !== null) {
    throw new Error("A folder scan is already in progress");
  }
  const scanToken = { cancelled: false };
  activeScanToken = scanToken;
  const scanStartedAt = Date.now();
  let lastProgressLogAt = 0;
  const reportProgress = (progress: IndexProgress): void => {
    onProgress?.(progress);
    const now = Date.now();
    if (now - lastProgressLogAt >= SCAN_LOG_INTERVAL_MS) {
      lastProgressLogAt = now;
      log.info(
        `[Scan] ${progress.phase} 已扫 ${progress.scanned}${progress.total > 0 ? `/${progress.total}` : ""}${progress.currentFile ? ` — ${progress.currentFile}` : ""}`
      );
    }
  };
  log.info(`[Scan] 开始扫描: ${folderPath}`);
  const newPhotoIds: number[] = [];
  const createdFolderIds: number[] = [];

  try {
    let resolvedPath = path.resolve(folderPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Folder does not exist: ${resolvedPath}`);
    }

    let folder = db
      .select()
      .from(folders)
      .where(
        process.platform === "win32"
          ? sql`lower(${folders.path}) = lower(${resolvedPath})`
          : eq(folders.path, resolvedPath)
      )
      .get();
    const folderExisted = !!folder;
    if (folder) {
      resolvedPath = folder.path;
    }
    if (!folder) {
      const result = db
        .insert(folders)
        .values({
          path: resolvedPath,
          displayName: path.basename(resolvedPath),
        })
        .returning({ insertedId: folders.id })
        .get();
      if (!result) {
        throw new Error("Failed to create folder record");
      }
      createdFolderIds.push(result.insertedId);
      folder = {
        id: result.insertedId,
        path: resolvedPath,
        displayName: path.basename(resolvedPath),
        appearanceColor: null,
        appearanceIcon: null,
        parentId: null,
        photoCount: 0,
        lastScannedAt: null,
        createdAt: Date.now(),
        isWatching: false,
        watcherStartedAt: null,
        lastWatcherEventAt: null,
      };
    }

    const folderId = folder.id;

    // 用户主动重新导入一个曾被「移除文件夹」的路径 → 忘掉这条移除记录。
    // （开机补扫走的是**树根**，树根不会在移除列表里，所以这里不会误清子目录的记录。）
    forgetRemovedPath(resolvedPath);
    // 本次扫描要跳过的目录：一次读好，避免在逐层遍历里反复查数据库。
    const removedPaths = getRemovedFolderPaths();

    // Async walk — avoids blocking the main process on large folders.
    // Each directory level yields the event loop via setImmediate to keep the UI responsive.
    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      if (scanToken.cancelled) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        // Permission denied or directory removed — skip silently
        return;
      }
      // Yield the event loop after reading each directory to prevent UI jank
      await new Promise<void>((r) => setImmediate(r));
      reportProgress({
        scanned: files.length,
        total: 0,
        phase: "scanning",
        currentFile: dir,
      });
      for (const entry of entries) {
        if (scanToken.cancelled) {
          return;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // 用户移除过的目录（及其整棵子树）不再扫描 —— 否则开机补扫会把
          // 刚删掉的文件夹连照片一起重新建回来。
          if (isPathRemoved(fullPath, removedPaths)) {
            continue;
          }
          await walk(fullPath);
        } else if (entry.isFile() && shouldIndex(fullPath)) {
          files.push(fullPath);
        }
      }
    }
    await walk(resolvedPath);

    // Auto-discover subdirectories that contain images and create folder records.
    // Walk up from each file's directory to the scan root, creating any missing
    // intermediate folder records with proper parentId linkage.
    //
    // 自用（2026-10-16，**修"导入大目录时界面点不动、连取消都点不了"**）：
    // 原来这里是 `for (const f of files)` —— 对**每一个文件**都算一遍父目录，
    // 而且整段没有一个 await（better-sqlite3 是**同步**的）✗：
    //   2.4 万个文件 → 主线程里跑几万条同步 SQL，事件循环被完全占死 ✗，
    //   界面收不到 IPC（连「取消」按钮都点不动）✓ 与实测现象一致。
    // 现在两处改动：
    //   ① 先按**目录去重**（2.4 万文件通常只有几百到几千个目录 ✓）；
    //   ② 每处理 200 个目录**让出一次事件循环** → 取消/界面始终可响应 ✓。
    const dirToFolderId = new Map<string, number>();
    dirToFolderId.set(resolvedPath, folderId);

    const uniqueDirs = new Set<string>();
    for (const f of files) {
      const parent = path.dirname(f);
      if (parent !== resolvedPath) {
        uniqueDirs.add(parent);
      }
    }
    /*
     * 自用：按**层级从浅到深**处理目录 ✓。
     * 这样父目录一定先于子目录登记，parentId 永远能取到（原来的写法靠遍历顺序碰运气，
     * 顺序不巧时最上层那个目录会拿到 parentId = null ✗）。
     */
    const orderedDirs = [...uniqueDirs].sort(
      (a, b) =>
        a.split(path.sep).length - b.split(path.sep).length ||
        (a < b ? -1 : a > b ? 1 : 0)
    );
    log.info(
      `[Scan] 目录登记：${files.length} 个文件 → ${orderedDirs.length} 个目录（已去重、按层级排序）`
    );

    let dirsProcessed = 0;
    for (const startDir of orderedDirs) {
      if (scanToken.cancelled) {
        break;
      }
      dirsProcessed++;
      if (dirsProcessed % 200 === 0) {
        reportProgress({
          scanned: files.length,
          total: files.length,
          phase: "indexing",
          currentFile: startDir,
        });
        await new Promise<void>((r) => setImmediate(r));
      }

      let dir = startDir;

      // Collect missing ancestor directories (bottom-up)
      const missing: string[] = [];
      while (dir !== resolvedPath && !dirToFolderId.has(dir)) {
        missing.unshift(dir);
        dir = path.dirname(dir);
      }

      // Create missing directories top-down so parentId is available
      for (const d of missing) {
        // 兜底：万一某个祖先被移除过（正常已被 walk 剪掉，这里再挡一次）
        if (isPathRemoved(d, removedPaths)) {
          continue;
        }
        const parentDir = path.dirname(d);
        const parentId = dirToFolderId.get(parentDir) ?? null;

        let subFolder = db
          .select({ id: folders.id })
          .from(folders)
          .where(eq(folders.path, d))
          .get();
        if (!subFolder) {
          const result = db
            .insert(folders)
            .values({
              path: d,
              displayName: path.basename(d),
              parentId,
            })
            .returning({ insertedId: folders.id })
            .get();
          if (result) {
            subFolder = { id: result.insertedId };
            createdFolderIds.push(result.insertedId);
          }
        } else if (subFolder) {
          // Existing folder record — update parentId if missing
          db.update(folders)
            .set({ parentId })
            .where(eq(folders.id, subFolder.id))
            .run();
        }

        if (subFolder) {
          dirToFolderId.set(d, subFolder.id);
        }
      }
    }

    // Index each file with concurrency for speed.
    // Sharp/libvips uses the libuv thread pool internally, so overlapping
    // thumbnail generation + metadata reads yields ~3x throughput on typical
    // consumer hardware without saturating I/O.
    // 自用：并发数固定 4（原「占用限制」滑块的缩放已整体删除）
    const CONCURRENCY = 4;
    const BATCH_SIZE = 50;
    const photoIds: number[] = [];
    let scanned = 0;
    let skipped = 0;
    let failed = 0;

    async function runWithConcurrency<T, R>(
      items: T[],
      fn: (item: T) => Promise<R | null>,
      limit: number
    ): Promise<Array<R | null>> {
      const results: Array<R | null> = new Array(items.length);
      let cursor = 0;

      async function worker(): Promise<void> {
        while (cursor < items.length && !scanToken.cancelled) {
          const idx = cursor++;
          const item = items[idx];
          results[idx] = await fn(item);
        }
      }

      const workers = Array.from(
        { length: Math.min(limit, items.length) },
        () => worker()
      );
      await Promise.all(workers);
      return results;
    }

    // Process one bounded batch at a time so EXIF/raw metadata for very large
    // folders cannot accumulate in memory before the first database write.
    for (
      let batchStart = 0;
      batchStart < files.length;
      batchStart += BATCH_SIZE
    ) {
      if (scanToken.cancelled) {
        break;
      }
      // 自用（2026-10-16）：每批之间显式让出事件循环 ✓。
      // 批次内部虽然有 await，但紧跟着的「查重 + 插入事务」是**同步**的 ✓；
      // 显式让一次可以保证「取消」和界面刷新总能轮到 ✓。
      await new Promise<void>((r) => setImmediate(r));
      const batchFiles = files.slice(batchStart, batchStart + BATCH_SIZE);
      const existingRows = db
        .select({ id: photos.id, folderId: photos.folderId, path: photos.path })
        .from(photos)
        .where(inArray(photos.path, batchFiles))
        .all();
      const existingByPath = new Map(
        existingRows.map((row) => [row.path, row])
      );

      const preparedRecords = await runWithConcurrency(
        batchFiles,
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Per-file indexing callback keeps all error and cancellation branches together for queue ordering.
        async (file) => {
          if (scanToken.cancelled) {
            return null;
          }

          reportProgress({
            scanned,
            total: files.length,
            phase: "indexing",
            currentFile: file,
          });

          try {
            const fileDir = path.dirname(file);
            const fileFolderId = dirToFolderId.get(fileDir) || folderId;

            // Check if already indexed
            const existing = existingByPath.get(file);

            if (existing) {
              if (fileFolderId !== null && existing.folderId !== fileFolderId) {
                const existingFolder = existing.folderId
                  ? db
                      .select({ path: folders.path })
                      .from(folders)
                      .where(eq(folders.id, existing.folderId))
                      .get()
                  : null;
                const newFolder = db
                  .select({ path: folders.path })
                  .from(folders)
                  .where(eq(folders.id, fileFolderId))
                  .get();
                if (
                  newFolder &&
                  (!existingFolder ||
                    getFolderDepth(newFolder.path) >
                      getFolderDepth(existingFolder.path))
                ) {
                  db.update(photos)
                    .set({ folderId: fileFolderId })
                    .where(eq(photos.id, existing.id))
                    .run();
                }
              }
              scanned++;
              return { type: "existing" as const, photoId: existing.id };
            }

            const prepared = await preparePhotoRecord(file, fileFolderId);
            if (!prepared) {
              scanned++;
              return null;
            }

            scanned++;
            return { type: "new" as const, ...prepared };
          } catch (error) {
            log.error({ file, err: error }, "Error preparing file");
            failed++;
            scanned++;
            return null;
          }
        },
        CONCURRENCY
      );

      // Batch insert: insert photos in batches
      const newRecords = preparedRecords.filter(
        (r) => r && r.type === "new"
      ) as Array<{
        type: "new";
        photoRecord: PhotoRecord;
              stat: fs.Stats;
        phash: string | null;
      }>;

      const existingRecords = preparedRecords.filter(
        (r) => r && r.type === "existing"
      ) as Array<{ type: "existing"; photoId: number }>;

      // Add existing photo IDs
      for (const record of existingRecords) {
        photoIds.push(record.photoId);
      }

      // Batch insert new photos
      for (let i = 0; i < newRecords.length; i += BATCH_SIZE) {
        if (scanToken.cancelled) {
          // Clean up thumbnails for prepared-but-uninserted records.
          // These files were processed by preparePhotoRecord (thumbnails
          // already on disk) but were never committed to the database, so
          // the IPC-level cancel cleanup won't find them.
          for (let k = i; k < newRecords.length; k++) {
            deletePhotoThumbnails(newRecords[k].photoRecord.path);
          }
          break;
        }

        // A watcher may finish while this scan prepares its batch. Include
        // that row in the scan result rather than attempting a duplicate insert.
        const batch = newRecords.slice(i, i + BATCH_SIZE).filter((record) => {
          const indexed = db
            .select({ id: photos.id })
            .from(photos)
            .where(eq(photos.path, record.photoRecord.path))
            .get();
          if (indexed) {
            photoIds.push(indexed.id);
            return false;
          }
          return true;
        });
        if (batch.length === 0) {
          continue;
        }
        const photoRecords = batch.map((r) => r.photoRecord);

        try {
          const insertedPairs: Array<{
            photoId: number;
            record: (typeof batch)[number];
          }> = [];

          db.transaction(() => {
            const insertedIds = db
              .insert(photos)
              .values(photoRecords)
              .returning({ insertedId: photos.id })
              .all();

            for (let j = 0; j < insertedIds.length; j++) {
              const photoId = insertedIds[j].insertedId;
              const record = batch[j];

              photoIds.push(photoId);
              newPhotoIds.push(photoId);
              insertedPairs.push({ photoId, record });
              // 自用（2026-10-17）：导入不再写 EXIF 记录 ✓
            }
          });

          for (const { photoId, record } of insertedPairs) {
            checkNewPhotoDuplicates(
              photoId,
              record.phash,
              record.photoRecord.path,
              record.stat.size
            );
            queuePrimaryColorVectorUpsert(
              photoId,
              record.photoRecord.dominantColors
            );
          }
        } catch (err: unknown) {
          // Fallback to individual inserts if batch fails
          log.warn(
            { err },
            "Batch insert failed, falling back to individual inserts"
          );
          for (const record of batch) {
            try {
              const result = db
                .insert(photos)
                .values(record.photoRecord)
                .returning({ insertedId: photos.id })
                .get();

              if (result) {
                const photoId = result.insertedId;
                photoIds.push(photoId);
                newPhotoIds.push(photoId);

                checkNewPhotoDuplicates(
                  photoId,
                  record.phash,
                  record.photoRecord.path,
                  record.stat.size
                );
                queuePrimaryColorVectorUpsert(
                  photoId,
                  record.photoRecord.dominantColors
                );
                // 自用（2026-10-17）：导入不再写 EXIF 记录 ✓
              }
            } catch {
              skipped++;
              failed++;
            }
          }
        }
      }

      // Count skipped files
      skipped += preparedRecords.filter((r) => r === null).length;
      if (scanToken.cancelled) {
        break;
      }
    }

    if (skipped > 0) {
      log.info(
        { indexed: photoIds.length, skipped, total: files.length },
        "Folder scan summary"
      );
    }

    // Clean up photos whose files no longer exist on disk — check all folders
    //
    // 自用（2026-10-16）：这一段原来也是**全程同步**的 ✗ ——
    // 对每个目录把该目录**所有**照片查出来，再逐张 `fs.existsSync`（同步 stat）✗。
    // 24,723 张图就是 2 万多次同步 stat + 同步 SQL → 事件循环同样被占死 ✓。
    // 现在：每 500 张让出一次事件循环，并且「取消」能立刻中断这一段 ✓。
    const stalePhotoIds: number[] = [];
    let staleChecked = 0;
    for (const [_dirPath, fid] of dirToFolderId) {
      if (scanToken.cancelled) {
        break;
      }
      const dbPhotos = db
        .select({ id: photos.id, path: photos.path })
        .from(photos)
        .where(eq(photos.folderId, fid))
        .all();
      for (const p of dbPhotos) {
        if (scanToken.cancelled) {
          break;
        }
        if (++staleChecked % 500 === 0) {
          await new Promise<void>((r) => setImmediate(r));
        }
        if (!fs.existsSync(p.path)) {
          db.delete(exifData).where(eq(exifData.photoId, p.id)).run();
          db.delete(photos).where(eq(photos.id, p.id)).run();
          stalePhotoIds.push(p.id);
          const idx = photoIds.indexOf(p.id);
          if (idx >= 0) {
            photoIds.splice(idx, 1);
          }
          const newIdx = newPhotoIds.indexOf(p.id);
          if (newIdx >= 0) {
            newPhotoIds.splice(newIdx, 1);
          }
          log.info({ path: p.path }, "Removed stale record");
        }
      }
    }
    if (stalePhotoIds.length > 0) {
      await deletePhotoVectors(stalePhotoIds).catch((err) => {
        log.warn({ err }, "Failed to remove stale photo vectors");
      });
    }

    const folderIds = Array.from(new Set(dirToFolderId.values()));
    const folderPhotoCounts = new Map<number, number>();
    if (folderIds.length > 0) {
      const rows = db
        .select({
          count: sql<number>`count(*)`,
          folderId: photos.folderId,
        })
        .from(photos)
        .where(
          and(inArray(photos.folderId, folderIds), isNull(photos.deletedAt))
        )
        .groupBy(photos.folderId)
        .all();

      for (const row of rows) {
        if (row.folderId !== null) {
          folderPhotoCounts.set(row.folderId, row.count);
        }
      }
    }

    for (const fid of folderIds) {
      db.update(folders)
        .set({
          ...(scanToken.cancelled ? {} : { lastScannedAt: Date.now() }),
          photoCount: folderPhotoCounts.get(fid) ?? 0,
        })
        .where(eq(folders.id, fid))
        .run();
    }

    // 重新加载文件夹匹配器缓存
    reloadFolderMatcher();

    if (!scanToken.cancelled) {
      reportProgress({
        scanned: files.length,
        total: files.length,
        phase: "complete",
        currentFile: "",
      });
    }

    /* 自用（2026-10-16）：一条**总账**日志 ✓ —— 出事后一眼能看出扫了多少、花了多久。 */
    log.info(
      `[Scan] 扫描结束${scanToken.cancelled ? "（已取消）" : ""}: ${resolvedPath} 用时 ${((Date.now() - scanStartedAt) / 1000).toFixed(1)}s，磁盘上 ${files.length} 个受支持文件，新增 ${newPhotoIds.length}，跳过 ${skipped}，失败 ${failed}，本次涉及 ${photoIds.length}，清理失效记录 ${stalePhotoIds.length}`
    );

    // Auto-tagging now runs after embedAllPhotos() completes, when all CLIP
    // vectors are available in LanceDB. This avoids expensive per-photo worker
    // embedding and prevents the scene-tag bias (every photo tagged as indoor/outdoor/city).

    return {
      createdFolderIds: [...createdFolderIds],
      folderId,
      photoIds,
      newPhotoIds,
      skipped,
      failed,
      cancelled: scanToken.cancelled,
      folderExisted,
    };
  } catch (error) {
    /* 自用（2026-10-16）：扫描失败也写日志 ✓（原来只有界面能看到，出事时日志为空 ✗）。 */
    log.error(
      `[Scan] 扫描失败（已回滚）: ${folderPath} 用时 ${((Date.now() - scanStartedAt) / 1000).toFixed(1)}s — ${error instanceof Error ? error.message : String(error)}`
    );
    const inserted =
      newPhotoIds.length > 0
        ? db
            .select({ id: photos.id, path: photos.path })
            .from(photos)
            .where(inArray(photos.id, newPhotoIds))
            .all()
        : [];
    if (newPhotoIds.length > 0) {
      db.transaction(() => {
        db.delete(exifData).where(inArray(exifData.photoId, newPhotoIds)).run();
        db.delete(photos).where(inArray(photos.id, newPhotoIds)).run();
      });
      for (const record of inserted) {
        deletePhotoThumbnails(record.path);
      }
      await deletePhotoVectors(newPhotoIds).catch(() => {
        /* best-effort rollback */
      });
    }
    for (const folderId of createdFolderIds.reverse()) {
      const remaining = db
        .select({ count: sql<number>`count(*)` })
        .from(photos)
        .where(eq(photos.folderId, folderId))
        .get()?.count;
      if (!remaining) {
        db.delete(folders).where(eq(folders.id, folderId)).run();
      }
    }
    reloadFolderMatcher();
    throw error;
  } finally {
    if (activeScanToken === scanToken) {
      activeScanToken = null;
    }
  }
}

// A watcher can discover files before a scan has registered their directories.
// Resolve the actual parent before asynchronous metadata work, so a stale
// ancestor match can never be written as the new photo's folder relation.
function resolveWatchedFileFolder(filePath: string): number | null {
  const db = getDatabase();
  // 用户移除过的目录：监听器刚发现的新文件也不要再把它建回来。
  // （父目录的监听器覆盖整棵子树，所以即使文件夹记录已删，事件仍会到达这里。）
  if (isPathRemoved(path.dirname(filePath))) {
    return null;
  }
  const ancestorId = getFolderMatcher().match(filePath);
  if (ancestorId === null) {
    return null;
  }
  const ancestor = db
    .select()
    .from(folders)
    .where(eq(folders.id, ancestorId))
    .get();
  if (!ancestor) {
    return null;
  }
  const relative = path.relative(ancestor.path, path.dirname(filePath));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  const folderId = db.transaction(() => {
    let parentId = ancestor.id;
    let directory = ancestor.path;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      directory = path.join(directory, segment);
      const existing = db
        .select({ id: folders.id })
        .from(folders)
        .where(
          process.platform === "win32"
            ? sql`lower(${folders.path}) = lower(${directory})`
            : eq(folders.path, directory)
        )
        .get();
      if (existing) {
        parentId = existing.id;
      } else {
        const inserted = db
          .insert(folders)
          .values({ path: directory, displayName: segment, parentId })
          .returning({ id: folders.id })
          .get();
        if (!inserted) {
          throw new Error("Failed to register watched directory");
        }
        parentId = inserted.id;
      }
    }
    return parentId;
  });
  if (folderId !== ancestorId) {
    reloadFolderMatcher();
  }
  return folderId;
}

/**
 * 自用版：取出"没有任何已索引祖先"的文件夹，也就是整棵树的根。
 *
 * 上游给**每一个**文件夹都建了 chokidar 监听器（本机 4,414 个），但每个监听器都带
 * `depth: 10`，父目录的监听器本就覆盖整棵子树 → 同一个文件会被多个祖先监听器重复上报。
 * 只监听树根即可覆盖全部层级（已实测：根目录监听器能收到第 3 层子目录的新增事件）。
 *
 * ⚠️ 不能用 `parent_id IS NULL` 判断：该列**没有外键约束**，历史上可能留下悬空值，
 * 那样这些文件夹既不是"根"、又不会被任何祖先监听器覆盖。所以向上遍历确认才稳妥。
 */
export function getIndexedRootFolders(): { id: number; path: string }[] {
  const db = getDatabase();
  const all = db
    .select({ id: folders.id, path: folders.path, parentId: folders.parentId })
    .from(folders)
    .all();
  const existing = new Set(all.map((f) => f.id));

  // "根" = 没有**已索引**父文件夹的文件夹。
  // ⚠️ 不能只用 `parent_id IS NULL`：该列虽有外键，历史上仍可能留下悬空值，
  // 而悬空父节点的子文件夹既不是根、也不会被任何祖先监听器覆盖 → 会漏掉文件变更。
  // 所以判据是"父 id 是否真的存在于库中"。
  const roots = all.filter(
    (f) => f.parentId === null || !existing.has(f.parentId)
  );

  // 兜底：数据异常（例如 parent 互相成环）导致一个根都找不到时，
  // 退回监听全部文件夹 —— 宁可多建监听器，也不能漏掉文件变更。
  return (roots.length > 0 ? roots : all).map((f) => ({
    id: f.id,
    path: f.path,
  }));
}

export function startWatching(
  onChange: (photoId: number | null, event: "add" | "remove") => void
): void {
  const db = getDatabase();
  // 自用版：默认只监听树根（理由见 private-build.ts 的 watchRootsOnly）。
  const indexedFolders = PRIVATE_BUILD.watchRootsOnly
    ? getIndexedRootFolders()
    : db
        .select({ id: folders.id, path: folders.path })
        .from(folders)
        .all();

  for (const folder of indexedFolders) {
    const watcherKey = watcherPathKey(folder.path);
    if (watchers.has(watcherKey)) {
      continue;
    }
    const context = createWatcher(db, folder.path, folder.id);
    if (!context) {
      continue;
    }
    const watcher = context.watcher;

    watcher.on("add", (filePath) => {
      if (!isCurrentWatcher(context)) {
        return;
      }
      if (!shouldIndex(filePath)) {
        return;
      }
      // 自用：软件自己重命名文件夹时，这批事件由 renameFolder 负责迁移，监听这边忽略
      if (isWatcherPathSuppressed(filePath)) {
        watcherStats.skipped++;
        return;
      }
      watcherStats.addEvents++;

      watcherQueue.add(async () => {
        try {
          if (!isCurrentWatcher(context)) {
            return;
          }
          const matchedFolderId = resolveWatchedFileFolder(filePath);
          // 用户移除过的目录：这里的文件一律不索引，否则会以「无文件夹」的形态
          // 回到库里，而且下次扫描又把它所属的文件夹建回来。
          if (isPathRemoved(path.dirname(filePath))) {
            watcherStats.skipped++;
            return;
          }

          const alreadyIndexed = db
            .select({ id: photos.id })
            .from(photos)
            .where(eq(photos.path, filePath))
            .get();

          if (alreadyIndexed) {
            watcherStats.skipped++;
            return;
          }

          const photoId = await indexSingleFile(filePath, matchedFolderId);
          if (matchedFolderId && photoId) {
            db.update(folders)
              .set({
                photoCount: sql`(select count(*) from photos where folder_id = ${matchedFolderId} and deleted_at is null)`,
                lastWatcherEventAt: Date.now(),
              })
              .where(eq(folders.id, matchedFolderId))
              .run();
          }
          watcherStats.processed++;
          onChange(photoId, "add");
        } catch (err) {
          watcherStats.errors++;
          log.error({ filePath, err }, "Watcher: Error processing add event");
        }
      });
    });

    watcher.on("unlink", (filePath) => {
      if (!isCurrentWatcher(context)) {
        return;
      }
      /*
       * 自用（关键）：软件自己重命名文件夹期间，**绝不能**走下面的 db.delete(photos) ✗ ——
       * 那会把照片的标签 / 相册 / 收藏关联一起级联删掉。迁移由 renameFolder 负责 ✓。
       */
      if (isWatcherPathSuppressed(filePath)) {
        watcherStats.skipped++;
        return;
      }
      watcherStats.unlinkEvents++;

      watcherQueue.add(() => {
        try {
          if (!isCurrentWatcher(context)) {
            return;
          }
          const photo = db
            .select({ id: photos.id, folderId: photos.folderId })
            .from(photos)
            .where(
              and(eq(photos.path, filePath), sql`${photos.deletedAt} IS NULL`)
            )
            .get();
          if (photo) {
            db.delete(exifData).where(eq(exifData.photoId, photo.id)).run();
            db.delete(photos).where(eq(photos.id, photo.id)).run();
            deletePhotoThumbnails(filePath);
            deletePhotoVectors([photo.id]).catch((err) =>
              log.error(
                { err, photoId: photo.id },
                "Watcher: vector cleanup failed on unlink"
              )
            );

            if (photo.folderId) {
              db.update(folders)
                .set({
                  photoCount: sql`MAX(0, photo_count - 1)`,
                  lastWatcherEventAt: Date.now(),
                })
                .where(eq(folders.id, photo.folderId))
                .run();
            }

            watcherStats.processed++;
            onChange(photo.id, "remove");
          }
        } catch (err) {
          watcherStats.errors++;
          log.error(
            { filePath, err },
            "Watcher: Error processing unlink event"
          );
        }
      });
    });

    // 更新文件夹 watcher 状态
    if (!isCurrentWatcher(context)) {
      continue;
    }
    if (!updateWatcherState(context, true)) {
      removeCurrentWatcher(context);
      closeWatcherSafely(context).catch(() => undefined);
    }
  }

  log.info({ count: watchers.size }, "Watcher: Started watching folders");
}

export function watchFolder(
  folderPath: string,
  onChange: (photoId: number | null, event: "add" | "remove") => void
): void {
  const watcherKey = watcherPathKey(folderPath);
  if (watchers.has(watcherKey)) {
    return;
  }
  const db = getDatabase();
  const context = createWatcher(db, folderPath, findFolderId(db, folderPath));
  if (!context) {
    return;
  }
  const watcher = context.watcher;

  watcher.on("add", (filePath) => {
    if (!isCurrentWatcher(context)) {
      return;
    }
    if (!shouldIndex(filePath)) {
      return;
    }
    // 自用：软件自己重命名文件夹时忽略（见 suppressWatcherPaths）
    if (isWatcherPathSuppressed(filePath)) {
      watcherStats.skipped++;
      return;
    }
    watcherStats.addEvents++;

    watcherQueue.add(async () => {
      try {
        if (!isCurrentWatcher(context)) {
          return;
        }
        const matchedFolderId = resolveWatchedFileFolder(filePath);
        // 用户移除过的目录：不索引（同上面那处）
        if (isPathRemoved(path.dirname(filePath))) {
          watcherStats.skipped++;
          return;
        }

        const alreadyIndexed = db
          .select({ id: photos.id })
          .from(photos)
          .where(eq(photos.path, filePath))
          .get();

        if (alreadyIndexed) {
          watcherStats.skipped++;
          return;
        }

        const photoId = await indexSingleFile(filePath, matchedFolderId);
        if (matchedFolderId && photoId) {
          db.update(folders)
            .set({
              photoCount: sql`(select count(*) from photos where folder_id = ${matchedFolderId} and deleted_at is null)`,
              lastWatcherEventAt: Date.now(),
            })
            .where(eq(folders.id, matchedFolderId))
            .run();
        }
        watcherStats.processed++;
        onChange(photoId, "add");
      } catch (err) {
        watcherStats.errors++;
        log.error({ filePath, err }, "Watcher: Error processing add event");
      }
    });
  });

  watcher.on("unlink", (filePath) => {
    if (!isCurrentWatcher(context)) {
      return;
    }
    // 自用（关键）：软件自己重命名文件夹时，不能把照片硬删（会连标签/相册关联一起丢）
    if (isWatcherPathSuppressed(filePath)) {
      watcherStats.skipped++;
      return;
    }
    watcherStats.unlinkEvents++;

    watcherQueue.add(() => {
      try {
        if (!isCurrentWatcher(context)) {
          return;
        }
        const photo = db
          .select({ id: photos.id, folderId: photos.folderId })
          .from(photos)
          .where(
            and(eq(photos.path, filePath), sql`${photos.deletedAt} IS NULL`)
          )
          .get();
        if (photo) {
          db.delete(exifData).where(eq(exifData.photoId, photo.id)).run();
          db.delete(photos).where(eq(photos.id, photo.id)).run();
          deletePhotoThumbnails(filePath);
          deletePhotoVectors([photo.id]).catch((err) =>
            log.error(
              { err, photoId: photo.id },
              "Watcher: vector cleanup failed on unlink"
            )
          );

          if (photo.folderId) {
            db.update(folders)
              .set({
                photoCount: sql`MAX(0, photo_count - 1)`,
                lastWatcherEventAt: Date.now(),
              })
              .where(eq(folders.id, photo.folderId))
              .run();
          }

          watcherStats.processed++;
          onChange(photo.id, "remove");
        }
      } catch (err) {
        watcherStats.errors++;
        log.error({ filePath, err }, "Watcher: Error processing unlink event");
      }
    });
  });
}

/** Stop watchers rooted at this folder or one of its descendants. */
export async function unwatchFolder(folderPath: string): Promise<void> {
  const root = watcherPathKey(folderPath);
  const descendantPrefix = `${root}${path.sep}`;
  const closing: Promise<void>[] = [];
  for (const [key, context] of watchers) {
    if (key === root || key.startsWith(descendantPrefix)) {
      removeCurrentWatcher(context);
      closing.push(closeWatcherSafely(context));
    }
  }
  await Promise.all(closing);
}

export async function stopWatching(): Promise<void> {
  const db = getDatabase();

  // 等待队列清空
  await watcherQueue.onIdle();

  const contexts = Array.from(watchers.values());
  watchers.clear();
  await Promise.all(contexts.map((context) => closeWatcherSafely(context)));

  // 更新所有文件夹状态
  try {
    db.update(folders).set({ isWatching: false, watcherStartedAt: null }).run();
  } catch (error) {
    logWatcherFailure(
      { folderId: null, folderPath: "<all>" },
      error,
      "state",
      "Watcher: Failed to update stopped state"
    );
  }

  log.info({ stats: watcherStats }, "Watcher: Stopped");

  watcherStats = {
    addEvents: 0,
    unlinkEvents: 0,
    processed: 0,
    skipped: 0,
    errors: 0,
  };
}

export async function cleanupOrphanedRecords(): Promise<{
  checked: number;
  removed: number;
}> {
  const db = getDatabase();
  const allPhotos = db
    .select({ id: photos.id, path: photos.path, folderId: photos.folderId })
    .from(photos)
    .where(sql`${photos.deletedAt} IS NULL`)
    .all();

  let removed = 0;
  const removedPhotoIds: number[] = [];
  const folderUpdates = new Map<number, number>();

  for (const photo of allPhotos) {
    if (!fs.existsSync(photo.path)) {
      // Clean up orphaned thumbnail files before removing DB records
      deletePhotoThumbnails(photo.path);

      db.delete(exifData).where(eq(exifData.photoId, photo.id)).run();
      db.delete(photos).where(eq(photos.id, photo.id)).run();
      removedPhotoIds.push(photo.id);

      if (photo.folderId) {
        folderUpdates.set(
          photo.folderId,
          (folderUpdates.get(photo.folderId) || 0) + 1
        );
      }

      removed++;
    }
  }

  if (removedPhotoIds.length > 0) {
    await deletePhotoVectors(removedPhotoIds).catch((err) => {
      log.warn({ err }, "Failed to remove orphaned photo vectors");
    });
  }

  for (const [folderId, count] of folderUpdates) {
    db.update(folders)
      .set({ photoCount: sql`MAX(0, photo_count - ${count})` })
      .where(eq(folders.id, folderId))
      .run();
  }

  return { checked: allPhotos.length, removed };
}

/**
 * Async variant of cleanupOrphanedRecords — yields the event loop every
 * BATCH_SIZE photos so the UI stays responsive during startup cleanup.
 */
export async function cleanupOrphanedRecordsAsync(
  onProgress?: (checked: number, removed: number, total: number) => void
): Promise<{ checked: number; removed: number }> {
  const db = getDatabase();
  const allPhotos = db
    .select({ id: photos.id, path: photos.path, folderId: photos.folderId })
    .from(photos)
    .where(sql`${photos.deletedAt} IS NULL`)
    .all();

  let removed = 0;
  const removedPhotoIds: number[] = [];
  const folderUpdates = new Map<number, number>();
  const BATCH_SIZE = 200;

  for (let i = 0; i < allPhotos.length; i += BATCH_SIZE) {
    const batch = allPhotos.slice(i, i + BATCH_SIZE);
    for (const photo of batch) {
      if (!fs.existsSync(photo.path)) {
        // Clean up orphaned thumbnail files before removing DB records
        deletePhotoThumbnails(photo.path);

        db.delete(exifData).where(eq(exifData.photoId, photo.id)).run();
        db.delete(photos).where(eq(photos.id, photo.id)).run();
        removedPhotoIds.push(photo.id);

        if (photo.folderId) {
          folderUpdates.set(
            photo.folderId,
            (folderUpdates.get(photo.folderId) || 0) + 1
          );
        }
        removed++;
      }
    }
    // Yield the event loop every batch to keep UI responsive
    await new Promise<void>((resolve) => setImmediate(resolve));
    onProgress?.(
      Math.min(i + BATCH_SIZE, allPhotos.length),
      removed,
      allPhotos.length
    );
  }

  if (removedPhotoIds.length > 0) {
    await deletePhotoVectors(removedPhotoIds).catch((err) => {
      log.warn({ err }, "Failed to remove orphaned photo vectors");
    });
  }

  for (const [folderId, count] of folderUpdates) {
    db.update(folders)
      .set({ photoCount: sql`MAX(0, photo_count - ${count})` })
      .where(eq(folders.id, folderId))
      .run();
  }

  return { checked: allPhotos.length, removed };
}

export function stopScanning(): void {
  if (activeScanToken) {
    activeScanToken.cancelled = true;
  }
}
