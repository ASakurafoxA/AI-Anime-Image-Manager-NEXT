// @vitest-environment node
/**
 * 2026-11-18（会话#14）：**移动/改名不丢标签**（认亲）的回归测试。
 *
 * 用户口径：「在资源管理器里移动/重命名文件或文件夹，标签不能丢」。
 * 两种场景都要保住同一条记录（id 不变 = 没有"删旧建新"）：
 *   ① 软件**没开**时移动 → 下次启动孤儿对账会先把它标成"缺失"，扫描时认亲恢复；
 *   ② 软件**开着**时移动 → unlink 延迟 250ms，add 到达时认亲接管，之后不再删。
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  watchers: [] as Array<
    EventEmitter & { close: ReturnType<typeof vi.fn>; folderPath: string }
  >,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  thumbnail: vi.fn(),
}));

vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("chokidar", () => ({
  default: {
    watch: (folderPath: string) => {
      const watcher = new EventEmitter() as (typeof state.watchers)[number];
      Object.assign(watcher, {
        close: vi.fn(() => {
          watcher.removeAllListeners();
          return Promise.resolve();
        }),
        folderPath,
      });
      state.watchers.push(watcher);
      return watcher;
    },
  },
}));
vi.mock("@/services/ai-embedder", () => ({
  deletePhotoVectors: async () => undefined,
}));
vi.mock("@/services/dedup-service", () => ({
  checkNewPhotoDuplicates: () => undefined,
}));
vi.mock("@/services/thumbnailer", () => ({
  generateThumbnail: state.thumbnail,
  deletePhotoThumbnails: () => undefined,
}));
vi.mock("@/services/raw-preview", () => ({ isRawFile: () => false }));
vi.mock("@/services/color-extractor", () => ({
  extractDominantColors: async () => null,
}));
vi.mock("@/utils/logger", () => ({ createLogger: () => state.logger }));

let sqlite: Database.Database;
let root: string;
let indexer: typeof import("@/services/indexer");
let schema: typeof import("@/db/schema");

beforeEach(async () => {
  vi.resetModules();
  state.watchers.length = 0;
  state.logger.info.mockReset();
  state.logger.warn.mockReset();
  state.logger.error.mockReset();
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db as ReturnType<typeof drizzle>, { migrationsFolder: "drizzle" });
  state.db = db;
  schema = await import("@/db/schema");
  const base = path.resolve(".test-runtime");
  fs.mkdirSync(base, { recursive: true });
  root = fs.mkdtempSync(path.join(base, "move-adopt-"));
  fs.mkdirSync(path.join(root, "A"));
  const buffer = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "#4080a0" },
  })
    .jpeg()
    .toBuffer();
  fs.writeFileSync(path.join(root, "A/photo.jpg"), buffer);
  state.thumbnail
    .mockReset()
    .mockResolvedValue({ buffer, thumbnailPath: null, width: 32, height: 32 });
  indexer = await import("@/services/indexer");
  await indexer.scanFolder(root);
});

afterEach(async () => {
  await indexer?.stopWatching();
  sqlite?.close();
  if (
    root &&
    path.dirname(root) === path.resolve(".test-runtime") &&
    path.basename(root).startsWith("move-adopt-")
  ) {
    await fs.promises.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

/** 给当前唯一那张照片挂一个标签，返回 { photoId, tagId }。 */
function tagTheOnlyPhoto(): { photoId: number; tagId: number } {
  const db = state.db as ReturnType<typeof drizzle>;
  const photo = db.select({ id: schema.photos.id }).from(schema.photos).get();
  expect(photo?.id).toBeTypeOf("number");
  const tag = db
    .insert(schema.tags)
    .values({ name: "测试角色" })
    .returning({ id: schema.tags.id })
    .get();
  db.insert(schema.photoTags)
    .values({ photoId: photo!.id, tagId: tag!.id, userConfirmed: true })
    .run();
  return { photoId: photo!.id, tagId: tag!.id };
}

describe("移动/改名不丢标签（认亲）", () => {
  it("软件没开时移动：孤儿标记 + 扫描认亲，id 与标签都保留", async () => {
    const { photoId } = tagTheOnlyPhoto();
    const oldPath = path.join(root, "A/photo.jpg");
    const newPath = path.join(root, "B/photo.jpg");
    fs.mkdirSync(path.dirname(newPath), { recursive: true });

    // 模拟"软件关着的时候移动"
    fs.renameSync(oldPath, newPath);
    const cleanup = await indexer.cleanupOrphanedRecords();
    expect(cleanup.removed).toBe(1);

    // 标记为"缺失"而不是删除：记录还在，标签还在
    const rawAfterMark = sqlite
      .prepare("select id, deleted_at, deletion_batch_id from photos")
      .all() as Array<{
      id: number;
      deleted_at: number | null;
      deletion_batch_id: string | null;
    }>;
    expect(rawAfterMark).toHaveLength(1);
    expect(rawAfterMark[0].deleted_at).not.toBeNull();
    expect(rawAfterMark[0].deletion_batch_id).toBe("__orphan_missing__");

    // 重新扫描 → 认亲：同一条记录改到新路径并恢复
    await indexer.scanFolder(root);

    const rows = sqlite
      .prepare("select id, path, deleted_at from photos")
      .all() as Array<{ id: number; path: string; deleted_at: number | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(photoId);
    expect(rows[0].path).toBe(newPath);
    expect(rows[0].deleted_at).toBeNull();

    const tagRows = sqlite
      .prepare("select count(*) as n from photo_tags where photo_id = ?")
      .get(photoId) as { n: number };
    expect(tagRows.n).toBe(1);
  });
});
