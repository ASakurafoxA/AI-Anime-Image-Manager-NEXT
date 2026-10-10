import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  default: {
    execFileSync: execFileSyncMock,
  },
  execFileSync: execFileSyncMock,
}));

import {
  getGpuName,
  getGpuSelection,
  isDiscreteGpu,
  isRealGpu,
  selectRealGpu,
  selectRealGpuName,
} from "../../../scripts/gpu-probe.mjs";

describe("GPU name detection", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it("filters Oray virtual adapters even when they appear first", () => {
    expect(
      selectRealGpuName([
        "OrayIddDriver Device",
        "NVIDIA GeForce RTX 4060 Laptop GPU",
      ])
    ).toBe("NVIDIA GeForce RTX 4060 Laptop GPU");
    expect(isRealGpu("OrayIddDriver Device")).toBe(false);
  });

  it("returns no name when every adapter is virtual", () => {
    expect(
      selectRealGpuName([
        "OrayIddDriver Device",
        "Microsoft Basic Display Adapter",
      ])
    ).toBeNull();
  });

  // 用户反馈的那个 bug：双显卡笔记本上核显排在前面，旧逻辑"取第一个真实显卡"会挑中核显。
  it("prefers the discrete GPU when the integrated one is listed first", () => {
    const adapters = [
      "Intel(R) UHD Graphics",
      "NVIDIA GeForce RTX 4060 Laptop GPU",
    ];

    expect(isDiscreteGpu(adapters[0])).toBe(false);
    expect(isDiscreteGpu(adapters[1])).toBe(true);
    expect(selectRealGpuName(adapters)).toBe(
      "NVIDIA GeForce RTX 4060 Laptop GPU"
    );
    // 序号要能直接当 DirectML 的 deviceId 用
    expect(selectRealGpu(adapters)).toEqual({
      index: 1,
      name: "NVIDIA GeForce RTX 4060 Laptop GPU",
    });
  });

  it("does not treat an AMD integrated Radeon (APU) as discrete", () => {
    const adapters = [
      "AMD Radeon(TM) Graphics",
      "NVIDIA GeForce RTX 4060 Laptop GPU",
    ];

    expect(selectRealGpuName(adapters)).toBe(
      "NVIDIA GeForce RTX 4060 Laptop GPU"
    );
  });

  it("falls back to the only real adapter when nothing looks discrete", () => {
    expect(selectRealGpu(["Intel(R) UHD Graphics"])).toEqual({
      index: 0,
      name: "Intel(R) UHD Graphics",
    });
  });

  // wmic 自 Windows 11 24H2 起默认不再预装，所以 PowerShell 必须是首选。
  it("queries PowerShell first and returns the discrete GPU", () => {
    execFileSyncMock.mockImplementation((command) => {
      if (command === "powershell") {
        return "Intel(R) UHD Graphics\r\nNVIDIA GeForce RTX 4060 Laptop GPU\r\n";
      }
      return "";
    });

    expect(getGpuName()).toBe("NVIDIA GeForce RTX 4060 Laptop GPU");
    expect(getGpuSelection()).toEqual({
      index: 1,
      name: "NVIDIA GeForce RTX 4060 Laptop GPU",
    });
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to wmic when PowerShell returns only virtual adapters", () => {
    execFileSyncMock.mockImplementation((command) => {
      if (command === "wmic") {
        return "Node,Name\r\nhost,AMD Radeon RX 6600\r\n";
      }
      return "OrayIddDriver Device\r\n";
    });

    expect(getGpuName()).toBe("AMD Radeon RX 6600");
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it("returns no name when both GPU queries fail", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("query failed");
    });

    expect(getGpuName()).toBeNull();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });
});
