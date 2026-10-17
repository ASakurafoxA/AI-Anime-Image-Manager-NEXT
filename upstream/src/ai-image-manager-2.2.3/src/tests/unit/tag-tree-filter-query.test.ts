/** @vitest-environment node */
/**
 * 标签树检索的回归测试。
 *
 * 背景：`queryPhotos` 的标签过滤从「IN (子查询)」改成了「EXISTS + 带主键的临时表」
 * （原因：真实图库 7.7 万图 / 420 万条 photo_tags 下，点「通用」原写法首页要 10.2 秒、
 * 「角色 AND 画风」计数要 57 秒）。改法涉及一张**连接级临时表**，所以这里重点验证：
 *   1. 子树展开语义没变（根 / 中间节点 / 叶子）
 *   2. OR 与 AND 语义没变
 *   3. **连续用不同标签查询不会串数据**（临时表是否每次都被清干净）
 *   4. 命中总数与列表一致
 */
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { folders, photos, photoTags, tags } from "@/db/schema";
import {
  invalidateCountCache,
  listPhotos,
} from "@/ipc/photos/handlers/listing";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("electron", () => ({
  app: { getPath: () => ".test-runtime", getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;

  db.insert(folders)
    .values({ id: 1, path: "C:/fixture", displayName: "fixture" })
    .run();

  // 标签树：
  //   通用(10) ├ 长发(11) ─ 双马尾(13)
  //            └ 微笑(12)
  //   角色(20) ├ 角色A(21)
  //            └ 角色B(22)
  //   画风(30) └ 厚涂(31)
  db.insert(tags)
    .values([
      { id: 10, name: "通用", parentId: null },
      { id: 11, name: "长发", parentId: 10 },
      { id: 12, name: "微笑", parentId: 10 },
      { id: 13, name: "双马尾", parentId: 11 },
      { id: 20, name: "角色", parentId: null },
      { id: 21, name: "角色A", parentId: 20 },
      { id: 22, name: "角色B", parentId: 20 },
      { id: 30, name: "画风", parentId: null },
      { id: 31, name: "厚涂", parentId: 30 },
    ])
    .run();

  for (let id = 1; id <= 7; id++) {
    db.insert(photos)
      .values({
        id,
        filename: `${id}.jpg`,
        path: `C:/fixture/${id}.jpg`,
        folderId: 1,
        fileDate: id,
      })
      .run();
  }

  // P1=长发  P2=双马尾  P3=角色A  P4=长发+角色A  P5=厚涂  P6=无标签  P7=微笑+厚涂
  const links: [number, number][] = [
    [1, 11],
    [2, 13],
    [3, 21],
    [4, 11],
    [4, 21],
    [5, 31],
    [7, 12],
    [7, 31],
  ];
  for (const [photoId, tagId] of links) {
    db.insert(photoTags).values({ photoId, tagId }).run();
  }

  invalidateCountCache();
});

afterEach(() => sqlite.close());

async function listIds(input: Record<string, unknown>) {
  const result = await call(listPhotos, {
    sort: "date",
    order: "asc",
    offset: 0,
    limit: 100,
    ...input,
  });
  return {
    ids: result.items.map((photo) => photo.id).sort((a, b) => a - b),
    total: result.total,
  };
}

describe("标签树检索：子树展开", () => {
  it("点根分类「通用」→ 返回整棵子树命中的图片", async () => {
    // 子树 = {10, 11, 12, 13} → P1(11) P2(13) P4(11) P7(12)
    expect(await listIds({ tagId: 10 })).toEqual({ ids: [1, 2, 4, 7], total: 4 });
  });

  it("点中间节点「长发」→ 只返回它和它后代命中的图片（不含兄弟节点）", async () => {
    // 子树 = {11, 13} → P1 P2 P4（P7 挂的是兄弟「微笑」，不能进来）
    expect(await listIds({ tagId: 11 })).toEqual({ ids: [1, 2, 4], total: 3 });
  });

  it("点叶子节点「微笑」→ 只返回该标签命中的图片", async () => {
    expect(await listIds({ tagId: 12 })).toEqual({ ids: [7], total: 1 });
  });

  it("点没有图片的标签 → 空结果且总数为 0", async () => {
    expect(await listIds({ tagId: 22 })).toEqual({ ids: [], total: 0 });
  });

  it("不带标签条件 → 返回全部图片", async () => {
    expect(await listIds({})).toEqual({ ids: [1, 2, 3, 4, 5, 6, 7], total: 7 });
  });
});

describe("标签树检索：AND / OR", () => {
  it("AND：两张标签必须同时命中（各自的子树都算）", async () => {
    // 通用子树 {10,11,12,13} ∧ 角色子树 {20,21,22} → 只有 P4
    expect(await listIds({ tagIds: [10, 20], tagMode: "and" })).toEqual({
      ids: [4],
      total: 1,
    });
    // 通用 ∧ 画风 → P7（微笑 + 厚涂）
    expect(await listIds({ tagIds: [10, 30], tagMode: "and" })).toEqual({
      ids: [7],
      total: 1,
    });
    // 角色 ∧ 画风 → 没有图片同时满足
    expect(await listIds({ tagIds: [20, 30], tagMode: "and" })).toEqual({
      ids: [],
      total: 0,
    });
  });

  it("OR：命中任意一个标签的子树即可", async () => {
    // 角色 ∪ 画风 = {20,21,22,30,31} → P3 P4 P5 P7
    expect(await listIds({ tagIds: [20, 30], tagMode: "or" })).toEqual({
      ids: [3, 4, 5, 7],
      total: 4,
    });
  });

  it("单个 tagId 等价于 tagIds 的 OR 模式（兼容旧调用）", async () => {
    const single = await listIds({ tagId: 10 });
    const asArray = await listIds({ tagIds: [10], tagMode: "or" });
    expect(single).toEqual(asArray);
  });
});

describe("临时表复用：连续查询不能串数据", () => {
  it("大集合 → 小集合 → 再回大集合，结果必须稳定", async () => {
    // 这是临时表方案最容易出错的地方：如果每次没清干净，
    // 第二次查询会带上第一次的标签，第三次也会被污染。
    expect((await listIds({ tagId: 10 })).ids).toEqual([1, 2, 4, 7]);
    expect((await listIds({ tagId: 31 })).ids).toEqual([5, 7]);
    expect((await listIds({ tagId: 20 })).ids).toEqual([3, 4]);
    expect((await listIds({ tagId: 10 })).ids).toEqual([1, 2, 4, 7]);
  });

  it("AND 与 OR 交替：组数变化时旧分组不能残留", async () => {
    // AND 用 2 个分组（下标 0/1），OR 只用 1 个分组（下标 0）。
    // 若切换时没有重建，OR 会读到 AND 留在第 0 组的半套标签。
    expect((await listIds({ tagIds: [10, 30], tagMode: "and" })).ids).toEqual([7]);
    expect((await listIds({ tagIds: [10, 30], tagMode: "or" })).ids).toEqual([
      1, 2, 4, 5, 7,
    ]);
    expect((await listIds({ tagIds: [10, 30], tagMode: "and" })).ids).toEqual([7]);
  });

  it("带标签 → 不带标签 → 再带标签，互不影响", async () => {
    expect((await listIds({ tagId: 20 })).ids).toEqual([3, 4]);
    expect((await listIds({})).ids).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((await listIds({ tagId: 20 })).ids).toEqual([3, 4]);
  });

  it("分页：翻到第二页时不重复、不漏", async () => {
    const first = await call(listPhotos, {
      tagId: 10,
      sort: "date",
      order: "asc",
      offset: 0,
      limit: 2,
    });
    const second = await call(listPhotos, {
      tagId: 10,
      sort: "date",
      order: "asc",
      offset: 2,
      limit: 2,
    });
    expect(first.items.map((p) => p.id)).toEqual([1, 2]);
    expect(second.items.map((p) => p.id)).toEqual([4, 7]);
    // 两页的总数必须是同一个值
    expect(first.total).toBe(4);
    expect(second.total).toBe(4);
  });
});
