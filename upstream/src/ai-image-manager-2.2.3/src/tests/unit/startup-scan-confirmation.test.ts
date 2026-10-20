// @vitest-environment node
/**
 * 自用（2026-10-16）：开机补扫「大图库先问一句」的行为测试 ✓。
 *
 * 守住的规则（用户实测过的坑）：
 *   · 已有照片数 ≥ 阈值（**固定 30000**）→ 不自动扫描，只登记「待确认」，
 *     等用户点「开始扫描」✗→✓
 *   · 小于阈值 → 照旧自动扫描（小目录不要打扰用户）✓
 *     （2026-10-17 用户口径确认：保持这条，与设置页文案「≥3 万张才二次确认」一致 ✓
 *       —— 曾经改成"未完成导入一律先问"，已按用户要求回退 ✗）
 *   · 点「先跳过」→ 清掉待确认、且**不扫描**，但账本保留（下次开机还会问）✓
 *   · 阈值不给用户选（用户口径：图库只增不减，挑数字没意义）✓
 */
import { setImmediate as tick } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  indexedPhotos: 0,
  lastScannedAt: null as number | null,
  roots: [] as Array<{ id: number; path: string }>,
  scan: vi.fn(),
  send: vi.fn(),
  settings: new Map<string, string>(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: state.send } }],
  },
}));
vi.mock("@/db", () => ({
  getDatabase: () => ({
    // 同时给出 `c`（照片数）与 `t`（上次扫描时间），两条查询各取所需 ✓
    get: () => ({ c: state.indexedPhotos, t: state.lastScannedAt }),
    select: () => ({ from: () => ({ where: () => ({ all: () => [] }) }) }),
  }),
}));
vi.mock("@/services/settings-manager", () => ({
  getSetting: (key: string) => state.settings.get(key) ?? null,
  setSetting: (key: string, value: string) => state.settings.set(key, value),
}));
vi.mock("@/utils/import-path", () => ({
  normalizeImportFolderPath: (value: string) => value,
  importPathKey: (value: string) => value.toLowerCase(),
}));
vi.mock("@/services/indexer", () => ({
  getIndexedRootFolders: () => state.roots,
  scanFolder: state.scan,
  stopScanning: vi.fn(),
  watchFolder: vi.fn(),
}));
vi.mock("@/ipc/photos/handlers/listing", () => ({
  invalidateCountCache: vi.fn(),
}));
vi.mock("@/ipc/photos/handlers/stats", () => ({
  invalidateIndexStatsCache: vi.fn(),
}));
vi.mock("@/services/ai/state", () => ({ getAiControlState: () => "idle" }));
vi.mock("@/services/ai-embedder", () => ({
  deletePhotoVectors: vi.fn(),
  embedAllPhotos: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/services/advanced-exif", () => ({
  scheduleAdvancedExifEnrichment: vi.fn(),
}));
vi.mock("@/services/folder-matcher", () => ({ reloadFolderMatcher: vi.fn() }));
vi.mock("@/services/thumbnailer", () => ({ deletePhotoThumbnails: vi.fn() }));

function scanResult() {
  return {
    folderId: 1,
    folderExisted: true,
    createdFolderIds: [],
    photoIds: [],
    newPhotoIds: [],
    skipped: 0,
    cancelled: false,
  };
}

describe("开机补扫：大图库先问一句", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.settings.clear();
    state.indexedPhotos = 0;
    state.lastScannedAt = null;
    state.roots = [];
    state.scan.mockResolvedValue(scanResult());
  });

  it("超过阈值 → 只登记待确认，不自动扫描；点「开始扫描」后才入队", async () => {
    state.settings.set("imports.unfinishedRoots", JSON.stringify(["big-root"]));
    state.indexedPhotos = 40_000;

    const queue = await import("@/services/import-queue");
    queue.resumeInterruptedImports();
    await tick();

    expect(state.scan).not.toHaveBeenCalled();
    expect(queue.getPendingStartupScans()).toEqual([
      { folderPath: "big-root", photoCount: 40_000 },
    ]);
    expect(queue.getImportQueueStatus().pending).toHaveLength(0);

    queue.confirmPendingStartupScans();
    await tick();

    expect(state.scan).toHaveBeenCalledTimes(1);
    expect(queue.getPendingStartupScans()).toHaveLength(0);
  });

  it("低于阈值 → 照旧自动扫描（小目录不打扰用户；与设置里「≥3 万张才二次确认」一致）", async () => {
    state.settings.set("imports.unfinishedRoots", JSON.stringify(["small-root"]));
    state.indexedPhotos = 24_723;

    const queue = await import("@/services/import-queue");
    queue.resumeInterruptedImports();
    await tick();

    expect(queue.getPendingStartupScans()).toHaveLength(0);
    expect(state.scan).toHaveBeenCalledTimes(1);
  });

  it("点「先跳过」：清掉待确认、不扫，账本仍留着（下次开机还会问）", async () => {
    state.settings.set("imports.unfinishedRoots", JSON.stringify(["big-root"]));
    state.indexedPhotos = 40_000;

    const queue = await import("@/services/import-queue");
    queue.resumeInterruptedImports();
    await tick();
    expect(queue.getPendingStartupScans()).toHaveLength(1);

    expect(queue.dismissPendingStartupScans()).toBe(1);
    expect(queue.getPendingStartupScans()).toHaveLength(0);
    expect(state.scan).not.toHaveBeenCalled();
    // 账本没被清掉 → 下次开机仍会问 ✓（不会静默丢记录）
    expect(state.settings.get("imports.unfinishedRoots")).toBe(
      JSON.stringify(["big-root"])
    );
  });

  it("正好到 3 万张也算大图库（阈值固定 30000，不给用户选）", async () => {
    state.settings.set("imports.unfinishedRoots", JSON.stringify(["edge-root"]));
    state.indexedPhotos = 30_000;

    const queue = await import("@/services/import-queue");
    queue.resumeInterruptedImports();
    await tick();

    expect(state.scan).not.toHaveBeenCalled();
    expect(queue.getPendingStartupScans()).toHaveLength(1);
  });

  it("点「先跳过」→ 待确认清空，且不扫描", async () => {
    state.settings.set("imports.unfinishedRoots", JSON.stringify(["big-root"]));
    state.indexedPhotos = 40_000;

    const queue = await import("@/services/import-queue");
    queue.resumeInterruptedImports();
    await tick();
    expect(queue.getPendingStartupScans()).toHaveLength(1);

    expect(queue.dismissPendingStartupScans()).toBe(1);
    await tick();

    expect(queue.getPendingStartupScans()).toHaveLength(0);
    expect(state.scan).not.toHaveBeenCalled();
  });

  it("阈值固定 30000；开关都能改，旧阈值键不生效", async () => {
    const queue = await import("@/services/import-queue");

    expect(queue.readStartupScanSettings()).toEqual({
      confirmLarge: true,
      enabled: false,
      largeThreshold: 30_000,
      precheck: true,
    });

    state.settings.set("imports.startupCatchUpScan", "true");
    state.settings.set("imports.startupScanPrecheck", "false");
    // 就算有人往 app_settings 里塞了旧的阈值键，也不该生效 ✓
    state.settings.set("imports.largeRescanThreshold", "5000");

    expect(queue.readStartupScanSettings()).toEqual({
      confirmLarge: true,
      enabled: true,
      largeThreshold: 30_000,
      precheck: false,
    });
  });

  it("总开关关着时，开机补扫根本不会排定时器", async () => {
    const queue = await import("@/services/import-queue");
    expect(queue.scheduleStartupCatchUpScan(10)).toBeNull();

    state.settings.set("imports.startupCatchUpScan", "true");
    const timer = queue.scheduleStartupCatchUpScan(10);
    expect(timer).not.toBeNull();
    if (timer) {
      clearTimeout(timer);
    }
  });
});

describe("开机补扫：B′ 只读预检（看文件夹修改时间）", () => {
  const OLD = new Date("2020-01-01T00:00:00Z");
  async function makeTree(names: string[]): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "aim-scan-"));
    const dirs: string[] = [];
    for (const name of names) {
      const dir = name.includes("/")
        ? path.join(root, ...name.split("/"))
        : path.join(root, name);
      await fs.promises.mkdir(dir, { recursive: true });
      dirs.push(dir);
    }
    /*
     * ⚠️ 必须**全部建完**再统一设时间，而且**深的先设、浅的后设** ✓：
     * 建子目录会把**父目录**的修改时间顶成"现在" ✗ ——
     * 顺序错了就会把"其实没变化"的目录弄成"刚变过" ✓（这个用例第一次就是这么失败的 ✓）。
     */
    dirs.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
    for (const dir of dirs) {
      await fs.promises.utimes(dir, OLD, OLD);
    }
    await fs.promises.utimes(root, OLD, OLD);
    return root;
  }

  async function runCatchUp(): Promise<
    typeof import("@/services/import-queue")
  > {
    state.settings.set("imports.startupCatchUpScan", "true");
    const queue = await import("@/services/import-queue");
    queue.scheduleStartupCatchUpScan(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return queue;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.settings.clear();
    state.indexedPhotos = 0;
    state.lastScannedAt = null;
    state.roots = [];
    state.scan.mockResolvedValue(scanResult());
  });

  it("整棵树一点没变 → 静默跳过：不扫、不弹提示（哪怕它是 7.6 万张的大图库）", async () => {
    const root = await makeTree(["artist-a", "artist-a/31990343"]);
    state.roots = [{ id: 28, path: root }];
    state.lastScannedAt = Date.now(); // 上次扫描是"现在"，目录更老 → 没变化
    state.indexedPhotos = 75_927;

    const queue = await runCatchUp();

    expect(state.scan).not.toHaveBeenCalled();
    expect(queue.getPendingStartupScans()).toHaveLength(0);
  });

  it("**深层**子文件夹有更新 → 认出来，并按大小弹提示（用户的实际结构）", async () => {
    const root = await makeTree(["artist-a", "artist-a/31990343"]);
    state.roots = [{ id: 28, path: root }];
    state.lastScannedAt = Date.now() - 60_000; // 上次扫描是 1 分钟前
    state.indexedPhotos = 75_927;
    // 模拟"往深两层那个文件夹里存了新图" → 它的修改时间变新 ✓
    const deep = path.join(root, "artist-a", "31990343");
    const now = new Date();
    await fs.promises.utimes(deep, now, now);

    const queue = await runCatchUp();

    expect(state.scan).not.toHaveBeenCalled();
    expect(queue.getPendingStartupScans()).toEqual([
      { folderPath: root, photoCount: 75_927 },
    ]);
  });

  it("小目录有更新 → 认出来并直接扫（不打扰用户）", async () => {
    const root = await makeTree(["artist-a"]);
    state.roots = [{ id: 1, path: root }];
    state.lastScannedAt = Date.now() - 60_000;
    state.indexedPhotos = 1_340;
    const now = new Date();
    await fs.promises.utimes(path.join(root, "artist-a"), now, now);

    await runCatchUp();

    expect(state.scan).toHaveBeenCalledTimes(1);
  });

  it("从没扫过（没有上次扫描时间）→ 不跳过，按原逻辑走", async () => {
    const root = await makeTree(["artist-a"]);
    state.roots = [{ id: 1, path: root }];
    state.lastScannedAt = null;
    state.indexedPhotos = 1_340;

    await runCatchUp();

    expect(state.scan).toHaveBeenCalledTimes(1);
  });

  it("关掉「只检查有没有变化」→ 没变化也照常往下走（大目录弹提示、不扫）", async () => {
    const root = await makeTree(["artist-a", "artist-a/31990343"]);
    state.roots = [{ id: 28, path: root }];
    state.lastScannedAt = Date.now(); // 目录没变化
    state.indexedPhotos = 75_927;
    state.settings.set("imports.startupScanPrecheck", "false");

    const queue = await runCatchUp();

    // 预检被关掉 → 不跳过 → 因为是大目录，进"待确认"
    expect(state.scan).not.toHaveBeenCalled();
    expect(queue.getPendingStartupScans()).toEqual([
      { folderPath: root, photoCount: 75_927 },
    ]);
  });

  it("关掉「只检查有没有变化」→ 小目录没变化也照样扫", async () => {
    const root = await makeTree(["artist-a"]);
    state.roots = [{ id: 1, path: root }];
    state.lastScannedAt = Date.now();
    state.indexedPhotos = 1_340;
    state.settings.set("imports.startupScanPrecheck", "false");

    await runCatchUp();

    expect(state.scan).toHaveBeenCalledTimes(1);
  });
});
