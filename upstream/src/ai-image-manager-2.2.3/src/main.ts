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
import { getEmbeddingModelFile } from "@/services/ai/model-config";
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
// ⚠️ 2026-10-18（会话#9）用户口径：**只需要和上游原版不同**（上游叫 AI Image Manager，
//    配置目录本来就是分开的），**自家三版不需要再拆** → 保持"三版共用一个配置目录" ✓
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

/*
 * 自用（2026-10-17）：启动期「主线程被谁占住」体检器。
 *
 * 现象：`[bg] startRemaining done` → `[bg] ensureModelAvailable done` 这一段，
 * 从 **2026-10-16 00:55** 起每次启动多出 **6~22 秒**（之前 9 天每次都是 0 秒 ✓），
 * 而这段里**一条日志都没有** → 主线程被某段"不写日志的同步活儿"占住了 ✗
 * （用户："启动又要等好几秒白屏了"）。
 *
 * 做法：每 100ms 记一次时间，**实际间隔比 100ms 多出来的部分 = 卡顿**；
 * 卡顿 ≥300ms 就写一条到 main.log（带"启动后第几秒"）。
 * 只在前 90 秒工作，之后自动停 —— 平时安静、出事有据 ✓。
 */
let startupLagTimer: NodeJS.Timeout | null = null;
/** 启动体检起点（给各段日志统一换算"启动后第几秒"）。 */
let startupProbeStartedAt = Date.now();
function startStartupLagProbe(limitMs = 90_000): void {
  if (startupLagTimer) {
    return;
  }
  startupProbeStartedAt = Date.now();
  const startedAt = startupProbeStartedAt;
  let last = Date.now();
  startupLagTimer = setInterval(() => {
    const now = Date.now();
    const drift = now - last - 100;
    last = now;
    if (drift >= 300) {
      logMain(
        `[perf] 主线程卡顿 ${drift}ms（启动后 ${((now - startedAt) / 1000).toFixed(1)}s）`
      );
    }
    if (now - startedAt > limitMs) {
      clearInterval(startupLagTimer as NodeJS.Timeout);
      startupLagTimer = null;
      logMain("[perf] 启动体检结束（90 秒）");
    }
  }, 100);
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
      "asar-unpacked-wd14-tagger-worker",
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "scripts",
        "wd14-tagger-worker.mjs"
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

/*
 * 自用（2026-10-18 · 会话#9 用户口径）：「托盘的大概缩放到这样」（给了张头部特写）。
 * 托盘只有 16px，整张立绘缩下去会糊成一团 → 托盘单独用**头部特写**（同样是透明底）✓
 */
function getTrayIconPath(): string {
  const name = "icon-tray.png";
  if (app.isPackaged) {
    return path.join(process.resourcesPath, name);
  }
  return path.join(app.getAppPath(), "assets", name);
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
  // 托盘优先用"头部特写"；没有就退回整图 ✓
  const trayIconPath = getTrayIconPath();
  const iconPath = fs.existsSync(trayIconPath) ? trayIconPath : getIconPath();
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

async function hasCurrentModels(modelsDir: string): Promise<boolean> {
  /*
   * 自用（NEXT，2026-10，用户要求）：**不再把 opus-mt（中译英）算作"当前模型"** ✗→✓。
   *
   * 缘由：用户已要求把 SigLIP 与 opus-mt **彻底移除**（旧模型不好用、也不留回退），
   * 而嵌入模型换成了**中文原生**的 Chinese-CLIP —— 中文查询直接编码，**根本不走翻译那一步**。
   *
   * 为什么必须删掉这两条检查：原来它们检查 `Xenova/opus-mt-zh-en/onnx/` 下的两个文件，
   * 模型一旦被移除，这里**永远返回 false** → `ensureModelAvailable()` 每次都判定
   * "模型不完整" → 反复重新复制/下载，删了也白删 ✗。
   *
   * 注意第一条 marker **保持原样**：`getEmbeddingModelFile()` 会按**当前**嵌入模型
   * 解析路径，换成 Chinese-CLIP 后它自然指向 `chinese-clip-.../model_quantized.onnx` ✓。
   */
  const markers = [
    getEmbeddingModelFile(modelsDir, "vision_model_quantized.onnx"),
  ];
  // 自用（2026-10-18 · 会话#9）：SFace 已整体剔除，不再校验人脸模型 ✓
  return markers.every((marker) => fs.existsSync(marker));
}

async function copyBundledModels(modelsDir: string): Promise<void> {
  const bundledModels = path.join(process.resourcesPath, "models-release");
  const bundledMarker = getEmbeddingModelFile(
    bundledModels,
    "vision_model_quantized.onnx"
  );
  log.info(
    "[ensureModelAvailable] bundledModels=%s exists=%s bundledMarker=%s exists=%s",
    bundledModels,
    fs.existsSync(bundledModels),
    bundledMarker,
    fs.existsSync(bundledMarker)
  );
  if (!fs.existsSync(bundledMarker)) {
    throw new Error("Bundled AI models are incomplete or failed hash verification");
  }

  log.info("Copying AI models from bundled resources...");
  try {
    await copyModelsOnce();
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
        "Copied AI models failed startup verification"
      );
    }
    log.info("AI models copied and hash verified");
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
      if (await hasCurrentModels(modelsDir)) {
        log.info("AI models copied and hash verified");
        return;
      }
      log.warn({ source: candidate }, "Dev model copy failed verification");
    } catch (err) {
      log.warn({ err, source: candidate }, "Failed to copy from dev path");
    }
  }
  log.warn("AI models not found in any dev path");
}

async function ensureModelAvailable(): Promise<void> {
  const modelsDir = path.join(getDataPath(), "models");
  /*
   * 自用（2026-10-17）：把这一步的耗时写进 main.log ——
   * 它正好是"白屏那 6~22 秒"的终点，必须量出来到底是"校验本身慢"还是"被别的东西挡住"。
   */
  const checkStartedAt = Date.now();
  const modelsReady = await hasCurrentModels(modelsDir);
  logMain(`[perf] 模型校验 ${Date.now() - checkStartedAt}ms → ${modelsReady}`);
  if (modelsReady) {
    log.info(
      "AI models already cached and hash verified at %s",
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
    // 自用（2026-10-17）：**别再是默认白** —— 窗口先出来时用主题底色，
    // 这样"还没画完就叫出来"看到的是深/浅底色，而不是刺眼的白屏 ✗→✓
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#08090a" : "#fbfbfc",
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
  /*
   * 自用（2026-10-17，用户口径）：**窗口要等"界面真的画出来"再显示** ✓
   *
   * 用户观察（关键）：「托盘图标都出来了，窗口却自己不弹；我点开它才看到白屏；
   *   等它自己出来就没有白屏」→ 也就是说，**弹窗时机**决定了会不会看到白屏 ✗。
   *
   * 为什么不能用 `ready-to-show`：它只代表"网页的**第一个空白帧**画好了"
   * —— 实测**启动后 0.8 秒**就触发，那时 React 连一个字都还没渲染 ✗，
   * 于是窗口先出来、里面一片白/空 ✗（用户看到的正是这个）。
   *
   * 所以改成：**渲染层在自己画完第一帧后发一条 IPC 回来**（`app:renderer-ready`），
   * 主进程收到才 `show()` ✓ —— 窗口一出现就是界面（dev 版多等的几秒是 Vite 渲染代价，
   * 打包版几乎瞬间，所以打包版感觉不到）。
   * 兜底：12 秒还没收到（极端情况）就照常显示，绝不至于"永远不开窗" ✓。
   */
  let windowShown = false;
  const showMainWindowWhenRendered = (reason: string) => {
    if (windowShown || isQuitting || !mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    windowShown = true;
    mainWindow.show();
    mainWindow.focus();
    logMain(
      `[perf] 窗口已显示（${reason}，启动后 ${((Date.now() - startupProbeStartedAt) / 1000).toFixed(1)}s）`
    );
  };
  const onRendererReady = () => showMainWindowWhenRendered("渲染层首帧已画");
  ipcMain.on("app:renderer-ready", onRendererReady);
  const rendererReadyFallback = setTimeout(
    () => showMainWindowWhenRendered("等渲染首帧超时 12s 兜底"),
    12_000
  );
  mainWindow.once("ready-to-show", () => {
    // 只记录时间，**不再据此显示窗口**（那时通常是空白帧）
    logMain(
      `[perf] ready-to-show（首个空白帧，启动后 ${((Date.now() - startupProbeStartedAt) / 1000).toFixed(1)}s）`
    );
  });
  mainWindow.webContents.on("did-finish-load", () => {
    logMain(
      `[perf] 渲染层加载完成（启动后 ${((Date.now() - startupProbeStartedAt) / 1000).toFixed(1)}s）`
    );
    lifecycleBridge.publish("initial");
    applyUiZoomScale();
  });
  mainWindow.once("closed", () => {
    clearTimeout(rendererReadyFallback);
    ipcMain.removeListener("app:renderer-ready", onRendererReady);
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
    // 自用（2026-10-17）：启动期主线程卡顿体检（90 秒后自动停，见 startStartupLagProbe）
    startStartupLagProbe();
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
