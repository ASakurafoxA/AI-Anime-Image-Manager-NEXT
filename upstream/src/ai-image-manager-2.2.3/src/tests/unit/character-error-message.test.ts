/** @vitest-environment node */
/**
 * 自用（2026-10-20 · 会话#10）：**角色识别的提示不能被吞成 "Internal server error"**。
 *
 * 用户实测：在角色识别页点按钮，只弹一句英文 `Internal server error`。
 * 根因：oRPC 的 `toORPCError()` 会把"普通 Error"换成
 * `INTERNAL_SERVER_ERROR` + 固定文案，原始 message 只留在 cause 里。
 * 这里钉住：`withUserFacingError()` 包过的调用，界面能拿到服务层写的中文提示。
 */
import { ORPCError, call } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/app", getPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] },
}));

/** 门禁用到的"零标签图数量"（0 = 打标已完成） */
const countsState = vi.hoisted(() => ({ untagged: 0 }));

const suggest = vi.hoisted(() => ({
  analyze: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDatabase: () => ({
    // 只服务"全库打标完成"那道门禁的 count 查询
    get: () => ({ c: countsState.untagged }),
  }),
}));

vi.mock("@/services/character-suggest", () => ({
  analyzeUnnamedCharacters: suggest.analyze,
  describeCharacterFeatureUnavailable: () => "缺模型",
  getCharacterSuggestProgress: () => ({
    running: false,
    phase: "idle",
    processed: 0,
    total: 0,
  }),
  resolveCharacterFeatureAccess: vi.fn(),
}));

import { withUserFacingError } from "@/ipc/photos/handlers/shared";
import { analyzeUnnamedCharacters } from "@/ipc/photos/handlers/tags";

describe("withUserFacingError", () => {
  it("普通 Error 的中文提示被原样带上（不再变成 Internal server error）", async () => {
    await expect(
      withUserFacingError(() => {
        throw new Error("CCIP 模型已就位，但还没有生成角色特征");
      })
    ).rejects.toThrow("CCIP 模型已就位，但还没有生成角色特征");
  });

  it("已经是 ORPCError 的原样抛出（不重复包装、不改状态码）", async () => {
    const original = new ORPCError("BAD_REQUEST", { message: "参数不对" });
    await expect(
      withUserFacingError(() => {
        throw original;
      })
    ).rejects.toBe(original);
  });
});

describe("角色识别接口的错误提示", () => {
  afterEach(() => {
    countsState.untagged = 0;
  });

  it("全库还没打完标时，服务端直接挡住，并给出中文门禁提示", async () => {
    countsState.untagged = 5;
    await expect(
      call(analyzeUnnamedCharacters, { dryRun: true })
    ).rejects.toThrow("还有 5 张图没有打标");
    // 门禁在服务层就拦住了，根本不会去跑"半套标签"的分析
    expect(suggest.analyze).not.toHaveBeenCalled();
  });

  it("打完标后，服务层的拒绝理由也能原样传到界面", async () => {
    countsState.untagged = 0;
    suggest.analyze.mockRejectedValueOnce(
      new Error(
        "CCIP 模型已就位，但还没有生成角色特征（全库需要先算一次）。请在「角色识别」页点「获取全库角色特征」。"
      )
    );

    await expect(
      call(analyzeUnnamedCharacters, { dryRun: true })
    ).rejects.toThrow("还没有生成角色特征");
  });
});
