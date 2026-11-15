/**
 * 角色识别「逐角色比对」的独立进程封装（2026-11-15 · 会话#13）。
 *
 * 背景与实测见 `scripts/character-search-worker.mjs` 顶部注释：
 * 同一条查询在应用主进程里要 650~2000ms、在新进程里只要 7~10ms，
 * 原因未定位但已排除数据/索引/运行时/线程池/单核/GC/主线程等因素。
 * 所以把比对搬到独立进程，主进程只收结果；进程卡住还能直接杀掉。
 *
 * 失败一律降级为 `null`，调用方会退回进程内的老路径 —— 这条链不能把识别功能搞挂。
 */

import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { CCIP_TABLE_NAME } from "@/services/ai/vector-db";
import { getDataPath } from "@/utils/data-path";

export interface CcipSearchHit {
  photoId: number;
  similarity: number;
}

/** worker 一次跑完时，按角色返回的候选（hits 已在 worker 里过滤成"只保留未命名照片"）。 */
export interface CcipSearchPerTag {
  hits: CcipSearchHit[];
  seedCount: number;
  tagId: number;
  tagName: string;
}

export interface CcipSearchWorkerSession {
  close: () => Promise<void>;
  /** 查不到 / 出错 / 超时一律返回 null（调用方按"向量库暂时不可用"处理）。 */
  search: (
    vector: number[] | Float64Array,
    limit: number
  ) => Promise<CcipSearchHit[] | null>;
  /**
   * **一次跑完**（2026-11-15 · 会话#13）：把全部角色向量一次发过去，worker 内部
   * 按 3 路并发跑完、过滤好再一次性回包。现场实测主进程"读回包"一次要 2.4~7.2 秒，
   * 逐批往返 139 次 = 4 分钟；整批一次往返后总量与往返次数无关。
   */
  searchAll: (
    vectors: number[][],
    metas: Array<{ seedCount: number; tagId: number; tagName: string }>,
    unnamedIds: number[],
    limit: number
  ) => Promise<CcipSearchPerTag[] | null>;
}

interface WorkerMessage {
  error?: string;
  hits?: CcipSearchHit[][];
  id?: number;
  indexCount?: number;
  ms?: number;
  nodeOptions?: string;
  parallelism?: number;
  receivedAt?: number;
  rows?: number;
  sendMs?: number;
  perTag?: CcipSearchPerTag[];
  type?: string;
  uvThreadpool?: string;
  version?: number;
}

/** worker 脚本位置：源码运行 / asar 内 / asar.unpacked / cwd 四种都试（与维护 worker 同款）。 */
function findWorkerScript(): string {
  const candidates = [
    path.join(app.getAppPath(), "scripts", "character-search-worker.mjs"),
    path.join(
      app.getAppPath(),
      "app.asar.unpacked",
      "scripts",
      "character-search-worker.mjs"
    ),
    path.join(process.cwd(), "scripts", "character-search-worker.mjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("character-search-worker.mjs not found");
}

const devLog = (message: string): void => {
  if (!app.isPackaged) {
    console.log(message);
  }
};

export async function createCcipSearchWorkerSession(options: {
  callTimeoutMs?: number;
  initTimeoutMs?: number;
} = {}): Promise<CcipSearchWorkerSession | null> {
  const initTimeoutMs = options.initTimeoutMs ?? 20_000;
  const callTimeoutMs = options.callTimeoutMs ?? 60_000;

  let child: ChildProcess;
  try {
    child = fork(findWorkerScript(), [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
  } catch (error) {
    devLog(
      `[CharacterSearch] worker 启动失败，退回进程内查询：${String(
        (error as Error)?.message ?? error
      )}`
    );
    return null;
  }

  const pending = new Map<
    number,
    {
      resolve: (hits: CcipSearchHit[] | null) => void;
      startedAt: number;
      timer: NodeJS.Timeout;
    }
  >();
  /** 「一次跑完」的在途请求（与逐次查询分开记，避免 id 串台）。 */
  const pendingMany = new Map<
    number,
    {
      resolve: (perTag: CcipSearchPerTag[] | null) => void;
      startedAt: number;
      timer: NodeJS.Timeout;
    }
  >();
  let nextId = 1;
  let closed = false;
  /* 排查用统计：worker 自报耗时 vs 主进程侧实际等待（两边一比就知道慢在哪） */
  let workerCalls = 0;
  let workerMsTotal = 0;
  let workerMsMax = 0;
  let mainMsTotal = 0;
  let mainMsMax = 0;

  const ready = new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const timer = setTimeout(() => settle(false), initTimeoutMs);

    child.on("message", (raw) => {
      const message = raw as WorkerMessage;
      if (message?.type === "ready") {
        devLog(
          `[CharacterSearch] worker 就绪｜版本=${message.version}｜行数=${message.rows}｜索引=${message.indexCount}｜并行度=${message.parallelism}｜NODE_OPTIONS='${message.nodeOptions ?? ""}'｜UV_THREADPOOL_SIZE='${message.uvThreadpool ?? ""}'`
        );
        settle(true);
        return;
      }
      if (message?.type === "result") {
        if (Array.isArray(message.perTag)) {
          const entryMany =
            typeof message.id === "number" ? pendingMany.get(message.id) : undefined;
          if (entryMany) {
            clearTimeout(entryMany.timer);
            pendingMany.delete(message.id as number);
            devLog(
              `[CharacterSearch] 整批返回：${message.perTag.length} 个角色，主进程侧等待 ${Math.round(performance.now() - entryMany.startedAt)}ms（worker 自报 ${message.ms ?? "?"}ms）`
            );
            entryMany.resolve(message.perTag);
          }
          return;
        }
        const entry =
          typeof message.id === "number" ? pending.get(message.id) : undefined;
        if (typeof message.ms === "number") {
          workerCalls += 1;
          workerMsTotal += message.ms;
          workerMsMax = Math.max(workerMsMax, message.ms);
        }
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(message.id as number);
          /*
           * 2026-11-15（会话#13）：**每次调用当场分账**（只在 dev 版、且明显偏慢时打）。
           * 主进程侧等 1.6 秒、worker 自报 9 毫秒 → 慢在主进程这边；
           * 两边都 1.6 秒 → 慢在这个被人的应用 fork 出来的子进程里。
           * 这样点下去两秒内就能看到结论，不用等整轮跑完。
           */
          const elapsed = performance.now() - entry.startedAt;
          if (elapsed > 500) {
            /*
             * 2026-11-15（会话#13）：**把往返拆成三段**（只在 dev 版、明显偏慢时打）。
             * 送达 = worker 收到时刻 − 主进程发出时刻（同一台机器，墙钟可直接相减）；
             * 回程 = 总耗时 − 送达 − worker 自报的处理时间。
             * 这样能一眼看出：慢在"消息进不去 worker"还是"结果出不来"。
             */
            const sentWallClock =
              Date.now() - Math.round(performance.now() - entry.startedAt);
            const deliver =
              typeof message.receivedAt === "number"
                ? message.receivedAt - sentWallClock
                : null;
            const backMs =
              deliver === null
                ? null
                : Math.round(elapsed) - deliver - (message.ms ?? 0);
            devLog(
              `[CharacterSearch] 单次偏慢：主进程侧 ${Math.round(elapsed)}ms（worker 自报 ${message.ms ?? "?"}ms｜worker 回包 ${message.sendMs ?? "?"}ms｜送达 ${deliver ?? "?"}ms｜回程 ${backMs ?? "?"}ms）`
            );
          }
          entry.resolve(message.hits?.[0] ?? []);
        }
        return;
      }
      if (message?.type === "error") {
        if (!settled) {
          settle(false);
          return;
        }
        const entry =
          typeof message.id === "number" ? pending.get(message.id) : undefined;
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(message.id as number);
          entry.resolve(null);
        }
      }
    });

    // 进程提前退出：初始化算失败，在途查询全部按"不可用"结束
    child.on("exit", () => {
      settle(false);
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.resolve(null);
      }
      pending.clear();
    });
  });

  try {
    child.send({
      type: "init",
      vectorsPath: path.join(getDataPath(), "vectors"),
      tableName: CCIP_TABLE_NAME,
    });
  } catch {
    /* 落到下面按初始化失败处理 */
  }

  if (!(await ready)) {
    try {
      child.kill();
    } catch {
      /* 尽力而为 */
    }
    devLog("[CharacterSearch] worker 初始化失败，退回进程内查询");
    return null;
  }

  return {
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        child.send({ type: "shutdown" });
      } catch {
        /* 已退出 */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* 尽力而为 */
          }
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      /*
       * 2026-11-15（会话#13）：一行汇总，直接判"慢在 worker 里还是慢在主进程侧"。
       * worker 自报 9ms/次、主进程侧却等 600ms/次 → 问题在主进程；
       * 两边都 600ms → 问题在这个 fork 出来的子进程里（继承了什么）。
       */
      if (workerCalls > 0) {
        devLog(
          `[CharacterSearch] 汇总｜worker 侧 ${workerCalls} 次 / 合计 ${Math.round(workerMsTotal)}ms / 最慢 ${Math.round(workerMsMax)}ms ｜ 主进程侧 合计 ${Math.round(mainMsTotal)}ms / 最慢 ${Math.round(mainMsMax)}ms`
        );
      }
    },
    searchAll: (vectors, metas, unnamedIds, limit) =>
      new Promise<CcipSearchPerTag[] | null>((resolve) => {
        if (closed) {
          resolve(null);
          return;
        }
        const id = nextId++;
        const startedAt = performance.now();
        const timer = setTimeout(() => {
          pendingMany.delete(id);
          resolve(null);
        }, 5 * 60_000);
        pendingMany.set(id, { resolve, startedAt, timer });
        try {
          child.send({
            type: "searchAll",
            id,
            limit,
            vectors,
            metas,
            unnamedIds,
          });
        } catch {
          clearTimeout(timer);
          pendingMany.delete(id);
          resolve(null);
        }
      }),
    search: (vector, limit) =>
      new Promise<CcipSearchHit[] | null>((resolve) => {
        if (closed) {
          resolve(null);
          return;
        }
        const id = nextId++;
        const startedAt = performance.now();
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(null);
        }, callTimeoutMs);
        pending.set(id, {
          resolve: (hits) => {
            const elapsed = performance.now() - startedAt;
            mainMsTotal += elapsed;
            mainMsMax = Math.max(mainMsMax, elapsed);
            resolve(hits);
          },
          startedAt,
          timer,
        });
        try {
          const sendStartedAt = performance.now();
          child.send({
            type: "search",
            id,
            limit,
            vectors: [Array.from(vector)],
          });
          const sendMs = performance.now() - sendStartedAt;
          if (sendMs > 200) {
            devLog(
              `[CharacterSearch] 发送卡住：child.send 用了 ${Math.round(sendMs)}ms`
            );
          }
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          resolve(null);
        }
      }),
  };
}
