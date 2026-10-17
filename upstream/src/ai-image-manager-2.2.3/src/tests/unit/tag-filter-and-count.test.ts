/** @vitest-environment node */
/**
 * AND 模式「计数选型」的**决策逻辑**测试。
 *
 * `buildAndCountConditions` 只在「每一组标签命中的关联行都够窄」时，
 * 才把计数换成「标签侧求交集」的写法；否则返回 null（沿用原来的逐图核对）。
 *
 * 为什么单独测决策而不是端到端测：要触发「某组很宽」需要 5 万行以上关联记录，
 * 端到端跑一次会慢到无法接受；而把阈值当参数传进来，就能用小 fixture 精确覆盖两条分支。
 *
 * 端到端的结果正确性由 `tag-tree-filter-query.test.ts` 覆盖
 * （那份 fixture 的两组都很窄，正好走的就是「标签侧求交集」这条路）。
 */
import { sql } from "drizzle-orm";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { photos, photoTags, tags } from "@/db/schema";
import { buildAndCountConditions } from "@/ipc/photos/handlers/listing";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("electron", () => ({
  app: { getPath: () => ".test-runtime", getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;

  db.insert(tags)
    .values([
      { id: 10, name: "组A", parentId: null },
      { id: 11, name: "A子", parentId: 10 },
      { id: 20, name: "组B", parentId: null },
      { id: 21, name: "B子", parentId: 20 },
    ])
    .run();
  for (let id = 1; id <= 12; id++) {
    db.insert(photos)
      .values({ id, filename: `${id}.jpg`, path: `C:/f/${id}.jpg`, fileDate: id })
      .run();
  }
  // 组 A（10/11）命中 1~6 号图 → 6 行；组 B（20/21）命中 1~2 号图 → 2 行
  db.insert(photoTags)
    .values([
      ...Array.from({ length: 6 }, (_, i) => ({ photoId: i + 1, tagId: 11 })),
      { photoId: 1, tagId: 21 },
      { photoId: 2, tagId: 21 },
    ])
    .run();
});

/** 复刻 fillTagFilterTable 的结果（白盒：直接建表灌数据）。 */
function fillTempTable(groups: number[][]): void {
  db.run(
    sql.raw(`CREATE TEMP TABLE IF NOT EXISTS _aim_tag_filter (
      group_id INTEGER NOT NULL, tag_id INTEGER NOT NULL,
      PRIMARY KEY (group_id, tag_id)) WITHOUT ROWID`)
  );
  db.run(sql.raw("DELETE FROM _aim_tag_filter"));
  const rows = groups.flatMap((ids, groupId) =>
    ids.map((tagId) => ({ groupId, tagId }))
  );
  const values = sql.join(
    rows.map((row) => sql`(${row.groupId}, ${row.tagId})`),
    sql`, `
  );
  db.run(
    sql`INSERT OR IGNORE INTO _aim_tag_filter (group_id, tag_id) VALUES ${values}`
  );
}

describe("AND 计数选型：决策逻辑", () => {
  it("两组都窄 → 换成标签侧求交集（返回条件）", () => {
    fillTempTable([[10, 11], [20, 21]]);
    // 阈值放宽到 100 → 两组都算「窄」
    const conditions = buildAndCountConditions(2, 100);
    expect(conditions).not.toBeNull();
    expect(conditions).toHaveLength(1);
  });

  it("有一组很宽 → 返回 null（沿用原写法）", () => {
    fillTempTable([[10, 11], [20, 21]]);
    // 阈值设为 3 → 组 A（6 行）属于「宽」
    expect(buildAndCountConditions(2, 3)).toBeNull();
  });

  it("只有一组时不改动（单个标签不需要交集）", () => {
    fillTempTable([[10, 11]]);
    expect(buildAndCountConditions(1, 100)).toBeNull();
  });

  it("三组都窄 → 仍然返回单个交集条件", () => {
    fillTempTable([[10, 11], [20, 21], [10]]);
    const conditions = buildAndCountConditions(3, 100);
    expect(conditions).not.toBeNull();
    expect(conditions).toHaveLength(1);
  });
});
