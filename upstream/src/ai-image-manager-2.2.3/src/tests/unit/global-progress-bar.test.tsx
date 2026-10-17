import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalProgressBar } from "@/components/global-progress-bar";
import type { GlobalAiProgress } from "@/hooks/use-global-ai-status";
import { useGlobalAiStatus } from "@/hooks/use-global-ai-status";
import { ipc } from "@/ipc/manager";

vi.mock("@/hooks/use-global-ai-status", () => ({
  useGlobalAiStatus: vi.fn(),
}));

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => false,
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        pauseTagging: vi.fn(),
        stopScanning: vi.fn(),
      },
    },
  },
}));

vi.mock("@/utils/progress-phrases", () => ({
  getRandomPhrase: () => "测试进度",
}));

const mockedUseGlobalAiStatus = vi.mocked(useGlobalAiStatus);

function getProgressBar(container: HTMLElement): HTMLElement {
  const bar = container.querySelector<HTMLElement>(
    '[data-reduced-motion-keep="progress-bar"]'
  );
  if (!bar) {
    throw new Error("Global progress bar is not rendered");
  }
  return bar;
}

/** 顶栏用了 useQueryClient（暂停后要主动失效 aiStatus），所以必须包一层 Provider。 */
function renderBar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GlobalProgressBar />
    </QueryClientProvider>
  );
}

const TAGGING_STATUS: GlobalAiProgress = {
  canCancel: false,
  isRunning: true,
  percent: 42,
  phase: "tagging",
  processed: 42,
  statusText: "打标中",
  total: 100,
};

describe("GlobalProgressBar", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows again when a new task starts during the exit animation", () => {
    let status: GlobalAiProgress = {
      canCancel: false,
      isRunning: true,
      percent: 42,
      phase: "embedding",
      processed: 42,
      statusText: "第一批",
      total: 100,
    };
    mockedUseGlobalAiStatus.mockImplementation(() => status);

    const view = renderBar();
    expect(getProgressBar(view.container)).toHaveClass("opacity-100");

    status = {
      ...status,
      isRunning: false,
      phase: "idle",
      statusText: "",
    };
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <GlobalProgressBar />
      </QueryClientProvider>
    );
    expect(getProgressBar(view.container)).toHaveClass("opacity-0");

    status = {
      ...status,
      isRunning: true,
      phase: "import-queue",
      statusText: "第二批",
    };
    act(() => {
      view.rerender(
        <QueryClientProvider client={new QueryClient()}>
          <GlobalProgressBar />
        </QueryClientProvider>
      );
    });

    expect(getProgressBar(view.container)).toHaveClass("opacity-100");
  });

  describe("打标暂停键", () => {
    it("正在打标时显示「暂停」，点了会调 pauseTagging", async () => {
      mockedUseGlobalAiStatus.mockImplementation(() => TAGGING_STATUS);
      vi.mocked(ipc.client.photos.pauseTagging).mockResolvedValue({
        paused: true,
      });

      renderBar();
      const button = screen.getByRole("button", { name: "aiPause" });
      fireEvent.click(button);

      await waitFor(() =>
        expect(ipc.client.photos.pauseTagging).toHaveBeenCalledWith({})
      );
    });

    it("不在打标时（例如只导入）不显示暂停键", () => {
      mockedUseGlobalAiStatus.mockImplementation(() => ({
        ...TAGGING_STATUS,
        canCancel: true,
        phase: "import-queue",
      }));

      renderBar();
      expect(screen.queryByRole("button", { name: "aiPause" })).toBeNull();
    });

    it("已暂停 / 空闲时不显示暂停键（避免重复暂停）", () => {
      // 暂停后 deriveStatus 会把 tagging-paused 归到 idle
      mockedUseGlobalAiStatus.mockImplementation(() => ({
        ...TAGGING_STATUS,
        isRunning: false,
        phase: "idle",
        statusText: "",
      }));

      renderBar();
      expect(screen.queryByRole("button", { name: "aiPause" })).toBeNull();
    });
  });
});
