import { createElement, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { initializeAppLanguage } from "@/actions/language";
import App from "@/app";
import i18n from "@/localization/i18n";
import { createRendererBootstrap } from "@/utils/renderer-bootstrap";

const container = document.getElementById("app");
if (!container) {
  throw new Error('Root element with id "app" not found');
}
if ("scrollRestoration" in window.history) {
  window.history.scrollRestoration = "manual";
}

const bootstrap = createRendererBootstrap(
  container,
  import.meta.hot?.data.root as Root | undefined
);
if (import.meta.hot) {
  import.meta.hot.data.root = bootstrap.root;
  import.meta.hot.dispose(() => bootstrap.dispose());
}

// Resolve the signed locale before rendering the first frame.
bootstrap
  .renderAfterInitialization(
    () => initializeAppLanguage(i18n),
    createElement(StrictMode, null, createElement(App))
  )
  .then(() => {
    /*
     * 自用（2026-10-17）：**界面画完了，通知主进程可以显示窗口了** ✓
     *
     * 为什么需要它：主进程原来靠 `ready-to-show` 显示窗口，而那只是
     * "网页的**第一个空白帧**"（实测启动后 0.8 秒就触发，React 还没渲染）✗
     * → 窗口先出来、里面一片白 ✗（用户实测："窗口先出来然后看白底"）。
     * 现在等 React 真正渲染完再通知 → 窗口一出现就是界面 ✓。
     *
     * 用 `setTimeout` 而不是 `requestAnimationFrame`：窗口在显示前是**隐藏**的，
     * 隐藏窗口的 rAF 会被节流/暂停；定时器最多晚 1 秒，但一定会执行 ✓。
     */
    setTimeout(() => {
      try {
        window.electronAPI?.notifyRendererReady?.();
      } catch {
        /* 非 Electron 环境（单测/浏览器）忽略 */
      }
    }, 120);
  })
  .catch(() => undefined);
