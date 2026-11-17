import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { duplicateCleanupPlans } from "@/db/schema";
import { setSetting } from "./settings-manager";

/**
 * 2026-11-18（会话#14）：**节流**。
 *
 * 这个函数在"每插入一张照片"时都会被调用（扫描/导入/监视器）。原来每次都会
 * `setSetting("duplicates.scannedSignature","")` + `UPDATE duplicate_cleanup_plans`
 * —— 导入 3.6 万张就是 **7 万多次数据库写**，是导入变慢的一个隐藏来源。
 *
 * 失效这件事是幂等的：只要这批导入还在进行，签名保持为空即可。
 * 因此 2 秒内只真正执行一次；超过 2 秒再补一次（防止长批次后漏失效）。
 */
let lastInvalidationAt = 0;
const INVALIDATE_THROTTLE_MS = 2000;

export function checkNewPhotoDuplicates(
  _photoId: number,
  _phash: string | null,
  _filePath: string,
  _fileSize: number,
  _threshold = 8
): void {
  const now = Date.now();
  if (now - lastInvalidationAt < INVALIDATE_THROTTLE_MS) {
    return;
  }
  lastInvalidationAt = now;
  // Import-time detection only invalidates the authoritative scan. It must not
  // publish an executable pair using a different verification path than the
  // full scan; the duplicate page will run the shared staged detector.
  setSetting("duplicates.scannedSignature", "");
  getDatabase()
    .update(duplicateCleanupPlans)
    .set({ status: "STALE", updatedAt: Date.now() })
    .where(eq(duplicateCleanupPlans.status, "READY"))
    .run();
}
