import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  powerMonitor,
  protocol,
  screen,
  shell,
  Tray,
} from "electron";
import { ipcMain } from "electron/main";
import started from "electron-squirrel-startup";
import Store from "electron-store";
import { exiftool } from "exiftool-vendored";
import sharp from "sharp";
import { getDatabase } from "@/db";
import { appSettings, exifData, folders, photos, photoTags } from "@/db/schema";
import { ipcContext } from "@/ipc/context";
import {
  cleanupExpiredTrash,
  getOrphanPhotoIds,
} from "@/ipc/photos/handlers/mutations";
import {
  getMainLocaleText,
  initializeMainLocalization,
  onMainLocaleChanged,
  syncLegacyRendererLocale,
} from "@/localization/main-runtime";
import { getActiveFaceModel } from "@/services/ai/face-model-config";
import {
  getEmbeddingModelFile,
  getTranslationModelFile,
} from "@/services/ai/model-config";
import { copyModelsOnce } from "@/services/ai/model-loader";
import { releaseGpu, tryAcquireGpu } from "@/services/ai/gpu-queue";
import { deletePhotoVectors, initVectorDB } from "@/services/ai-embedder";
import {
  appendDiagnosticLog,
  installConsoleDiagnostics,
  recordDiagnosticIncident,
} from "@/services/diagnostics";
import {
  DiagnosticSanitizer,
  sanitizeRendererRoute,
} from "@/services/diagnostics/sanitizer";
import { cancelFaceDetection } from "@/services/face-detector";
import { shutdownFacePool } from "@/services/face-worker-pool";
import {
  getHttpServerAuthToken,
  getHttpServerPort,
  startHttpServerEarly,
} from "@/services/http-server";
import { MODEL_MANIFEST, verifyModelFile } from "@/services/model-downloader";
import {
  configurePluginManager,
  registerPluginProtocols,
} from "@/services/plugin-manager";
import { extractRawPreview, isRawFile } from "@/services/raw-preview";
import { registry, ServiceLevel } from "@/services/registry";
import {
  getSendToFilePaths,
  setupSendToShortcut,
} from "@/services/sendto-integration";
import { getSetting } from "@/services/settings-manager";
import { generateThumbnail, getThumbnailDir } from "@/services/thumbnailer";
import {
  getTrackedChildProcessCount,
  terminateTrackedChildProcesses,
  terminateTrackedChildProcessesSync,
} from "@/services/tracked-child-processes";
import {
  installUpdate,
  isUpdateInstallationActive,
  isUpdateQuitAllowed,
  startUpdateManager,
  stopAutomaticChecks,
} from "@/services/update-manager";
import {
  createWanderLifecycleBridge,
  type WanderLifecycleBridge,
} from "@/services/wander-lifecycle";
import {
  createBeforeQuitHandler,
  destroyTraySafely,
  observeWindowLoad,
  showOrCreateWindow,
} from "@/services/window-tray-lifecycle";
import {
  APP_PREFERENCE_DEFAULTS,
  APP_PREFERENCE_KEYS,
  parseBooleanPreference,
  parseCloseBehavior,
} from "@/types/app-preferences";
import { getDataPath, initDataPath } from "@/utils/data-path";
import { getFolderPaths } from "@/utils/folder-paths";
import { isBenignRendererErrorMessage } from "@/utils/renderer-error-filter";
import { cleanupBrokenLegacyStartMenuShortcut } from "@/utils/windows-shortcut-cleanup";
import { IPC_CHANNELS, inDevelopment } from "./constants";
import {
  APP_DISPLAY_NAME,
  PRIVATE_BUILD,
} from "@/config/private-build";
import { NEBULA_GLASS_MANIFEST } from "./plugins/builtins/nebula-glass-manifest";
import { OFFICIAL_LOCALE_TRUSTED_KEYS } from "./plugins/trusted-locale-keys";
import { createLogger } from "./utils/logger.js";
import { getBasePath } from "./utils/path";
import { resolveSafePath } from "./utils/path-security.js";

configurePluginManager([NEBULA_GLASS_MANIFEST], OFFICIAL_LOCALE_TRUSTED_KEYS);

const log = createLogger("main");
installConsoleDiagnostics();
const QUIT_CLEANUP_TIMEOUT_MS = 8000;

// ── Squirrel startup event handling ──────────────────────────────────
if (started) {
  app.quit();
}

// E2E runs must not share the real profile or its single-instance lock.
// Set this before requestSingleInstanceLock() and before any userData access.
const e2eUserDataDir = process.env.AI_IMAGE_MANAGER_E2E_USER_DATA_DIR;
const isE2E =
  app.commandLine.hasSwitch("e2e") ||
  process.argv.includes("--e2e") ||
  process.env.CI === "e2e" ||
  Boolean(e2eUserDataDir);
if (isE2E && e2eUserDataDir) {
  app.setPath("userData", path.resolve(e2eUserDataDir));
  app.disableHardwareAcceleration();
}

// Isolated verification env (e.g. face model upgrade A/B testing): an explicit
// user-data override that works outside E2E runs, so the real profile and its
// single-instance lock stay untouched. Set it, then add the same folder via
// Settings → Storage or app-config.json dataPath.
const devUserDataDir = process.env.AI_IMAGE_MANAGER_USER_DATA_DIR;
if (devUserDataDir) {
  app.setPath("userData", path.resolve(devUserDataDir));
}

// 改名（2026-10 加了 "LAN" 后缀）**不能**换数据目录。
// app.getPath("userData") 默认跟着 package.json 的 productName 走，改名的瞬间
// 它就会变成 ...\APPDATA\AI Anime Image Manager NEXT —— 而用户的图库位置
// （app-config.json）、标签与局域网口令哈希都在旧目录里，那样会看起来"全丢了"。
// 所以这里显式钉死旧目录；两个环境变量（E2E / 隔离验证）仍然优先。
if (!isE2E && !devUserDataDir) {
  const legacyUserDataDir = path.join(
    app.getPath("appData"),
    "AI Anime Image Manager"
  );
  app.setPath("userData", legacyUserDataDir);
  // Crashpad 的目录也一起钉住：它的默认值是 <userData>\Crashpad，而 Crashpad
  // 在原生层启动得比这里的 setPath 更早，会先在**新名字**下建一个空目录。
  app.setPath("crashDumps", path.join(legacyUserDataDir, "Crashpad"));
}

// ── Single instance lock ─────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let logDir: string | null = null;
const legacyLogSanitizer = new DiagnosticSanitizer();

// ── Log directory (scoped to app userData, not AppData root) ─────────
logDir = path.join(app.getPath("userData"), "logs");
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(
  path.join(logDir, "startup.log"),
  `STARTUP ${new Date().toISOString()} argv=${legacyLogSanitizer.sanitize(JSON.stringify(process.argv))}\n`,
  { flag: "a" }
);

app.on("child-process-gone", (_event, details) => {
  if (details.reason === "clean-exit") {
    return;
  }
  const message = `${details.type} process exited: ${details.reason} (${details.exitCode})`;
  const incident = recordDiagnosticIncident({
    source: "worker-crash",
    message,
  });
  appendDiagnosticLog({
    incidentId: incident.id,
    level: "error",
    message,
    module: details.name || details.type,
    process: "worker",
  });
});

function appendStartupLog(filename: string, message: string) {
  if (!logDir) {
    return;
  }
  try {
    fs.writeFileSync(
      path.join(logDir, filename),
      `${legacyLogSanitizer.sanitize(message)}\n`,
      { flag: "a" }
    );
  } catch {
    /* best-effort */
  }
}

function logMain(message: string) {
  appendStartupLog("main.log", `${new Date().toISOString()} ${message}`);
}

function summarizePathState(label: string, targetPath: string): string {
  try {
    const exists = fs.existsSync(targetPath);
    if (!exists) {
      return `${label}: MISSING ${targetPath}`;
    }
    const stats = fs.statSync(targetPath);
    const kind = stats.isDirectory() ? "dir" : "file";
    return `${label}: OK ${kind} ${targetPath}`;
  } catch (error) {
    return `${label}: ERROR ${targetPath} :: ${(error as Error).message}`;
  }
}

function logPackagedPathDiagnostics() {
  const appPath = app.getAppPath();
  const diagnostics = [
    `[Diag] isPackaged=${String(app.isPackaged)}`,
    `[Diag] process.execPath=${process.execPath}`,
    `[Diag] app.getPath(userData)=${app.getPath("userData")}`,
    `[Diag] app.getAppPath()=${appPath}`,
    `[Diag] process.resourcesPath=${process.resourcesPath}`,
    summarizePathState(
      "app-exe",
      path.join(path.dirname(appPath), "ai-image-manager.exe")
    ),
    summarizePathState("resources-dir", process.resourcesPath),
    summarizePathState(
      "app.asar",
      path.join(process.resourcesPath, "app.asar")
    ),
    summarizePathState(
      "asar-unpacked-transformers",
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "@xenova",
        "transformers",
        "package.json"
      )
    ),
    summarizePathState(
      "asar-unpacked-embed-worker",
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "scripts",
        "embed-worker.mjs"
      )
    ),
    summarizePathState(
      "asar-unpacked-face-worker",
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "scripts",
        "face-worker.mjs"
      )
    ),
    summarizePathState(
      "asar-unpacked-wd14-tagger-worker",
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "scripts",
        "wd14-tagger-worker.mjs"
      )
    ),
    // NEXT：PixAI 打标 worker 与它的预处理模块（同目录，worker 静态 import 它）
    summarizePathState(
      "asar-unpacked-pixai-tagger-worker",
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "scripts",
        "pixai-tagger-worker.mjs"
      )
    ),
    summarizePathState(
      "asar-unpacked-pixai-preprocess",
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "scripts",
        "pixai-preprocess.mjs"
      )
    ),
    summarizePathState(
      "resource-model",
      getEmbeddingModelFile(
        path.join(process.resourcesPath, "models-release"),
        "vision_model_quantized.onnx"
      )
    ),
    summarizePathState(
      "cached-model",
      getEmbeddingModelFile(
        path.join(getDataPath(), "models"),
        "vision_model_quantized.onnx"
      )
    ),
  ];

  for (const line of diagnostics) {
    log.info(line);
    appendStartupLog("startup.log", line);
    appendStartupLog("whenReady.log", line);
  }
}

// ── Window & tray references ─────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let wanderLifecycleBridge: WanderLifecycleBridge | null = null;
// True once before-quit fires — distinguishes "user clicked close" (hide to
// tray) from "app actually quitting" (e.g. relaunch, tray menu Exit, OS
// shutdown). Without this flag, every close is intercepted and app.quit()
// becomes a no-op, breaking app.relaunch() and similar flows.
let isQuitting = false;

// Periodic trash cleanup timer (runs every 6 hours to enforce 30-day retention)
let trashCleanupTimer: ReturnType<typeof setInterval> | null = null;
const TRASH_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── Window state store (lazy init) ───────────────────────────────────
let windowStore: Store<{
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isMaximized?: boolean;
  trayMinimizeHinted: boolean;
}>;

function getWindowStore() {
  if (!windowStore) {
    windowStore = new Store<{
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      isMaximized?: boolean;
      trayMinimizeHinted: boolean;
    }>({
      name: "window-state",
      defaults: { width: 1280, height: 800, trayMinimizeHinted: false },
    });
  }
  return windowStore;
}

function getWindowPreferences() {
  try {
    return {
      closeBehavior: parseCloseBehavior(
        getSetting(APP_PREFERENCE_KEYS.closeBehavior)
      ),
      rememberBounds: parseBooleanPreference(
        getSetting(APP_PREFERENCE_KEYS.rememberBounds),
        APP_PREFERENCE_DEFAULTS.rememberBounds
      ),
    };
  } catch {
    return {
      closeBehavior: APP_PREFERENCE_DEFAULTS.closeBehavior,
      rememberBounds: APP_PREFERENCE_DEFAULTS.rememberBounds,
    };
  }
}

function isBoundsVisible(bounds: {
  height: number;
  width: number;
  x: number;
  y: number;
}): boolean {
  try {
    return screen.getAllDisplays().some((display) => {
      const right = Math.min(
        bounds.x + bounds.width,
        display.workArea.x + display.workArea.width
      );
      const bottom = Math.min(
        bounds.y + bounds.height,
        display.workArea.y + display.workArea.height
      );
      const left = Math.max(bounds.x, display.workArea.x);
      const top = Math.max(bounds.y, display.workArea.y);
      return right - left >= 32 && bottom - top >= 32;
    });
  } catch {
    return false;
  }
}

function showMainWindow() {
  try {
    showOrCreateWindow({
      createWindow: () => {
        mainWindow = null;
        createWindow(getHttpServerPort() ?? 0, getHttpServerAuthToken());
      },
      isQuitting,
      window: mainWindow,
    });
  } catch (error) {
    log.error({ err: error }, "Failed to show or recreate main window");
  }
}

// ── Main-process localization ──────────────────────────────────────
type TrayLabelKey =
  | "closeWindowQuestion"
  | "closeWindowTitle"
  | "launchAtStartup"
  | "minimizeToTray"
  | "quit"
  | "showWindow"
  | "tooltip";

function tTray(key: TrayLabelKey): string {
  return getMainLocaleText(key);
}

// ── Tray icon ────────────────────────────────────────────────────────
function getIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "icon.png");
  }
  return path.join(app.getAppPath(), "assets", "icon.png");
}

function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    {
      label: tTray("showWindow"),
      click: () => {
        showMainWindow();
      },
    },
    { type: "separator" },
    {
      label: tTray("launchAtStartup"),
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    { type: "separator" },
    {
      label: tTray("quit"),
      click: () => {
        app.quit();
      },
    },
  ]);
}

function rebuildTrayMenu() {
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
    tray.setToolTip(tTray("tooltip"));
  }
}

// The runtime owns the active main catalog; this listener keeps an already
// created tray synchronized after an atomic language commit or preview.
onMainLocaleChanged(rebuildTrayMenu);

function createTray() {
  const iconPath = getIconPath();
  if (fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    tray = new Tray(img.resize({ width: 16, height: 16 }));
  } else {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip(tTray("tooltip"));

  tray.setContextMenu(buildTrayMenu());

  tray.on("double-click", () => {
    showMainWindow();
  });
}

function destroyTray() {
  const currentTray = tray;
  tray = null;
  if (!currentTray) {
    return;
  }

  const destroyed = destroyTraySafely(currentTray, (error) => {
    log.warn({ err: error }, "Failed to destroy tray during quit");
  });
  if (destroyed) {
    log.info("Tray destroyed during quit");
  }
}

// ── Global shortcuts ─────────────────────────────────────────────────
function registerGlobalShortcuts() {
  // 自用：窗口级快捷键（呼出窗口并聚焦搜索 / 隐藏窗口）已按开关停用。
  // 窗口的常规关闭、最小化、托盘行为都在别处，不受影响。
  if (PRIVATE_BUILD.slimWindowShortcuts) {
    log.info("Global shortcuts disabled by PRIVATE_BUILD.slimWindowShortcuts");
    return;
  }
  const searchRegistered = globalShortcut.register("Ctrl+Shift+F", () => {
    if (!mainWindow || isQuitting) {
      return;
    }
    showMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("global-shortcut:search");
    }
  });
  if (!searchRegistered) {
    log.warn("Failed to register global shortcut Ctrl+Shift+F");
  }

  const hideRegistered = globalShortcut.register("Ctrl+Shift+H", () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    }
  });
  if (!hideRegistered) {
    log.warn("Failed to register global shortcut Ctrl+Shift+H");
  }

  log.info(
    "Global shortcuts registered: Ctrl+Shift+F (search), Ctrl+Shift+H (hide)"
  );
}

// ── MIME type mapping ────────────────────────────────────────────────
function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".avif": "image/avif",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".heic": "image/heic",
    ".heif": "image/heif",
    // RAW camera formats
    ".cr2": "image/x-canon-cr2",
    ".cr3": "image/x-canon-cr3",
    ".nef": "image/x-nikon-nef",
    ".nrw": "image/x-nikon-nrw",
    ".arw": "image/x-sony-arw",
    ".srf": "image/x-sony-srf",
    ".sr2": "image/x-sony-sr2",
    ".dng": "image/x-adobe-dng",
    ".orf": "image/x-olympus-orf",
    ".rw2": "image/x-panasonic-rw2",
    ".raf": "image/x-fujifilm-raf",
    ".pef": "image/x-pentax-pef",
    ".rwl": "image/x-leica-rwl",
    ".3fr": "image/x-hasselblad-3fr",
    ".raw": "image/x-raw",
  };
  return mimeTypes[ext] ?? "image/jpeg";
}

// ── I/O 信号量：限制 local-media:// 协议的并发文件操作 ──────────
// 防止快速滚动时数十个并发 readFile + sharp 打爆磁盘 I/O。
// 信号量在模块顶层创建，生命周期 = 应用生命周期。
class IoSemaphore {
  private running = 0;
  private readonly pending: Array<() => void> = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
  }

  release(): void {
    this.running--;
    const next = this.pending.shift();
    if (next) {
      this.running++;
      next();
    }
  }
}

const mediaSemaphore = new IoSemaphore(16);

// ── 文件夹列表缓存 ── 由 @/utils/folder-paths 集中管理，供 local-media 协议、
// HTTP 服务器的路径安全校验和索引模块共用。
// 缓存 TTL 10 秒；索引变更（新建/删除文件夹）通过 invalidateFoldersCache() 主动失效。
//
// ── AI model availability (copy from resources or dev paths) ─────────

async function verifyCurrentFaceModels(modelsDir: string): Promise<{
  invalidFiles: string[];
  valid: boolean;
}> {
  const activeFaceModel = getActiveFaceModel();
  const invalidFiles: string[] = [];

  for (const fileName of activeFaceModel.modelFiles) {
    const entry = MODEL_MANIFEST.find(
      (candidate) =>
        candidate.subPath === "face" && candidate.fileName === fileName
    );
    const filePath = path.join(modelsDir, "face", fileName);
    if (
      !(
        entry &&
        (await verifyModelFile(filePath, entry.sha256, entry.sizeBytes))
      )
    ) {
      invalidFiles.push(fileName);
    }
  }

  return { invalidFiles, valid: invalidFiles.length === 0 };
}

async function hasCurrentModels(modelsDir: string): Promise<boolean> {
  const markers = [
    getEmbeddingModelFile(modelsDir, "vision_model_quantized.onnx"),
    getTranslationModelFile(modelsDir, "encoder_model_quantized.onnx"),
    getTranslationModelFile(modelsDir, "decoder_model_merged_quantized.onnx"),
  ];
  const faceValidation = await verifyCurrentFaceModels(modelsDir);
  return (
    markers.every((marker) => fs.existsSync(marker)) && faceValidation.valid
  );
}

async function copyBundledModels(modelsDir: string): Promise<void> {
  const bundledModels = path.join(process.resourcesPath, "models-release");
  const bundledMarker = getEmbeddingModelFile(
    bundledModels,
    "vision_model_quantized.onnx"
  );
  const bundledFaceValidation = await verifyCurrentFaceModels(bundledModels);

  log.info(
    "[ensureModelAvailable] bundledModels=%s exists=%s bundledMarker=%s exists=%s faceValid=%s",
    bundledModels,
    fs.existsSync(bundledModels),
    bundledMarker,
    fs.existsSync(bundledMarker),
    bundledFaceValidation.valid
  );
  if (!(fs.existsSync(bundledMarker) && bundledFaceValidation.valid)) {
    throw new Error(
      `Bundled AI models are incomplete or failed hash verification; invalid face files: ${bundledFaceValidation.invalidFiles.join(", ") || "none"}`
    );
  }

  log.info("Copying AI models from bundled resources...");
  try {
    await copyModelsOnce();
    await fs.promises.cp(
      path.join(bundledModels, "face"),
      path.join(modelsDir, "face"),
      { recursive: true }
    );
    const copied = await hasCurrentModels(modelsDir);
    const visionMarker = getEmbeddingModelFile(
      modelsDir,
      "vision_model_quantized.onnx"
    );
    const size = fs.existsSync(visionMarker)
      ? fs.statSync(visionMarker).size
      : 0;
    log.info(
      "[ensureModelAvailable] copy done — marker exists=%s size=%d",
      copied,
      size
    );
    if (!copied || size <= 0) {
      throw new Error(
        "Copied AI models failed startup verification, including the active face model"
      );
    }
    log.info("AI models copied and current face model hashes verified");
  } catch (err) {
    log.error({ err }, "Failed to copy AI models from resources");
    throw err;
  }
}

async function copyDevModels(modelsDir: string): Promise<void> {
  const devCandidates = [
    path.join(process.cwd(), "models"),
    path.join(app.getAppPath(), "models"),
    path.join(app.getAppPath(), "..", "models"),
    path.join(app.getAppPath(), "..", "..", "models"),
  ];
  for (const candidate of devCandidates) {
    const marker = getEmbeddingModelFile(
      candidate,
      "vision_model_quantized.onnx"
    );
    log.debug({ marker }, "Checking for AI model");
    if (!fs.existsSync(marker)) {
      continue;
    }
    log.info({ source: candidate }, "Copying AI models from dev path");
    try {
      await fs.promises.cp(candidate, modelsDir, { recursive: true });
      const copiedFaceValidation = await verifyCurrentFaceModels(modelsDir);
      if (copiedFaceValidation.valid) {
        log.info("AI models copied and current face model hashes verified");
        return;
      }
      log.warn(
        {
          invalidFiles: copiedFaceValidation.invalidFiles,
          source: candidate,
        },
        "Dev model copy rejected because the active face model failed hash verification"
      );
    } catch (err) {
      log.warn({ err, source: candidate }, "Failed to copy from dev path");
    }
  }
  log.warn("AI models not found in any dev path");
}

async function ensureModelAvailable(): Promise<void> {
  const modelsDir = path.join(getDataPath(), "models");
  if (await hasCurrentModels(modelsDir)) {
    log.info(
      "AI models already cached and face hashes verified at %s",
      modelsDir
    );
    return;
  }
  if (app.isPackaged) {
    await copyBundledModels(modelsDir);
    return;
  }
  await copyDevModels(modelsDir);
}

// ── UI zoom scale ────────────────────────────────────────────────────
// Persisted via the app_settings table (key "ui.zoomScale"), applied on
// every window load so the preference survives restarts. Defaults to 1
// (follow system DPI); the settings → appearance page offers 80%–130%.
function applyUiZoomScale() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  try {
    const db = getDatabase();
    const row = db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, "ui.zoomScale"))
      .get();
    const parsed = Number.parseFloat(row?.value ?? "");
    const scale = Number.isFinite(parsed)
      ? Math.min(2, Math.max(0.5, parsed))
      : 1;
    mainWindow.webContents.setZoomFactor(scale);
  } catch {
    // DB not ready yet — leave the default zoom; the settings page will
    // apply the stored value the next time it changes.
  }
}

// ── Create main window ───────────────────────────────────────────────
function createWindow(httpPort: number, httpAuthToken: string) {
  const modulePath = getBasePath();
  const basePath =
    path.basename(modulePath) === "chunks"
      ? path.dirname(modulePath)
      : modulePath;
  const preload = path.join(basePath, "preload.js");
  const rendererEntry = path.join(
    basePath,
    `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`
  );
  const trustedRendererUrl =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "undefined"
      ? pathToFileURL(rendererEntry).toString()
      : MAIN_WINDOW_VITE_DEV_SERVER_URL;

  const store = getWindowStore();
  const windowPreferences = getWindowPreferences();
  const savedWidth = windowPreferences.rememberBounds
    ? store.get("width", 1280)
    : 1280;
  const savedHeight = windowPreferences.rememberBounds
    ? store.get("height", 800)
    : 800;
  const savedX = windowPreferences.rememberBounds ? store.get("x") : undefined;
  const savedY = windowPreferences.rememberBounds ? store.get("y") : undefined;
  const savedBounds =
    savedX !== undefined && savedY !== undefined
      ? { height: savedHeight, width: savedWidth, x: savedX, y: savedY }
      : null;

  mainWindow = new BrowserWindow({
    width: savedWidth,
    height: savedHeight,
    minWidth: 720,
    minHeight: 480,
    show: false,
    ...(savedBounds && isBoundsVisible(savedBounds)
      ? { x: savedX, y: savedY }
      : {}),
    title: APP_DISPLAY_NAME,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, "icon.png")
      : path.join(app.getAppPath(), "assets", "icon.png"),
    webPreferences: {
      additionalArguments: [
        `--http-port=${httpPort}`,
        `--http-token=${httpAuthToken}`,
        ...(isE2E ? ["--e2e"] : []),
      ],
      devTools: inDevelopment,
      contextIsolation: true,
      nodeIntegration: false,
      preload,
    },
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition:
      process.platform === "darwin" ? { x: 12, y: 9 } : undefined,
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        shell.openExternal(url).catch(() => undefined);
      }
    } catch {
      // Invalid and non-web URLs are intentionally denied.
    }
    return { action: "deny" };
  });
  const preventUntrustedNavigation = (event: Electron.Event, url: string) => {
    if (!ipcContext.isTrustedRendererUrl(url)) {
      event.preventDefault();
    }
  };
  mainWindow.webContents.on("will-navigate", preventUntrustedNavigation);
  mainWindow.webContents.on("will-redirect", preventUntrustedNavigation);

  wanderLifecycleBridge?.dispose();
  const lifecycleWindow = mainWindow;
  const lifecycleBridge = createWanderLifecycleBridge({
    powerMonitor,
    send: (state) => {
      if (!lifecycleWindow.isDestroyed()) {
        lifecycleWindow.webContents.send(IPC_CHANNELS.WANDER_LIFECYCLE, state);
      }
    },
    window: lifecycleWindow,
  });
  wanderLifecycleBridge = lifecycleBridge;

  if (windowPreferences.rememberBounds && store.get("isMaximized", false)) {
    mainWindow.maximize();
  }

  let closePromptOpen = false;
  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    const { closeBehavior } = getWindowPreferences();
    if (closeBehavior === "quit" || !tray) {
      event.preventDefault();
      app.quit();
      return;
    }

    event.preventDefault();
    if (closeBehavior === "tray") {
      hideMainWindowToTray();
      return;
    }

    if (closePromptOpen) {
      return;
    }
    closePromptOpen = true;
    const window = mainWindow;
    if (!window || window.isDestroyed()) {
      closePromptOpen = false;
      return;
    }
    dialog
      .showMessageBox(window, {
        buttons: [tTray("minimizeToTray"), tTray("quit")],
        cancelId: 0,
        defaultId: 0,
        message: tTray("closeWindowQuestion"),
        title: tTray("closeWindowTitle"),
        type: "question",
      })
      .then(({ response }) => {
        if (response === 1) {
          app.quit();
        } else {
          hideMainWindowToTray();
        }
      })
      .finally(() => {
        closePromptOpen = false;
      });
  });

  function hideMainWindowToTray() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (!store.get("trayMinimizeHinted", false)) {
      store.set("trayMinimizeHinted", true);
      if (Notification.isSupported()) {
        new Notification({
          title: APP_DISPLAY_NAME,
          body: "应用已最小化至系统托盘，双击托盘图标可重新打开",
          silent: false,
        }).show();
      }
    }
    mainWindow.hide();
  }

  const saveBounds = () => {
    if (!getWindowPreferences().rememberBounds) {
      return;
    }
    if (mainWindow?.isMaximized()) {
      store.set("isMaximized", true);
    } else {
      store.set("isMaximized", false);
      const bounds = mainWindow?.getBounds();
      if (bounds) {
        store.set({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        });
      }
    }
  };

  mainWindow.on("resize", saveBounds);
  mainWindow.on("move", saveBounds);
  mainWindow.on("maximize", () => {
    if (getWindowPreferences().rememberBounds) {
      store.set("isMaximized", true);
    }
    mainWindow?.webContents.send("window:maximize-change", true);
  });
  mainWindow.on("unmaximize", () => {
    if (getWindowPreferences().rememberBounds) {
      store.set("isMaximized", false);
    }
    mainWindow?.webContents.send("window:maximize-change", false);
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    lifecycleBridge.publish("initial");
    applyUiZoomScale();
  });
  mainWindow.webContents.on("console-message", (details) => {
    if (details.level !== "warning" && details.level !== "error") {
      return;
    }
    const isBenignRendererError = isBenignRendererErrorMessage(details.message);
    const level =
      details.level === "error" && !isBenignRendererError ? "error" : "warn";
    appendDiagnosticLog({
      action: level === "error" ? "console-error" : "console-warning",
      level,
      message: details.message,
      module: "renderer-console",
      process: "renderer",
      route: sanitizeRendererRoute(
        mainWindow?.webContents.getURL().split("#").at(-1) || "/"
      ),
      source: `${details.sourceId}:${details.lineNumber}`,
    });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    const message = `Renderer process exited: ${details.reason} (${details.exitCode})`;
    const incident = recordDiagnosticIncident({
      source: "renderer-crash",
      message,
    });
    appendDiagnosticLog({
      incidentId: incident.id,
      level: "error",
      message,
      module: "renderer-lifecycle",
      process: "main",
    });
    dialog
      .showMessageBox({
        type: "error",
        title: APP_DISPLAY_NAME,
        message: "界面进程意外退出 / The interface process crashed",
        detail: `事件编号 / Incident: ${incident.id}\n可在“设置 → 帮助与诊断”生成反馈包。`,
        buttons: ["重新加载 / Reload", "关闭 / Close"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0 && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload();
        }
      })
      .catch((error) => {
        appendDiagnosticLog({
          incidentId: incident.id,
          level: "error",
          message: error instanceof Error ? error.message : String(error),
          module: "renderer-crash-dialog",
          process: "main",
        });
      });
  });

  ipcContext.setMainWindow(mainWindow, trustedRendererUrl);

  // typeof guard: prevents ReferenceError in production strict mode
  const loadingWindow = mainWindow;
  const windowLoad =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "undefined"
      ? loadingWindow.loadFile(rendererEntry)
      : loadingWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  observeWindowLoad({
    load: windowLoad,
    isActive: () =>
      !(isQuitting || loadingWindow.isDestroyed()) &&
      mainWindow === loadingWindow,
    onInactive: (error) => {
      log.debug({ err: error }, "Renderer load ended after window teardown");
    },
    onFailure: (error) => {
      const incident = recordDiagnosticIncident({
        message: error instanceof Error ? error.message : String(error),
        source: "startup-failure",
        stack: error instanceof Error ? error.stack : undefined,
      });
      appendDiagnosticLog({
        incidentId: incident.id,
        level: "error",
        message: incident.message,
        module: "renderer-load",
        process: "main",
        stack: incident.stack,
      });
    },
  });

  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const bounds = display.workArea;
  if (
    mainWindow.getBounds().width < 720 ||
    mainWindow.getBounds().height < 480
  ) {
    mainWindow.setSize(
      Math.max(1280, bounds.width - 80),
      Math.max(800, bounds.height - 120)
    );
  }
}

// ── Auto-update state (persisted in main process so settings page can query on mount) ─

// ── Auto-update check ────────────────────────────────────────────────
function checkForUpdates() {
  startUpdateManager();
  /*
  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: "Uyoung666/ai-image-manager",
    },
    notifyUser: true,
    onNotifyUser: (info) => {
      log.info(
        { version: info.releaseName, url: info.updateURL },
        "Update downloaded — notifying renderer"
      );
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("update:available", {
          version: info.releaseName,
          releaseDate: info.releaseDate,
          releaseNotes: info.releaseNotes,
        });
      }
      broadcastUpdateStatus({
        phase: "downloaded",
        version: info.releaseName,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate,
        updateURL: info.updateURL,
      });
    },
    logger: {
      log: (msg) => log.info(`[updater] ${msg}`),
      info: (msg) => log.info(`[updater] ${msg}`),
      warn: (msg) => log.warn(`[updater] ${msg}`),
      error: (msg) => log.error(`[updater] ${msg}`),
    },
  });

  autoUpdater.on("checking-for-update", () => {
    broadcastUpdateStatus({ phase: "checking" });
  });

  autoUpdater.on("update-available", () => {
    broadcastUpdateStatus({ phase: "downloading" });
  });

  autoUpdater.on("update-not-available", () => {
    broadcastUpdateStatus({ phase: "up-to-date" });
  });

  autoUpdater.on("error", (err) => {
    const raw = err?.message || String(err);
    let code = raw;
    if (NETWORK_ERROR_RE.test(raw)) {
      code = "NETWORK_ERROR";
    } else if (HTTP_ERROR_RE.test(raw)) {
      code = "UPDATE_NOT_FOUND";
    } else if (/acquire.*lock|another.*instance|mutex/i.test(raw)) {
      // Squirrel.Windows lock contention — another instance is running or
      // stale lock file; not actionable by user, don't show in UI
      log.warn(
        { raw },
        "[updater] Squirrel lock contention, suppressing error"
      );
      return; // Don't broadcast — this is a transient Squirrel-internal error
    }
    // Truncate raw Squirrel/.NET stack traces — they contain GBK-garbled text
    // that renders as mojibake in the UI
    const sanitized = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
    broadcastUpdateStatus({ phase: "error", message: sanitized });
  });

  // download-progress: try to forward (Electron 41 types removed it, but Squirrel may still emit)
  try {
    (autoUpdater as any).on("download-progress", (progress: any) => {
      broadcastUpdateStatus({
        phase: "downloading",
        percent: Math.round(progress.percent || 0),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      });
    });
  } catch {
    // download-progress not available
  }

  log.info("Update checker started");
  */
}

ipcMain.on("app:restart", (event) => {
  if (!ipcContext.isTrustedSender(event)) {
    return;
  }
  if (isUpdateInstallationActive() && !isUpdateQuitAllowed()) {
    log.info("app:restart blocked while update installation is active");
    return;
  }
  app.relaunch({
    args: process.argv.slice(1).concat(["--relaunch"]),
    execPath: process.execPath,
  });
  app.quit();
});

ipcMain.on("app:install-update", (event) => {
  if (!ipcContext.isTrustedSender(event)) {
    return;
  }
  fs.writeFileSync(
    path.join(logDir, "startup.log"),
    `${new Date().toISOString()} install-update: quitAndInstall\n`,
    { flag: "a" }
  );
  installUpdate();
});

// Sync language from renderer to main process (updates tray menu labels)
ipcMain.on("app:language-changed", (event, lang: string) => {
  if (!ipcContext.isTrustedSender(event)) {
    return;
  }
  syncLegacyRendererLocale(lang);
});

ipcMain.on("shell:open-external", (event, url: string) => {
  if (!ipcContext.isTrustedSender(event)) {
    return;
  }
  if (url && typeof url === "string") {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return;
      }
    } catch {
      return;
    }
    try {
      Promise.resolve(shell.openExternal(url)).catch((err) => {
        log.error({ err }, "Failed to open external URL");
      });
    } catch (err) {
      log.error({ err }, "Failed to open external URL");
    }
  }
});

ipcMain.on(IPC_CHANNELS.IS_DIRECTORY_PATH, (event, filePath: unknown) => {
  if (!ipcContext.isTrustedSender(event)) {
    event.returnValue = false;
    return;
  }
  if (typeof filePath !== "string" || !filePath) {
    event.returnValue = false;
    return;
  }
  try {
    event.returnValue = fs.statSync(filePath).isDirectory();
  } catch {
    event.returnValue = false;
  }
});

ipcMain.handle("app:get-http-port", (event) => {
  if (!ipcContext.isTrustedSender(event)) {
    return null;
  }
  return getHttpServerPort();
});

ipcMain.handle("clipboard:copy-image", async (event, filePath: string) => {
  if (!ipcContext.isTrustedSender(event)) {
    return false;
  }
  if (!filePath || typeof filePath !== "string") {
    return false;
  }
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    log.warn({ filePath }, "clipboard:copy-image — file not accessible");
    return false;
  }
  try {
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) {
      log.warn({ filePath }, "clipboard:copy-image — nativeImage is empty");
      return false;
    }
    clipboard.writeImage(img);
    return true;
  } catch (err) {
    log.error({ filePath, err }, "clipboard:copy-image — failed");
    return false;
  }
});

// ── IPC / oRPC setup ─────────────────────────────────────────────────
async function setupORPC() {
  const { upgradeRpcPort } = await import("./ipc/handler");
  ipcMain.on(IPC_CHANNELS.START_ORPC_SERVER, (event) => {
    if (!ipcContext.isTrustedSender(event) || event.ports.length !== 1) {
      return;
    }
    const [serverPort] = event.ports;
    if (!serverPort) {
      return;
    }
    upgradeRpcPort(serverPort);
  });

  ipcMain.on(IPC_CHANNELS.NATIVE_FILE_DRAG, (event, filePath: string) => {
    if (!ipcContext.isTrustedSender(event)) {
      return;
    }
    if (!(filePath && fs.existsSync(filePath))) {
      return;
    }
    const icon = nativeImage.createFromPath(filePath).resize({
      width: 64,
      height: 64,
    });
    event.sender.startDrag({ file: filePath, icon });
  });
}

// ── Startup cleanup: orphan records + photoCount drift ───────────────
async function runStartupCleanup() {
  try {
    const db = getDatabase();
    const orphanIds = getOrphanPhotoIds(db);

    if (orphanIds.length > 0) {
      db.delete(exifData).where(inArray(exifData.photoId, orphanIds)).run();
      db.delete(photoTags).where(inArray(photoTags.photoId, orphanIds)).run();
      db.delete(photos).where(inArray(photos.id, orphanIds)).run();
      log.info(
        { count: orphanIds.length },
        "Startup cleanup: removed orphan photo records"
      );

      initVectorDB()
        .then(() => deletePhotoVectors(orphanIds))
        .catch(() => {
          /* best-effort */
        });
    }
  } catch (err) {
    log.warn({ err }, "Orphan cleanup skipped");
  }

  // ── Expired trash cleanup: permanently delete photos in trash > 30 days ──
  try {
    const expiredCount = await cleanupExpiredTrash();
    if (expiredCount > 0) {
      log.info(
        { count: expiredCount },
        "Startup cleanup: removed expired trash photos"
      );
    }
  } catch (err) {
    log.warn({ err }, "Expired trash cleanup skipped");
  }

  try {
    const db = getDatabase();
    const allFolders = db.select({ id: folders.id }).from(folders).all();
    for (const f of allFolders) {
      const count =
        db
          .select({ c: sql<number>`count(*)` })
          .from(photos)
          .where(
            and(sql`${photos.folderId} = ${f.id}`, isNull(photos.deletedAt))
          )
          .get()?.c ?? 0;
      db.update(folders)
        .set({ photoCount: count })
        .where(sql`${folders.id} = ${f.id}`)
        .run();
    }
  } catch (err) {
    log.warn({ err }, "photoCount recalculation skipped");
  }
}

// ── Bootstrap background services (non-blocking after window is shown) ──
/**
 * 无头打标：`--run-pixai-tagging`（NEXT 新增，见 `PixAI集成实施计划.md`）。
 *
 * 为什么要有它：
 *  1. **全库重跑不必开着界面**。实测 PixAI 单张 CPU ≈ 6.5 秒、DirectML ≈ 0.6 秒，
 *     8 万张就是 145 小时 / 13 小时 —— 挂一夜更实际。进度照常写进
 *     `<userData>/logs/app.log`（最多每 10 秒一行）。
 *  2. **自动化验证**：配合 `AI_IMAGE_MANAGER_USER_DATA_DIR=<临时目录>` 就能在
 *     **完全隔离的图库**里跑真打标，不去动用户的库（没有自定义 dataPath 时，
 *     图库默认就是 userData 目录，见 `utils/data-path.ts`）。
 *
 * 退出码：`0` 全部成功 / `1` 有失败（日志里有 photoId 与原因）/ `2` 抛错或开关不对。
 */
async function runHeadlessPixaiTagging(): Promise<number> {
  const { getActiveTagger } = await import("@/config/private-build");
  if (getActiveTagger() !== "pixai") {
    log.error(
      "[Headless] private-build 的 usePixaiTagger 不是 true —— 无头入口只支持 PixAI"
    );
    return 2;
  }

  const { ensureLocalModel } = await import("@/services/ai/model-loader");
  const { runPixaiTagging } = await import("@/services/ai/pixai-tagger");
  const modelsDir = await ensureLocalModel();

  // 无头入口也走互斥：否则命令行打标会和界面里的建向量同时抢显卡
  const blocked = tryAcquireGpu("tagging");
  if (blocked) {
    log.error(`[Headless] 打标未启动：${blocked}`);
    return 2;
  }

  // `--tag-limit=N` 只打前 N 张（快速验证用）
  const limitArg = process.argv.find((arg) => arg.startsWith("--tag-limit="));
  const maxPhotos = limitArg
    ? Number.parseInt(limitArg.slice("--tag-limit=".length), 10)
    : undefined;

  /**
   * 默认「全库重跑」，加 `--tag-resume` 则从断点续跑。
   *
   * ⚠️ 这里用的是 `resetCursor`：它现在的语义是**显式要求从头**（无条件归零）。
   *    自用（需求 1）之后，界面上那条路（"生成 AI 标签"）传的是 `resetCursor: false`，
   *    所以永远不会误伤已经在跑的断点。曾有一版把两者混在一个判定里，
   *    结果本命令在**已有游标的库**上静默变成"续跑"（第 10 轮发现并修掉，
   *    见 `services/ai/tagging-cursor.ts` 的注释）。
   */
  const resume = process.argv.includes("--tag-resume");
  if (!resume) {
    const { getPixaiTaggingBaseline } = await import("@/services/ai/pixai-tagger");
    const before = getPixaiTaggingBaseline();
    log.info(
      `[Headless] 全库重跑：原进度约 ${before.done}/${before.total}，将从头开始；` +
        "想从断点续跑请加 --tag-resume"
    );
  } else {
    log.info("[Headless] --tag-resume：从断点续跑，不清空游标");
  }

  log.info(
    `[Headless] PixAI 打标开始：modelsDir=${modelsDir}` +
      (maxPhotos ? `，只打 ${maxPhotos} 张` : "，全库") +
      `，GPU=${process.argv.includes("--tag-gpu") ? "尝试 DirectML" : "否（CPU）"}`
  );

  let lastLoggedAt = 0;
  const result = await runPixaiTagging(modelsDir, {
    ...(maxPhotos && Number.isFinite(maxPhotos) ? { maxPhotos } : {}),
    // 默认全库重跑（它就是唯一会真正归零的开关）；--tag-resume 时保持续跑
    resetCursor: !resume,
    // `--tag-gpu` 才尝试 DirectML：它快 10 倍以上（实测 0.6s vs 6.5s/张），
    // 但有原生崩溃风险（客户端会自动降级一次到 CPU，不会死循环）。
    useGpu: process.argv.includes("--tag-gpu"),
    onProgress: (p) => {
      const now = Date.now();
      if (now - lastLoggedAt < 10_000 && p.done < p.total) {
        return;
      }
      lastLoggedAt = now;
      const percent = p.total > 0 ? ((p.done / p.total) * 100).toFixed(1) : "?";
      log.info(
        `[Headless] 进度 ${p.done}/${p.total} (${percent}%) 已标 ${p.tagged} 失败 ${p.failed}`
      );
    },
  });

  releaseGpu("tagging");
  log.info(
    `[Headless] 完成：总数 ${result.total}、成功 ${result.tagged}、失败 ${result.failed}` +
      (result.cancelled ? "（被中止）" : "")
  );
  return result.failed > 0 ? 1 : 0;
}

/**
 * 无头建向量（"特征提取"）：`--run-embedding [--embed-limit=N]`。
 *
 * 为什么要有它：**吞吐问题主要出在这条链上**（SigLIP + worker 池），
 * 而它原本只能开界面点按钮才会跑，无法在命令行量化"多少张/秒"。
 * 有了它就能：
 *   1. 在隔离图库里跑基准（配 `AI_IMAGE_MANAGER_USER_DATA_DIR`），不影响真实库；
 *   2. 改并发/批量/预处理后，用同一条命令做**前后对比**（这是唯一可信的对比方式）。
 *
 * 会处理"待建向量"的照片：`isAiProcessed = 0` 的照片，以及**已标记处理过但向量库里没有**的
 * 照片（embedder 自己会重新排队）。所以想只测 N 张，先在隔离库把那 N 张的
 * `is_ai_processed` 置 0（脚本里就这么做）。
 *
 * 退出码：`0` 正常跑完 / `1` 抛错 / `2` 前置条件不满足。
 */
async function runHeadlessEmbedding(): Promise<number> {
  const limitArg = process.argv.find((arg) => arg.startsWith("--embed-limit="));
  const limit = limitArg
    ? Number.parseInt(limitArg.slice("--embed-limit=".length), 10)
    : undefined;

  const { embedAllPhotos } = await import("@/services/ai/embedder");

  // 无头入口也走互斥：否则命令行建向量会和界面里的打标同时抢显卡
  const blocked = tryAcquireGpu("embedding");
  if (blocked) {
    log.error(`[Headless] 建向量未启动：${blocked}`);
    return 2;
  }

  if (limit && Number.isFinite(limit)) {
    const { getDatabase } = await import("@/db");
    const { photos } = await import("@/db/schema");
    const { eq, sql } = await import("drizzle-orm");
    // 只放开前 N 张"已处理"的照片 → embedder 会精确地只处理它们
    const db = getDatabase();
    const candidates = db
      .select({ id: photos.id })
      .from(photos)
      .where(sql`${photos.isAiProcessed} = 1 AND ${photos.deletedAt} IS NULL`)
      .limit(limit)
      .all()
      .map((row) => row.id);
    for (const id of candidates) {
      db.update(photos)
        .set({ isAiProcessed: false })
        .where(eq(photos.id, id))
        .run();
    }
    log.info(
      `[Headless] 已把 ${candidates.length} 张标记为待建向量（仅测这批）`
    );
  }

  let lastLoggedAt = 0;
  let totalProcessed = 0;
  const startedAt = Date.now();
  const embeddedCount = await embedAllPhotos((progress) => {
    totalProcessed = Math.max(totalProcessed, progress.processed ?? 0);
    const now = Date.now();
    if (
      now - lastLoggedAt < 10_000 &&
      (progress.processed ?? 0) < (progress.total ?? 0)
    ) {
      return;
    }
    lastLoggedAt = now;
    const elapsedSec = (now - startedAt) / 1000;
    const rate = elapsedSec > 0 ? (totalProcessed / elapsedSec).toFixed(2) : "?";
    log.info(
      `[Headless] 建向量进度 ${progress.processed ?? 0}/${progress.total ?? 0}（${rate} 张/秒）`
    );
  });
  const elapsedSec = (Date.now() - startedAt) / 1000;
  releaseGpu("embedding");
  log.info(
    `[Headless] 建向量完成：处理 ${embeddedCount} 张，耗时 ${elapsedSec.toFixed(1)}s，` +
      `平均 ${(elapsedSec / Math.max(1, embeddedCount)).toFixed(3)} 秒/张（${(embeddedCount / Math.max(0.001, elapsedSec)).toFixed(2)} 张/秒）`
  );
  return 0;
}

async function startBackgroundServices() {
  try {
    logMain("[bg] startLevel(Critical) begin");
    await registry.startLevel(ServiceLevel.Critical);
    log.info("Critical services started");
    logMain("[bg] startLevel(Critical) done");

    await runStartupCleanup();
    logMain("[bg] runStartupCleanup done");

    // 模型复制和服务初始化并行：AI 服务在模型就绪前启动会优雅降级
    const modelPromise = ensureModelAvailable();
    await registry.startRemaining();
    log.info("All services started");
    logMain("[bg] startRemaining done");

    await modelPromise;
    logMain("[bg] ensureModelAvailable done");

    // ── Periodic trash cleanup: enforce 30-day retention even when app runs for days ──
    trashCleanupTimer = setInterval(() => {
      cleanupExpiredTrash()
        .then((count) => {
          if (count > 0) {
            log.info(
              { count },
              "Periodic cleanup: removed expired trash photos"
            );
          }
        })
        .catch((err) => {
          log.warn({ err }, "Periodic trash cleanup failed");
        });
    }, TRASH_CLEANUP_INTERVAL_MS);
    logMain(
      `[bg] Periodic trash cleanup scheduled (every ${TRASH_CLEANUP_INTERVAL_MS / 3_600_000}h)`
    );
  } catch (err) {
    const stack = (err as Error)?.stack || String(err);
    logMain(`[bg] FATAL ${stack}`);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// App initialization
// ═══════════════════════════════════════════════════════════════════════

// Custom protocol must be registered as privileged BEFORE app.whenReady()
protocol.registerSchemesAsPrivileged([
  {
    scheme: "local-media",
    privileges: {
      supportFetchAPI: true,
      bypassCSP: true,
      corsEnabled: false,
      stream: true,
    },
  },
  {
    scheme: "aim-plugin",
    privileges: {
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
  {
    scheme: "aim-plugin-user",
    privileges: {
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);

fs.writeFileSync(path.join(logDir, "startup.log"), "BEFORE_WHENREADY\n", {
  flag: "a",
});

// Windows AUMID — 没有它 dev 模式下 Notification 会被系统静默丢弃
if (process.platform === "win32") {
  // 自用版使用独立的 AppUserModelId，让 Windows 任务栏把它与上游原版视为两个不同的应用。
  // 2026-10 起带 "NEXT" 后缀：三个版本各自独立分组，互不覆盖图标；
  // 这个值必须与 forge.config.ts 里 MakerWix 的 appUserModelId **完全一致** ——
  // Windows 是用它把窗口和「开始菜单快捷方式」关联起来取任务栏图标的，
  // 对不上时任务栏就会退回 exe 自带的图标（dev 下即 Electron 的原子图标）。
  app.setAppUserModelId("com.private.ai-anime-image-manager-next");
}

const BROWSER_COMPATIBLE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".avif",
  ".svg",
]);

function notFoundResponse(): Response {
  return new Response(null, { status: 404 });
}

async function ensureLocalMediaFile(resolved: string): Promise<boolean> {
  if (fs.existsSync(resolved)) {
    return true;
  }
  const thumbDir = getThumbnailDir();
  if (!(thumbDir && resolveSafePath(resolved, [thumbDir]))) {
    return false;
  }
  const photo = getDatabase()
    .select({ path: photos.path })
    .from(photos)
    .where(eq(photos.thumbnailPath, resolved))
    .get();
  if (!photo) {
    return false;
  }
  try {
    await generateThumbnail(photo.path, "md");
    return fs.existsSync(resolved);
  } catch (err) {
    log.warn(
      { filePath: resolved, err },
      "local-media: Thumbnail regeneration failed"
    );
    return false;
  }
}

async function renderLocalMedia(resolved: string): Promise<Response> {
  if (!(await ensureLocalMediaFile(resolved))) {
    return notFoundResponse();
  }
  const ext = path.extname(resolved).toLowerCase();
  const buffer = await fs.promises.readFile(resolved);
  if (BROWSER_COMPATIBLE_EXTENSIONS.has(ext)) {
    return new Response(buffer, {
      headers: {
        "content-type": getMimeType(ext),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
  if (isRawFile(resolved)) {
    const preview = await extractRawPreview(resolved);
    if (preview) {
      return new Response(new Uint8Array(preview), {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }
  }
  try {
    const converted = await sharp(resolved).rotate().png().toBuffer();
    return new Response(new Uint8Array(converted), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    log.warn({ filePath: resolved, err }, "local-media: Conversion failed");
    return new Response(buffer, {
      headers: {
        "content-type": getMimeType(ext),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
}

async function handleLocalMediaRequest(request: {
  url: string;
}): Promise<Response> {
  try {
    const encodedPath = request.url.slice("local-media://".length);
    const filePath = decodeURIComponent(encodedPath);
    const resolved = path.resolve(filePath);
    const allowedPaths = [getDataPath(), ...getFolderPaths()];
    const safePath = resolveSafePath(resolved, allowedPaths);
    if (!safePath) {
      log.warn({ filePath }, "Security: local-media blocked");
      return new Response(null, { status: 403 });
    }
    await mediaSemaphore.acquire();
    try {
      return await renderLocalMedia(safePath);
    } finally {
      mediaSemaphore.release();
    }
  } catch (err) {
    log.debug({ err }, "local-media: Request failed");
    return notFoundResponse();
  }
}

app.whenReady().then(async () => {
  // Squirrel.Windows event (install/update/obsolete): quit immediately,
  // don't run expensive init like model copying — the process gets killed
  // and partial copies cause "AI embedding failure" on next launch.
  if (started) {
    return;
  }

  if (app.isPackaged && process.platform === "win32") {
    const shortcutCleanup = cleanupBrokenLegacyStartMenuShortcut({
      appDataPath: app.getPath("appData"),
      executablePath: process.execPath,
      readShortcutLink: (shortcutPath) => shell.readShortcutLink(shortcutPath),
    });
    if (shortcutCleanup === "shortcut-removed") {
      logMain("[startup] Removed broken legacy Start Menu shortcut");
    } else if (shortcutCleanup === "cleanup-failed") {
      logMain("[startup] Failed to inspect legacy Start Menu shortcut");
    }
  }

  fs.writeFileSync(
    path.join(logDir, "whenReady.log"),
    `WHENREADY ${new Date().toISOString()}\n`
  );

  logPackagedPathDiagnostics();

  try {
    // ── Step 1: Fast synchronous setup (no blocking I/O) ─────────────
    initDataPath();
    log.info({ dataPath: getDataPath() }, "Data path initialized");
    await initializeMainLocalization();
    log.info("Main-process localization initialized");

    // Register custom protocol handler for local file access.
    // Must be set up before createWindow() since the window loads
    // local-media:// URLs immediately.
    protocol.handle("local-media", handleLocalMediaRequest);
    registerPluginProtocols();

    // ── Step 2: Start HTTP server (must be ready before window loads) ──
    const httpPort = await startHttpServerEarly();
    log.info({ port: httpPort }, "HTTP server started");

    await setupORPC();
    createWindow(httpPort, getHttpServerAuthToken());
    createTray();
    registerGlobalShortcuts();
    checkForUpdates();
    setupSendToShortcut();

    log.info("Window ready — starting background services...");

    // ── Step 3: Non-blocking background initialization ───────────────
    // GPU detection is now handled on-demand by the Onboarding overlay
    // (step 2) and the Settings page's GpuSettingsCard — no automatic
    // startup popup needed.
    const backgroundStartup = startBackgroundServices().catch((err) =>
      log.warn({ err }, "Non-critical services degraded")
    );
    if (
      process.env.CI === "e2e" &&
      process.argv.includes("--e2e-quit-after-ready")
    ) {
      backgroundStartup.finally(() => {
        setTimeout(() => app.quit(), 100);
      });
    }

    // ── 只重跑「词表导入/改名」：`--import-pixai-vocab` ──────────────────
    // 用途：改了中文名表（`pixai-zh-names.ts`）之后，把库里已有的标签行**改名**，
    // 不必重新打一遍标签（导入逻辑自带 toRename，几秒钟就能完成）。
    if (process.argv.includes("--import-pixai-vocab")) {
      void (async () => {
        let exitCode = 2;
        try {
          await backgroundStartup;
          const { ensureLocalModel } = await import(
            "@/services/ai/model-loader"
          );
          const { importPixaiVocabulary } = await import(
            "@/services/ai/pixai-tagger"
          );
          const modelsDir = await ensureLocalModel();
          const stats = importPixaiVocabulary(modelsDir);
          log.info({ stats }, "[Headless] PixAI 词表导入/改名完成");
          exitCode = 0;
        } catch (error) {
          log.error({ err: error }, "[Headless] PixAI 词表导入失败");
        }
        app.exit(exitCode);
      })();
    }

    // ── 无头打标（NEXT）：`--run-pixai-tagging [--tag-limit=N]` ─────────
    // 全库重跑不必开着界面；配 AI_IMAGE_MANAGER_USER_DATA_DIR 可在隔离图库里验证。
    // 详见 runHeadlessPixaiTagging() 的注释。退出码 0/1/2。
    if (process.argv.includes("--run-pixai-tagging")) {
      void (async () => {
        let exitCode = 2;
        try {
          // 等后台服务（含向量库）就绪，否则特征写不进去
          await backgroundStartup;
          exitCode = await runHeadlessPixaiTagging();
        } catch (error) {
          log.error({ err: error }, "[Headless] 打标过程抛错");
        }
        app.exit(exitCode);
      })();
    }

    // ── 无头建向量：`--run-embedding [--embed-limit=N]` ────────────────
    // 用于量化"特征提取多少张/秒"，以及改并发/批量后的前后对比。
    if (process.argv.includes("--run-embedding")) {
      void (async () => {
        let exitCode = 2;
        try {
          await backgroundStartup;
          exitCode = await runHeadlessEmbedding();
        } catch (error) {
          log.error({ err: error }, "[Headless] 建向量过程抛错");
          exitCode = 1;
        }
        app.exit(exitCode);
      })();
    }

    // ── Background color data backfill (non-blocking, deferred 5s) ─────
    setTimeout(async () => {
      try {
        const db = getDatabase();
        const row = db
          .select({ value: appSettings.value })
          .from(appSettings)
          .where(eq(appSettings.key, "colors_migrated"))
          .get();

        if (!row || row.value !== "true") {
          log.info("[ColorMigration] Starting background color backfill...");
          const { runColorMigration } = await import(
            "@/ipc/photos/handlers/stats"
          );
          const result = await runColorMigration(false);
          log.info({ result }, "[ColorMigration] Background backfill complete");
        }
      } catch (err) {
        log.warn({ err }, "[ColorMigration] Startup backfill failed");
      }
    }, 5000);

    // MakerNote enrichment is deferred and never blocks the basic import path.
    setTimeout(() => {
      import("@/services/advanced-exif")
        .then(({ scheduleAdvancedExifEnrichment }) =>
          scheduleAdvancedExifEnrichment(0)
        )
        .catch((err) =>
          log.warn({ err }, "[AdvancedExif] Startup enrichment failed")
        );
    }, 8000);

    // Forward system theme changes to renderer
    nativeTheme.on("updated", () => {
      mainWindow?.webContents.send(
        "theme:system-changed",
        nativeTheme.shouldUseDarkColors ? "dark" : "light"
      );
    });

    // Handle files sent via SendTo or command-line
    const sentFilePaths = getSendToFilePaths();
    if (sentFilePaths.length > 0) {
      log.info(
        { count: sentFilePaths.length },
        "Received files via SendTo/CLI"
      );
      mainWindow?.webContents.once("did-finish-load", () => {
        mainWindow?.webContents.send("sendto:files", sentFilePaths);
      });
    }
  } catch (error) {
    const message = String(error);
    fs.writeFileSync(path.join(logDir, "whenReady.log"), `CATCH ${message}\n`);
    log.error({ err: error }, "Error during app initialization");
    dialog.showErrorBox("Startup Failed", message);
    app.quit();
  }
});

// ── Second instance: focus existing window ───────────────────────────
app.on("second-instance", (_event, _commandLine, _workingDirectory) => {
  showMainWindow();
});

// ── Window lifecycle ─────────────────────────────────────────────────
// Don't quit when all windows are closed (tray keeps app alive)
app.on("window-all-closed", () => {
  // macOS: standard behavior
  // Windows/Linux: tray keeps it alive
});

app.on("activate", () => {
  showMainWindow();
});

// ── Cleanup on quit ──────────────────────────────────────────────────
async function waitForQuitCleanup(
  operation: Promise<unknown>,
  label: string,
  timeoutMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    log.warn({ err: error }, `Quit cleanup step failed: ${label}`);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * 退出前优雅收尾"建向量"（自用·吞吐修复 2026-10-09）。
 *
 * 问题（日志实测）：用户关窗口/退出时，主进程直接 `terminateTrackedChildProcessesSync()`
 * 把正在推理的 embed worker 用 SIGTERM 杀掉 —— 上一批"已算完但还没落库/没写标记"的
 * 照片就变成**半嵌入**状态（向量库里有、SQLite 标记说没有，或反过来）。
 * 下次启动的自检会把这些照片重新排队甚至整批清理重跑，等于白跑。
 *
 * 做法：先请求取消（worker 会在**当前批次边界**停下），等它真正结束后再继续走原来的
 * 终止流程。超时（30 秒）就放弃等待 —— 退出不能被一个卡死的 worker 拖住。
 */
async function settleRunningEmbeddingBeforeQuit(): Promise<void> {
  try {
    const { cancelEmbedding, isCurrentEmbeddingRun, activeEmbeddingRunId } =
      await import("@/services/ai-embedder");
    const runId = activeEmbeddingRunId;
    if (runId <= 0) {
      return;
    }
    log.info(`quit cleanup: 建向量仍在进行（run ${runId}），先请求停止并等待收尾`);
    cancelEmbedding();
    /**
     * 等待上限。
     *
     * ⚠️ 2026-10-09 实测教训：原来是 30 秒，而一轮大批量建向量**刚被取消时会先跑清理
     * （可能好几分钟）**，30 秒必然超时 → 进程直接退出 → 已建好的向量被回滚，
     * 用户白跑 20 分钟。这里放宽到 5 分钟，让收尾有机会做完。
     */
    const deadline = Date.now() + 300_000;
    while (isCurrentEmbeddingRun(runId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (isCurrentEmbeddingRun(runId)) {
      log.warn("quit cleanup: 等待建向量收尾超时（5 分钟），继续退出");
    } else {
      log.info("quit cleanup: 建向量已收尾");
    }
  } catch (error) {
    log.warn({ err: error }, "quit cleanup: 收尾建向量时出错（忽略，继续退出）");
  }
}

async function cleanupApplicationBeforeQuit(): Promise<void> {
  log.info("quit cleanup: started");
  // 先让"建向量"在批次边界停下并落库，避免半嵌入（必须早于杀子进程）
  await settleRunningEmbeddingBeforeQuit();
  const { suspendImportsForShutdown } = await import("@/services/import-queue");
  suspendImportsForShutdown();
  stopAutomaticChecks();
  try {
    if (logDir) {
      fs.writeFileSync(
        path.join(logDir, "migrate.log"),
        `${new Date().toISOString()} quit-cleanup: START\n`,
        { flag: "a" }
      );
    }
  } catch {
    /* best-effort */
  }
  // Clear periodic trash cleanup timer
  if (trashCleanupTimer) {
    clearInterval(trashCleanupTimer);
    trashCleanupTimer = null;
  }
  try {
    globalShortcut.unregisterAll();
  } catch (error) {
    log.warn({ err: error }, "Failed to unregister global shortcuts");
  }
  try {
    wanderLifecycleBridge?.dispose();
  } catch (error) {
    log.warn({ err: error }, "Failed to dispose wander lifecycle bridge");
  }
  wanderLifecycleBridge = null;

  // Face detection is not a registry-owned service and may have its own
  // Electron worker pool. Invalidate the run before terminating its children
  // so rejected worker promises cannot persist late results during shutdown.
  cancelFaceDetection();
  shutdownFacePool();

  // Kill forked ELECTRON_RUN_AS_NODE workers first. This both unlocks the
  // installed executable for MSI and causes pending service operations to
  // unwind instead of making registry.stop() wait indefinitely.
  const trackedWorkerCount = getTrackedChildProcessCount();
  try {
    if (logDir) {
      fs.writeFileSync(
        path.join(logDir, "migrate.log"),
        `${new Date().toISOString()} quit-cleanup: TRACKED_WORKERS=${trackedWorkerCount}\n`,
        { flag: "a" }
      );
    }
  } catch {
    /* best-effort */
  }
  await waitForQuitCleanup(
    terminateTrackedChildProcesses(),
    "worker termination",
    2000
  );
  await waitForQuitCleanup(exiftool.end(false), "ExifTool termination", 2000);
  await waitForQuitCleanup(
    registry.stop(),
    "service registry",
    QUIT_CLEANUP_TIMEOUT_MS
  );
  try {
    if (logDir) {
      fs.writeFileSync(
        path.join(logDir, "migrate.log"),
        `${new Date().toISOString()} quit-cleanup: DONE\n`,
        { flag: "a" }
      );
    }
  } catch {
    /* best-effort */
  }
  log.info("quit cleanup: finished");
}

const handleBeforeQuit = createBeforeQuitHandler({
  cleanup: cleanupApplicationBeforeQuit,
  destroyTray,
  markQuitting: () => {
    isQuitting = true;
  },
  onCleanupError: (error) => {
    log.error({ err: error }, "Unexpected failure during quit cleanup");
  },
  requestQuit: () => {
    app.quit();
  },
  shouldBlockQuit: () => isUpdateInstallationActive() && !isUpdateQuitAllowed(),
  onQuitBlocked: () => {
    log.info("before-quit: update installation is still running");
  },
});

app.on("before-quit", (event) => {
  log.info("before-quit: application shutdown requested");
  handleBeforeQuit(event);
});

app.on("will-quit", () => {
  // Synchronous final guard for process-exit paths and workers that appeared
  // during the bounded cleanup window.
  destroyTray();
  terminateTrackedChildProcessesSync();
  log.info("will-quit: final shutdown permitted");
});

process.once("exit", terminateTrackedChildProcessesSync);
