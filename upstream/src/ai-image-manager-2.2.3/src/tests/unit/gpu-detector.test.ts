import { beforeEach, describe, expect, it, vi } from "vitest";

const getSettingMock = vi.hoisted(() => vi.fn());
const setSettingMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/settings-manager", () => ({
  getSetting: getSettingMock,
  setSetting: setSettingMock,
}));

vi.mock("@/services/diagnostics/worker-output", () => ({
  captureWorkerOutput: vi.fn(),
}));

vi.mock("@/services/tracked-child-processes", () => ({
  trackChildProcess: vi.fn((child) => child),
}));

vi.mock("@/utils/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
  }),
}));

import {
  GPU_DETECTOR_VERSION,
  getCachedDetection,
  getDmlDeviceId,
  recordEmbeddingProbeResult,
} from "@/services/gpu-detector";

describe("cached GPU detection", () => {
  beforeEach(() => {
    getSettingMock.mockReset();
    setSettingMock.mockReset();
  });

  it("invalidates cached Oray virtual adapter results", () => {
    getSettingMock.mockReturnValue(
      JSON.stringify({
        detectorVersion: GPU_DETECTOR_VERSION,
        dmlAvailable: true,
        gpuName: "OrayIddDriver Device",
        probeTimeMs: 20,
      })
    );

    expect(getCachedDetection()).toBeNull();
  });

  it("keeps cached results for a real GPU", () => {
    const cached = {
      detectorVersion: GPU_DETECTOR_VERSION,
      dmlAvailable: true,
      dmlDeviceId: 1,
      gpuName: "NVIDIA GeForce RTX 4060 Laptop GPU",
      gpuIndex: 1,
      probeTimeMs: 20,
    };
    getSettingMock.mockReturnValue(JSON.stringify(cached));

    expect(getCachedDetection()).toEqual(cached);
  });

  // 旧版探测逻辑（没有 detectorVersion）留下的结论必须作废，否则用户升级后仍按旧结论跑
  // —— 继续"图像嵌入用 CPU"或用核显。
  it("invalidates caches written by an older detector version", () => {
    getSettingMock.mockReturnValue(
      JSON.stringify({
        dmlAvailable: true,
        gpuName: "NVIDIA GeForce RTX 4060 Laptop GPU",
        probeTimeMs: 20,
      })
    );

    expect(getCachedDetection()).toBeNull();
  });

  it("exposes the detected DML device id only when it is a valid index", () => {
    getSettingMock.mockReturnValue(
      JSON.stringify({
        detectorVersion: GPU_DETECTOR_VERSION,
        dmlAvailable: true,
        dmlDeviceId: 1,
        gpuName: "NVIDIA GeForce RTX 4060 Laptop GPU",
        probeTimeMs: 20,
      })
    );
    expect(getDmlDeviceId()).toBe(1);

    getSettingMock.mockReturnValue(
      JSON.stringify({
        detectorVersion: GPU_DETECTOR_VERSION,
        dmlAvailable: true,
        dmlDeviceId: null,
        gpuName: "NVIDIA GeForce RTX 4060 Laptop GPU",
        probeTimeMs: 20,
      })
    );
    expect(getDmlDeviceId()).toBeNull();
  });

  // 界面上的"图像嵌入 GPU 加速中 / 使用 CPU"读的是这份缓存；
  // 工作进程每次启动都会重探，结论必须回写，否则会出现"实际用 GPU、界面说 CPU"。
  it("writes the embedding probe verdict back to the cache", () => {
    getSettingMock.mockReturnValue(
      JSON.stringify({
        detectorVersion: GPU_DETECTOR_VERSION,
        dmlAvailable: true,
        dmlDeviceId: 2,
        embeddingDmlAvailable: false,
        gpuName: "NVIDIA GeForce RTX 4070 Ti SUPER",
        probeTimeMs: 20,
      })
    );

    recordEmbeddingProbeResult(true, 2);

    expect(setSettingMock).toHaveBeenCalledWith(
      "gpu.detected",
      expect.stringContaining('"embeddingDmlAvailable":true')
    );
  });

  it("does not fabricate a cache when nothing was detected yet", () => {
    getSettingMock.mockReturnValue(null);

    recordEmbeddingProbeResult(true, 2);

    expect(setSettingMock).not.toHaveBeenCalled();
  });

  /**
   * 自用（多卡·回归）：探针失败时**不能把已知的显卡列表抹掉**。
   *
   * 用户截图那个 bug：某个任务占满显卡时探针失败（"worker exited unexpectedly"），
   * 失败结果里没有 `adapters` 字段，直接覆盖缓存会让 `adapters` 变空
   * → 设置页「使用显卡」+ 多卡开关**整段消失**。
   */
  it("keeps the known adapter list when a probe fails", () => {
    getSettingMock.mockReturnValue(
      JSON.stringify({
        detectorVersion: GPU_DETECTOR_VERSION,
        adapters: [
          { deviceId: 2, name: "NVIDIA GeForce RTX 4070 Ti SUPER", ok: true },
        ],
        dmlAvailable: true,
        dmlDeviceId: 2,
        gpuName: "NVIDIA GeForce RTX 4070 Ti SUPER",
        probeTimeMs: 20,
      })
    );

    recordEmbeddingProbeResult(false, null, "Probe worker exited unexpectedly");

    const written = setSettingMock.mock.calls.at(-1)?.[1] as string;
    expect(written).toContain("NVIDIA GeForce RTX 4070 Ti SUPER");
    expect(written).toContain('"adapters":[{"deviceId":2');
    expect(written).toContain('"embeddingDmlAvailable":false');
  });
});
