import { os } from "@orpc/server";
import { z } from "zod";
import {
  createDuplicateCleanupPlan,
  executeDuplicateCleanupPlan,
  listDuplicateCleanupBatches,
  restoreDuplicateCleanupBatch,
} from "@/services/duplicate-cleanup-plan";
import { withUserFacingError } from "./shared";

/*
 * 自用（2026-11-09 · 会话#11）：**清理相关错误必须把原话送到界面** ✗→✓
 *
 * 现场：用户点「执行清理」只看到「执行清理计划失败，图片未被部分清理」这句兜底文案。
 * 根因：oRPC 对普通 `Error` 有兜底，会把 message 换成 `Internal server error`（只留在 cause 里），
 * 于是 `DuplicateCleanupPlanError` 里的 `PLAN_EXPIRED` / `FILE_CHANGED` / `STALE_GROUP`
 * 这些**关键信息全被吞掉**，前端 `duplicateErrorKey()` 一个都匹配不上 ✗
 * 现在统一走 `withUserFacingError()`，同时在这里打一条日志，排查时不用再靠猜 ✓
 */
async function runCleanupAction<T>(label: string, task: () => T | Promise<T>) {
  try {
    return await withUserFacingError(task);
  } catch (error) {
    console.warn(
      `[DupCleanup] ${label} 失败: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
}

export const listDuplicateCleanupBatchesHandler = os.handler(() =>
  listDuplicateCleanupBatches()
);

const duplicateCleanupGroupInput = z.object({
  deletePhotoIds: z.array(z.number().int().positive()).min(1),
  groupKey: z.string().min(1),
  groupVersion: z.string().min(1),
  keepPhotoIds: z.array(z.number().int().positive()).min(1),
  matchType: z.enum(["exact", "similar"]),
  reviewRevision: z.number().int().nonnegative(),
});

export const createDuplicateCleanupPlanHandler = os
  .input(z.object({ groups: z.array(duplicateCleanupGroupInput).min(1) }))
  .handler(({ input }) =>
    runCleanupAction("创建计划", () => createDuplicateCleanupPlan(input))
  );

export const executeDuplicateCleanupPlanHandler = os
  .input(z.object({ planId: z.string().uuid() }))
  .handler(({ input }) =>
    runCleanupAction("执行计划", () => executeDuplicateCleanupPlan(input))
  );

export const restoreDuplicateCleanupBatchHandler = os
  .input(z.object({ batchId: z.string().uuid() }))
  .handler(({ input }) =>
    runCleanupAction("撤销批次", () => restoreDuplicateCleanupBatch(input))
  );
