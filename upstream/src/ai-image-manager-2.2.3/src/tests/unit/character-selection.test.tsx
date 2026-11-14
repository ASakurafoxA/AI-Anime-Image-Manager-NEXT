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

describe("⑤ 命名后缩略图不会炸开（2026-11-14 · 会话#12 回归）", () => {
  it("缓存里是命名前那几十张、组只剩 5 张时，只渲染组内这 5 张", async () => {
    mocks.getStoredCharacterGroups.mockResolvedValue({
      groups: [
        {
          ...discoveryGroup([1, 2, 3, 4, 5]),
          maxPersonCount: 1,
          multiPhotoCount: 0,
        },
      ],
    });
    // 模拟"展开过的组"：缓存接口一次回 40 张（含组外照片）
    mocks.getCharacterGroupPhotos.mockResolvedValue({
      photos: Array.from({ length: 40 }, (_, index) => photo(index + 1)),
    });

    renderDiscovery();

    await waitFor(() => {
      const circles = screen.queryAllByLabelText("characterDiscoveryToggleSelect");
      // 不按 group.photoIds 过滤的话这里会是 40 → 用户看到的"炸开"
      expect(circles).toHaveLength(5);
    });
  });
});

describe("④ 多人组可以一次命名多个角色（2026-11-14 · 会话#12）", () => {
  it("多选名字：输入后点「添加」变成 chip，提交时把多个名字一起发出去", async () => {
    const { faceActions } = await import("@/actions/faces");
    const nameMock = vi.mocked(faceActions.nameCharacterGroup);
    nameMock.mockResolvedValue({
      applied: 5,
      attempted: 6,
      tagId: 101,
      tagName: "甲",
      tags: [
        { applied: 5, attempted: 6, tagId: 101, tagName: "甲" },
        { applied: 2, attempted: 3, tagId: 102, tagName: "乙" },
      ],
      namedAll: true,
      remaining: 0,
    } as never);
    mocks.getStoredCharacterGroups.mockResolvedValue({
      groups: [
        {
          ...discoveryGroup([31, 32, 33]),
          maxPersonCount: 2,
          multiPhotoCount: 2,
        },
      ],
    });

    renderDiscovery();

    // 多人组会显示"可多选名字"的输入框（只有一个，不是一列）
    const extraInput = await screen.findByPlaceholderText(
      "characterDiscoveryExtraNamePlaceholder"
    );
    expect(screen.getAllByPlaceholderText("characterDiscoveryExtraNamePlaceholder")).toHaveLength(1);

    fireEvent.change(screen.getByPlaceholderText("characterDiscoveryNamePlaceholder"), {
      target: { value: "甲" },
    });
    // 输入第二个名字 → 点「添加」→ 变成 chip
    fireEvent.change(extraInput, { target: { value: "乙" } });
    fireEvent.click(screen.getByText("characterDiscoveryAddName"));
    await waitFor(() => expect(screen.getByText("乙")).toBeTruthy());
    // 这一组最多 2 人 → 加满 1 个附加名字后，输入框收起（不再继续加）
    expect(
      screen.queryByPlaceholderText("characterDiscoveryExtraNamePlaceholder")
    ).toBeNull();

    fireEvent.click(screen.getByText("characterDiscoveryNameApply"));

    await waitFor(() => expect(nameMock).toHaveBeenCalledTimes(1));
    const payload = nameMock.mock.calls[0][0] as {
      targets: Array<{ name?: string; tagId?: number }>;
      photoIds: number[];
    };
    expect(payload.targets).toEqual([{ name: "甲" }, { name: "乙" }]);
    expect(payload.photoIds).toEqual([31, 32, 33]);
  });

  it("只填一个名字（不加 chip）→ 按单人处理，targets 只有一个", async () => {
    const { faceActions } = await import("@/actions/faces");
    const nameMock = vi.mocked(faceActions.nameCharacterGroup);
    nameMock.mockResolvedValue({
      applied: 3,
      attempted: 3,
      tagId: 201,
      tagName: "甲",
      tags: [{ applied: 3, attempted: 3, tagId: 201, tagName: "甲" }],
      namedAll: true,
      remaining: 0,
    } as never);
    mocks.getStoredCharacterGroups.mockResolvedValue({
      groups: [
        { ...discoveryGroup([51, 52, 53]), maxPersonCount: 3, multiPhotoCount: 2 },
      ],
    });

    renderDiscovery();
    await screen.findByPlaceholderText("characterDiscoveryExtraNamePlaceholder");
    fireEvent.change(screen.getByPlaceholderText("characterDiscoveryNamePlaceholder"), {
      target: { value: "甲" },
    });
    fireEvent.click(screen.getByText("characterDiscoveryNameApply"));

    await waitFor(() => expect(nameMock).toHaveBeenCalledTimes(1));
    const payload = nameMock.mock.calls[0][0] as {
      targets: Array<{ name?: string; tagId?: number }>;
    };
    expect(payload.targets).toEqual([{ name: "甲" }]);
  });

  it("名字 chip 可以移除", async () => {
    mocks.getStoredCharacterGroups.mockResolvedValue({
      groups: [
        { ...discoveryGroup([61, 62]), maxPersonCount: 3, multiPhotoCount: 1 },
      ],
    });

    renderDiscovery();
    const extraInput = await screen.findByPlaceholderText(
      "characterDiscoveryExtraNamePlaceholder"
    );
    fireEvent.change(extraInput, { target: { value: "乙" } });
    fireEvent.click(screen.getByText("characterDiscoveryAddName"));
    await waitFor(() => expect(screen.getByText("乙")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("characterDiscoveryRemoveName"));
    await waitFor(() => expect(screen.queryByText("乙")).toBeNull());
  });

  it("附加名字框也能检索已有标签：点建议 → 用 tagId（不新建同名标签）", async () => {
    const { faceActions } = await import("@/actions/faces");
    vi.mocked(faceActions.searchCharacterTags).mockResolvedValue({
      matches: [{ id: 900, name: "初音未来 (hatsune_miku)", rootName: "角色" }],
      total: 1,
    } as never);
    const nameMock = vi.mocked(faceActions.nameCharacterGroup);
    nameMock.mockResolvedValue({
      applied: 2,
      attempted: 2,
      tagId: 101,
      tagName: "甲",
      tags: [
        { applied: 2, attempted: 2, tagId: 101, tagName: "甲" },
        { applied: 1, attempted: 1, tagId: 900, tagName: "初音未来 (hatsune_miku)" },
      ],
      namedAll: true,
      remaining: 0,
    } as never);
    mocks.getStoredCharacterGroups.mockResolvedValue({
      groups: [
        { ...discoveryGroup([71, 72]), maxPersonCount: 3, multiPhotoCount: 1 },
      ],
    });

    renderDiscovery();
    const extraInput = await screen.findByPlaceholderText(
      "characterDiscoveryExtraNamePlaceholder"
    );
    fireEvent.change(extraInput, { target: { value: "初音" } });

    // 250ms 防抖后出建议；点它 → 变成 chip
    const suggestion = await screen.findByText(/初音未来/);
    fireEvent.click(suggestion);
    await waitFor(() => expect(screen.getByText(/初音未来/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText("characterDiscoveryNamePlaceholder"), {
      target: { value: "甲" },
    });
    fireEvent.click(screen.getByText("characterDiscoveryNameApply"));

    await waitFor(() => expect(nameMock).toHaveBeenCalledTimes(1));
    const payload = nameMock.mock.calls[0][0] as {
      targets: Array<{ name?: string; tagId?: number }>;
    };
    // 已有标签走 tagId，手输的才是 name
    expect(payload.targets).toEqual([{ name: "甲" }, { tagId: 900 }]);
  });

  it("全是单人的组：不出现多名字输入框（只命名一个）", async () => {
    mocks.getStoredCharacterGroups.mockResolvedValue({
      groups: [{ ...discoveryGroup([41, 42]), maxPersonCount: 1, multiPhotoCount: 0 }],
    });

    renderDiscovery();

    await screen.findByPlaceholderText("characterDiscoveryNamePlaceholder");
    expect(
      screen.queryByPlaceholderText("characterDiscoveryExtraNamePlaceholder")
    ).toBeNull();
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
    // 勾了第 2 张 → 按钮固定叫「打标」（补漏这边不再显示"命名选中的 N 张"）
    fireEvent.click(screen.getByText("characterSuggestionApply"));

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
    // 有勾选后主按钮文案**不变**（数字提示已去掉，2026-11-14 · 会话#12）
    expect(screen.getByText("characterDiscoveryNameApply")).toBeTruthy();
    expect(screen.queryByText("characterDiscoveryNameSelectedApply")).toBeNull();
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

    // 什么都不选也点得动 → 按钮固定是「打标」（数字提示已去掉，2026-11-14 · 会话#12）
    fireEvent.click(screen.getByText("characterSingleNamedSelectAll"));
    await waitFor(() => {
      for (const circle of circles) {
        expect(circle).toHaveAttribute("aria-pressed", "true");
      }
    });
    // 三个按钮是常驻的（不再"全选后消失"）
    expect(screen.getByText("characterSingleNamedInvert")).toBeTruthy();
    expect(screen.getByText("characterSingleNamedSelectNone")).toBeTruthy();

    fireEvent.click(screen.getByText("characterSuggestionApply"));
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

    /*
     * 2026-11-14（会话#12）：工具条与「多人图只认出一个名字」统一 ——
     * 左边保留说明文字，右边固定「已选 N/M + 全选 / 反选 / 清空」三个按钮。
     */
    expect(screen.getByText("characterDiscoverySelectHint")).toBeTruthy();
    expect(screen.getByText("characterSingleNamedInvert")).toBeTruthy();
    expect(screen.getByText("characterSingleNamedSelectNone")).toBeTruthy();

    fireEvent.click(screen.getByText("characterSingleNamedSelectAll"));
    await waitFor(() => {
      for (const circle of circles) {
        expect(circle).toHaveAttribute("aria-pressed", "true");
      }
    });

    // 反选 → 全勾变全不勾（回到"整组"语义）
    fireEvent.click(screen.getByText("characterSingleNamedInvert"));
    await waitFor(() => {
      for (const circle of circles) {
        expect(circle).toHaveAttribute("aria-pressed", "false");
      }
    });
  });
});
