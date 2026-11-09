import { os } from "@orpc/server";
import { z } from "zod";
import { getDatabase } from "@/db";
import {
  applyDuplicateKeepCount,
  applyDuplicateKeepCountToAllGroups,
  DUPLICATE_REVIEW_DECISIONS,
  updateDuplicateReviewState,
} from "@/services/duplicate-review";

const duplicateReviewDecision = z.enum(DUPLICATE_REVIEW_DECISIONS);

export const updateDuplicateReview = os
  .input(
    z.object({
      decisions: z
        .array(
          z.object({
            decision: duplicateReviewDecision,
            photoId: z.number().int().positive(),
          })
        )
        .min(1),
      expectedReviewRevision: z.number().int().nonnegative(),
      groupKey: z.string().min(1),
      groupVersion: z.string().min(1),
      ignoreState: z.enum(["ACTIVE", "IGNORED"]).optional(),
    })
  )
  .handler(({ input }) => updateDuplicateReviewState(getDatabase(), input));

export const applyDuplicateKeepCountHandler = os
  .input(
    z.object({
      count: z.number().int().positive(),
      expectedReviewRevision: z.number().int().nonnegative(),
      groupKey: z.string().min(1),
      groupVersion: z.string().min(1),
    })
  )
  .handler(({ input }) => applyDuplicateKeepCount(getDatabase(), input));

/*
 * 自用（2026-11-09 · 会话#11）：**一次设置所有组的保留数量** ✓
 * （用户原话："我这几千个组每个都要重复操作三次才能添加很费劲" —— 逐个调必然爆炸）
 */
export const applyDuplicateKeepCountToAllHandler = os
  .input(z.object({ count: z.number().int().positive().max(64) }))
  .handler(({ input }) => applyDuplicateKeepCountToAllGroups(getDatabase(), input));
