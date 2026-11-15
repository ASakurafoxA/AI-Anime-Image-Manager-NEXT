/**
 * 角色识别「逐角色比对」专用 worker（2026-11-15 · 会话#13）。
 *
 * ── 为什么要有这个进程 ───────────────────────────────────────────────
 * 用户真机复现：同样一张 `ccip_embeddings`（版本 873 / 85,542 行 / IvfFlat 索引），
 * 在**应用主进程**里查一次要 650~2000ms，而在**新进程**里只要 7~10ms；
 * 连"打开表"在应用里都要 1.5 秒。已逐一排除：索引、全表扫描、Electron 运行时、
 * 双连接、真实质心向量、libuv 线程池、CPU 亲和性（单核）、GC、主线程阻塞、内存。
 * 异常只存在于应用进程内部，原因未定位 —— 所以**干脆把查询搬出这个进程**：
 * 独立进程实测就是 10ms 级，而且它卡住时主进程可以直接杀掉，界面不会再冻死。
 *
 * ── 协议（与主进程 IPC）──────────────────────────────────────────────
 *   → { type: "init", vectorsPath, tableName }
 *   ← { type: "ready", rows, version, indexCount }
 *   → { type: "search", id, vectors: number[][], limit }
 *   ← { type: "result", id, hits: Array<Array<{ photoId, similarity }>> }
 *   ← { type: "error", id?, error }
 *   → { type: "shutdown" }
 *
 * 只读：只做 connect / openTable / vectorSearch / toArray，不写库。
 */

import path from "node:path";

let db = null;
let table = null;
let limit = 300;

function reply(message) {
  try {
    process.send?.(message);
  } catch {
    /* 主进程已退出 */
  }
}

async function openTable(vectorsPath, tableName) {
  const lancedb = await import("@lancedb/lancedb");
  db = await lancedb.connect(vectorsPath);
  table = await db.openTable(tableName);
  const [rows, version, indices] = await Promise.all([
    table.countRows(),
    table.version(),
    table.listIndices(),
  ]);
  const os = await import("node:os");
  return {
    rows,
    version,
    indexCount: indices.length,
    // 排查用：worker 自己看到的并行度与关键环境变量（能和离线对照）
    parallelism:
      typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length,
    nodeOptions: process.env.NODE_OPTIONS ?? "",
    uvThreadpool: process.env.UV_THREADPOOL_SIZE ?? "",
  };
}

async function searchOne(vector, lim) {
  const rows = await table
    .vectorSearch(Array.from(vector))
    .distanceType("l2")
    .limit(lim)
    .toArray();
  return rows
    .map((row) => ({
      photoId: row.photo_id,
      similarity: Math.max(0, 1 - Number(row._distance ?? 0) / 2),
    }))
    .filter((hit) => Number.isFinite(hit.photoId));
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "init") {
    limit = Number(message.limit) > 0 ? Number(message.limit) : 300;
    void (async () => {
      try {
        const info = await openTable(message.vectorsPath, message.tableName);
        reply({ type: "ready", ...info });
      } catch (error) {
        reply({ type: "error", error: String(error?.message ?? error) });
      }
    })();
    return;
  }
  if (message.type === "searchAll") {
    /*
     * 2026-11-15（会话#13）：**一次跑完**（关键改动）。
     * 实测主进程"读回包"一次要 2.4~7.2 秒（worker 侧只要 10ms），
     * 于是 300 个角色 × 每批一次往返 = 4 分钟。改成整批一次往返：
     * 即使单次回程仍要几秒，总量也只剩"一次"。
     * 这里顺带把"只保留未命名照片"的过滤也做了，回包体积很小。
     */
    const id = message.id;
    const perCallLimit =
      Number(message.limit) > 0 ? Number(message.limit) : limit;
    const unnamed = new Set(
      Array.isArray(message.unnamedIds) ? message.unnamedIds : []
    );
    const metas = Array.isArray(message.metas) ? message.metas : [];
    const vectors = Array.isArray(message.vectors) ? message.vectors : [];
    void (async () => {
      const startedAt = performance.now();
      try {
        const perTag = [];
        const CONCURRENCY = 3;
        for (let start = 0; start < vectors.length; start += CONCURRENCY) {
          const slice = vectors.slice(start, start + CONCURRENCY);
          const hitsList = await Promise.all(
            slice.map((vector) => searchOne(vector, perCallLimit))
          );
          for (let i = 0; i < hitsList.length; i += 1) {
            const meta = metas[start + i] ?? {};
            perTag.push({
              tagId: meta.tagId,
              tagName: meta.tagName,
              seedCount: meta.seedCount,
              hits: hitsList[i].filter((hit) => unnamed.has(hit.photoId)),
            });
          }
        }
        reply({
          type: "result",
          id,
          perTag,
          ms: Math.round(performance.now() - startedAt),
        });
      } catch (error) {
        reply({ type: "error", id, error: String(error?.message ?? error) });
      }
    })();
    return;
  }
  if (message.type === "search") {
    const id = message.id;
    // 排查用：收到消息的时刻（主进程用它算"送达耗时"，判断慢在管道还是回程）
    const receivedAt = Date.now();
    void (async () => {
      try {
        const vectors = Array.isArray(message.vectors) ? message.vectors : [];
        const perCallLimit =
          Number(message.limit) > 0 ? Number(message.limit) : limit;
        const startedAt = performance.now();
        const hits = await Promise.all(
          vectors.map((vector) => searchOne(vector, perCallLimit))
        );
        // 排查用：worker 自己算这段花多久 + 回包（process.send）花了多久
        const sendStartedAt = performance.now();
        reply({
          type: "result",
          id,
          hits,
          ms: Math.round(performance.now() - startedAt),
          receivedAt,
          sendMs: Math.round(performance.now() - sendStartedAt),
        });
      } catch (error) {
        reply({ type: "error", id, error: String(error?.message ?? error) });
      }
    })();
    return;
  }
  if (message.type === "shutdown") {
    void (async () => {
      try {
        await db?.close?.();
      } catch {
        /* 尽力而为 */
      }
      process.exit(0);
    })();
  }
});

// 没有 IPC 父进程（被手动执行）时给一句用法，避免空转
if (!process.send) {
  console.log(
    `character-search-worker: 需要由主进程 fork 使用（argv=${process.argv.slice(2).join(" ") || "none"}）`
  );
  console.log(`cwd=${process.cwd()} file=${path.basename(import.meta.url)}`);
  process.exit(0);
}
