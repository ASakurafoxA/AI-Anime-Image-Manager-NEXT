/** @vitest-environment node */
/**
 * 徽标统计「落盘快照」的测试。
 *
 * 目的：重启应用后不要再花 3.6 秒（32 万图时 21 秒）重算那条统计。
 * 靠「图库指纹」（图片数 / 关联行数 / 关联最大 id）判断快照是否还新鲜。
 *
 * 怎么验证"确实读了快照而不是重算"：把某个标签从一张图挪到另一张图
 * （行数不变、最大 id 不变 → 指纹不变，但统计结果会变），
 * 此时若返回的是**旧数字**，就证明走的是快照。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { photos, photoTags, tags } from "@/db/schema";
import { invalidateCountCache } from "@/ipc/photos/handlers/listing";
import { getTags } from "@/ipc/photos/handlers/tags";
import { clearTagCountCache } from "@/services/tag-count-cache";
import { invalidateTagSearch } from "@/services/tag-search-revision";

const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "aim-tagcount-"));
const snapshotFile = path.join(snapshotDir, "tag-photo-counts.json");

vi.mock("@/utils/data-path", () => ({
  getDataPath: () => snapshotDir,
}));

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("electron", () => ({
  app: { getPath: () => snapshotDir, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  fs.rmSync(snapshotFile, { force: true });
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
  for (let id = 1; id <= 4; id++) {
    db.insert(photos)
      .values({ id, filename: `${id}.jpg`, path: `C:/f/${id}.jpg`, fileDate: id })
      .run();
  }
  // P1、P2 → 长发(11)；P3、P4 → 角色A(21)
  db.insert(photoTags)
    .values([
      { photoId: 1, tagId: 11 },
      { photoId: 2, tagId: 11 },
      { photoId: 3, tagId: 21 },
      { photoId: 4, tagId: 21 },
    ])
    .run();
});

afterAll(() => {
  fs.rmSync(snapshotDir, { recursive: true, force: true });
});

async function counts() {
  const rows = await call(getTags, {});
  return new Map(rows.map((row) => [row.id, row.photoCount]));
}

describe("徽标统计落盘快照", () => {
  it("算完之后会写出快照文件", async () => {
    expect((await counts()).get(11)).toBe(2);
    expect(fs.existsSync(snapshotFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(snapshotFile, "utf-8"));
    expect(parsed.version).toBe(1);
    expect(parsed.fingerprint.photoCount).toBe(4);
    expect(parsed.fingerprint.linkCount).toBe(4);
  });

  it("清掉内存缓存后（模拟重启）直接读快照，不重算", async () => {
    expect((await counts()).get(11)).toBe(2);

    // 模拟重启：内存缓存没了，但快照文件还在
    clearTagCountCache();
    // 把「长发」从 P2 挪到 P4：行数不变、最大 id 不变 → 指纹不变
    db.update(photoTags)
      .set({ photoId: 4 })
      .where(sql`${photoTags.photoId} = 2`)
      .run();

    const afterRestart = await counts();
    // 若真的重算了，长发 会是 1（只剩 P1）；返回 2 说明用的是快照
    expect(afterRestart.get(11)).toBe(2);
  });

  it("指纹变了（新增关联行）→ 快照作废并重算", async () => {
    expect((await counts()).get(11)).toBe(2);
    clearTagCountCache();

    // 给 P3 也加上「长发」→ 关联行数 + 最大 id 都变
    db.insert(photoTags).values({ photoId: 3, tagId: 11 }).run();

    expect((await counts()).get(11)).toBe(3);
  });

  it("指纹变了（删除图片）→ 快照作废并重算", async () => {
    expect((await counts()).get(21)).toBe(2);
    clearTagCountCache();

    // 软删除 P3（挂着角色A）
    db.update(photos).set({ deletedAt: Date.now() }).where(eq(photos.id, 3)).run();

    expect((await counts()).get(21)).toBe(1);
  });

  it("快照文件损坏时不影响使用（自动重算）", async () => {
    expect((await counts()).get(11)).toBe(2);
    clearTagCountCache();
    fs.writeFileSync(snapshotFile, "{ 这不是合法 JSON", "utf-8");

    expect((await counts()).get(11)).toBe(2);
  });

  it("按文件夹查询不复用全局快照", async () => {
    expect((await counts()).get(11)).toBe(2);
    clearTagCountCache();
    invalidateTagSearch();
    invalidateCountCache();

    // folderId=999 没有图 → 数字应为 0，不能拿到全局的 2
    const scoped = await call(getTags, { folderId: 999 });
    const scopedMap = new Map(scoped.map((row) => [row.id, row.photoCount]));
    expect(scopedMap.get(11)).toBe(0);
  });
});
