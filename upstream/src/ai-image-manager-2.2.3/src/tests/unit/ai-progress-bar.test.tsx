import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiProgressBar } from "@/components/AiProgressBar";
import { ipc } from "@/ipc/manager";

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        cancelAiIndexing: vi.fn(),
        getAiProgress: vi.fn(),
        pauseAiIndexing: vi.fn(),
        resumeAiIndexing: vi.fn(),
        startAiIndexing: vi.fn(),
      },
    },
  },
}));

describe("AiProgressBar", () => {
  it("renders resume controls from backend paused state after mount", async () => {
    vi.mocked(ipc.client.photos.getAiProgress).mockResolvedValue({
      controlState: "paused",
      currentFile: "paused at 3/10",
      isActive: false,
      isModelLoaded: true,
      isPaused: true,
      phase: "embedding",
      processed: 3,
      runId: 1,
      total: 10,
    });

    render(<AiProgressBar />);

    await waitFor(() => {
      expect(screen.getByText("aiResume")).toBeInTheDocument();
    });
    expect(screen.getByText("cancel")).toBeInTheDocument();
    expect(screen.queryByText("aiPause")).not.toBeInTheDocument();
  });

  // 自用（需求 7）：特征提取 / 打标阶段，百分比左侧要有"处理速度 + 预估剩余时间"
  it("shows processing speed and an estimated remaining time while embedding", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      vi.mocked(ipc.client.photos.getAiProgress).mockImplementation(async () => {
        const processed = Math.min(100, calls * 5);
        calls += 1;
        return {
          controlState: "running" as const,
          currentFile: "",
          isActive: true,
          isModelLoaded: true,
          isPaused: false,
          phase: "embedding" as const,
          processed,
          runId: 1,
          total: 100,
        };
      });

      render(<AiProgressBar />);
      // 时序：①先让首次取数落地（它才会去排 1000ms 的轮询计时器）
      //       ②再推进 1000ms 触发第一次轮询 → 采到第二个样本，才能算出速度
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(screen.getByText(/张\/秒/)).toBeInTheDocument();
      expect(screen.getByText(/剩余约/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not show speed or remaining time for non-counting phases", async () => {
    vi.mocked(ipc.client.photos.getAiProgress).mockResolvedValue({
      controlState: "running" as const,
      currentFile: "",
      downloadPercent: 42,
      isActive: true,
      isModelLoaded: false,
      isPaused: false,
      phase: "loading" as const,
      processed: 0,
      runId: 1,
      total: 0,
    });

    render(<AiProgressBar />);

    await waitFor(() => {
      expect(screen.getByText(/42/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/张\/秒/)).not.toBeInTheDocument();
    expect(screen.queryByText(/剩余约/)).not.toBeInTheDocument();
  });
});
