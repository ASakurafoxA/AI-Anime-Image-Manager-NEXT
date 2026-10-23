import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PeoplePage } from "@/routes/people";

/**
 * 人物识别页（2026-10-18 重写后）的形态：
 *   · 只剩新模型（CCIP + 标签）那条链 —— **不再有任何 face/identity 调用** ✓
 *   · 两颗识别按钮受"全库打标完成"门禁约束，灰的时候要写清原因 ✓
 */
const mocks = vi.hoisted(() => ({
  coverage: { complete: true, total: 100, untagged: 0 },
  listManualCharacterRoles: vi.fn(async () => ({ roles: [] })),
  getCharacterFeatureStatus: vi.fn(async () => ({ source: "ccip" })),
  nameCharacterGroup: vi.fn(async () => ({ applied: 2, attempted: 2 })),
}));

vi.mock("@/actions/faces", () => ({
  faceActions: {
    analyzeUnnamedCharacters: vi.fn(),
    buildCharacterFeatures: vi.fn(),
    clearUnnamedCharacterResults: vi.fn(),
    getCharacterClusterProgress: vi.fn(),
    getCharacterFeatureProgress: vi.fn(),
    getCharacterFeatureStatus: mocks.getCharacterFeatureStatus,
    getStoredCharacterGroups: vi.fn(),
    listManualCharacterRoles: mocks.listManualCharacterRoles,
    nameCharacterGroup: mocks.nameCharacterGroup,
  },
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        getTaggingCoverage: vi.fn(async () => mocks.coverage),
      },
      settings: {
        getAppSetting: vi.fn(async () => ({ value: "true" })),
      },
    },
  },
}));

vi.mock("@/hooks/use-global-ai-status", () => ({
  useGlobalAiStatus: () => ({ phase: "idle" }),
}));

vi.mock("@/hooks/useRouteScrollRestoration", () => ({
  useRouteScrollRestoration: () => undefined,
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/components/character-discovery-dialog", () => ({
  CharacterDiscoveryDialog: () => null,
}));

vi.mock("@/components/character-missing-dialog", () => ({
  /*
   * 自用（2026-10-23 · 会话#10）：回归测试用的假弹窗 —— 渲染一个按钮，
   * 点它等于在真实弹窗里点「打标」（onApply 传一行真实数据）。
   */
  CharacterMissingDialog: (props: {
    onApply: (
      row: { tagId: number; tagName: string; count: number; photoIds: number[] },
      ids: number[]
    ) => void;
  }) => (
    <button
      onClick={() =>
        props.onApply(
          { tagId: 42, tagName: "凯露", count: 2, photoIds: [7, 8] },
          []
        )
      }
      type="button"
    >
      apply-missing
    </button>
  ),
}));

vi.mock("@/components/manual-roles-section", () => ({
  ManualRolesSection: () => <div data-testid="manual-roles" />,
}));

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => null,
  createFileRoute: () => (options: unknown) => options,
  useRouterState: () => false,
  useNavigate: () => () => undefined,
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PeoplePage />
    </QueryClientProvider>
  );
}

describe("PeoplePage（新模型版）", () => {
  beforeEach(() => {
    mocks.coverage = { complete: true, total: 100, untagged: 0 };
    vi.clearAllMocks();
  });

  it("显示合并后的「角色识别」入口与「获取全库角色特征」", async () => {
    renderPage();
    expect(
      await screen.findByRole("button", { name: "characterFeatureBuild" })
    ).toBeTruthy();
    /*
     * 自用（2026-10-23 · 会话#10）：两颗识别按钮合成一个「角色识别」入口，
     * 两项操作（发现新角色 / 给已有角色补漏）在菜单里，不再是常驻按钮。
     */
    expect(
      screen.getByRole("button", { name: /characterRecognitionMenu/ })
    ).toBeTruthy();
  });

  it("全库打标没完成时，识别入口禁用并写明原因", async () => {
    mocks.coverage = { complete: false, total: 100, untagged: 7 };
    renderPage();

    const entry = await screen.findByRole("button", {
      name: /characterRecognitionMenu/,
    });
    expect((entry as HTMLButtonElement).disabled).toBe(true);
    // 提示行由 i18n 键渲染（测试环境里 t 直接返回键名）
    expect(screen.getByText(/peopleTaggingGateHint/)).toBeTruthy();
  });

  it("「给已有角色补漏」点打标时按 tagId 复用已有标签（不再只传名字）", async () => {
    renderPage();
    const apply = await screen.findByRole("button", { name: "apply-missing" });
    fireEvent.click(apply);
    await waitFor(() =>
      expect(mocks.nameCharacterGroup).toHaveBeenCalledWith({
        tagId: 42,
        name: "凯露",
        photoIds: [7, 8],
      })
    );
  });
});
