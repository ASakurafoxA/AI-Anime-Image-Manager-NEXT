/**
 * 自用（第 10 轮·吞吐修复）：**建向量 与 打标 互斥**。
 *
 * 为什么需要（日志实测）：
 *   两条链都走 DirectML、都在同一块显卡上推理，同时跑会互相抢 GPU：
 *     17:54 建向量启动 2 个 embed worker  →  18:02 打标启动 PixAI worker
 *   两边同时占着显卡时，打标掉到 **1.7 张/秒**（单独跑是 1.71 张/秒的单 worker 基准，
 *   而混跑时实测每批 5 秒/8 张 ≈ 1.6，且 embed 侧也从 20 张/秒掉下来）。
 *   实测同样两个 DirectML 会话并行：总吞吐反而**低于**只开一个（见下）。
 *
 * 实测数据（真实模型 + 真实缩略图，各 30 张）：
 *   · 打标 1 个 worker : **1.71 张/秒**（586ms/张）
 *   · 打标 2 个 worker : 1.30 张/秒
 *   · 打标 3 个 worker : 0.59 张/秒
 *   · 打标 4 个 worker : 0.43 张/秒
 * 结论：这块显卡上"多开会更慢"。所以：
 *   ① 打标默认只开 **1 个** worker（见 `pixai-tagger-client.ts`）；
 *   ② 两条链之间用这个模块做互斥：谁在跑，另一个就**不启动**（不排队、不等待），
 *      界面上会收到明确原因，而不是"两边都慢"。
 *
 * 设计取舍：只做"同一进程内的互斥"（两个 AI 任务都由主进程发起）。
 * 不阻塞、不排队 —— 排队会让用户以为"点了没反应"，明确拒绝更清楚。
 */

export type GpuHeavyTask = "embedding" | "tagging";

let current: GpuHeavyTask | null = null;
let currentSince = 0;

const LABEL: Record<GpuHeavyTask, string> = {
  embedding: "建向量（以图搜图特征）",
  tagging: "AI 打标",
};

/** 谁在占用显卡（null = 空闲）。 */
export function getGpuHeavyTask(): GpuHeavyTask | null {
  return current;
}

/** 给界面/日志用的一句话说明。 */
export function describeGpuHeavyTask(): string {
  if (!current) {
    return "";
  }
  const seconds = Math.max(0, Math.round((Date.now() - currentSince) / 1000));
  return `${LABEL[current]}正在使用显卡（已运行 ${seconds} 秒）`;
}

/**
 * 尝试占用显卡。
 * @returns null = 占用成功；否则返回"被谁挡住"的说明。
 */
export function tryAcquireGpu(task: GpuHeavyTask): string | null {
  if (current === null) {
    current = task;
    currentSince = Date.now();
    return null;
  }
  if (current === task) {
    // 同一类任务重复进入（例如自动打标 + 手动打标）：交给各自的 running 守卫处理
    return null;
  }
  return describeGpuHeavyTask();
}

/** 释放占用。只有当前持有者能释放，避免误放别人的锁。 */
export function releaseGpu(task: GpuHeavyTask): void {
  if (current === task) {
    current = null;
  }
}
