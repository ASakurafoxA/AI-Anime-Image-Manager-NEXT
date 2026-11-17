// @vitest-environment node
/**
 * 2026-11-18（会话#14）：**"同名、只换了路径"的文件夹自动找回** 回归测试。
 *
 * 用户口径：文件夹改名请在软件里改；但"名字不变、只挪了位置"要能自动把数据找回来。
 * 这里钉住三件事：
 *   ① 同名 + 文件签名匹配 → 文件夹和照片路径都迁移过去（id / 标签不变）；
 *   ② 如果之前已经被标成"缺失"，迁移时要**顺手恢复**（否则路径对了图还是隐藏的）；
 *   ③ 匹配不上（同名但内容不同）→ 什么都不做。
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/utils/logger", () => ({ createLogger: () => state.logger }));

import { folders, photoTags, photos, tags } from "@/db/schema";
import {
  adoptRelocatedFolderPath,
  relocateSameNameFolders,
} from "@/services/folder-relocation";

let sqlite: Database.Database;
let root: string;

beforeEach(() => {
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db as ReturnType<typeof drizzle>, { migrationsFolder: "drizzle" });
  state.db = db;
  const base = path.resolve(".test-runtime");
  fs.mkdirSync(base, { recursive: true });
  root = fs.mkdtempSync(path.join(base, "reloc-"));
});

afterEach(async () => {
  sqlite?.close();
  if (
    root &&
    path.dirname(root) === path.resolve(".test-runtime") &&
    path.basename(root).startsWith("reloc-")
  ) {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

function db() {
  return state.db as ReturnType<typeof drizzle>;
}

describe("同名文件夹换路径：自动找回", () => {
  it("迁移路径并恢复被标记为缺失的记录，标签保留", () => {
    const newLocation = path.join(root, "新位置", "截图");
    fs.mkdirSync(newLocation, { recursive: true });
    const filePath = path.join(newLocation, "a.jpg");
    fs.writeFileSync(filePath, Buffer.from("hello-image"));
    const stat = fs.statSync(filePath);

    // 旧的（已不存在的）位置
    const oldRoot = path.join(root, "旧位置");
    fs.mkdirSync(oldRoot, { recursive: true });
    const oldFolderPath = path.join(oldRoot, "截图");

    const rootRow = db()
      .insert(folders)
      .values({ path: root, displayName: path.basename(root) })
      .returning({ id: folders.id })
      .get()!;
    const folderRow = db()
      .insert(folders)
      .values({
        path: oldFolderPath,
        displayName: "截图",
        parentId: rootRow.id,
      })
      .returning({ id: folders.id })
      .get()!;
    const photoRow = db()
      .insert(photos)
      .values({
        path: path.join(oldFolderPath, "a.jpg"),
        folderId: folderRow.id,
        filename: "a.jpg",
        fileSize: stat.size,
        fileDate: Math.floor(stat.mtimeMs),
        // 模拟"上一次对账已经标成缺失"
        deletedAt: Date.now(),
        deletionBatchId: "__orphan_missing__",
      })
      .returning({ id: photos.id })
      .get()!;
    const tagRow = db()
      .insert(tags)
      .values({ name: "测试角色" })
      .returning({ id: tags.id })
      .get()!;
    db()
      .insert(photoTags)
      .values({ photoId: photoRow.id, tagId: tagRow.id, userConfirmed: true })
      .run();

    const migrated = relocateSameNameFolders(state.db as ReturnType<typeof drizzle>);
    expect(migrated).toEqual([{ from: oldFolderPath, to: newLocation }]);

    const folderNow = db()
      .select({ path: folders.path })
      .from(folders)
      .where(eq(folders.id, folderRow.id))
      .get();
    expect(folderNow?.path).toBe(newLocation);

    const photoNow = sqlite
      .prepare("select path, deleted_at, deletion_batch_id from photos")
      .get() as {
      path: string;
      deleted_at: number | null;
      deletion_batch_id: string | null;
    };
    expect(photoNow.path).toBe(path.join(newLocation, "a.jpg"));
    expect(photoNow.deleted_at).toBeNull();
    expect(photoNow.deletion_batch_id).toBeNull();

    const tagCount = sqlite
      .prepare("select count(*) n from photo_tags where photo_id = ?")
      .get(photoRow.id) as { n: number };
    expect(tagCount.n).toBe(1);
  });

  it("同名但内容对不上 → 不迁移", () => {
    const newLocation = path.join(root, "新位置", "截图");
    fs.mkdirSync(newLocation, { recursive: true });
    fs.writeFileSync(path.join(newLocation, "a.jpg"), Buffer.from("different"));

    const oldFolderPath = path.join(root, "旧位置", "截图");
    fs.mkdirSync(path.dirname(oldFolderPath), { recursive: true });

    const rootRow = db()
      .insert(folders)
      .values({ path: root, displayName: path.basename(root) })
      .returning({ id: folders.id })
      .get()!;
    const folderRow = db()
      .insert(folders)
      .values({ path: oldFolderPath, displayName: "截图", parentId: rootRow.id })
      .returning({ id: folders.id })
      .get()!;
    db()
      .insert(photos)
      .values({
        path: path.join(oldFolderPath, "a.jpg"),
        folderId: folderRow.id,
        filename: "a.jpg",
        fileSize: 999_999,
        fileDate: Date.now(),
      })
      .run();

    const migrated = relocateSameNameFolders(state.db as ReturnType<typeof drizzle>);
    expect(migrated).toEqual([]);
  });
});



describe("重新拖入/重新扫描时把旧记录认回来", () => {
  it("同名且内容一致 → 认回旧记录（路径迁移、标签保留）", () => {
    // 旧位置（已不存在）
    const oldFolderPath = path.join(root, "旧位置", "截图");
    fs.mkdirSync(path.dirname(oldFolderPath), { recursive: true });
    // 新位置（库外，例如 F:\截图）
    const newPath = path.join(root, "新位置", "截图");
    fs.mkdirSync(newPath, { recursive: true });
    fs.writeFileSync(path.join(newPath, "a.jpg"), Buffer.from("image-a"));
    fs.writeFileSync(path.join(newPath, "b.jpg"), Buffer.from("image-bb"));
    const aStat = fs.statSync(path.join(newPath, "a.jpg"));
    const bStat = fs.statSync(path.join(newPath, "b.jpg"));

    const rootRow = db()
      .insert(folders)
      .values({ path: root, displayName: path.basename(root) })
      .returning({ id: folders.id })
      .get()!;
    const folderRow = db()
      .insert(folders)
      .values({
        path: oldFolderPath,
        displayName: "截图",
        parentId: rootRow.id,
      })
      .returning({ id: folders.id })
      .get()!;
    for (const [name, stat] of [
      ["a.jpg", aStat],
      ["b.jpg", bStat],
    ] as const) {
      db()
        .insert(photos)
        .values({
          path: path.join(oldFolderPath, name),
          folderId: folderRow.id,
          filename: name,
          fileSize: stat.size,
          fileDate: Math.floor(stat.mtimeMs),
          deletedAt: Date.now(),
          deletionBatchId: "__orphan_missing__",
        })
        .run();
    }
    const tagRow = db()
      .insert(tags)
      .values({ name: "测试角色" })
      .returning({ id: tags.id })
      .get()!;
    const firstPhoto = sqlite
      .prepare("select id from photos order by id limit 1")
      .get() as { id: number };
    db()
      .insert(photoTags)
      .values({ photoId: firstPhoto.id, tagId: tagRow.id, userConfirmed: true })
      .run();

    const adopted = adoptRelocatedFolderPath(
      state.db as ReturnType<typeof drizzle>,
      newPath
    );
    expect(adopted).toBe(true);

    const folderNow = db()
      .select({ path: folders.path })
      .from(folders)
      .where(eq(folders.id, folderRow.id))
      .get();
    expect(folderNow?.path).toBe(newPath);
    const rows = sqlite
      .prepare("select path, deleted_at from photos order by path")
      .all() as Array<{ path: string; deleted_at: number | null }>;
    expect(rows.map((row) => row.path)).toEqual([
      path.join(newPath, "a.jpg"),
      path.join(newPath, "b.jpg"),
    ]);
    expect(rows.every((row) => row.deleted_at === null)).toBe(true);
    const tagCount = sqlite
      .prepare("select count(*) n from photo_tags where photo_id = ?")
      .get(firstPhoto.id) as { n: number };
    expect(tagCount.n).toBe(1);
  });

  it("同名但内容不符 → 不认回（按新文件夹处理）", () => {
    const oldFolderPath = path.join(root, "旧位置", "截图");
    fs.mkdirSync(path.dirname(oldFolderPath), { recursive: true });
    const newPath = path.join(root, "新位置", "截图");
    fs.mkdirSync(newPath, { recursive: true });
    fs.writeFileSync(path.join(newPath, "a.jpg"), Buffer.from("different"));

    const rootRow = db()
      .insert(folders)
      .values({ path: root, displayName: path.basename(root) })
      .returning({ id: folders.id })
      .get()!;
    const folderRow = db()
      .insert(folders)
      .values({ path: oldFolderPath, displayName: "截图", parentId: rootRow.id })
      .returning({ id: folders.id })
      .get()!;
    db()
      .insert(photos)
      .values({
        path: path.join(oldFolderPath, "a.jpg"),
        folderId: folderRow.id,
        filename: "a.jpg",
        fileSize: 999_999,
        fileDate: Date.now(),
      })
      .run();

    expect(
      adoptRelocatedFolderPath(state.db as ReturnType<typeof drizzle>, newPath)
    ).toBe(false);
  });
});