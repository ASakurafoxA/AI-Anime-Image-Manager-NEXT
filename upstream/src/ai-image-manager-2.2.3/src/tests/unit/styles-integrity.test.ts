import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * 自用（2026-10-18 · 会话#9）：**样式表完整性守卫**。
 *
 * 起因：我改图标时用了一段"先以 'w' 打开、再读同一文件"的脚本 —— Python 会
 * **先截断再读**，结果把 `global.css` 写成了 0 字节 ✗，整个界面变成无样式的裸 HTML。
 * 这个测试就是防这种事故：只要样式表被写空 / 括号不配平，立刻红 ✓
 */
// vitest 的 import.meta.url 不一定是 file: 协议 → 用相对 cwd 的固定路径
const cssPath = path.resolve(process.cwd(), "src", "styles", "global.css");

describe("global.css 完整性", () => {
  it("不是空文件，且大括号配平", () => {
    const css = readFileSync(cssPath, "utf8");
    // 正常约 78 KB；留足余量，只挡住"被写空/被截断"这类事故
    expect(css.length).toBeGreaterThan(20_000);
    const open = (css.match(/{/g) ?? []).length;
    const close = (css.match(/}/g) ?? []).length;
    expect(open).toBe(close);
    expect(open).toBeGreaterThan(100);
  });

  it("关键样式仍在（动画与品牌图标）", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain("@keyframes album-view-enter");
    expect(css).toContain("@keyframes context-menu-pop");
    expect(css).toContain(".whats-new-brand-icon");
  });
});
