/**
 * 「主进程正在做一件长时间的重活」的共享标记（2026-11-15 · 会话#13）。
 *
 * 背景（用户实测）：刚开软件就点「角色识别 → 给已有角色补漏」，比对会从正常
 * 1 秒左右掉到 20 组/秒。排查发现开机后 25s / 60s / 120s 各排了一件重活
 * （开机补扫、孤儿记录检查、缩略图缓存统计），它们的「让路」判定只认
 * **查重 / 打标 / 建向量 / 算特征**，**不认识角色识别** → 照样跟分析抢
 * 同一个主进程的时间片、同一块图库盘。
 *
 * 为什么单独放一个模块：判定方在 `services/registry.ts` 与
 * `services/ai/vector-db.ts`，而标记方在 `services/character-suggest.ts` ——
 * 后者连带一大串 AI 依赖，反向 import 会把服务注册表拖进依赖环。
 * 这里只有一个计数，谁都不依赖，安全。
 *
 * 用法：重活开始 `beginMainThreadHeavyWork()`，结束（含异常）`endMainThreadHeavyWork()`；
 * 后台维护任务用 `isMainThreadHeavyWorkRunning()` 决定要不要让路。
 */
let activeCount = 0;

export function beginMainThreadHeavyWork(): void {
  activeCount += 1;
}

export function endMainThreadHeavyWork(): void {
  if (activeCount > 0) {
    activeCount -= 1;
  }
}

export function isMainThreadHeavyWorkRunning(): boolean {
  return activeCount > 0;
}

/*
 * 2026-11-15（会话#13）：顺带记一下「主进程同时在服务多少缩略图请求」。
 * 排查用：角色识别比对期间若主线程被缩略图请求压满，查询回调会排队，
 * 「整批耗时」就会假性变慢（查询本身离线只要 10ms）。只做计数，不做限流。
 */
let localMediaRequests = 0;
let localMediaBytes = 0;

export function noteLocalMediaRequest(bytes: number): void {
  localMediaRequests += 1;
  localMediaBytes += bytes;
}

export function readLocalMediaStats(): { bytes: number; requests: number } {
  return { requests: localMediaRequests, bytes: localMediaBytes };
}
