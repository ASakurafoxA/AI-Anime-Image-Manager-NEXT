/** @vitest-environment node */
/**
 * 规模集成测试：2 万张真实数据库里的指纹检索。
 *
 * 为什么要有这个测试：查重以前「永远跑不完」（原实现逐张调用
 * `bkTree.query(phash, Math.max(threshold, 16))`，77k 张实测 20 分钟未完成）。
 * 小夹具（3 张图）测不出这类问题，所以这里用 2 万行真实 SQLite 跑一遍
 * 真正的调用路径：stats.ts → collectLibraryPhashPairs → getPhashIndex → phash-match。
 */
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
}));

vi.mock("@/db", () => ({
  getDatabase: () => {
    if (!state.db) {
      throw new Error("test database is not initialized");
    }
    return state.db;
  },
}));

import { folders, photos } from "@/db/schema";
import {
  collectLibraryPhashPairs,
  invalidatePhashIndex,
  queryPhashIndex,
} from "@/services/phash-index";

const PHOTO_COUNT = 20_000;
const CLUSTER_COUNT = 500;
const CLUSTER_SIZE = 3;

let sqlite: Database.Database;

/** 造一个 16 位十六进制指纹；counter 保证随机组之间彼此远离。 */
function randomPhash(counter: number): string {
  return crypto
    .createHash("sha1")
    .update(`random-${counter}`)
    .digest("hex")
    .slice(0, 16);
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  state.db = drizzle(sqlite);
  migrate(state.db, { migrationsFolder: "drizzle" });

  const db = state.db;
  db.insert(folders)
    .values({ displayName: "Scale", path: "F:\\scale-fixture", photoCount: PHOTO_COUNT })
    .run();
  const folder = db.select().from(folders).get();
  if (!folder) {
    throw new Error("fixture folder was not created");
  }

  // 前 CLUSTER_COUNT*CLUSTER_SIZE 张：每 CLUSTER_SIZE 张共用一个指纹（植入的重复）
  // 其余：各自独立指纹
  const planted: Array<{ ids: number[]; phash: string }> = [];
  const rows: Array<{
    createdAt: number;
    fileDate: number;
    fileSize: number;
    filename: string;
    folderId: number;
    height: number;
    id: number;
    path: string;
    phash: string;
    width: number;
  }> = [];

  let id = 1;
  for (let c = 0; c < CLUSTER_COUNT; c++) {
    const phash = crypto
      .createHash("sha1")
      .update(`cluster-${c}`)
      .digest("hex")
      .slice(0, 16);
    const ids: number[] = [];
    for (let m = 0; m < CLUSTER_SIZE; m++) {
      ids.push(id);
      rows.push({
        createdAt: 1,
        fileDate: 1,
        fileSize: 100,
        filename: `c${c}-${m}.jpg`,
        folderId: folder.id,
        height: 1000,
        id,
        path: `F:\\scale-fixture\\c${c}-${m}.jpg`,
        phash,
        width: 1000,
      });
      id++;
    }
    planted.push({ ids, phash });
  }
  while (id <= PHOTO_COUNT) {
    rows.push({
      createdAt: 1,
      fileDate: 1,
      fileSize: 100,
      filename: `r${id}.jpg`,
      folderId: folder.id,
      height: 1000,
      id,
      path: `F:\\scale-fixture\\r${id}.jpg`,
      phash: randomPhash(id),
      width: 1000,
    });
    id++;
  }

  // 分批插入（一次性 2 万行会超过 SQLite 的参数上限）
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    db.insert(photos)
      .values(rows.slice(i, i + CHUNK))
      .run();
  }
  invalidatePhashIndex();
  plantedRows = planted;
});

let plantedRows: Array<{ ids: number[]; phash: string }> = [];

afterEach(() => {
  state.db = null;
  sqlite?.close();
});

describe("pHash engine at library scale", () => {
  it(
    "finds every planted duplicate pair on 20k photos, quickly",
    async () => {
      const started = Date.now();
      const pairs = collectLibraryPhashPairs(4);
      const elapsed = Date.now() - started;

      const found = new Set(pairs.map((p) => `${p.photoAId}_${p.photoBId}`));
      let expected = 0;
      for (const cluster of plantedRows) {
        for (let a = 0; a < cluster.ids.length; a++) {
          for (let b = a + 1; b < cluster.ids.length; b++) {
            expected++;
            const [lo, hi] =
              cluster.ids[a] < cluster.ids[b]
                ? [cluster.ids[a], cluster.ids[b]]
                : [cluster.ids[b], cluster.ids[a]];
            expect(found.has(`${lo}_${hi}`)).toBe(true);
          }
        }
      }

      // 随机指纹之间几乎不该出现 <=4 的巧合；留一点容差
      expect(pairs.length).toBeGreaterThanOrEqual(expected);
      expect(pairs.length).toBeLessThan(expected + 200);

      // 关键回归：旧实现在这个规模上根本跑不完（分钟级甚至更久）
      expect(elapsed).toBeLessThan(60_000);
    },
    120_000
  );

  it(
    "single-photo lookup returns the whole cluster",
    async () => {
      const target = plantedRows[7];
      const hits = queryPhashIndex(target.phash, 4);
      const ids = hits.map((h) => h.photoId).sort((a, b) => a - b);
      expect(ids).toEqual([...target.ids].sort((a, b) => a - b));
      expect(hits.every((h) => h.distance === 0)).toBe(true);
    },
    120_000
  );

  it("rebuilds the index when photos change (no stale cache)", async () => {
    expect(collectLibraryPhashPairs(4).length).toBeGreaterThan(0);

    // 新增一张与已有图完全相同的指纹 → 必须被发现（判据含张数变化）
    const db = state.db;
    if (!db) {
      throw new Error("no db");
    }
    const target = plantedRows[0];
    db.insert(photos)
      .values({
        createdAt: 1,
        fileDate: 1,
        fileSize: 100,
        filename: "late.jpg",
        folderId: 1,
        height: 1000,
        id: PHOTO_COUNT + 1,
        path: "F:\\scale-fixture\\late.jpg",
        phash: target.phash,
        width: 1000,
      })
      .run();

    const hits = queryPhashIndex(target.phash, 4);
    expect(hits.map((h) => h.photoId)).toContain(PHOTO_COUNT + 1);
  });

  it("survives an empty library", () => {
    sqlite.exec("DELETE FROM photos");
    invalidatePhashIndex();
    expect(collectLibraryPhashPairs(4)).toEqual([]);
    expect(queryPhashIndex("0000000000000000", 4)).toEqual([]);
  });
});

// 让 drizzle 的类型被引用到（避免 lint 认为 sql 未使用）
void sql;
