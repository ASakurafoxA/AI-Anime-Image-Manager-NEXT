import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SelectionActionBar } from "@/components/SelectionActionBar";
import { PRIVATE_BUILD } from "@/config/private-build";

/**
 * ⚠️ 自用版：`PRIVATE_BUILD.hideCull === true` 会把「选片」整个隐藏，
 * 于是"更多操作"按钮**根本不渲染**（`SelectionActionBar.tsx` 里
 * `!PRIVATE_BUILD.hideCull && onStartCull` 才是显示条件）。
 *
 * 所以下面两条上游测试测的是**本版故意不提供的功能** → 跳过，
 * 避免每次跑测试都被误判为"改坏了"。上游行为在 hideCull=false 的版本里另有覆盖。
 */
const cullUiAvailable = !PRIVATE_BUILD.hideCull;

const { translate } = vi.hoisted(() => ({
  translate: vi.fn((key: string, options?: Record<string, unknown>) => {
    const values: Record<string, string> = {
      clearSelection: "清除选择",
      cullRequiresTwoPhotos: "至少选择两张图片才能开始筛选",
      cullStart: "开始筛选",
      moreActions: "更多操作",
      selectedPhotos: "已选 {{count}} 张",
    };
    const value = values[key] ?? key;
    return options
      ? Object.entries(options).reduce(
          (text, [name, option]) =>
            text.replace(new RegExp(`{{${name}}}`, "g"), String(option)),
          value
        )
      : value;
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));

function renderSelectionActionBar(
  selectedCount: number,
  onStartCull: () => void
) {
  render(
    <SelectionActionBar
      onClearSelection={vi.fn()}
      onStartCull={onStartCull}
      selectedCount={selectedCount}
    />
  );
}

describe("SelectionActionBar", () => {
  it.skipIf(!cullUiAvailable)("disables culling below two selected photos and explains why", async () => {
    const user = userEvent.setup();
    const onStartCull = vi.fn();
    renderSelectionActionBar(1, onStartCull);

    await user.click(screen.getByRole("button", { name: "更多操作" }));

    const cullAction = await screen.findByRole("button", { name: "开始筛选" });
    expect(cullAction).toBeDisabled();
    await user.click(cullAction);
    expect(onStartCull).not.toHaveBeenCalled();

    const tooltipTrigger = cullAction.parentElement;
    expect(tooltipTrigger).not.toBeNull();
    if (!tooltipTrigger) {
      return;
    }
    expect(tooltipTrigger).toHaveAttribute("tabindex", "0");

    fireEvent.focus(tooltipTrigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "至少选择两张图片才能开始筛选"
    );
  });

  it.skipIf(!cullUiAvailable)("keeps culling available with two selected photos", async () => {
    const user = userEvent.setup();
    const onStartCull = vi.fn();
    renderSelectionActionBar(2, onStartCull);

    await user.click(screen.getByRole("button", { name: "更多操作" }));

    const cullAction = await screen.findByRole("button", { name: "开始筛选" });
    expect(cullAction).toBeEnabled();
    await user.click(cullAction);

    expect(onStartCull).toHaveBeenCalledOnce();
  });
});
