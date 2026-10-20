/** @vitest-environment jsdom */
/**
 * 自用（2026-10-20 · 会话#10）：底部状态栏与顶栏**不能各说各话**。
 *
 * 用户实测：顶栏显示"AI 标签生成 · 已暂停"，右下角却是黄色的"AI 索引中 3%"。
 * 根因：导入后的自动打标是挂在建向量那一轮里的（`isEmbedding` 仍为 true），
 * 而 StatusBar 先判 `isEmbedding`、后判阶段 → 暂停打标被显示成"正在索引"。
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBar } from "@/components/StatusBar";
import type { AiStatus } from "@/types/photo";

function makeStatus(overrides: Partial<AiStatus>): AiStatus {
  return {
    embeddingProgress: { phase: "idle", processed: 0, total: 0 },
    indexReady: false,
    isEmbedding: false,
    vectorCount: 0,
    ...overrides,
  } as AiStatus;
}

function renderBar(aiStatus: AiStatus) {
  return render(
    <StatusBar aiStatus={aiStatus} selectedCount={0} totalPhotos={1358} />
  );
}

describe("StatusBar 的打标状态", () => {
  it("打标暂停时显示「已暂停」，不能显示成「AI 索引中」（isEmbedding 仍为 true）", () => {
    const view = renderBar(
      makeStatus({
        // 自动打标挂在建向量那一轮里：这个标志当然是 true
        isEmbedding: true,
        embeddingProgress: {
          phase: "tagging-paused",
          processed: 136,
          total: 4381,
        },
      })
    );

    expect(view.container.textContent).toContain("aiPaused");
    expect(view.container.textContent).toContain("继续会从断点接着打");
    expect(view.container.textContent).not.toContain("aiIndexingPercent");
  });

  it("打标进行中显示打标文案（不是索引百分比）", () => {
    const view = renderBar(
      makeStatus({
        isEmbedding: true,
        embeddingProgress: { phase: "tagging", processed: 136, total: 4381 },
      })
    );

    expect(view.container.textContent).toContain("正在生成 AI 标签 136/4381");
    expect(view.container.textContent).not.toContain("aiIndexingPercent");
  });

  it("建向量跑着的时候才显示「AI 索引中」", () => {
    const view = renderBar(
      makeStatus({
        isEmbedding: true,
        embeddingProgress: { phase: "embedding", processed: 40, total: 1358 },
      })
    );

    expect(view.container.textContent).toContain("aiIndexingPercent");
    expect(view.container.textContent).not.toContain("aiPaused");
  });
});
