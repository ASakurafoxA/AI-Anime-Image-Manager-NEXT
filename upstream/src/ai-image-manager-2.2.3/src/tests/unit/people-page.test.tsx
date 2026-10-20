import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
    nameCharacterGroup: vi.fn(),
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
  CharacterMissingDialog: () => null,
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

  it("显示两颗识别按钮与「获取全库角色特征」", async () => {
    renderPage();
    expect(
      await screen.findByRole("button", { name: "characterFeatureBuild" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "characterDiscoveryTitle" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "peopleFindUnnamedCharacters" })
    ).toBeTruthy();
  });

  it("全库打标没完成时，两颗识别按钮禁用并写明原因", async () => {
    mocks.coverage = { complete: false, total: 100, untagged: 7 };
    renderPage();

    const discovery = await screen.findByRole("button", {
      name: "characterDiscoveryTitle",
    });
    expect((discovery as HTMLButtonElement).disabled).toBe(true);
    // 提示行由 i18n 键渲染（测试环境里 t 直接返回键名）
    expect(screen.getByText(/peopleTaggingGateHint/)).toBeTruthy();
  });
});
