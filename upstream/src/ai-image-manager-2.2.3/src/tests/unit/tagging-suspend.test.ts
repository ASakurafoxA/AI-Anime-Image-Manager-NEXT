// @vitest-environment node
/**
 * 自用（2026-10-17，待办第 5 项）：**真正挂起式暂停**的标志语义。
 *
 * 用户口径：老做法"取消 + 等它停"会把 worker 杀掉 → "继续"要重新初始化几秒 ✗；
 * 挂起 = 循环在批边界原地等、**worker 不销毁**、模型保持热态 → 继续是**秒接** ✓
 *
 * 这里只钉住最容易写错的标志关系（不碰模型/DB）：
 *   ① pause 后 `isPixaiTaggingSuspended()` = true
 *   ② resume 后 = false（继续是秒接的关键）
 *   ③ **cancel 必须同时清挂起** —— 否则循环会卡在等待里永远不退出 ✗
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/app", getPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] },
}));

const tagger = await import("@/services/ai/pixai-tagger");

describe("pixai tagging suspend（挂起式暂停）", () => {
  it("pause → suspended=true；resume → false", () => {
    expect(tagger.isPixaiTaggingSuspended()).toBe(false);
    tagger.pausePixaiTagging();
    expect(tagger.isPixaiTaggingSuspended()).toBe(true);
    tagger.resumePixaiTagging();
    expect(tagger.isPixaiTaggingSuspended()).toBe(false);
  });

  it("cancel 会顺带清掉挂起（否则循环卡死在等待里）", () => {
    tagger.pausePixaiTagging();
    expect(tagger.isPixaiTaggingSuspended()).toBe(true);
    tagger.cancelPixaiTagging();
    expect(tagger.isPixaiTaggingSuspended()).toBe(false);
  });
});
