/**
 * CCIP「每卡进程数」的纯逻辑（NEXT 版，2026-10-17）。
 *
 * 为什么单独一个文件：这个设置原本是**人脸链路**的「每卡 worker 数」
 * （`ai.faceWorkersPerCard`，服务已删除的人脸检测 worker 池）。
 * 用户口径：「**每卡 work 数，是用来服务多模式的**」—— 它属于**要保留的功能**，
 * 所以要**迁移到新模型（CCIP）**上，而不是跟着人脸链路一起删掉 ✓
 *
 * 这里只放**纯函数与常量**（不 import 任何主进程模块），因此：
 *   · 主进程 `services/ai/ccip-embedder.ts` 用它算 worker 布局；
 *   · 渲染层 `routes/settings.behavior.tsx` 直接用同一份常量/选项，
 *     键名与范围**只有一处定义**，不会两边写歪 ✓
 */

/** app_settings 里的键名（主进程与设置页共用）。 */
export const CCIP_WORKERS_PER_CARD_KEY = "ai.ccipWorkersPerCard";

/**
 * 默认每卡 **4** 个 worker —— 实测拐点（2026-10-17 复测，见下）。
 *
 * 重要：上一版这里写的是 2（依据是 1.13 那一次探针）。本次用**生产 worker 协议**
 * （`scripts/ccip-embed-worker.mjs` + DML 设备 2 + 1 线程、每进程先热身 4 张、
 * 固定测同一批 72 张、每档两轮平均）重测，结果是一条**在 4 就饱和**的曲线：
 *
 * | 每卡 worker 数 | 吞吐 | 相对 1 个 |
 * |---|---|---|
 * | 1 | 15.73 张/秒 | 100% |
 * | 2 | 23.77 | 151% |
 * | 3 | 29.65 | 188% |
 * | **4** | **34.66** | **220%** ← 拐点 |
 * | 5 / 6 / 8 | 33.9 / 33.2 / 34.2 | ≈216 / 211 / 217% |
 *
 * → 4 个之后不再变快，只是多占内存，所以**默认 4**、上限放到 8（换机器可能拐点不同）✓
 */
export const CCIP_WORKERS_PER_CARD_DEFAULT = 4;

export const CCIP_WORKERS_PER_CARD_MIN = 1;
export const CCIP_WORKERS_PER_CARD_MAX = 8;

/** 设置页下拉可选的档位（4 = 实测拐点，6 留给更强的机器）。 */
export const CCIP_WORKERS_OPTIONS = [1, 2, 3, 4, 6] as const;

/**
 * 把设置里的原始字符串解析成"每卡进程数"：
 * 读不到 / 不是数字 → 默认 2；超出范围 → 夹到 1~4 ✓
 */
export function clampCcipWorkersPerCard(
  raw: string | number | null | undefined
): number {
  const parsed =
    typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return CCIP_WORKERS_PER_CARD_DEFAULT;
  }
  return Math.min(
    CCIP_WORKERS_PER_CARD_MAX,
    Math.max(CCIP_WORKERS_PER_CARD_MIN, Math.trunc(parsed))
  );
}

/**
 * 算出"每个 worker 用哪张卡"：**卡数 × 每卡进程数**，按轮转分配（0,1,0,1…）✓
 *
 * 为什么轮转而不是静态对半切：派活是"谁空闲谁接"，快卡会自然多接几批，
 * 异构卡不会被慢卡拖住 ✓（静态切分才会）
 */
export function ccipWorkerSlotDevices(
  devices: ReadonlyArray<number | null>,
  perCard: number
): Array<number | null> {
  if (devices.length === 0) {
    return [null];
  }
  const slots = Math.max(1, Math.trunc(perCard)) * devices.length;
  return Array.from(
    { length: slots },
    (_, index) => devices[index % devices.length] ?? null
  );
}
