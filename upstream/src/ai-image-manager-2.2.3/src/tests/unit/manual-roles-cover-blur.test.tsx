import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ALBUM_BAR_SLOT_ID,
  ManualRolesSection,
} from "@/components/manual-roles-section";

/**
 * 2026-11-15（会话#13）：「我创建的角色」卡片右键 → 模糊化封面。
 * 用户口径：「给创建的角色相册增加右键选择模糊化封面的功能」。
 * 这里只守两件事：右键能弹出菜单、点它确实把开关发出去（真正的落库在 store 里）。
 */
const setManualRoleCoverBlur = vi.fn(
  async (_input: { blurred: boolean; tagId: number }) => ({ updated: true })
);

/*
 * 2026-11-15（会话#13）：「减少动画」开关要能管住模糊过渡。
 * 用 vi.hoisted 保证工厂能安全读到这个可变状态（vi.mock 会被提升到 import 之前）。
 */
const motionState = vi.hoisted(() => ({ reduced: false }));

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => motionState.reduced,
}));

vi.mock("@/actions/faces", () => ({
  faceActions: {
    deleteManualCharacterRole: vi.fn(),
    listTagPhotos: vi.fn(async () => ({ photos: [] })),
    removeTagFromPhotos: vi.fn(),
    renameManualCharacterRole: vi.fn(),
    setManualRoleCover: vi.fn(),
    setManualRoleCoverBlur: (input: { blurred: boolean; tagId: number }) =>
      setManualRoleCoverBlur(input),
  },
}));

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>
  );
}

const baseRole = {
  createdAt: 0,
  photoCount: 3,
  representativePhotoId: 5,
  tagId: 7,
  tagName: "test-role",
  thumbnailPath: "F:\\gallery\\thumbs\\a.webp",
};

describe("我创建的角色 · 右键模糊化封面", () => {
  it("右键卡片 → 点「模糊化封面」→ 发出 blurred: true", async () => {
    setManualRoleCoverBlur.mockClear();
    renderWithQuery(<ManualRolesSection roles={[baseRole]} />);

    const nameNode = screen.getByText("test-role");
    const card = nameNode.closest("div[class*='rounded-[10px]']");
    expect(card).toBeTruthy();
    fireEvent.contextMenu(card as HTMLElement);

    const item = await screen.findByText("manualRolesBlurCover");
    fireEvent.click(item);

    await waitFor(() =>
      expect(setManualRoleCoverBlur).toHaveBeenCalledWith({
        blurred: true,
        tagId: 7,
      })
    );
  });

  it("已经模糊过的角色 → 菜单文案变成「取消模糊化」，封面带 blur-sm", () => {
    renderWithQuery(
      <ManualRolesSection roles={[{ ...baseRole, coverBlurred: true }]} />
    );

    const nameNode = screen.getByText("test-role");
    const card = nameNode.closest("div[class*='rounded-[10px]']") as HTMLElement;
    fireEvent.contextMenu(card);
    expect(screen.getByText("manualRolesUnblurCover")).toBeTruthy();

    const image = card.querySelector("img");
    expect(image?.className).toContain("blur-sm");
    // 默认（动画开着）要有过渡类；只过渡 filter（不再带 transform，避免解除模糊时"抽一下"）
    expect(image?.className).toContain("transition-[filter]");
    expect(image?.className).not.toContain("scale-105");
  });

  it("「减少动画」开着时，不加模糊过渡（受设置管控）", () => {
    motionState.reduced = true;
    try {
      renderWithQuery(
        <ManualRolesSection roles={[{ ...baseRole, coverBlurred: true }]} />
      );
      const nameNode = screen.getByText("test-role");
      const card = nameNode.closest(
        "div[class*='rounded-[10px]']"
      ) as HTMLElement;
      const image = card.querySelector("img");
      expect(image?.className).toContain("blur-sm");
      expect(image?.className).not.toContain("transition-[filter");
    } finally {
      motionState.reduced = false;
    }
  });

  it("展开图集时，操作栏渲染到页面顶部挂载点（不是悬空条）", async () => {
    renderWithQuery(
      <div>
        <div data-testid="album-bar-slot" id={ALBUM_BAR_SLOT_ID} />
        <ManualRolesSection roles={[baseRole]} />
      </div>
    );

    fireEvent.click(screen.getByText("manualRolesExpand"));

    await waitFor(() => {
      const slot = screen.getByTestId("album-bar-slot");
      expect(slot.textContent ?? "").toContain("manualRolesBackToList");
    });
  });
});
