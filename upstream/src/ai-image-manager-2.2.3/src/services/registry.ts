import { closeDatabase, getDatabase, initDatabase } from "@/db";
import { getAiControlState } from "@/services/ai/state";
import { shutdownTextWorker } from "@/services/ai/text-worker-client";
import { shutdownTranslationWorker } from "@/services/ai/translation-worker-client";
import { hasActiveDuplicateScan } from "@/services/duplicate-scan-runtime";
import { getSetting, setSetting } from "@/services/settings-manager";
import {
  closeVectorDB,
  embedAllPhotos,
  initVectorDB,
  isAiModelLoaded,
  isVectorDBInitialized,
  loadModel,
  setEmbeddingModel,
  setIsModelLoaded,
  setLocalModelPath,
  stopEmbedding,
  warmupAiSearch,
  wasAutoRepaired,
} from "@/services/ai-embedder";
import { shutdownPool } from "@/services/embed-worker-pool";
import {
  resumeInterruptedImports,
  scheduleStartupCatchUpScan,
  scheduleWatchedFilesAiProcessing,
  stopImports,
} from "@/services/import-queue";
import {
  cleanupOrphanedRecordsAsync,
  startWatching,
  stopWatching,
} from "@/services/indexer";
import {
  checkAndCleanDiskCache,
  initThumbnailer,
} from "@/services/thumbnailer";

// ── Service lifecycle types ───────────────────────────────────────────

export const ServiceLevel = {
  /** App cannot function without this */
  Critical: 1,
  /** App can start but features are degraded */
  Essential: 2,
  /** Optional enhancement, failure is non-blocking */
  Optional: 3,
} as const;

export type ServiceLevel = (typeof ServiceLevel)[keyof typeof ServiceLevel];

const serviceLevelNames: Record<ServiceLevel, string> = {
  [ServiceLevel.Critical]: "Critical",
  [ServiceLevel.Essential]: "Essential",
  [ServiceLevel.Optional]: "Optional",
};

export interface ServiceHealth {
  detail?: string;
  level: ServiceLevel;
  name: string;
  status: "ok" | "degraded" | "error" | "stopped";
}

export interface ServiceDescriptor {
  /** Names of services that must be healthy before this one starts */
  dependencies?: string[];
  health: () =>
    | Omit<ServiceHealth, "name" | "level">
    | Promise<Omit<ServiceHealth, "name" | "level">>;
  level: ServiceLevel;
  name: string;
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
}

export interface HealthReport {
  allHealthy: boolean;
  services: ServiceHealth[];
  summary: string;
}

// ── Registry ──────────────────────────────────────────────────────────

class ServiceRegistry {
  private readonly services = new Map<string, ServiceDescriptor>();
  private startOrder: string[] = [];

  register(desc: ServiceDescriptor): void {
    if (this.services.has(desc.name)) {
      throw new Error(`Service "${desc.name}" is already registered`);
    }
    this.services.set(desc.name, desc);
  }

  /** Start all registered services in dependency order. */
  async start(): Promise<HealthReport> {
    await this.startServices({});
    return this.health();
  }

  /**
   * Start services filtered by max level.
   * level=Critical starts only critical services; level=Essential starts
   * critical + essential; level=Optional starts all.
   */
  async startLevel(maxLevel: ServiceLevel): Promise<HealthReport> {
    await this.startServices({ maxLevel });
    return this.health();
  }

  /**
   * Start remaining registered-but-not-yet-started services.
   * Useful after staged startup inserts maintenance between levels.
   */
  async startRemaining(): Promise<HealthReport> {
    await this.startServices({ skipStarted: true });
    return this.health();
  }

  private async startServices(opts: {
    maxLevel?: ServiceLevel;
    skipStarted?: boolean;
  }): Promise<void> {
    const order = this.resolveOrder();
    const started = new Set(this.startOrder);

    for (const name of order) {
      if (opts.skipStarted && started.has(name)) {
        continue;
      }

      const svc = this.services.get(name);
      if (!svc) {
        continue;
      }

      if (opts.maxLevel !== undefined && svc.level > opts.maxLevel) {
        continue;
      }

      const levelLabel = serviceLevelNames[svc.level];

      try {
        console.log(`[ServiceRegistry] Starting ${name} (${levelLabel})…`);
        await svc.start();
        this.startOrder.push(name);
        console.log(`[ServiceRegistry] ${name} started`);
      } catch (err: unknown) {
        const msg = (err as Error)?.message ?? String(err);
        if (svc.level === ServiceLevel.Critical) {
          console.error(
            `[ServiceRegistry] CRITICAL service "${name}" failed: ${msg}`
          );
          throw new Error(`Critical service "${name}" failed to start: ${msg}`);
        }
        // Non-critical services degrade gracefully
        console.warn(
          `[ServiceRegistry] ${name} (${levelLabel}) failed to start — degrading: ${msg}`
        );
      }
    }
  }

  /** Stop all started services in reverse order. */
  async stop(): Promise<void> {
    const toStop = [...this.startOrder].reverse();
    for (const name of toStop) {
      const svc = this.services.get(name);
      if (!svc) {
        continue;
      }
      try {
        console.log(`[ServiceRegistry] Stopping ${name}…`);
        await svc.stop();
      } catch (err: unknown) {
        console.warn(
          `[ServiceRegistry] Error stopping ${name}:`,
          (err as Error)?.message
        );
      }
    }
    this.startOrder = [];
  }

  /** Run health checks on all registered services. */
  async health(): Promise<HealthReport> {
    const results: ServiceHealth[] = [];
    let allHealthy = true;

    for (const [name, svc] of this.services) {
      try {
        const h = await svc.health();
        results.push({ name, level: svc.level, ...h });
        if (h.status !== "ok") {
          allHealthy = false;
        }
      } catch (err: unknown) {
        results.push({
          name,
          level: svc.level,
          status: "error",
          detail: (err as Error)?.message ?? "health check failed",
        });
        allHealthy = false;
      }
    }

    const summary = allHealthy
      ? "All services healthy"
      : `${results.filter((r) => r.status === "error").length} service(s) in error state`;

    return { allHealthy, services: results, summary };
  }

  /** Topological sort by dependency graph. */
  private resolveOrder(): string[] {
    const names = [...this.services.keys()];
    const visited = new Set<string>();
    const result: string[] = [];
    const visiting = new Set<string>();

    function visit(name: string) {
      if (visited.has(name)) {
        return;
      }
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving "${name}"`);
      }
      visiting.add(name);
      const svc = registry.services.get(name);
      if (svc?.dependencies) {
        for (const dep of svc.dependencies) {
          if (!registry.services.has(dep)) {
            throw new Error(
              `Service "${name}" depends on unknown service "${dep}"`
            );
          }
          visit(dep);
        }
      }
      visiting.delete(name);
      visited.add(name);
      result.push(name);
    }

    for (const name of names) {
      visit(name);
    }
    return result;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

export const registry = new ServiceRegistry();
let thumbnailCleanupInterval: ReturnType<typeof setInterval> | undefined;
/** 自用（2026-10-16）：启动后那次延迟执行的缓存检查（见 thumbnailCleaner 的 start）。 */
let thumbnailCleanupTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * 自用（2026-10-17）：启动后的孤儿记录清理**延后 60 秒**再跑。
 * 实测它要对全库 7.7 万张图各做一次 `fs.existsSync`（6040~8072ms）✗，
 * 正好压在界面首帧那一刻 —— 而孤儿记录不影响显示 ✓，晚一分钟查没有副作用。
 */
const STARTUP_ORPHAN_CLEANUP_DELAY_MS = 60_000;
let orphanCleanupTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * 自用（2026-10-17 第二轮，用户实测"查重被后台任务抢磁盘"）：
 * 这个检查**每次启动**都要对 7.7 万张逐个 `fs.existsSync`（实测 4.8~8.1 秒）✗，
 * 而它清的是"**文件**已被外部删掉/移动"的记录 —— 这种变化极慢，
 * 一天查一次完全够 ✓。所以：
 *   · 24 小时内查过 → **直接跳过**；
 *   · 正在查重 / AI 任务在跑 → **让路**（10 分钟后再看）。
 */
const ORPHAN_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ORPHAN_SCAN_SETTING_KEY = "maintenance.lastFileOrphanScanAt";
/** 自用（2026-10-17）：缩略图缓存检查也改成"一天最多数一遍"（它要 stat 全库缩略图）✓ */
const THUMBNAIL_CHECK_SETTING_KEY = "maintenance.lastThumbnailCheckAt";
const BUSY_RETRY_DELAY_MS = 10 * 60 * 1000;

/** 自用：现在是不是有"重活"在跑（查重 / 打标 / 建向量）—— 这种时候后台维护要主动让路 ✓ */
function isHeavyWorkRunning(): boolean {
  try {
    if (hasActiveDuplicateScan()) {
      return true;
    }
  } catch {
    /* 忽略 */
  }
  try {
    return getAiControlState() !== "idle";
  } catch {
    return false;
  }
}

// ── Service definitions ───────────────────────────────────────────────

registry.register({
  name: "database",
  level: ServiceLevel.Critical,
  start: () => {
    initDatabase();
  },
  stop: () => {
    closeDatabase();
  },
  health: () => {
    try {
      const db = getDatabase();
      // Run a cheap query to verify the connection is alive
      db.run("SELECT 1");
      return { status: "ok" as const };
    } catch {
      return { status: "error" as const, detail: "Database connection lost" };
    }
  },
});

registry.register({
  name: "thumbnailer",
  level: ServiceLevel.Critical,
  dependencies: ["database"],
  start: () => {
    initThumbnailer();
  },
  stop: () => {
    // Thumbnails are file-based; no explicit cleanup needed
  },
  health: () => {
    // The thumbnailer is a thin wrapper around sharp — it cannot "fail"
    return { status: "ok" as const };
  },
});

registry.register({
  name: "fileWatcher",
  level: ServiceLevel.Essential,
  dependencies: ["database", "thumbnailer"],
  start: async () => {
    const { BrowserWindow } = await import("electron");

    // 启动时清理孤立记录（fire-and-forget，不阻塞启动）
    /*
     * 自用（2026-10-17 第二轮，用户实测"查重被后台任务抢磁盘"）：
     *
     * 这一步对**全库每张图**（本机 77,299 张）做一次 `fs.existsSync` ——
     * 实测 **4.8~8.1 秒** ✗，而它清的只是"**文件**被外部删掉/移动"的记录，变化极慢 ✓。
     * 所以改成：**24 小时内查过就跳过**；正在查重 / AI 任务在跑就**让路**（10 分钟后再看）✓。
     *
     * ⚠️ 注意它和「设置 → 存储 → 清理无效记录」**不是一回事**：
     *   设置页那个只查"文件夹记录已不存在"（纯 SQL、瞬间完成）；
     *   这里查的是"**文件**还在不在"（逐个 stat、很慢），没有手动入口 ✗，所以不能直接删掉。
     */
    const scheduleOrphanCleanup = (delayMs: number) => {
      orphanCleanupTimer = setTimeout(() => {
        orphanCleanupTimer = undefined;
        if (isHeavyWorkRunning()) {
          console.log(
            `[perf] 孤儿记录检查：有查重/AI 任务在跑 → 让路，${BUSY_RETRY_DELAY_MS / 60000} 分钟后再看 ✓`
          );
          scheduleOrphanCleanup(BUSY_RETRY_DELAY_MS);
          return;
        }
        const lastScanAt = Number(getSetting(ORPHAN_SCAN_SETTING_KEY) ?? 0) || 0;
        if (Date.now() - lastScanAt < ORPHAN_SCAN_INTERVAL_MS) {
          console.log(
            "[perf] 孤儿记录检查：24 小时内已经查过 → 本次跳过 ✓（省下 5~8 秒磁盘操作）"
          );
          return;
        }
        const orphanStartedAt = Date.now();
        cleanupOrphanedRecordsAsync()
          .then(({ removed, checked }) => {
            setSetting(ORPHAN_SCAN_SETTING_KEY, String(Date.now()));
            console.log(
              `[perf] 孤儿记录检查（文件是否还在）：检查 ${checked} 张 / 移除 ${removed} 张，耗时 ${Date.now() - orphanStartedAt}ms`
            );
          })
          .catch(() => {
            /* 孤儿清理失败不影响启动 */
          });
      }, delayMs);
    };
    scheduleOrphanCleanup(STARTUP_ORPHAN_CLEANUP_DELAY_MS);

    startWatching((photoId, event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("file-change", { type: event, photoId });
      }
      // 自用版：软件运行中新增的文件，索引后自动跑 AI（嵌入 + 打标）。
      // 上游的监听器路径只做索引，不触发 AI —— 否则新图看得见但搜不到、没标签。
      if (event === "add") {
        scheduleWatchedFilesAiProcessing();
      }
    });
    // 自用（2026-10-16）：这个函数现在是异步的（内部要做"有没有变化"的只读预检）
    void resumeInterruptedImports();

    // 自用版：开机增量补扫 —— 补上"关机期间直接存进目录"的图。
    // 延迟执行，先让其余服务启动完成，避免抢磁盘 I/O 与 AI 模型加载。
    // 理由与开关见 src/config/private-build.ts 的 startupCatchUpScan。
    scheduleStartupCatchUpScan();

    // 自用版：清理应用回收站里超过 30 天的文件（按"删除时刻"算，移动时已改时间戳）。
    // 失败不影响启动，所以吞掉异常。
    // 自用（2026-10-17）：同样加耗时（它是同步 fs.rmSync 循环，回收站一多就会卡主线程 ✗）。
    void (async () => {
      try {
        const { purgeExpiredAppTrash } = await import("@/services/app-trash");
        const trashStartedAt = Date.now();
        purgeExpiredAppTrash();
        console.log(
          `[perf] 启动回收站清理：耗时 ${Date.now() - trashStartedAt}ms`
        );
      } catch {
        /* 回收站清理失败不阻塞启动 */
      }
    })();
  },
  stop: async () => {
    if (orphanCleanupTimer) {
      clearTimeout(orphanCleanupTimer);
      orphanCleanupTimer = undefined;
    }
    await stopImports();
    await stopWatching();
  },
  health: () => {
    return { status: "ok" as const };
  },
});

registry.register({
  name: "aiVectorDB",
  level: ServiceLevel.Optional,
  start: async () => {
    await initVectorDB();
    // If the vector DB was auto-repaired during init (corruption detected and
    // rebuilt), auto-trigger re-embedding so the user doesn't need to click
    // "AI Smart Index" manually. The embedAllPhotos progress is broadcast via
    // IPC so the sidebar AiProgressBar stays up-to-date.
    if (wasAutoRepaired) {
      console.log("[Registry] Auto-repair detected — starting auto re-index");
      const { BrowserWindow } = await import("electron");
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("ai-auto-repair-started");
      }
      embedAllPhotos((aiProgress) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("ai-progress", aiProgress);
        }
      })
        .then((count) => {
          if (count > 0) {
            console.log(`[Registry] Auto re-index complete: ${count} photos`);
          }
        })
        .catch((err) => {
          console.warn("[Registry] Auto re-index failed:", err?.message);
        });
    }
  },
  stop: async () => {
    await closeVectorDB();
  },
  health: () => {
    if (isVectorDBInitialized()) {
      return { status: "ok" as const };
    }
    return {
      status: "degraded" as const,
      detail: "Vector database not initialized",
    };
  },
});

registry.register({
  name: "aiModel",
  level: ServiceLevel.Optional,
  start: async () => {
    await loadModel();
    warmupAiSearch().catch((err) => {
      console.warn("[Registry] AI search warmup failed:", err?.message);
    });
  },
  stop: () => {
    stopEmbedding();
    // Reset model state so the next start() reloads from the
    // current getDataPath() — essential after data-path migration
    // (onboarding / settings) which moves models to a new directory.
    setIsModelLoaded(false);
    setEmbeddingModel(null);
    setLocalModelPath(null);
    shutdownTextWorker();
    shutdownTranslationWorker();
    try {
      shutdownPool();
    } catch {
      /* pool may not have been started */
    }
  },
  health: () => {
    if (isAiModelLoaded()) {
      return { status: "ok" as const };
    }
    return {
      status: "degraded" as const,
      detail: "AI embedding model not loaded",
    };
  },
});

registry.register({
  name: "httpServer",
  level: ServiceLevel.Critical,
  dependencies: ["database"],
  start: async () => {
    const {
      isHttpServerRunning,
      startHttpServerEarly,
      syncLanListener,
    } = await import("@/services/http-server");
    // 如果已经在 createWindow() 之前通过 startHttpServerEarly() 启动，则跳过。
    if (!isHttpServerRunning()) {
      await startHttpServerEarly();
    }
    // 再对齐一次局域网监听器：早期启动时数据库还没就绪，
    // 而"开关 + 口令 + 端口"都在数据库里（本服务依赖 database，所以这里一定是就绪的）。
    await syncLanListener();
  },
  stop: async () => {
    const { stopHttpServer } = await import("@/services/http-server");
    await stopHttpServer();
  },
  health: async () => {
    const { isHttpServerRunning } = await import("@/services/http-server");
    if (isHttpServerRunning()) {
      return { status: "ok" as const };
    }
    return {
      status: "error" as const,
      detail: "HTTP server is not running",
    };
  },
});

registry.register({
  name: "thumbnailCleaner",
  level: ServiceLevel.Optional,
  start: async () => {
    /*
     * 自用（2026-10，**修"启动后一碰就未响应"**）：
     * 这里原来是 `await checkAndCleanDiskCache()` ✗ ——
     * 它要遍历缩略图缓存（实测 **77,268 个文件** ✗），
     * 一 await 就把**服务注册表的启动**卡住 ✓，
     * 而界面的"就绪门"在等服务注册表 → 于是界面画得出来、却一直取不到照片 ✗
     *（实测：等几分钟它扫完，界面自己就恢复正常 ✓）。
     *
     * 现在改成**后台跑**：服务立刻报告 started ✓，清理在后台慢慢做 ✓。
     *
     * 自用（2026-10-16，**再往后挪 2 分钟** ✗→✓）：
     * 实测日志：这次扫描 **耗时 16,074ms、扫了 77,268 个文件 / 7,618 MB** ✓，
     * 而它正好和「渲染层加载」撞在一起（同一秒里主进程既要服务页面、
     * 又要做 7 万多次 stat ✗）→ 界面在这一段里最容易「未响应」✗。
     * 启动时**并不需要**立刻知道缓存有多大 ✓，所以挪到启动 2 分钟后再做：
     * 先把界面和照片列表让出来 ✓，再慢慢数文件和清理 ✓。
     */
    const startupCleanupDelayMs = 2 * 60 * 1000;
    /*
     * 自用（2026-10-17 第二轮，用户实测"查重被后台任务抢磁盘"）：
     * 这次检查要 stat **7.7 万个缩略图文件**（实测 5.4~16 秒）✗，
     * 若此时用户正好在扫查重（它也在逐张读文件），两边就互相拖慢 ✗ →
     * **有查重/AI 任务在跑时主动让路**（10 分钟后再看）✓
     */
    const runThumbnailCacheCheck = (delayMs: number) => {
      thumbnailCleanupTimer = setTimeout(() => {
        thumbnailCleanupTimer = undefined;
        if (isHeavyWorkRunning()) {
          console.log(
            "[perf] 缩略图缓存检查：有查重/AI 任务在跑 → 让路，10 分钟后再看 ✓"
          );
          runThumbnailCacheCheck(BUSY_RETRY_DELAY_MS);
          return;
        }
        /*
         * 自用（2026-10-17 第二轮）：**一天最多数一遍** ✓
         * 它要 stat 全库缩略图（本机 7.7 万个文件 → 5.4~16 秒）✗，
         * 而结论几乎总是"没到阈值、不清理"（本机 7.45GB / 7.7 万，阈值 18GB / 10 万）——
         * 每次启动都数一遍纯属白花时间 ✓。缓存变大是"天"级别的变化，一天一次足够 ✓。
         */
        const lastCheckAt =
          Number(getSetting(THUMBNAIL_CHECK_SETTING_KEY) ?? 0) || 0;
        if (Date.now() - lastCheckAt < ORPHAN_SCAN_INTERVAL_MS) {
          console.log(
            "[perf] 缩略图缓存检查：一天内已经数过 → 本次跳过 ✓（省下 5~16 秒磁盘操作）"
          );
          return;
        }
        setSetting(THUMBNAIL_CHECK_SETTING_KEY, String(Date.now()));
        checkAndCleanDiskCache()
          .then((result) => {
            if (result.cleaned) {
              console.log(
                `[Registry] Thumbnail cache cleaned on startup: ${result.filesRemoved} files, ${result.freedMB.toFixed(1)}MB freed`
              );
            }
          })
          .catch(() => {
            // 清理失败不影响启动。
          });
      }, delayMs);
    };
    runThumbnailCacheCheck(startupCleanupDelayMs);

    // 每天清理一次（同样：有重活在跑就让路，下次再来 ✓）
    const cleanupInterval = setInterval(
      () => {
        if (isHeavyWorkRunning()) {
          return;
        }
        checkAndCleanDiskCache()
          .then((result) => {
            if (result.cleaned) {
              console.log(
                `[Registry] Thumbnail cache cleaned: ${result.filesRemoved} files, ${result.freedMB.toFixed(1)}MB freed`
              );
            }
          })
          .catch(() => {
            // Cleanup runs again on the next scheduled interval.
          });
      },
      24 * 60 * 60 * 1000
    );

    // Store interval for cleanup
    thumbnailCleanupInterval = cleanupInterval;
  },
  stop: () => {
    if (thumbnailCleanupTimer) {
      clearTimeout(thumbnailCleanupTimer);
      thumbnailCleanupTimer = undefined;
    }
    if (thumbnailCleanupInterval) {
      clearInterval(thumbnailCleanupInterval);
      thumbnailCleanupInterval = undefined;
    }
  },
  health: () => {
    return { status: "ok" as const };
  },
});
