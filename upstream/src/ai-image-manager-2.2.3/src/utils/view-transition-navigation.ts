import { flushSync } from "react-dom";

export function startNavigationViewTransition(
  navigate: () => Promise<void>
): Promise<void> {
  const transition = document.startViewTransition(() =>
    flushSync(() => navigate())
  );
  /*
   * 2026-11-16（会话#13）：**接住"过渡被中断"**。
   *
   * 用户实测：外观设置页切主题时故障面板记过一条
   * `Transition was aborted because of invalid state` —— 这是浏览器在
   * "过渡还没走完又被跳过/又跳转"时对 `ready` / `finished` 的拒绝。
   * 不接住它就变成"未处理 Promise 拒绝"，被当成故障记下来（假故障，会把真故障埋掉）。
   * 注意：返回值保持 `updateCallbackDone` 不变（调用方 await 的语义不变）。
   */
  transition.ready?.catch?.(() => undefined);
  transition.finished?.catch?.(() => undefined);
  return transition.updateCallbackDone;
}
