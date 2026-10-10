import { afterEach, describe, expect, it } from "vitest";
import {
  describeGpuHeavyTask,
  getGpuHeavyTask,
  releaseGpu,
  tryAcquireGpu,
} from "@/services/ai/gpu-queue";

/**
 * 自用（第 10 轮·吞吐修复）：建向量 与 打标 必须**互斥**。
 *
 * 为什么：两条链都走 DirectML、都在同一块显卡上推理，同时跑会互相抢 GPU
 * （实测打标从 1.71 张/秒掉下来、建向量也从 20 张/秒掉下来）。
 * 这里的回归保护是：谁先拿到谁跑，另一个被明确拒绝并给出"被谁挡着"的说明。
 */
describe("gpu-queue（建向量 / 打标 互斥）", () => {
  afterEach(() => {
    // 每个用例后把锁清干净，避免相互污染
    releaseGpu("embedding");
    releaseGpu("tagging");
  });

  it("空闲时任何任务都能拿到锁", () => {
    expect(getGpuHeavyTask()).toBeNull();
    expect(tryAcquireGpu("embedding")).toBeNull();
    expect(getGpuHeavyTask()).toBe("embedding");
  });

  it("建向量在跑时，打标会被拒绝并说明原因", () => {
    expect(tryAcquireGpu("embedding")).toBeNull();
    const blocked = tryAcquireGpu("tagging");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("建向量");
    // 被拒之后锁仍属于建向量
    expect(getGpuHeavyTask()).toBe("embedding");
  });

  it("打标在跑时，建向量会被拒绝并说明原因", () => {
    expect(tryAcquireGpu("tagging")).toBeNull();
    const blocked = tryAcquireGpu("embedding");
    expect(blocked).not.toBeNull();
    expect(blocked).toContain("打标");
    expect(getGpuHeavyTask()).toBe("tagging");
  });

  it("同一类任务重复进入不算冲突（由各自的 running 守卫处理）", () => {
    expect(tryAcquireGpu("tagging")).toBeNull();
    expect(tryAcquireGpu("tagging")).toBeNull();
    expect(getGpuHeavyTask()).toBe("tagging");
  });

  it("释放后另一个任务就能拿到锁", () => {
    tryAcquireGpu("embedding");
    releaseGpu("embedding");
    expect(getGpuHeavyTask()).toBeNull();
    expect(tryAcquireGpu("tagging")).toBeNull();
    expect(getGpuHeavyTask()).toBe("tagging");
  });

  it("非持有者释放不会误放别人的锁", () => {
    tryAcquireGpu("embedding");
    // 打标并不是持有者，释放应当无效
    releaseGpu("tagging");
    expect(getGpuHeavyTask()).toBe("embedding");
  });

  it("说明文字包含任务名与已运行时间", () => {
    tryAcquireGpu("tagging");
    const text = describeGpuHeavyTask();
    expect(text).toContain("AI 打标");
    expect(text).toContain("秒");
    releaseGpu("tagging");
    expect(describeGpuHeavyTask()).toBe("");
  });
});
