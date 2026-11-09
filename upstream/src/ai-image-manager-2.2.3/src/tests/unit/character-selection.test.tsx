import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterDiscoveryDialog } from "@/components/character-discovery-dialog";
import { CharacterMissingDialog } from "@/components/character-missing-dialog";
import { ManualRolesSection } from "@/components/manual-roles-section";

/**
 * 自用（2026-11-08 · 会话#11）—— 用户实测反馈的三件事的回归用例：
 *   ① 角色图集里**右键菜单**飘走、不在鼠标位置（`fixed` 被祖先 transform 改了参照系）；
 *   ② 两个识别列表里 **≤5 张就选不了**（原来只有 >5 张才有「展开」）；
 *   ③ 一两百张里只想排除几张时 **没有一键「全选」**。
 */
const mocks = vi.hoisted(() => ({
  getCharacterFeatureStatus: vi.fn(),
  getCharacterGroupPhotos: vi.fn(),
  getStoredCharacterGroups: vi.fn(),
  listTagPhotos: vi.fn(),
}));

vi.mock("@/actions/faces", () => ({
  faceActions: {
    buildCharacterFeatures: vi.fn(),
    cancelCharacterFeatures: vi.fn(),
    clearStoredCharacterGroups: vi.fn(),
    discoverUnnamedCharacterGroups: vi.fn(),
    getCharacterClusterProgress: vi.fn(),
    getCharacterFeatureProgress: vi.fn(),
    getCharacterFeatureStatus: mocks.getCharacterFeatureStatus,
    getCharacterGroupPhotos: mocks.getCharacterGroupPhotos,
    getStoredCharacterGroups: mocks.getStoredCharacterGroups,
    listTagPhotos: mocks.listTagPhotos,
    nameCharacterGroup: vi.fn(),
    searchCharacterTags: vi.fn(),
    setManualRoleCover: vi.fn(),
  },
}));

function photo(id: number) {
  return {
    fileSize: 1024,
    filename: `${id}.png`,
    height: 100,
    id,
    path: `F:\\图库\\${id}.png`,
    thumbnailPath: `F:\\图库\\thumbs\\${id}.webp`,
    width: 100,
  };
}

function discoveryGroup(ids: number[]) {
  return {
    meanSimilarity: 0.95,
    namedTagId: null,
    namedTagName: null,
    photoIds: ids,
    representativeId: ids[0],
    size: ids.length,
    thumbnails: ids.slice(0, 5).map((id) => `F:\\图库\\thumbs\\${id}.webp`),
  };
}

function renderDiscovery() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CharacterDiscoveryDialog onOpenChange={vi.fn()} open />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCharacterFeatureStatus.mockResolvedValue({
    message: null,
    modelAvailable: true,
    preferCcip: true,
    reason: "ready",
    source: "ccip",
    vectorCount: 100,
  });
  mocks.getStoredCharacterGroups.mockResolvedValue({ groups: [] });
});

afterEach(() => {
  cleanup();
});

describe("① 角色图集右键菜单贴在鼠标位置", () => {
  it("菜单 portal 到 body，left/top 用鼠标坐标（不再被祖先 transform 平移）", async () => {
    mocks.listTagPhotos.mockResolvedValue({ photos: [photo(51), photo(52)] });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ManualRolesSection
          roles={[
            {
              createdAt: 1,
              photoCount: 2,
              representativePhotoId: 51,
              tagId: 7,
              tagName: "大升麻",
              thumbnailPath: "F:\\图库\\thumbs\\51.webp",
            },
          ]}
        />
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByText("manualRolesExpand"));
    await waitFor(() =>
      expect(container.querySelectorAll("img")).toHaveLength(2)
    );

    fireEvent.contextMenu(container.querySelectorAll("img")[0], {
      clientX: 500,
      clientY: 300,
    });

    const menuLabel = await screen.findByText("manualRolesSetCover");
    // 文本节点挂在 <button> 上，再往上一层就是菜单容器本身
    const menu = menuLabel.parentElement as HTMLElement;
    // portal 到 body → 不受 `.album-view-enter` 的 transform 影响
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.left).toBe("500px");
    expect(menu.style.top).toBe("300px");
  });
});

describe("② ≤5 张也能直接在小图上勾选", () => {
  it("「识别漏标签」小分组：没有展开按钮，但小图上有勾选圈，且只打勾选的图", async () => {
    mocks.getCharacterGroupPhotos.mockResolvedValue({
      photos: [photo(11), photo(12), photo(13)],
    });
    const onApply = vi.fn();
    render(
      <CharacterMissingDialog
        analyzing={false}
        applied={{}}
        applying={null}
        onApply={onApply}
        onOpenChange={vi.fn()}
        open
        rows={[
          {
            count: 3,
            meanSimilarity: 0.95,
            photoIds: [11, 12, 13],
            tagId: 42,
            tagName: "大升麻",
            thumbnails: ["/a.webp", "/b.webp", "/c.webp"],
          },
        ]}
      />
    );

    // ≤5 张：不再出现「展开」
    expect(screen.queryByText("characterDiscoveryExpand")).toBeNull();

    const circles = await screen.findAllByLabelText(
      "characterDiscoveryToggleSelect"
    );
    expect(circles).toHaveLength(3);

    // 只勾第 2 张 → 只打这一张（≤5 张没法全选，就是单选，这是对的）
    fireEvent.click(circles[1]);
    await waitFor(() =>
      expect(circles[1]).toHaveAttribute("aria-pressed", "true")
    );
    fireEvent.click(screen.getByText("characterDiscoveryNameSelectedApply"));

    expect(onApply).toHaveBeenCalledTimes(1);
    const [, ids] = onApply.mock.calls[0] as [unknown, number[]];
    expect(ids).toEqual([12]);
  });

  it("「识别漏标签」小分组：勾了又全部取消 → 回到「整组打标」的老口径", async () => {
    mocks.getCharacterGroupPhotos.mockResolvedValue({
      photos: [photo(11), photo(12), photo(13)],
    });
    const onApply = vi.fn();
    render(
      <CharacterMissingDialog
        analyzing={false}
        applied={{}}
        applying={null}
        onApply={onApply}
        onOpenChange={vi.fn()}
        open
        rows={[
          {
            count: 3,
            meanSimilarity: 0.95,
            photoIds: [11, 12, 13],
            tagId: 42,
            tagName: "大升麻",
            thumbnails: ["/a.webp", "/b.webp", "/c.webp"],
          },
        ]}
      />
    );

    const circles = await screen.findAllByLabelText(
      "characterDiscoveryToggleSelect"
    );
    fireEvent.click(circles[0]);
    await waitFor(() =>
      expect(circles[0]).toHaveAttribute("aria-pressed", "true")
    );
    fireEvent.click(circles[0]);
    await waitFor(() =>
      expect(circles[0]).toHaveAttribute("aria-pressed", "false")
    );

    fireEvent.click(screen.getByText("characterSuggestionApply"));
    expect(onApply).toHaveBeenCalledTimes(1);
    const [, ids] = onApply.mock.calls[0] as [unknown, number[]];
    expect([...ids].sort((a, b) => a - b)).toEqual([11, 12, 13]);
  });

  it("「发现没有标签的角色」小分组同样能在小图上勾选", async () => {
    mocks.getStoredCharacterGroups.mockResolvedValue({
      groups: [discoveryGroup([21, 22, 23])],
    });
    mocks.getCharacterGroupPhotos.mockResolvedValue({
      photos: [photo(21), photo(22), photo(23)],
    });

    renderDiscovery();

    const circles = await screen.findAllByLabelText(
      "characterDiscoveryToggleSelect"
    );
    expect(circles).toHaveLength(3);
    expect(screen.queryByText("characterDiscoveryExpand")).toBeNull();

    fireEvent.click(circles[0]);
    await waitFor(() =>
      expect(circles[0]).toHaveAttribute("aria-pressed", "true")
    );
    // 有勾选后，主按钮变成「命名 N 张」
    expect(screen.getByText("characterDiscoveryNameSelectedApply")).toBeTruthy();
  });
});

describe("③ 展开图集支持一键全选", () => {
  it("「识别漏标签」大分组：展开 → 全选 → 打标用的是整组", async () => {
    const ids = [31, 32, 33, 34, 35, 36, 37];
    mocks.getCharacterGroupPhotos.mockResolvedValue({
      photos: ids.map((id) => photo(id)),
    });
    const onApply = vi.fn();
    render(
      <CharacterMissingDialog
        analyzing={false}
        applied={{}}
        applying={null}
        onApply={onApply}
        onOpenChange={vi.fn()}
        open
        rows={[
          {
            count: ids.length,
            meanSimilarity: 0.95,
            photoIds: ids,
            tagId: 43,
            tagName: "kokoro",
            thumbnails: ids.slice(0, 5).map((id) => `/thumbs/${id}.webp`),
          },
        ]}
      />
    );

    fireEvent.click(await screen.findByText("characterDiscoveryExpand"));
    const circles = await screen.findAllByLabelText(
      "characterDiscoveryToggleSelect"
    );
    expect(circles).toHaveLength(7);

    // 先什么都不选 → 按钮是「打标」；点「全选」后变成 N 张
    fireEvent.click(screen.getByText("manualRolesSelectAll"));
    await waitFor(() => {
      for (const circle of circles) {
        expect(circle).toHaveAttribute("aria-pressed", "true");
      }
    });
    // 全选之后这个按钮就该消失（已经全选中了）
    expect(screen.queryByText("manualRolesSelectAll")).toBeNull();

    fireEvent.click(screen.getByText("characterDiscoveryNameSelectedApply"));
    expect(onApply).toHaveBeenCalledTimes(1);
    const [, appliedIds] = onApply.mock.calls[0] as [unknown, number[]];
    expect([...appliedIds].sort((a, b) => a - b)).toEqual(ids);
  });

  it("「发现没有标签的角色」大分组：展开 → 全选 → 7 张全勾上", async () => {
    const ids = [41, 42, 43, 44, 45, 46, 47];
    mocks.getStoredCharacterGroups.mockResolvedValue({
      groups: [discoveryGroup(ids)],
    });
    mocks.getCharacterGroupPhotos.mockResolvedValue({
      photos: ids.map((id) => photo(id)),
    });

    renderDiscovery();

    fireEvent.click(await screen.findByText("characterDiscoveryExpand"));
    const circles = await screen.findAllByLabelText(
      "characterDiscoveryToggleSelect"
    );
    expect(circles).toHaveLength(7);

    fireEvent.click(screen.getByText("manualRolesSelectAll"));
    await waitFor(() => {
      for (const circle of circles) {
        expect(circle).toHaveAttribute("aria-pressed", "true");
      }
    });
  });
});
