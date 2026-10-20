import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalProgressBar } from "@/components/global-progress-bar";
import { GlobalAiStatusProvider } from "@/hooks/use-global-ai-status";
import { ipc } from "@/ipc/manager";

/**
 * 自用（2026-10-20 · 会话#10）：**暂停打标**时顶栏必须：
 *   ① 显示"已暂停"，**不能**同时再给一个"暂停"键；
 *   ② 点「继续」要调 `batchGenerateTags`（从断点续跑），**不能**调 `resumeAiIndexing`。
 *
 * 用户实测的两个现象就出在这里：
 *   · 暂停后顶栏同时出现"暂停 / 已暂停 / 继续"三个键（因为 `tagging-paused`
 *     被映射成 `embedding`，于是建向量的"暂停"也一起渲染出来）；
 *   · 点「继续」调用的是建向量的恢复接口，打标根本没动。
 */
vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

vi.mock("@/utils/progress-phrases", () => ({
  getRandomPhrase: () => "测试进度",
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        batchGenerateTags: vi.fn(),
        cancelCharacterFeatures: vi.fn(),
        getAiProgress: vi.fn(),
        getAiStatus: vi.fn(),
        getCharacterFeatureProgress: vi.fn(),
        getImportQueueStatus: vi.fn(),
        pauseTagging: vi.fn(),
        resumeAiIndexing: vi.fn(),
        stopScanning: vi.fn(),
      },
    },
  },
}));

function renderBar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GlobalAiStatusProvider>
        <GlobalProgressBar />
      </GlobalAiStatusProvider>
    </QueryClientProvider>
  );
}

/** 模拟主进程推进度的那条 postMessage（与 preload 转发的结构一致）。 */
function emitAiProgress(payload: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: "ai-progress", ...payload },
      })
    );
  });
}

describe("暂停打标时的顶栏", () => {
  beforeEach(() => {
    // 组件里 `resume.then(...)` 会立即挂回调：mock 必须返回 Promise，否则报未捕获异常
    vi.mocked(ipc.client.photos.batchGenerateTags).mockResolvedValue({
      resumed: true,
    } as never);
    vi.mocked(ipc.client.photos.resumeAiIndexing).mockResolvedValue({
      resumed: true,
    } as never);
    vi.mocked(ipc.client.photos.pauseTagging).mockResolvedValue({
      paused: true,
    } as never);
    vi.mocked(ipc.client.photos.getAiProgress).mockResolvedValue({
      phase: "idle",
      processed: 0,
      total: 0,
    } as never);
    vi.mocked(ipc.client.photos.getAiStatus).mockResolvedValue({
      embeddingProgress: { phase: "idle", processed: 0, total: 0 },
      indexedPhotos: 1358,
      totalPhotos: 1358,
    } as never);
    vi.mocked(ipc.client.photos.getImportQueueStatus).mockResolvedValue({
      current: null,
      history: [],
      pending: [],
    } as never);
    vi.mocked(ipc.client.photos.getCharacterFeatureProgress).mockResolvedValue({
      running: false,
    } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("暂停后只给「继续」，不再多给一个「暂停」；继续调 batchGenerateTags", async () => {
    renderBar();
    emitAiProgress({
      phase: "tagging-paused",
      processed: 136,
      total: 4381,
      isPaused: true,
    });

    // 已暂停的提示与张数（不是"AI 特征提取 1358/1358（还需 0）"那种假 100%）
    await waitFor(() => {
      expect(document.body.textContent).toContain("AI 标签生成 136/4381");
    });
    expect(document.body.textContent).toContain("已暂停");

    // 不能再冒出一个"暂停"键
    expect(screen.queryByRole("button", { name: "aiPause" })).toBeNull();

    // 「继续」必须走打标续跑，而不是建向量的恢复
    const resume = screen.getByRole("button", { name: "aiResume" });
    fireEvent.click(resume);
    await waitFor(() =>
      expect(ipc.client.photos.batchGenerateTags).toHaveBeenCalledWith({})
    );
    expect(ipc.client.photos.resumeAiIndexing).not.toHaveBeenCalled();
  });

  it("建向量被暂停时，「继续」走 resumeAiIndexing", async () => {
    renderBar();
    emitAiProgress({
      phase: "embedding",
      processed: 200,
      total: 1000,
      isPaused: true,
    });

    const resume = await screen.findByRole("button", { name: "aiResume" });
    fireEvent.click(resume);
    await waitFor(() =>
      expect(ipc.client.photos.resumeAiIndexing).toHaveBeenCalledWith({})
    );
    expect(ipc.client.photos.batchGenerateTags).not.toHaveBeenCalled();
  });
});
