import { afterEach, describe, expect, it, vi } from "vitest";
import { startNavigationViewTransition } from "@/utils/view-transition-navigation";

const originalStartViewTransition = document.startViewTransition;

afterEach(() => {
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: originalStartViewTransition,
  });
  vi.restoreAllMocks();
});

describe("view transition navigation", () => {
  it("preserves the Promise navigation contract", () => {
    const navigationPromise = Promise.resolve();
    const updateCallbackDone = Promise.resolve();
    const navigate = vi.fn(() => navigationPromise);
    let updateResult: unknown;
    const startViewTransition = vi.fn(
      (updateCallback: ViewTransitionUpdateCallback) => {
        updateResult = updateCallback();
        return { updateCallbackDone } as ViewTransition;
      }
    );
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    });

    const result = startNavigationViewTransition(navigate);

    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
    expect(updateResult).toBe(navigationPromise);
    expect(result).toBe(updateCallbackDone);
    expect(typeof result.catch).toBe("function");
  });

  it("过渡被中断时接住 ready / finished，避免未处理拒绝", () => {
    const readyCatch = vi.fn(() => Promise.resolve());
    const finishedCatch = vi.fn(() => Promise.resolve());
    const updateCallbackDone = Promise.resolve();
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: vi.fn(
        () =>
          ({
            finished: { catch: finishedCatch },
            ready: { catch: readyCatch },
            updateCallbackDone,
          }) as unknown as ViewTransition
      ),
    });

    const result = startNavigationViewTransition(async () => undefined);

    // 2026-11-16（会话#13）：外观页切主题时报的
    // `Transition was aborted because of invalid state` 就是这两个 promise 的拒绝，
    // 必须接住（否则变成"未处理拒绝"、被故障面板记成假故障）。
    expect(readyCatch).toHaveBeenCalledOnce();
    expect(finishedCatch).toHaveBeenCalledOnce();
    expect(result).toBe(updateCallbackDone);
  });
});
