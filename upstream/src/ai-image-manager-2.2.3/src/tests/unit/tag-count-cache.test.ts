/** @vitest-environment node */
/**
 * 标签树徽标数字的缓存测试。
 *
 * 背景：徽标统计那条递归 CTE 在真实图库（7.7 万图 / 420 万条 photo_tags）上要
 * **3,380 ms**（1,237 万行 JOIN 后再去重分组），但它只在图库内容变化时才变。
 *
 * 这里**通过 `getTags` 验证**（而不是直接调内部函数），因为：
 *   · 侧边栏看到的就是 getTags 返回的 photoCount，这才是真正的契约
 *   · 本地版把统计内联在 getTags 里、LAN/NEXT 抽成了 queryTagPhotoCounts，
 *     走 getTags 能让三版共用同一份测试
 */
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { photos, photoTags, tags } from "@/db/schema";
import { invalidateCountCache } from "@/ipc/photos/handlers/listing";
import { getTags } from "@/ipc/photos/handlers/tags";
import { clearTagCountCache } from "@/services/tag-count-cache";
import { invalidateTagSearch } from "@/services/tag-search-revision";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("electron", () => ({
  app: { getPath: () => ".test-runtime", getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;

/** 取「标签 id → 徽标数字」的表。 */
async function counts(): Promise<Map<number, number>> {
  const rows = await call(getTags, {});
  return new Map(rows.map((row) => [row.id, row.photoCount]));
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  clearTagCountCache();

  db.insert(tags)
    .values([
      { id: 10, name: "通用", parentId: null },
      { id: 11, name: "长发", parentId: 10 },
      { id: 20, name: "角色", parentId: null },
      { id: 21, name: "角色A", parentId: 20 },
    ])
    .run();
  for (let id = 1; id <= 3; id++) {
    db.insert(photos)
      .values({ id, filename: `${id}.jpg`, path: `C:/f/${id}.jpg`, fileDate: id })
      .run();
  }
  // P1 → 长发(11)   P2 → 通用(10)   P3 → 角色A(21)
  db.insert(photoTags)
    .values([
      { photoId: 1, tagId: 11 },
      { photoId: 2, tagId: 10 },
      { photoId: 3, tagId: 21 },
    ])
    .run();
});

afterEach(() => sqlite.close());

describe("标签徽标数字的缓存", () => {
  it("算得对：父标签的数字包含整棵子树", async () => {
    const result = await counts();
    expect(result.get(10)).toBe(2); // 通用子树 {10,11} → P1 + P2
    expect(result.get(11)).toBe(1);
    expect(result.get(20)).toBe(1); // 角色子树 {20,21} → P3
    expect(result.get(21)).toBe(1);
  });

  it("第二次调用走缓存：改了底层数据但不清缓存，数字不变", async () => {
    expect((await counts()).get(11)).toBe(1);
    db.insert(photoTags).values({ photoId: 2, tagId: 11 }).run();
    // 没有走任何失效入口 → 仍应是旧的 1（证明确实用了缓存）
    expect((await counts()).get(11)).toBe(1);
  });

  it("修订号变化（打标 / 改标签）→ 自动重算", async () => {
    expect((await counts()).get(11)).toBe(1);
    db.insert(photoTags).values({ photoId: 2, tagId: 11 }).run();
    invalidateTagSearch();
    const after = await counts();
    expect(after.get(11)).toBe(2); // P1 + P2
    expect(after.get(10)).toBe(2); // 通用子树仍是 {P1, P2}
  });

  it("invalidateCountCache（导入完成 / 删除）→ 自动重算", async () => {
    expect((await counts()).get(11)).toBe(1);
    db.insert(photoTags).values({ photoId: 3, tagId: 11 }).run();
    invalidateCountCache();
    expect((await counts()).get(11)).toBe(2); // P1 + P3
  });

  it("软删除的照片不计入数字", async () => {
    expect((await counts()).get(11)).toBe(1);
    db.update(photos).set({ deletedAt: Date.now() }).where(eq(photos.id, 1)).run();
    clearTagCountCache();
    expect((await counts()).get(11)).toBe(0);
  });

  it("按文件夹查询不会复用全局缓存", async () => {
    const all = await counts();
    expect(all.get(11)).toBe(1);
    // folderId=999 没有任何照片 → 数字应为 0，不能拿到全局的 1
    const scoped = await call(getTags, { folderId: 999 });
    const scopedMap = new Map(scoped.map((row) => [row.id, row.photoCount]));
    expect(scopedMap.get(11)).toBe(0);
  });
});
