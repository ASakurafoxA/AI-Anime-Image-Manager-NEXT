/** @vitest-environment node */
/**
 * 自用（2026-10-20 · 会话#10）：**建向量（AI 索引）的暂停 / 继续**也要按同一个口径修。
 *
 * 用户这次问：「几个同样有进度条、同样断点续传的功能有没有一样的问题」。
 * 建向量这条链上和打标同类的两个坑：
 *   ① 暂停后的"已暂停"状态会被循环自己的收尾进度覆盖（那条没带 isPaused）；
 *   ② 点「继续」时如果还在 `pausing`（循环还没退出），老代码直接返回 resumed:false →
 *      界面毫无反应（"点继续也不会继续"）。
 *   ③ 没在跑时点暂停，会把界面钉在"已暂停 + 继续"（点继续什么也不会发生）。
 */
import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const facade = vi.hoisted(() => {
  const state = {
    control: "running" as string,
    progress: {
      phase: "embedding" as string,
      processed: 10,
      total: 100,
      currentFile: "",
    },
    written: [] as Array<Record<string, unknown>>,
  };
  return {
    state,
    written: state.written,
    resumeEmbedding: vi.fn(),
    pauseEmbedding: vi.fn(),
    embedAllPhotos: vi.fn(async () => 0),
  };
});

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/app", getPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("@/db", () => ({
  getDatabase: () => {
    throw new Error("this test must not touch the database");
  },
}));

vi.mock("@/services/ai/model-loader", () => ({
  ensureLocalModel: vi.fn(async () => "/models"),
}));

vi.mock("@/services/ai-embedder", () => {
  const mod = {
    get aiControlState() {
      return facade.state.control;
    },
    activeEmbeddingRunId: 0,
    batchSuggestTags: vi.fn(),
    cancelEmbedding: vi.fn(),
    checkAiHealth: vi.fn(),
    cleanupPartialEmbedding: vi.fn(),
    embedAllPhotos: facade.embedAllPhotos,
    finishEmbeddingRun: vi.fn(),
    getAiReadiness: vi.fn(),
    getEmbeddingProgress: () => ({ ...facade.state.progress }),
    isAutoTaggingActive: () => false,
    pauseEmbedding: facade.pauseEmbedding,
    rebuildVectorDB: vi.fn(),
    resetAllAiProcessedFlags: vi.fn(),
    resumeEmbedding: facade.resumeEmbedding,
    setAiControlState: vi.fn(),
    setCurrentProgress: (next: Record<string, unknown>) => {
      facade.state.progress = {
        ...(next as typeof facade.state.progress),
      };
      facade.written.push(next);
    },
    setWasAutoRepaired: vi.fn(),
    stopEmbedding: vi.fn(),
  };
  return mod;
});

import {
  pauseAiIndexing,
  resumeAiIndexing,
} from "@/ipc/photos/handlers/ai";

describe("建向量的暂停 / 继续", () => {
  beforeEach(() => {
    facade.state.control = "running";
    facade.state.progress = {
      phase: "embedding",
      processed: 10,
      total: 100,
      currentFile: "",
    };
    facade.written.length = 0;
    facade.resumeEmbedding.mockReset();
    facade.pauseEmbedding.mockReset();
    facade.embedAllPhotos.mockClear();
  });

  it("没在跑时点暂停：不要把界面钉在「已暂停」", async () => {
    facade.state.control = "idle";
    const result = await call(pauseAiIndexing, {});
    expect(result).toMatchObject({ paused: false });
    expect(facade.written.at(-1)).toMatchObject({ phase: "idle" });
  });

  it("暂停时推出去的进度必须带 isPaused（界面才知道该显示「继续」）", async () => {
    await call(pauseAiIndexing, {});
    expect(facade.pauseEmbedding).toHaveBeenCalled();
    expect(facade.written.at(-1)).toMatchObject({
      isPaused: true,
      processed: 10,
      total: 100,
    });
  });

  it("还在 pausing 时点「继续」：等它停下来再恢复，而不是直接没反应", async () => {
    facade.state.control = "pausing";
    facade.resumeEmbedding.mockImplementation(() => {
      // 恢复接口只在 paused 时才成功（与真实实现一致）
      facade.state.control = "idle";
      return true;
    });
    // 模拟"循环在 150ms 后才真正停下"
    setTimeout(() => {
      facade.state.control = "paused";
    }, 150);

    const result = await call(resumeAiIndexing, {});
    expect(facade.resumeEmbedding).toHaveBeenCalledTimes(1);
    expect(facade.embedAllPhotos).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ resumed: true });
  });
});
