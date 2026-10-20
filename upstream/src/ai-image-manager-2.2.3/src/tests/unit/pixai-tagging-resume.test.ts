/** @vitest-environment node */
/**
 * 自用（2026-10-20 · 会话#10）：**打标断点续跑按数据判定**的回归测试。
 *
 * 用户报的现象：「退出软件重新打标的时候进度没有继承」——
 * 实测根因是进度/断点都只看 `pixai.tagger.cursor`（"处理到哪个 id"的高水位），
 * 而导入时的自动打标走 `photoIds` 分支、**不推进游标**：
 * 于是库里已经有两万多张有标签，游标还停在很低的数字 →
 * 下次点「生成 AI 标签」既从很低的位置重新扫，界面也显示成 0/全库。
 *
 * 这里钉住修好后的口径：
 *   ① `done` = **真的已经有自动标签的张数**（跟游标无关）
 *   ② `total` = 全库未删除张数
 *   ③ `remaining` = 还没有任何自动标签的张数（这一轮真正要处理的数量）
 *   ④ 只有"手动标签"的照片**不算**打完标（它还需要自动标签）
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/app", getPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("@/db", () => ({
  getDatabase: () => {
    if (!state.db) {
      throw new Error("test database is not initialized");
    }
    return state.db;
  },
}));

import { folders, photoTags, photos, tags } from "@/db/schema";
import { getSetting } from "@/services/settings-manager";
import {
  getPixaiTaggingBaseline,
  getPixaiTaggingStatus,
  resetPixaiTaggingProgress,
} from "@/services/ai/pixai-tagger";

function getDb() {
  if (!state.db) {
    throw new Error("test database is not initialized");
  }
  return state.db;
}

function seedLibrary() {
  const db = getDb();
  db.insert(folders)
    .values({ displayName: "Fixtures", path: "C:/fixtures", photoCount: 6 })
    .run();
  const folder = db.select().from(folders).get();
  if (!folder) {
    throw new Error("fixture folder was not created");
  }
  db.insert(photos)
    .values(
      [1, 2, 3, 4, 5, 6].map((id) => ({
        id,
        path: `C:/fixtures/${id}.jpg`,
        filename: `${id}.jpg`,
        folderId: folder.id,
        width: 100,
        height: 100,
        // 6 号是软删除的：它不能被算进"全库"
        deletedAt: id === 6 ? 1_000 : null,
      }))
    )
    .run();
  db.insert(tags)
    .values([
      { id: 1, name: "1girl" },
      { id: 2, name: "solo" },
    ])
    .run();
  // 1 号已经有自动标签（= 真的打完标了）
  db.insert(photoTags)
    .values({
      photoId: 1,
      tagId: 1,
      confidence: 0.9,
      origin: "auto",
      userConfirmed: false,
    })
    .run();
  // 2 号只有手动标签：它还需要自动标签，不能算"已完成"
  db.insert(photoTags)
    .values({
      photoId: 2,
      tagId: 2,
      confidence: null,
      origin: "manual",
      userConfirmed: true,
    })
    .run();
  // 6 号是软删除的，即使有自动标签也不能算进"已完成"（否则进度会 >100%）
  db.insert(photoTags)
    .values({
      photoId: 6,
      tagId: 1,
      confidence: 0.9,
      origin: "auto",
      userConfirmed: false,
    })
    .run();
}

describe("PixAI 打标断点续跑（按数据判定）", () => {
  beforeEach(() => {
    const sqlite = new Database(":memory:");
    state.db = drizzle(sqlite);
    migrate(state.db, { migrationsFolder: "drizzle" });
    seedLibrary();
  });

  it("done 按已有自动标签计数，不看游标", () => {
    // 游标压根没写过（= 0），但库里已经有一张打好标了 —— 旧口径会算成 0/5
    expect(getPixaiTaggingBaseline()).toEqual({ done: 1, total: 5 });
  });

  it("remaining = 还没有任何自动标签的张数（手动标签的照片也算没打）", () => {
    // 2/3/4/5 号都还没有自动标签；6 号软删不算
    expect(getPixaiTaggingStatus().remaining).toBe(4);
  });

  it("又打下几张之后，done 跟着涨、remaining 跟着降", () => {
    getDb()
      .insert(photoTags)
      .values(
        [3, 4].map((photoId) => ({
          photoId,
          tagId: 1,
          confidence: 0.8,
          origin: "auto" as const,
          userConfirmed: false,
        }))
      )
      .run();
    expect(getPixaiTaggingBaseline()).toEqual({ done: 3, total: 5 });
    expect(getPixaiTaggingStatus().remaining).toBe(2);
  });

  it("「全部重打」：resetPixaiTaggingProgress 会立一个标记（光清游标已经不够了）", () => {
    resetPixaiTaggingProgress();
    expect(getSetting("pixai.tagger.cursor")).toBe("0");
    // 没有这个标记，按数据判定的续跑会跳过所有已有标签的图 → 等于没重打
    expect(getSetting("pixai.tagger.forceFullRescan")).toBe("1");
  });
});
