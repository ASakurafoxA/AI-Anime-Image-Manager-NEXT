/**
 * 向量库维护 / 索引构建 worker（自用，2026-10）。
 *
 * 为什么要有它：`optimize()` 与 `createIndex()` 都是**不可中断的同步原生调用** ✗
 * （实测 createIndex 在 2.2 万行要 30 秒、7.7 万行要 1~2 分钟；
 *   optimize/compaction 在 1.9 万个碎片的库上要数分钟），
 * 在主进程里跑会把界面卡到「未响应」（Windows 甚至判定 AppHang 并关掉应用 ✗）。
 *
 * 放进独立进程后：主进程只是**等子进程**（事件循环自由 ✓），界面全程流畅 ✓。
 *
 * ── 2026-10-16 修正（重要）────────────────────────────────────────────
 * 旧版这里调用的是 `table.compactFiles()` / `table.cleanupOldVersions()` ✗ ——
 * **这两个方法在 `@lancedb/lancedb` 0.18 里根本不存在** ✗，
 * 代码里又有 `if (typeof … === "function")` 守卫 ✓ → 一直**静默空转**，
 * 碎片/旧版本从未清理过 ✗（实测 `vectors` 目录涨到 19,409 个文件 ✗）。
 *
 * 正确的 API 是 `table.optimize(options)` ✓：
 *   await table.optimize({ cleanupOlderThan: new Date(Date.now() - 60_000), deleteUnverified: true })
 *
 * ── cleanupOlderThan 到底是什么？（2026-10-16 实测，别再猜 ✓）──────────
 * JS 封装会把它换算成**"年龄"**再交给原生层（`dist/table.js`）：
 *     cleanupOlderThanMs = Date.now() - cleanupOlderThan.getTime()
 * 原生层语义 ="清掉比 (现在 − 年龄) 更早的版本"。实测（40 批写入 = 41 个版本）：
 *   · 不传参数（默认 7 天）        → 清 0 个，文件 122 → 127 ✗
 *   · cleanupOlderThan = new Date(0)（= 年龄 56 年）→ **清 0 个** ✗（19,409 个文件就是这么堆起来的）
 *   · cleanupOlderThan = 1 秒前     → 清 0 个（因为版本都还不到 1 秒）
 *   · cleanupOlderThan = 现在/1ms 前 → 清 42 个，文件 122 → **3** ✓，版本 41 → 1 ✓
 * 所以：**要清干净就得传"刚刚"**。这里用 `Date.now() - 60_000`（1 分钟前）：
 *   · 年龄恒为正（不会踩到"年龄=0"那个不稳的边界）✓
 *   · 比 1 分钟更早的版本全清 → 碎片真正落盘释放 ✓
 *   · 仍留 1 分钟的时间旅行窗口，避免打断正在进行的读 ✓
 *
 * deleteUnverified = 清掉没有被清单引用的残留数据文件 ✓。
 *
 * 协议：
 *   → { type: "run", vectorsPath, tasks: { optimize?, compact?, cleanup?, index?, numPartitions?, tables?, cleanupOlderThanMs? } }
 *   ← { type: "result", ok, result: {
 *         optimizeMs, indexMs, rows, skipped,
 *         filesBefore, filesAfter,
 *         tables: [{ name, rows, filesBefore, filesAfter, optimizeMs,
 *                    fragmentsRemoved, filesRemoved, filesAdded,
 *                    oldVersionsRemoved, bytesRemoved, error }]
 *       }, durationMs }
 *   → { type: "shutdown" }
 *
 * 命令行（冒烟/手工维护用）：
 *   node scripts/vector-maintenance-worker.mjs --vectors=<路径> [--optimize] [--index] [--tables=a,b]
 */

import fs from "node:fs";
import path from "node:path";

/** 默认维护这几张表：存在就清、不存在就跳过（不报错）。 */
const DEFAULT_TABLES = [
  "photo_embeddings",
  "pixai_embeddings",
  "wd14_embeddings",
  "color_embeddings",
];

const INDEX_TABLES = ["photo_embeddings", "pixai_embeddings"];

/**
 * 默认清理"1 分钟以前"的旧版本（详见文件头实测说明）。
 * 传 `tasks.cleanupOlderThanMs` 可覆盖（0 = 只保留最新版本，实测有边界不稳，不建议）。
 */
const DEFAULT_CLEANUP_OLDER_THAN_MS = 60_000;

function nowMs() {
  return Date.now();
}

/** 数一个表目录里有多少个文件（碎片治理的效果要看得见 ✓）。 */
async function countFiles(dir) {
  let count = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        count += 1;
        try {
          bytes += (await fs.promises.stat(full)).size;
        } catch {
          /* 读不到大小不影响计数 */
        }
      }
    }
  }
  return { count, bytes };
}

function tableDir(vectorsPath, name) {
  return path.join(vectorsPath, `${name}.lance`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 清一张表：compaction（合并小文件）+ prune（清旧版本）+ 清未引用文件。 */
async function optimizeTable(db, vectorsPath, name, cleanupOlderThanMs) {
  const dir = tableDir(vectorsPath, name);
  const entry = {
    name,
    rows: null,
    filesBefore: null,
    filesAfter: null,
    bytesBefore: null,
    bytesAfter: null,
    versionsBefore: null,
    versionsAfter: null,
    optimizeMs: 0,
    fragmentsRemoved: 0,
    filesRemoved: 0,
    filesAdded: 0,
    oldVersionsRemoved: 0,
    bytesRemoved: 0,
    error: null,
  };

  const before = await countFiles(dir);
  entry.filesBefore = before.count;
  entry.bytesBefore = before.bytes;

  const startedAt = nowMs();
  try {
    const table = await db.openTable(name);
    entry.rows = await table.countRows();
    entry.versionsBefore = (await table.listVersions()).length;
    if (typeof table.optimize !== "function") {
      // 这种情况正是"静默空转"的根因，必须大声报出来 ✗ → 记 error，不吞掉。
      entry.error = "table.optimize 不存在（LanceDB 版本不匹配）";
    } else {
      const stats = await table.optimize({
        cleanupOlderThan: new Date(Date.now() - cleanupOlderThanMs),
        deleteUnverified: true,
      });
      entry.fragmentsRemoved = stats?.compaction?.fragmentsRemoved ?? 0;
      entry.filesRemoved = stats?.compaction?.filesRemoved ?? 0;
      entry.filesAdded = stats?.compaction?.filesAdded ?? 0;
      entry.oldVersionsRemoved = stats?.prune?.oldVersionsRemoved ?? 0;
      entry.bytesRemoved = stats?.prune?.bytesRemoved ?? 0;
      entry.versionsAfter = (await table.listVersions()).length;
    }
  } catch (error) {
    entry.error = errorMessage(error);
  }
  entry.optimizeMs = nowMs() - startedAt;

  const after = await countFiles(dir);
  entry.filesAfter = after.count;
  entry.bytesAfter = after.bytes;
  return entry;
}

async function buildIndex(db, name, numPartitions, lancedb, result) {
  const startedAt = nowMs();
  try {
    const table = await db.openTable(name);
    const rows = await table.countRows();
    if (name === "photo_embeddings") {
      result.rows = rows;
    }
    if (rows <= 0) {
      return;
    }
    const { Index } = lancedb;
    if (!Index || typeof Index.ivfFlat !== "function") {
      result.skipped.push("index-unavailable");
      return;
    }
    const partitions = Math.max(
      2,
      Math.floor(Math.sqrt(Number(numPartitions ?? rows)))
    );
    /*
     * 自用（2026-10-16，**修"排序不准/该有的图没被取到"**）：
     * 原来建的是 `ivfPq`（乘积量化 ✗）—— 它把向量**压缩存储**，
     * 距离是近似值 → 分数会失真、真正的近邻可能被漏掉 ✗
     * （用户对比同类工具 MaterialSearch：同一个模型、同一个库，它排序明显更准 ✓，
     *   而它用的是不压缩的精确检索 ✓）。
     *
     * 现在改成 `ivfFlat`：IVF 分区 + **不压缩的原始向量** ✓ → 距离精确 ✓、
     * 仍然是分区的子线性检索（不至于全表暴力扫）✓。
     * 关键：**只重建索引，不需要重建向量** ✓（已入库的向量一个字节都不用动 ✓）。
     */
    await table.createIndex("vector", {
      config: Index.ivfFlat({ numPartitions: partitions, distanceType: "cosine" }),
    });
  } catch (error) {
    result.skipped.push(`${name}-index-failed`);
    result.indexErrors.push(`${name}: ${errorMessage(error)}`);
  }
  result.indexMs += nowMs() - startedAt;
}

async function runTasks(message) {
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(message.vectorsPath);
  const tasks = message.tasks ?? {};

  const result = {
    optimizeMs: 0,
    indexMs: 0,
    rows: null,
    skipped: [],
    filesBefore: 0,
    filesAfter: 0,
    tables: [],
    indexErrors: [],
  };

  const tableNames = await db.tableNames();
  // 兼容旧字段：compact / cleanup 都表示"清一次表"。
  const wantOptimize = Boolean(
    tasks.optimize ?? (tasks.compact || tasks.cleanup)
  );
  const requested =
    Array.isArray(tasks.tables) && tasks.tables.length > 0
      ? tasks.tables
      : DEFAULT_TABLES;
  const cleanupOlderThanMs = Number.isFinite(tasks.cleanupOlderThanMs)
    ? Number(tasks.cleanupOlderThanMs)
    : DEFAULT_CLEANUP_OLDER_THAN_MS;

  if (wantOptimize) {
    for (const name of requested) {
      if (!tableNames.includes(name)) {
        result.skipped.push(`${name}-missing`);
        continue;
      }
      const entry = await optimizeTable(
        db,
        message.vectorsPath,
        name,
        cleanupOlderThanMs
      );
      result.tables.push(entry);
      result.optimizeMs += entry.optimizeMs;
      result.filesBefore += entry.filesBefore ?? 0;
      result.filesAfter += entry.filesAfter ?? 0;
      if (entry.error) {
        result.skipped.push(`${name}-optimize-failed`);
      }
    }
  }

  if (tasks.index) {
    for (const name of INDEX_TABLES) {
      if (!tableNames.includes(name)) {
        result.skipped.push(`${name}-missing`);
        continue;
      }
      await buildIndex(db, name, tasks.numPartitions, lancedb, result);
    }
  }

  return result;
}

/*
 * 自用：支持**直接命令行运行**（便于冒烟测试与手工维护，不依赖父进程）：
 *   node scripts/vector-maintenance-worker.mjs --vectors=<路径> [--optimize] [--index] [--tables=a,b]
 */
const vectorsArg = process.argv.find((arg) => arg.startsWith("--vectors="));
if (vectorsArg) {
  const vectorsPath = vectorsArg.slice("--vectors=".length);
  const tablesArg = process.argv.find((arg) => arg.startsWith("--tables="));
  const tables = tablesArg
    ? tablesArg
        .slice("--tables=".length)
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : undefined;
  if (vectorsPath) {
    const startedAt = nowMs();
    runTasks({
      vectorsPath,
      tasks: {
        optimize:
          process.argv.includes("--optimize") ||
          process.argv.includes("--compact") ||
          process.argv.includes("--cleanup"),
        index: process.argv.includes("--index"),
        tables,
      },
    })
      .then((result) => {
        console.log("[worker] result:", JSON.stringify(result, null, 2));
        console.log(`[worker] 总耗时 ${((nowMs() - startedAt) / 1000).toFixed(1)} 秒`);
        process.exit(0);
      })
      .catch((error) => {
        console.error("[worker] failed:", error);
        process.exit(1);
      });
  }
}

process.on("message", (message) => {
  if (message?.type === "shutdown") {
    process.exit(0);
  }
  if (message?.type !== "run") {
    return;
  }
  const startedAt = nowMs();
  runTasks(message)
    .then((result) => {
      process.send?.({
        type: "result",
        ok: true,
        result,
        durationMs: nowMs() - startedAt,
      });
    })
    .catch((error) => {
      process.send?.({
        type: "result",
        ok: false,
        error: errorMessage(error),
        durationMs: nowMs() - startedAt,
      });
    });
});
