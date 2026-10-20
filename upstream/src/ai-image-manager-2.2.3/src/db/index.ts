import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { app } from "electron";
import { getDataPath } from "@/utils/data-path";
import { APP_DISPLAY_NAME } from "@/config/private-build";
import { isSafePath } from "@/utils/path-security";
import {
  advancedExifData,
  albumPhotos,
  albums,
  appSettings,
  cloudConfigs,
  cloudSyncLog,
  cullActionLogs,
  cullSessionPhotos,
  cullSessions,
  duplicateCleanupEvents,
  duplicateCleanupPlanItems,
  duplicateCleanupPlans,
  duplicateDetectionRuns,
  duplicatePhotoFingerprints,
  duplicateReviewEvents,
  duplicateReviewGroups,
  duplicateReviewMembers,
  duplicateRunGroups,
  duplicateRunMembers,
  duplicateRunPairs,
  exifData,
  faceIdentities,
  faceIdentityExclusions,
  faceIdentityMembers,
  faceReviewDecisions,
  faceVectors,
  folders,
  photoSequenceExclusions,
  photoSequenceMembers,
  photoSequenceSuggestions,
  photoSequences,
  photos,
  photoTags,
  photoViewStats,
  pluginAssets,
  pluginInstallations,
  pluginPreferences,
  tags,
} from "./schema";

const schema = {
  advancedExifData,
  albumPhotos,
  albums,
  appSettings,
  cloudConfigs,
  cloudSyncLog,
  cullActionLogs,
  cullSessionPhotos,
  cullSessions,
  duplicatePhotoFingerprints,
  duplicateCleanupEvents,
  duplicateCleanupPlanItems,
  duplicateCleanupPlans,
  duplicateDetectionRuns,
  duplicateReviewEvents,
  duplicateReviewGroups,
  duplicateReviewMembers,
  duplicateRunGroups,
  duplicateRunMembers,
  duplicateRunPairs,
  exifData,
  faceIdentities,
  faceIdentityExclusions,
  faceIdentityMembers,
  faceReviewDecisions,
  faceVectors,
  folders,
  photoSequenceExclusions,
  photoSequenceMembers,
  photoSequenceSuggestions,
  photoSequences,
  photos,
  photoTags,
  photoViewStats,
  pluginAssets,
  pluginInstallations,
  pluginPreferences,
  tags,
};

let dbInstance: ReturnType<typeof drizzle> | null = null;
let sqliteConnection: Database.Database | null = null;

/*
 * ── 自用（2026-10-16）：数据库语句记录器（排查「界面未响应」用）───────────
 *
 * 背景：出现「窗口未响应 + 一个核心满载 + 持续读盘」时，日志会**完全停写** ✗，
 * 事后完全看不出卡在哪条语句上（实测两次，只能强杀进程 ✓）。
 *
 * 做法：把每条语句**在执行之前**就写进文件 ✓ —— 所以卡死的那条语句一定能被记下来；
 * 中途被强杀也不会丢（对比之下，等它跑完再记就永远没机会 ✗）。
 *
 * 打开方式（不需要改代码、也不影响正常使用）：
 *   · 环境变量 `AIM_TRACE_QUERIES=1`，或
 *   · 在软件配置目录的 `logs\` 下放一个空文件 `query-trace.on` ✓
 * 记录位置：软件配置目录的 `logs\query-trace.log` ✓
 *
 * 成本：只有开启时才写盘；每行还会带 3 层调用位置，方便直接定位到代码 ✓。
 * 关掉：删掉 `query-trace.on` 文件即可（下次启动生效）✓。
 */
const QUERY_TRACE_ENV = "AIM_TRACE_QUERIES";
const QUERY_TRACE_MARKER = "query-trace.on";
const QUERY_TRACE_FILE = "query-trace.log";
/** 超过这个耗时就额外记一条 SLOW（方便事后只看慢的）✓。 */
const QUERY_TRACE_SLOW_MS = 1000;
/** 记录文件体积上限：到了就停止记录，免得把磁盘写爆 ✗。 */
const QUERY_TRACE_MAX_BYTES = 100 * 1024 * 1024;

let queryTraceFd: number | null | undefined;
let queryTraceBytes = 0;

function getQueryTraceFd(): number | null {
  if (queryTraceFd !== undefined) {
    return queryTraceFd;
  }
  queryTraceFd = null;
  try {
    const enabled =
      process.env[QUERY_TRACE_ENV] === "1" ||
      fs.existsSync(path.join(app.getPath("userData"), "logs", QUERY_TRACE_MARKER));
    if (!enabled) {
      return queryTraceFd;
    }
    const logsDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const filePath = path.join(logsDir, QUERY_TRACE_FILE);
    queryTraceFd = fs.openSync(filePath, "a");
    fs.writeSync(
      queryTraceFd,
      `\n===== 语句记录开始 ${new Date().toISOString()} pid=${process.pid} =====\n`
    );
  } catch {
    queryTraceFd = null;
  }
  return queryTraceFd;
}

/** 语句开始执行前的调用位置（3 层），用于定位到代码文件。 */
function traceCaller(): string {
  try {
    const stack = new Error().stack ?? "";
    return stack
      .split("\n")
      .slice(2, 5)
      .map((line) => line.trim().replace(/^at\s+/, ""))
      .join(" ← ");
  } catch {
    return "";
  }
}

function traceStatementStart(sql: string): number {
  const startedAt = Date.now();
  const fd = getQueryTraceFd();
  if (fd === null) {
    return startedAt;
  }
  try {
    if (queryTraceBytes >= QUERY_TRACE_MAX_BYTES) {
      fs.writeSync(
        fd,
        `${new Date().toISOString()} | 记录已达上限，停止记录\n`
      );
      fs.closeSync(fd);
      queryTraceFd = null;
      return startedAt;
    }
    const oneLine = sql.replace(/\s+/g, " ").trim().slice(0, 2000);
    const text = `${new Date(startedAt).toISOString()} | 开始 | ${oneLine}\n         ↳ ${traceCaller()}\n`;
    fs.writeSync(fd, text);
    queryTraceBytes += text.length;
  } catch {
    /* 记录失败不影响业务 */
  }
  return startedAt;
}

function traceStatementEnd(
  sql: string,
  startedAt: number,
  error?: unknown
): void {
  const fd = getQueryTraceFd();
  if (fd === null) {
    return;
  }
  const elapsed = Date.now() - startedAt;
  if (error === undefined && elapsed < QUERY_TRACE_SLOW_MS) {
    return;
  }
  try {
    const oneLine = sql.replace(/\s+/g, " ").trim().slice(0, 400);
    fs.writeSync(
      fd,
      `${new Date().toISOString()} | ${error === undefined ? `慢 ${elapsed}ms` : `出错 ${elapsed}ms`} | ${oneLine}\n`
    );
  } catch {
    /* 记录失败不影响业务 */
  }
}

/** 给语句挂上计时与记录（失败就原样返回，绝不影响业务）✓。 */
function wrapStatementForTrace<T>(statement: T, sql: string): T {
  try {
    const target = statement as unknown as Record<string, unknown>;
    for (const method of ["all", "get", "run"] as const) {
      const original = target[method];
      if (typeof original !== "function") {
        continue;
      }
      const fn = original as (...args: unknown[]) => unknown;
      target[method] = function traced(this: unknown, ...args: unknown[]) {
        const startedAt = traceStatementStart(sql);
        try {
          const result = fn.apply(this, args);
          traceStatementEnd(sql, startedAt);
          return result;
        } catch (error) {
          traceStatementEnd(sql, startedAt, error);
          throw error;
        }
      };
    }
  } catch {
    /* 挂不上就算了，不能因为排查工具把程序弄坏 */
  }
  return statement;
}

/** 给连接装上记录器（prepare / exec / pragma 都覆盖）✓。 */
function instrumentSqliteForTrace(sqlite: Database.Database): void {
  try {
    if (getQueryTraceFd() === null) {
      return;
    }
    const originalPrepare = sqlite.prepare.bind(sqlite);
    (sqlite as unknown as Record<string, unknown>).prepare = (
      sql: string,
      ...rest: unknown[]
    ) =>
      wrapStatementForTrace(
        (originalPrepare as (...a: unknown[]) => unknown)(sql, ...rest),
        sql
      );

    const originalExec = sqlite.exec.bind(sqlite);
    (sqlite as unknown as Record<string, unknown>).exec = (...args: unknown[]) => {
      const sql = String(args[0] ?? "");
      const startedAt = traceStatementStart(sql);
      try {
        const result = (originalExec as (...a: unknown[]) => unknown)(...args);
        traceStatementEnd(sql, startedAt);
        return result;
      } catch (error) {
        traceStatementEnd(sql, startedAt, error);
        throw error;
      }
    };
  } catch {
    /* 排查工具装不上不影响业务 */
  }
}

interface SQLiteTableColumn {
  name: string;
}

export interface PhotoTagProvenanceRepairResult {
  addedOrigin: boolean;
  addedUserConfirmed: boolean;
}

/**
 * Repair databases whose migration journal says the provenance migration ran
 * even though a timestamp collision caused SQLite to skip its SQL.
 */
export function repairPhotoTagProvenanceSchema(
  sqlite: Database.Database
): PhotoTagProvenanceRepairResult {
  const columns = sqlite
    .prepare("PRAGMA table_info('photo_tags')")
    .all() as SQLiteTableColumn[];
  if (columns.length === 0) {
    return { addedOrigin: false, addedUserConfirmed: false };
  }

  const names = new Set(columns.map(({ name }) => name));
  const addedOrigin = !names.has("origin");
  const addedUserConfirmed = !names.has("user_confirmed");

  if (addedOrigin || addedUserConfirmed) {
    sqlite.transaction(() => {
      if (addedOrigin) {
        sqlite.exec(
          "ALTER TABLE photo_tags ADD origin text DEFAULT 'manual' NOT NULL"
        );
        sqlite.exec(
          `UPDATE photo_tags
           SET origin = CASE
             WHEN confidence IS NULL THEN 'manual'
             ELSE 'auto'
           END`
        );
      }
      if (addedUserConfirmed) {
        sqlite.exec(
          "ALTER TABLE photo_tags ADD user_confirmed integer DEFAULT 0 NOT NULL"
        );
        sqlite.exec(
          `UPDATE photo_tags
           SET user_confirmed = CASE
             WHEN confidence IS NULL THEN 1
             ELSE 0
           END`
        );
      }
    })();
  }

  return { addedOrigin, addedUserConfirmed };
}

export function getDbPath(): string {
  const dataPath = getDataPath();
  const dbDir = path.join(dataPath, "data");
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return path.join(dbDir, "ai-image-manager.db");
}

function getMigrationsFolder(): string {
  // 定义允许的迁移文件路径白名单
  const allowedRoots = [app.getAppPath(), process.cwd(), process.resourcesPath];

  // In development, migrations are in the project root
  const candidates = [
    path.join(app.getAppPath(), "drizzle"),
    path.join(process.cwd(), "drizzle"),
    path.join(app.getAppPath(), "..", "..", "drizzle"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && isSafePath(candidate, allowedRoots)) {
      return candidate;
    }
  }
  // Fallback for packaged app
  const prodPath = path.join(process.resourcesPath, "drizzle");
  if (fs.existsSync(prodPath) && isSafePath(prodPath, allowedRoots)) {
    return prodPath;
  }
  throw new Error("Migrations folder not found");
}

export function initDatabase(): ReturnType<typeof drizzle> {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = getDbPath();
  console.log(`[DB] Initializing database at: ${dbPath}`);

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqliteConnection = sqlite;

  /* 自用（2026-10-16）：只有在开启记录器时才挂上（见文件上方说明）✓。 */
  instrumentSqliteForTrace(sqlite);

  // Register custom SQLite functions
  sqlite.function(
    "closest_color_dist",
    (r: number, g: number, b: number, colorsJson: string | null) => {
      if (!colorsJson) {
        return Number.MAX_VALUE;
      }
      try {
        const colors = JSON.parse(colorsJson);
        let minDist = Number.POSITIVE_INFINITY;
        for (const c of colors) {
          const dr = c.r - r;
          const dg = c.g - g;
          const db = c.b - b;
          const dist = dr * dr + dg * dg + db * db;
          if (dist < minDist) {
            minDist = dist;
          }
        }
        return minDist;
      } catch {
        return Number.MAX_VALUE;
      }
    }
  );

  dbInstance = drizzle(sqlite, { schema });

  // Auto-run migrations on startup
  const migrationsFolder = getMigrationsFolder();
  try {
    console.log(`[DB] Running migrations from: ${migrationsFolder}`);
    migrate(dbInstance, { migrationsFolder });
    console.log("[DB] Migrations complete");
    const provenanceRepair = repairPhotoTagProvenanceSchema(sqlite);
    if (provenanceRepair.addedOrigin || provenanceRepair.addedUserConfirmed) {
      console.warn(
        `[DB] Repaired photo tag provenance columns: origin=${provenanceRepair.addedOrigin} userConfirmed=${provenanceRepair.addedUserConfirmed}`
      );
    }
  } catch (err) {
    closeDatabase();
    throw err;
  }

  // Repair self-referencing tags (can happen if a category parent name matches a candidate tag)
  const selfRef = sqlite
    .prepare("UPDATE tags SET parent_id = NULL WHERE id = parent_id")
    .run();
  if (selfRef.changes > 0) {
    console.log(`[DB] Repaired ${selfRef.changes} self-referencing tag(s)`);
  }

  // Repair RAW format: legacy data stored as "jpeg" from embedded preview
  const rawFormats = [
    "cr2",
    "cr3",
    "nef",
    "nrw",
    "arw",
    "srf",
    "sr2",
    "dng",
    "orf",
    "rw2",
    "raf",
    "pef",
    "rwl",
    "3fr",
    "raw",
  ];
  let rawFixed = 0;
  for (const rf of rawFormats) {
    const result = sqlite
      .prepare(
        "UPDATE photos SET format = ? WHERE LOWER(filename) LIKE ? AND format != ?"
      )
      .run(rf, `%.${rf}`, rf);
    rawFixed += result.changes;
  }
  if (rawFixed > 0) {
    console.log(`[DB] Repaired ${rawFixed} RAW photo(s) format`);
  }

  // Heal stale thumbnail_path values. The thumbnailer stores absolute paths
  // (e.g. "C:/.../AI Image Manager/thumbnails/<hash>.webp") in the DB, so a
  // data-path migration leaves every row pointing at the old location. The
  // local-media protocol then 403s those URLs and the gallery shows
  // placeholders. Rewrite mismatched rows to the current thumbnails dir,
  // preserving each row's hashed filename.
  try {
    const currentThumbDir = path.join(getDataPath(), "thumbnails");
    const norm = currentThumbDir.replace(/\\/g, "/").toLowerCase();
    const rows = sqlite
      .prepare(
        "SELECT id, thumbnail_path AS p FROM photos WHERE thumbnail_path IS NOT NULL AND thumbnail_path != ''"
      )
      .all() as { id: number; p: string }[];
    const update = sqlite.prepare(
      "UPDATE photos SET thumbnail_path = ? WHERE id = ?"
    );
    const healMany = sqlite.transaction(
      (items: { id: number; p: string }[]) => {
        let healed = 0;
        for (const row of items) {
          const rowNorm = row.p.replace(/\\/g, "/").toLowerCase();
          if (rowNorm.startsWith(`${norm}/`)) {
            continue;
          }
          const filename = path.basename(row.p);
          const fixed = path.join(currentThumbDir, filename);
          update.run(fixed, row.id);
          healed++;
        }
        return healed;
      }
    );
    const healedCount = healMany(rows);
    if (healedCount > 0) {
      console.log(
        `[DB] Healed ${healedCount} stale thumbnail path(s) → ${currentThumbDir}`
      );
    }
  } catch (err) {
    console.warn(
      "[DB] Thumbnail path heal skipped:",
      (err as Error)?.message ?? err
    );
  }

  return dbInstance;
}

export function getDatabase(): ReturnType<typeof drizzle> {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

function dbDiag(msg: string) {
  try {
    const dir = path.join(
      process.env.APPDATA || "/tmp",
      APP_DISPLAY_NAME,
      "logs"
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "migrate.log"),
      `${new Date().toISOString()} ${msg}\n`,
      { flag: "a" }
    );
  } catch {
    /* best-effort */
  }
}

export function closeDatabase(): void {
  const connection = sqliteConnection;
  if (!connection) {
    dbDiag("closeDatabase: sqliteConnection already null, skip");
    console.warn("[DB] Connection was already null/undefined, skipping close");
    dbInstance = null;
    return;
  }

  let closed = false;
  try {
    // A busy/failing checkpoint must not prevent close(). close() itself also
    // flushes committed WAL pages, and retaining the reference until it has
    // actually succeeded lets a later shutdown retry a failed close.
    try {
      const checkpoint = connection.pragma(
        "wal_checkpoint(TRUNCATE)"
      ) as Array<{
        busy?: number;
      }>;
      if (checkpoint[0]?.busy) {
        dbDiag("closeDatabase: wal_checkpoint busy");
        console.warn("[DB] WAL checkpoint was busy; continuing with close()");
      } else {
        dbDiag("closeDatabase: wal_checkpoint OK");
      }
    } catch (err) {
      dbDiag(
        `closeDatabase: wal_checkpoint ERROR ${(err as Error)?.message ?? err}`
      );
      console.error(
        "[DB] WAL checkpoint failed; continuing with close():",
        (err as Error)?.message ?? err
      );
    }

    connection.close();
    closed = true;
    dbDiag("closeDatabase: OK");
    console.log("[DB] Connection closed gracefully");
  } catch (err) {
    dbDiag(`closeDatabase: close ERROR ${(err as Error)?.message ?? err}`);
    console.error(
      "[DB] Non-fatal error during close:",
      (err as Error)?.message ?? err
    );
  } finally {
    if (closed) {
      sqliteConnection = null;
      dbInstance = null;
    }
  }
}
