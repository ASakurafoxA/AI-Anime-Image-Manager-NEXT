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
  it("saves the feature source together with the multi-GPU fields", async () => {
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
        deviceIds: [],
        multiGpuEnabled: false,
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
        deviceIds: [],
        multiGpuEnabled: false,
      });
    });
  });

  /**
   * 回归：诊断探针偶发失败（显卡被别的任务占满）时，缓存里的 `adapters` 会变空，
   * 原来「使用显卡」+ 多卡开关会因为 `usableAdapters.length > 0` 不成立而**整段消失**
   * （用户截图就是这个）。现在只要还记得显卡名字，这一块就要显示出来。
   */
  it("keeps the adapter and multi-GPU controls when a failed probe wiped the adapter list", async () => {
    vi.mocked(ipc.client.settings.getGpuSettings).mockResolvedValue({
      detected: {
        dmlAvailable: false,
        embeddingDmlAvailable: false,
        embeddingError: "Probe worker exited unexpectedly",
        gpuName: "NVIDIA GeForce RTX 4070 Ti SUPER",
        probeTimeMs: 1637,
      },
      deviceId: "auto",
      deviceIds: [],
      effectiveDevices: [2],
      enabled: true,
      multiGpuEnabled: false,
      promptShown: true,
      searchImageSource: "thumbnail",
    });

    render(<GpuSettingsCard />);

    // 两块都必须还在
    expect(await screen.findByLabelText("gpuAdapterTitle")).toBeInTheDocument();
    expect(screen.getByLabelText("multiGpuTitle")).toBeInTheDocument();
  });

  /**
   * 用户明确要求：**只用 1 张卡时完全不显示每卡速度**（顶上已有总速度，重复没意义）。
   */
  it("hides the per-card speeds when only one GPU is in use", async () => {
    vi.mocked(ipc.client.settings.getGpuSettings).mockResolvedValue({
      detected: { dmlAvailable: true, gpuName: "Test GPU", probeTimeMs: 12 },
      deviceId: "2",
      deviceIds: [2],
      effectiveDevices: [2],
      enabled: true,
      multiGpuEnabled: false,
      promptShown: true,
      searchImageSource: "thumbnail",
    });
    vi.mocked(ipc.client.settings.getGpuSpeeds).mockResolvedValue({
      speeds: [{ deviceId: 2, label: null, perSecond: 12.3 }],
    });

    render(<GpuSettingsCard />);

    // 等状态行渲染出来（说明轮询也回来了）
    expect(await screen.findByText("gpuStatusFace")).toBeInTheDocument();
    await waitFor(() => {
      expect(ipc.client.settings.getGpuSpeeds).toHaveBeenCalled();
    });
    expect(screen.queryByText("multiGpuCardLabel")).toBeNull();
  });

  /**
   * 用户明确要求：**≥2 张才显示，用几张显示几个**（最多 3 张）。
   */
  it("shows exactly as many per-card speeds as GPUs in use", async () => {
    vi.mocked(ipc.client.settings.getGpuSettings).mockResolvedValue({
      detected: { dmlAvailable: true, gpuName: "Test GPU", probeTimeMs: 12 },
      deviceId: "2",
      deviceIds: [2, 3],
      effectiveDevices: [2, 3],
      enabled: true,
      multiGpuEnabled: true,
      promptShown: true,
      searchImageSource: "thumbnail",
    });
    vi.mocked(ipc.client.settings.getGpuSpeeds).mockResolvedValue({
      speeds: [
        { deviceId: 2, label: null, perSecond: 11.1 },
        { deviceId: 3, label: null, perSecond: 22.2 },
      ],
    });

    render(<GpuSettingsCard />);

    /*
     * 两张卡 → 正好两栏。
     * ⚠️ 测试环境的 `t()` 是替身：带插值的键（multiGpuCardSpeed / multiGpuCardLabel）
     * 直接返回键名、不会把数字插进去，所以只能断言"栏数"，不能断言 11.1 这种数值。
     * multiGpuCardLabel 在每个栏里各出现一次 → 出现几次就是几栏。
     */
    await waitFor(() => {
      expect(screen.getAllByText("multiGpuCardLabel")).toHaveLength(2);
    });
  });
});
