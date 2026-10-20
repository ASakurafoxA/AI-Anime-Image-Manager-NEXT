/** @vitest-environment node */
/**
 * 自用（2026-10-20 · 会话#10）：**暂停打标**的两个真实故障的回归测试。
 *
 * 用户报：「打标无法暂停，点击暂停后又会继续」。
 * 代码里有两个漏点，各写一个用例钉住：
 *   ① **启动窗口期丢暂停**：点「生成 AI 标签」之后要先加载模型（十几秒），
 *      这段时间 `isPixaiTaggingRunning()` 还是 false，老代码直接把暂停请求丢掉 →
 *      模型一加载完照样从头打到尾。
 *   ② **在途批次把相位翻回运行中**：暂停是"批边界才停"，正在跑的那一批收尾时
 *      还会回调一次进度，老代码无条件写 `phase: "tagging"` →
 *      界面又从"已暂停"跳回"进行中"；轮询接口 `getAiProgress` 也一样。
 */
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const s = {
    progress: {
      phase: "idle" as string,
      processed: 0,
      total: 0,
      currentFile: "",
    },
    modelCalled: false,
    db: null as unknown as ReturnType<typeof drizzle>,
    ensureLocalModel: (() => Promise.resolve("")) as () => Promise<string>,
    resolveModel: ((_: string) => undefined) as (value: string) => void,
  };
  let resolveModel: ((value: string) => void) | null = null;
  let modelPromise: Promise<string> | null = null;
  s.ensureLocalModel = () => {
    s.modelCalled = true;
    if (!modelPromise) {
      modelPromise = new Promise<string>((resolve) => {
        resolveModel = resolve;
      });
    }
    return modelPromise;
  };
  s.resolveModel = (value: string) => {
    resolveModel?.(value);
    resolveModel = null;
  };
  return s;
});

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

// 只替身"模型加载"和"建向量状态"：打标模块本身保持真实，才能验证挂起标志。
vi.mock("@/services/ai/model-loader", () => ({
  ensureLocalModel: () => state.ensureLocalModel(),
}));

vi.mock("@/services/ai-embedder", () => ({
  activeEmbeddingRunId: 0,
  aiControlState: "idle",
  batchSuggestTags: vi.fn(),
  cancelEmbedding: vi.fn(),
  checkAiHealth: vi.fn(),
  cleanupPartialEmbedding: vi.fn(),
  embedAllPhotos: vi.fn(),
  finishEmbeddingRun: vi.fn(),
  getAiReadiness: vi.fn(),
  getEmbeddingProgress: () => ({ ...state.progress }),
  isAutoTaggingActive: () => false,
  pauseEmbedding: vi.fn(),
  rebuildVectorDB: vi.fn(),
  resetAllAiProcessedFlags: vi.fn(),
  resumeEmbedding: vi.fn(),
  setAiControlState: vi.fn(),
  setCurrentProgress: (next: typeof state.progress) => {
    Object.assign(state.progress, next);
  },
  setWasAutoRepaired: vi.fn(),
  stopEmbedding: vi.fn(),
}));

vi.mock("@/services/ai/pixai-tagger", async (original) => {
  const actual =
    await original<typeof import("@/services/ai/pixai-tagger")>();
  return {
    ...actual,
    // 真的去跑会加载 1.86 GB 模型；这里只关心"暂停请求有没有被接住"
    runPixaiTagging: vi.fn(async () => ({
      total: 0,
      tagged: 0,
      failed: 0,
      cancelled: false,
    })),
  };
});

import { batchGenerateTags, getAiProgress, pauseTagging } from "@/ipc/photos/handlers/ai";
import {
  isPixaiTaggingSuspended,
  resumePixaiTagging,
} from "@/services/ai/pixai-tagger";

async function waitUntil(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached in time");
}

describe("暂停打标", () => {
  beforeEach(() => {
    const sqlite = new Database(":memory:");
    state.db = drizzle(sqlite);
    migrate(state.db, { migrationsFolder: "drizzle" });
    resumePixaiTagging();
    state.progress.phase = "idle";
    state.progress.processed = 0;
    state.progress.total = 0;
  });

  it("启动窗口期（模型还没加载完）点暂停，也会接住", async () => {
    const job = call(batchGenerateTags, {});
    // 等它真的走到"加载模型"那一步：这正是老代码会丢暂停的窗口
    await waitUntil(() => state.modelCalled);
    expect(isPixaiTaggingSuspended()).toBe(false);

    const result = await call(pauseTagging, {});
    expect(result).toMatchObject({
      paused: true,
      suspended: true,
      starting: true,
    });
    expect(isPixaiTaggingSuspended()).toBe(true);
    expect(state.progress.phase).toBe("tagging-paused");

    // 放行"模型加载"：这一轮会照常跑完，收尾时不能把"挂起"留给下一次
    state.resolveModel("/models");
    await job;
    expect(isPixaiTaggingSuspended()).toBe(false);
  });

  it("挂起期间，轮询接口 getAiProgress 报的是「已暂停」而不是「进行中」", async () => {
    state.progress.phase = "tagging";
    state.progress.processed = 120;
    state.progress.total = 1000;

    const running = await call(getAiProgress, {});
    expect(running.phase).toBe("tagging");

    const { pausePixaiTagging } = await import("@/services/ai/pixai-tagger");
    pausePixaiTagging();
    const paused = await call(getAiProgress, {});
    expect(paused.phase).toBe("tagging-paused");
    expect(paused.isPaused).toBe(true);
    // 张数不能被暂停清掉：界面上要能看到"停在哪儿"
    expect(paused.processed).toBe(120);
    expect(paused.total).toBe(1000);

    resumePixaiTagging();
    expect((await call(getAiProgress, {})).phase).toBe("tagging");
  });
});
