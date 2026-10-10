// @vitest-environment node
/**
 * 「移除文件夹」标记机制。
 *
 * 要解决的问题（用户反馈）：在建库时把一个文件夹从索引里移除（左侧树右键 → 移除文件夹），
 * 但**下次打开软件它又回来了** —— 因为本版有「开机增量补扫」
 * （`scheduleStartupCatchUpScan`），而 `scanFolder` 在遍历时会自动把
 * 「含图片的子目录」重新建成文件夹记录。
 *
 * 机制：移除时按**绝对路径**记一个标记（不用文件夹 id —— id 会随
 * "移除→重新导入"变化，路径不会），扫描时跳过带标记的目录及其整棵子树；
 * 用户**手动重新导入**该路径时才清掉标记。
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("chokidar", () => ({
  default: { watch: () => new EventEmitter() },
}));
vi.mock("@/services/ai-embedder", () => ({
  deletePhotoVectors: async () => undefined,
}));
vi.mock("@/services/dedup-service", () => ({
  checkNewPhotoDuplicates: () => undefined,
}));
vi.mock("@/services/thumbnailer", () => ({
  generateThumbnail: async () => ({
    buffer: Buffer.from(""),
    thumbnailPath: null,
    width: 32,
    height: 32,
  }),
  deletePhotoThumbnails: () => undefined,
}));
vi.mock("@/services/raw-preview", () => ({ isRawFile: () => false }));
vi.mock("@/services/color-extractor", () => ({
  extractDominantColors: async () => null,
}));
vi.mock("@/utils/logger", () => ({
  createLogger: () => state.logger,
}));

let sqlite: Database.Database;
let root: string;
let indexer: typeof import("@/services/indexer");
let exclusions: typeof import("@/services/folder-exclusions");

const folderRows = () =>
  sqlite
    .prepare("select path, parent_id as parentId from folders order by path")
    .all() as { path: string; parentId: number | null }[];
const photoRows = () =>
  sqlite
    .prepare("select path, folder_id as folderId from photos order by path")
    .all() as { path: string; folderId: number | null }[];

beforeEach(async () => {
  vi.resetModules();
  sqlite = new Database(":memory:");
  state.db = drizzle(sqlite);
  migrate(state.db as ReturnType<typeof drizzle>, {
    migrationsFolder: "drizzle",
  });
  const base = path.resolve(".test-runtime");
  fs.mkdirSync(base, { recursive: true });
  root = fs.mkdtempSync(path.join(base, "aim-removal-"));
  fs.mkdirSync(path.join(root, "保留"));
  fs.mkdirSync(path.join(root, "要移除"));
  const buffer = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "#4080a0" },
  })
    .jpeg()
    .toBuffer();
  fs.writeFileSync(path.join(root, "保留/keep.jpg"), buffer);
  fs.writeFileSync(path.join(root, "要移除/drop.jpg"), buffer);

  indexer = await import("@/services/indexer");
  exclusions = await import("@/services/folder-exclusions");
});

afterEach(async () => {
  await indexer?.stopWatching();
  sqlite?.close();
  if (root && path.basename(root).startsWith("aim-removal-")) {
    await fs.promises.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

/** 模拟 `deleteFolder`：删掉记录和照片，并打上「已移除」标记。 */
function removeFolderLikeTheApp(folderPath: string) {
  const row = sqlite
    .prepare("select id from folders where path = ?")
    .get(folderPath) as { id: number } | undefined;
  if (row) {
    sqlite.prepare("delete from photo_tags where photo_id in (select id from photos where folder_id = ?)").run(row.id);
    sqlite.prepare("delete from photos where folder_id = ?").run(row.id);
    sqlite.prepare("delete from folders where id = ?").run(row.id);
  }
  exclusions.addRemovedFolderPath(folderPath);
}

describe("移除标记：路径语义", () => {
  it("标记后：它自己和它的子孙都算「已移除」，别的路径不受影响", () => {
    exclusions.addRemovedFolderPath("C:/lib/推特/新建文件夹");
    expect(exclusions.isPathRemoved("C:/lib/推特/新建文件夹")).toBe(true);
    expect(exclusions.isPathRemoved("C:/lib/推特/新建文件夹/深层")).toBe(true);
    expect(exclusions.isPathRemoved("C:/lib/推特")).toBe(false);
    // 大小写与分隔符不敏感（Windows 语义）
    expect(exclusions.isPathRemoved("c:\\lib\\推特\\新建文件夹")).toBe(true);
  });

  it("不会把「前缀相同但不是子目录」的路径误判", () => {
    exclusions.addRemovedFolderPath("C:/lib/abc");
    expect(exclusions.isPathRemoved("C:/lib/abc2")).toBe(false);
  });

  it("手动重新添加某路径 → 忘掉它和它的祖先，但保留它下面的标记", () => {
    exclusions.setRemovedFolderPaths([
      "C:/lib/A",
      "C:/lib/A/B",
      "C:/lib/X",
    ]);
    // 重新导入 A/B：A（祖先）与 A/B（自己）都要忘掉，A/B 才能被扫描
    exclusions.forgetRemovedPath("C:/lib/A/B");
    expect(exclusions.getRemovedFolderPaths()).not.toContain("C:/lib/A");
    expect(exclusions.getRemovedFolderPaths()).not.toContain("C:/lib/A/B");
    // 无关的 X 不受影响
    expect(exclusions.getRemovedFolderPaths()).toContain("C:/lib/X");
  });

  it("重新导入父目录时，下面单独标记过的子目录仍然保持移除", () => {
    exclusions.setRemovedFolderPaths(["C:/lib/A/子"]);
    exclusions.forgetRemovedPath("C:/lib/A");
    expect(exclusions.getRemovedFolderPaths()).toContain("C:/lib/A/子");
    expect(exclusions.isPathRemoved("C:/lib/A/子")).toBe(true);
  });

  it("重复添加同一个路径不会堆叠", () => {
    exclusions.addRemovedFolderPath("C:/lib/A");
    exclusions.addRemovedFolderPath("C:/lib/A");
    expect(exclusions.getRemovedFolderPaths()).toEqual(["C:/lib/A"]);
  });
});

describe("移除标记：扫描行为（用户实际场景）", () => {
  it("首次扫描：两个子目录都被收录", async () => {
    await indexer.scanFolder(root);
    const paths = folderRows().map((r) => r.path);
    expect(paths).toHaveLength(3); // 根 + 保留 + 要移除
    expect(photoRows()).toHaveLength(2);
  });

  it("移除一个子目录后再次扫描（模拟开机补扫）→ 不复活", async () => {
    await indexer.scanFolder(root);
    const removedPath = path.join(root, "要移除");
    removeFolderLikeTheApp(removedPath);

    // 再次扫描树根 = 开机增量补扫做的事
    await indexer.scanFolder(root);

    const paths = folderRows().map((r) => r.path);
    expect(paths).not.toContain(removedPath);
    expect(paths.some((p) => p.endsWith("保留"))).toBe(true);
    // 被移除目录里的照片也不该被重新索引
    const photos = photoRows().map((r) => r.path);
    expect(photos.some((p) => p.includes("要移除"))).toBe(false);
    expect(photos.some((p) => p.includes("保留"))).toBe(true);
  });

  it("手动重新导入该路径 → 标记被清掉，内容正常收回来", async () => {
    await indexer.scanFolder(root);
    const removedPath = path.join(root, "要移除");
    removeFolderLikeTheApp(removedPath);
    await indexer.scanFolder(root);
    expect(folderRows().map((r) => r.path)).not.toContain(removedPath);

    // 用户主动导入这个路径
    await indexer.scanFolder(removedPath);

    const paths = folderRows().map((r) => r.path);
    expect(paths).toContain(removedPath);
    expect(exclusions.isPathRemoved(removedPath)).toBe(false);
    expect(photoRows().some((r) => r.path.includes("要移除"))).toBe(true);
  });

  it("重复扫描不会产生重复的文件夹或照片记录", async () => {
    await indexer.scanFolder(root);
    const before = folderRows().length;
    const photosBefore = photoRows().length;
    await indexer.scanFolder(root);
    expect(folderRows().length).toBe(before);
    expect(photoRows().length).toBe(photosBefore);
  });
});
