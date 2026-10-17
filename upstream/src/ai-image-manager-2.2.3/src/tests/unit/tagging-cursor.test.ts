import { describe, expect, it } from "vitest";
import { shouldResetTaggingCursor } from "@/services/ai/tagging-cursor";

/**
 * 自用（需求 1）：打标"断点续跑 / 全库重跑"的核心判定。
 *
 * 两个出口，语义必须严格分开：
 *  · 界面点"生成 AI 标签" → 传 `resetCursor: false` → **永不归零**（断点续跑）
 *  · 明确要重打（无头 `--run-pixai-tagging`、换模型） → 传 `resetCursor: true` → **无条件归零**
 *
 * 第 10 轮修的就是"两者混在一起"：当时 `resetCursor: true` 在有游标的库上
 * 被判定成"不归零"，于是"全库重跑"入口静默退化成续跑。
 */
describe("shouldResetTaggingCursor (自用需求 1)", () => {
  it("never resets when the caller did not ask for it (界面续跑路径)", () => {
    expect(
      shouldResetTaggingCursor(
        { resetCursor: false },
        { cursor: 5000, fullRunDone: false }
      )
    ).toBe(false);
    expect(
      shouldResetTaggingCursor(
        { resetCursor: false },
        { cursor: 0, fullRunDone: false }
      )
    ).toBe(false);
    expect(
      shouldResetTaggingCursor({}, { cursor: 5000, fullRunDone: false })
    ).toBe(false);
  });

  it("keeps resuming by default even when a previous run was interrupted", () => {
    // 跑到一半（5000 张）崩溃/关软件/取消 —— FULL_RUN 标记没置位，但游标已在。
    // 这就是用户报的"建库中途退出后要从头开始"的回归保护：界面路径不传 resetCursor。
    expect(
      shouldResetTaggingCursor({}, { cursor: 5000, fullRunDone: false })
    ).toBe(false);
  });

  it("resets when the caller explicitly asks for a full re-run", () => {
    // 无头 --run-pixai-tagging 的语义：有游标也要从头全库重打
    expect(
      shouldResetTaggingCursor(
        { resetCursor: true },
        { cursor: 5000, fullRunDone: false }
      )
    ).toBe(true);
    // 已经完整跑过一轮，依然要能重跑（换模型时就是这个场景）
    expect(
      shouldResetTaggingCursor(
        { resetCursor: true },
        { cursor: 20_000, fullRunDone: true }
      )
    ).toBe(true);
    // 全新库：归零等于没做事，全库扫一遍就是首次建库
    expect(
      shouldResetTaggingCursor(
        { resetCursor: true },
        { cursor: 0, fullRunDone: false }
      )
    ).toBe(true);
  });
});
