import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AboutAuthor, AboutProjectAuthor } from "@/components/about/about-author";
import { AboutGallery } from "@/components/about/about-gallery";
import {
  APP_REPOSITORY_URL,
  AUTHOR_HOMEPAGE_URL,
} from "@/config/private-build";
import { UiPreferencesContext } from "@/contexts/ui-preferences-context";
import { Route } from "@/routes/settings.about";

const DEPENDENCIES_LABEL = /settingsDependencies/;

const mocks = vi.hoisted(() => ({
  version: vi.fn(),
  confetti: vi.fn(),
  openExternalLink: vi.fn(),
}));
vi.mock("@/ipc/manager", () => ({
  ipc: { client: { app: { appVersion: mocks.version } } },
}));
// 自用（需求 8）：拦下"打开外部链接"，用来断言点击行为
vi.mock("@/actions/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/actions/shell")>()),
  openExternalLink: mocks.openExternalLink,
}));
vi.mock("@/hooks/useRouteScrollRestoration", () => ({
  useRouteScrollRestoration: () => undefined,
}));
vi.mock("@/components/about/about-crowd", () => ({ default: () => <div /> }));
vi.mock("@/components/ConfettiOverlay", () => ({
  ConfettiOverlay: mocks.confetti,
}));
vi.mock("@/components/SignatureOverlay", () => ({
  SignatureOverlay: () => null,
}));
vi.mock("@/components/animated-github-button", () => ({
  // 自用（需求 8）：把 href 暴露出来，断言"本项目主页"跳的是本版本仓库
  AnimatedGitHubButton: ({ href }: { href: string }) => (
    <span data-href={href} data-testid="github-button" />
  ),
}));
vi.mock("@/components/animated-name-loader", () => ({
  AnimatedNameLoader: () => null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.version.mockResolvedValue("2.2.2");
  mocks.confetti.mockReturnValue(null);
});

describe("about gallery", () => {
  it("starts with artwork 3 and restores the selection after hover and focus", () => {
    render(<AboutGallery />);
    const cards = within(screen.getByTestId("about-gallery")).getAllByRole(
      "button"
    );
    expect(cards[2]).toHaveAttribute("aria-pressed", "true");
    fireEvent.mouseEnter(cards[0]);
    expect(cards[0]).toHaveAttribute("data-active", "true");
    fireEvent.mouseLeave(cards[0]);
    expect(cards[2]).toHaveAttribute("data-active", "true");
    fireEvent.click(cards[4]);
    fireEvent.focus(cards[4]);
    fireEvent.mouseEnter(cards[0]);
    expect(cards[0]).toHaveAttribute("data-active", "true");
    fireEvent.mouseLeave(cards[0]);
    fireEvent.blur(cards[4]);
    fireEvent.focus(cards[1]);
    expect(cards[1]).toHaveAttribute("data-active", "true");
    fireEvent.blur(cards[1]);
    expect(cards[4]).toHaveAttribute("data-active", "true");
    expect(cards[4]).toHaveAttribute("aria-pressed", "true");
  });

  it("selects with Enter and Space without opening another view", async () => {
    const user = userEvent.setup();
    render(<AboutGallery />);
    const cards = within(screen.getByTestId("about-gallery")).getAllByRole(
      "button"
    );
    await user.tab();
    expect(cards[0]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(cards[0]).toHaveAttribute("aria-pressed", "true");
    await user.tab();
    await user.keyboard(" ");
    expect(cards[1]).toHaveAttribute("aria-pressed", "true");
  });

  it("replaces a failed image without losing its selection control", () => {
    render(<AboutGallery />);
    fireEvent.error(screen.getAllByRole("img")[2]);
    expect(screen.getByText("aboutImageUnavailable")).toBeVisible();
    expect(
      within(screen.getByTestId("about-gallery")).getAllByRole("button")
    ).toHaveLength(5);
  });

  it("applies reduced motion to both gallery and author", () => {
    const { container } = render(
      <UiPreferencesContext.Provider
        value={{ reduceMotion: true, setReduceMotion: async () => undefined }}
      >
        <AboutGallery />
        <AboutAuthor />
      </UiPreferencesContext.Provider>
    );
    expect(
      container.querySelectorAll('[data-reduced-motion="true"]')
    ).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Uyoung · aboutAuthorHint" })
    ).toBeVisible();
  });
});

describe("about author", () => {
  it("shows a greeting on hover and returns to the author name on leave", () => {
    render(<AboutAuthor />);
    const author = screen.getByRole("button", {
      name: "Uyoung · aboutAuthorHint",
    });
    fireEvent.mouseEnter(author);
    expect(author).toHaveAttribute("data-message", "greeting");
    expect(author).toHaveAccessibleName(
      "aboutAuthorGreeting · aboutAuthorHint"
    );
    fireEvent.click(author);
    expect(author).toHaveAttribute("data-message", "message");
    fireEvent.mouseLeave(author);
    expect(author).toHaveAttribute("data-message", "name");
  });

  it("supports keyboard greeting and message changes without leaving the page", async () => {
    const user = userEvent.setup();
    render(<AboutAuthor />);
    const author = screen.getByRole("button", {
      name: "Uyoung · aboutAuthorHint",
    });
    await user.tab();
    expect(author).toHaveFocus();
    expect(author).toHaveAttribute("data-message", "greeting");
    await user.keyboard("{Enter}");
    expect(author).toHaveAccessibleName("aboutAuthorMessage · aboutAuthorHint");
    await user.keyboard(" ");
    expect(author).toHaveAttribute("data-message", "greeting");
    await user.tab();
    expect(author).toHaveAttribute("data-message", "name");
  });
});

it("keeps the version easter egg and accessible dependency disclosure", async () => {
  const Page = Route.options.component;
  if (!Page) {
    throw new Error("About route is missing");
  }
  const { container } = render(<Page />);
  expect(container.querySelector(".about-identity")).toBeNull();
  await screen.findByText("2.2.2");
  const version = screen.getByRole("button", { name: "settingsVersion" });
  for (let i = 0; i < 6; i++) {
    fireEvent.click(version);
  }
  expect(mocks.confetti.mock.lastCall?.[0].active).toBe(false);
  fireEvent.click(version);
  expect(mocks.confetti.mock.lastCall?.[0].active).toBe(true);
  const deps = screen.getByRole("button", {
    name: DEPENDENCIES_LABEL,
  });
  fireEvent.click(deps);
  expect(deps).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Electron")).toBeVisible();
});

describe("about links (自用需求 8)", () => {
  it("sends the project-home button to this version's own repository", async () => {
    const Page = Route.options.component;
    if (!Page) {
      throw new Error("About route is missing");
    }
    render(<Page />);

    const hrefs = (await screen.findAllByTestId("github-button")).map((node) =>
      node.getAttribute("data-href")
    );
    expect(hrefs).toContain(APP_REPOSITORY_URL);
    // 个人主页不再挂在按钮上（改到作者名字上了）
    expect(hrefs).not.toContain(AUTHOR_HOMEPAGE_URL);
  });

  it("shows the homepage address on hover and opens it from the author name", () => {
    render(<AboutProjectAuthor />);
    const author = screen.getByRole("button", {
      name: "ASakurafoxA · aboutProjectAuthorHint",
    });

    expect(author).toHaveAttribute("data-message", "name");

    fireEvent.mouseEnter(author);
    // 悬停时显示的"紫色内容"就是个人主页网址
    expect(author).toHaveAttribute("data-message", "homepage");
    expect(author).toHaveAccessibleName(
      `${AUTHOR_HOMEPAGE_URL} · aboutProjectAuthorHint`
    );

    fireEvent.click(author);
    expect(mocks.openExternalLink).toHaveBeenCalledWith(AUTHOR_HOMEPAGE_URL);

    fireEvent.mouseLeave(author);
    expect(author).toHaveAttribute("data-message", "name");
  });
});
