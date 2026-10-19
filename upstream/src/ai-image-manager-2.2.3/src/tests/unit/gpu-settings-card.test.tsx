import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GpuSettingsCard } from "@/components/gpu-settings-card";
import { ipc } from "@/ipc/manager";

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      settings: {
        checkGpuCapability: vi.fn(),
        getGpuSettings: vi.fn(),
        getGpuSpeeds: vi.fn().mockResolvedValue({ speeds: [] }),
        setGpuSettings: vi.fn(),
      },
    },
  },
}));

describe("GpuSettingsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipc.client.settings.getGpuSettings).mockResolvedValue({
      detected: null,
      deviceId: "auto",
      enabled: false,
      promptShown: false,
      searchImageSource: "thumbnail",
      deviceIds: [],
      multiGpuEnabled: false,
      effectiveDevices: [],
    });
  });

  it("reports its loaded state and hides the separate save action in onboarding mode", async () => {
    const onEnabledChange = vi.fn();
    const onLoaded = vi.fn();

    render(
      <GpuSettingsCard
        hideSaveButton
        onEnabledChange={onEnabledChange}
        onLoaded={onLoaded}
      />
    );

    await waitFor(() => {
      expect(onLoaded).toHaveBeenCalledOnce();
    });
    expect(onEnabledChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("淇濆瓨")).not.toBeInTheDocument();
  });

  it("reports detection work and the enabled state to the onboarding parent", async () => {
    const onBusyChange = vi.fn();
    const onEnabledChange = vi.fn();
    vi.mocked(ipc.client.settings.checkGpuCapability).mockResolvedValue({
      dmlAvailable: true,
      gpuName: "Test GPU",
      probeTimeMs: 12,
    });

    render(
      <GpuSettingsCard
        hideSaveButton
        onBusyChange={onBusyChange}
        onEnabledChange={onEnabledChange}
      />
    );

    await screen.findByText("gpuDetect");
    onBusyChange.mockClear();
    onEnabledChange.mockClear();
    fireEvent.click(screen.getByText("gpuDetect"));

    await waitFor(() => {
      expect(onEnabledChange).toHaveBeenCalledWith(true);
    });
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it("shows DirectML image embedding as active when its probe succeeds", async () => {
    vi.mocked(ipc.client.settings.getGpuSettings).mockResolvedValue({
      detected: {
        dmlAvailable: false,
        embeddingDmlAvailable: true,
        embeddingProbeTimeMs: 34,
        probeTimeMs: 12,
      },
      deviceId: "auto",
      enabled: true,
      promptShown: true,
      searchImageSource: "thumbnail",
      deviceIds: [],
      multiGpuEnabled: false,
      effectiveDevices: [],
    });

    render(<GpuSettingsCard hideSaveButton />);
    await waitFor(() => {
      expect(screen.getByText("gpuStatusActive")).toBeInTheDocument();
    });
  });

  /*
   * 自用（2026-10-17，用户口径）：「**角色识别是需要 GPU 的**」——
   * 这一行从人脸检测池**迁移到 CCIP**：判据是通用 DML 探测结论 `dmlAvailable` ✓
   * 下面这条只给 `dmlAvailable: true`（**不给** embeddingDmlAvailable），
   * 能出现「GPU 加速中」就说明「角色识别」那行确实是靠 dmlAvailable 亮起来的 ✓
   */
  it("shows the detected real GPU name without changing DirectML status", async () => {
    vi.mocked(ipc.client.settings.getGpuSettings).mockResolvedValue({
      detected: {
        dmlAvailable: true,
        gpuName: "NVIDIA GeForce RTX 4060 Laptop GPU",
        probeTimeMs: 34,
      },
      deviceId: "auto",
      enabled: true,
      promptShown: true,
      searchImageSource: "thumbnail",
      deviceIds: [],
      multiGpuEnabled: false,
      effectiveDevices: [],
    });

    render(<GpuSettingsCard hideSaveButton />);

    await waitFor(() => {
      expect(
        screen.getByText("NVIDIA GeForce RTX 4060 Laptop GPU")
      ).toBeInTheDocument();
    });
    // 两个状态行都在：角色识别（CCIP）+ 图像嵌入
    expect(screen.getByText("gpuStatusCharacter")).toBeInTheDocument();
    expect(screen.getByText("gpuStatusEmbed")).toBeInTheDocument();
    expect(screen.getByText("gpuStatusActive")).toBeInTheDocument();
  });

  it("shows CPU fallback after an embedding probe failure without claiming GPU use", async () => {
    vi.mocked(ipc.client.settings.getGpuSettings).mockResolvedValue({
      detected: {
        dmlAvailable: false,
        embeddingDmlAvailable: false,
        embeddingError: "model incompatible",
        probeTimeMs: 12,
      },
      deviceId: "auto",
      enabled: true,
      promptShown: true,
      searchImageSource: "thumbnail",
      deviceIds: [],
      multiGpuEnabled: false,
      effectiveDevices: [],
    });

    render(<GpuSettingsCard hideSaveButton />);

    await waitFor(() => {
      expect(screen.getByText("gpuStatusProbeFailed")).toBeInTheDocument();
    });
    expect(screen.queryByText("gpuStatusActive")).not.toBeInTheDocument();
  });

  /**
   * ⚠️ 原「AI 占用限制」滑块已按用户要求**整体删除**（PWM 式限速对偶发高负载没用），
   * 所以这条测试只再校验"特征来源"与多卡字段是否随保存一起发出。
   */
  it("saves the feature source together with the selected GPU", async () => {
    render(<GpuSettingsCard />);

    // 默认缩略图（快）：下拉框有选项可开
    const sourceSelect = await screen.findByLabelText("searchImageSourceTitle");
    expect(sourceSelect).toBeInTheDocument();
    // 滑块应当**不存在**了
    expect(screen.queryByLabelText("throttleTitle")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(ipc.client.settings.setGpuSettings).toHaveBeenCalledWith({
        deviceId: "auto",
        enabled: false,
        searchImageSource: "thumbnail",
      });
    });
  });

  it("sends the original-photo source when the user picks higher fidelity", async () => {
    render(<GpuSettingsCard />);

    fireEvent.click(await screen.findByLabelText("searchImageSourceTitle"));
    fireEvent.click(
      screen.getByRole("option", { name: "searchImageSourceOriginal" })
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(ipc.client.settings.setGpuSettings).toHaveBeenCalledWith({
        deviceId: "auto",
        enabled: false,
        searchImageSource: "original",
      });
    });
  });

  /**
   * 回归：诊断探针偶发失败（显卡被别的任务占满）时，缓存里的 `adapters` 会变空，
   * 原来「使用显卡」+ 多卡开关会因为 `usableAdapters.length > 0` 不成立而**整段消失**
   * （用户截图就是这个）。现在只要还记得显卡名字，这一块就要显示出来。
   */
      });
