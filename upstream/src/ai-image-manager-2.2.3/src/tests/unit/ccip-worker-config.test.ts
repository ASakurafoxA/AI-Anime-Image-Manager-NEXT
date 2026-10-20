import { describe, expect, it } from "vitest";
import {
  CCIP_WORKERS_OPTIONS,
  CCIP_WORKERS_PER_CARD_DEFAULT,
  CCIP_WORKERS_PER_CARD_KEY,
  ccipWorkerSlotDevices,
  clampCcipWorkersPerCard,
} from "@/services/ai/ccip-worker-config";

/*
 * 自用（2026-10-17，用户口径）：「**每卡 work 数，是用来服务多模式的**」
 * 这套东西原本挂在已删除的人脸检测池上，现在**迁移到 CCIP** ✓
 * 这几条测试钉住"键名固定、默认 2、范围 1~4、多卡轮转"。
 */
describe("CCIP 每卡进程数（多卡模式的设置项）", () => {
  it("键名与默认值固定（主进程与设置页共用同一份定义）", () => {
    expect(CCIP_WORKERS_PER_CARD_KEY).toBe("ai.ccipWorkersPerCard");
    // 实测拐点是 4（见 ccip-worker-config.ts 里的阶梯表）✓
    expect(CCIP_WORKERS_PER_CARD_DEFAULT).toBe(4);
    expect([...CCIP_WORKERS_OPTIONS]).toEqual([1, 2, 3, 4, 6]);
  });

  it("读不到 / 不是数字 → 默认 4", () => {
    expect(clampCcipWorkersPerCard(null)).toBe(4);
    expect(clampCcipWorkersPerCard(undefined)).toBe(4);
    expect(clampCcipWorkersPerCard("")).toBe(4);
    expect(clampCcipWorkersPerCard("abc")).toBe(4);
  });

  it("超出范围夹到 1~8", () => {
    expect(clampCcipWorkersPerCard("0")).toBe(1);
    expect(clampCcipWorkersPerCard("-5")).toBe(1);
    expect(clampCcipWorkersPerCard("9")).toBe(8);
    expect(clampCcipWorkersPerCard(99)).toBe(8);
  });

  it("正常值原样生效（数字与字符串两种存法都认）", () => {
    expect(clampCcipWorkersPerCard("1")).toBe(1);
    expect(clampCcipWorkersPerCard("3")).toBe(3);
    expect(clampCcipWorkersPerCard(4)).toBe(4);
    expect(clampCcipWorkersPerCard("6")).toBe(6);
  });

  it("单卡 N 个进程 = 同一张卡重复 N 次", () => {
    expect(ccipWorkerSlotDevices([2], 2)).toEqual([2, 2]);
    expect(ccipWorkerSlotDevices([2], 1)).toEqual([2]);
    expect(ccipWorkerSlotDevices([2], 3)).toEqual([2, 2, 2]);
  });

  it("多卡按轮转分配（卡数 × 每卡进程数）", () => {
    expect(ccipWorkerSlotDevices([0, 1], 2)).toEqual([0, 1, 0, 1]);
    expect(ccipWorkerSlotDevices([0, 1, 2], 1)).toEqual([0, 1, 2]);
    expect(ccipWorkerSlotDevices([0, 1, 2], 2)).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it("系统默认适配器（null）也能轮转", () => {
    expect(ccipWorkerSlotDevices([null], 2)).toEqual([null, null]);
    expect(ccipWorkerSlotDevices([0, null], 1)).toEqual([0, null]);
  });

  it("没有可用设备时至少给一个默认槽（不会算出 0 个 worker）", () => {
    expect(ccipWorkerSlotDevices([], 2)).toEqual([null]);
  });
});
