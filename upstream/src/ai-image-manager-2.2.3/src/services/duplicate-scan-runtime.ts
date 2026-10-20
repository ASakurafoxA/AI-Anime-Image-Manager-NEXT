const activeDuplicateScanRuns = new Set<string>();

/**
 * Process-local guard for a scan currently doing file/vector work. The
 * database row remains the cross-process audit record; this set prevents a
 * long-running scan from being mistaken for an abandoned row after a fixed
 * lease interval.
 */
export function markDuplicateScanActive(runId: string): void {
  activeDuplicateScanRuns.add(runId);
}

export function markDuplicateScanFinished(runId: string): void {
  activeDuplicateScanRuns.delete(runId);
}

export function hasActiveDuplicateScan(): boolean {
  return activeDuplicateScanRuns.size > 0;
}

export interface DuplicateScanProgress {
  processed: number;
  stage:
    | "idle"
    | "queued"
    | "hashing"
    | "matching"
    | "verifying"
    | "publishing"
    | "completed"
    | "cancelled"
    /** 自用（2026-10-17）：用户点了「暂停」—— 与"已取消"不同，可以「继续」✓ */
    | "paused"
    | "failed";
  total: number;
}

let generation = 0;
let tail: Promise<unknown> = Promise.resolve();
let pending: {
  key: string;
  generation: number;
  promise: Promise<unknown>;
} | null = null;
let progress: DuplicateScanProgress = { stage: "idle", processed: 0, total: 0 };
/** 自用（2026-10-17）：本次停下是"暂停"还是"取消"（只影响运行记录的 status 与界面文案）✓ */
let pauseRequested = false;

export function getDuplicateScanProgress(): DuplicateScanProgress {
  return { ...progress };
}

export function cancelDuplicateScan(): void {
  generation += 1;
  progress = { ...progress, stage: "cancelled" };
}

/**
 * 自用（2026-10-17，待办「查重的暂停 / 断点继续」）：
 * **暂停** = 和"取消"用同一套停下机制（下一个检查点退出），但语义不同 ✓
 *
 * 为什么不用真正"挂起"：扫描是主进程里一次同步/异步混合的长任务，
 * 挂起需要把批次分发改成"可等待的队列"（那是另一条更大的待办「真正挂起式暂停」）✗。
 * 这里的"断点继续"靠**已算好的文件哈希已落库**实现：继续时会复用（实测有缓存用例 ✓），
 * 所以继续 ≠ 从头再来 ✓ —— 对用户来说就是"接着扫"✓。
 */
export function pauseDuplicateScan(): void {
  pauseRequested = true;
  cancelDuplicateScan();
  // 覆盖成 paused：界面据此显示「已暂停 / 继续」，而「取消」显示的是"已取消" ✓
  progress = { ...progress, stage: "paused" };
}

/**
 * 自用（2026-10-17）：**看一眼**这次停下是不是"用户点了暂停"（不清标记）✓
 * 供"记录运行状态"用；真正的消费在 IPC handler 里（它要把结果变成"已暂停"而不是报错）。
 */
export function isPauseRequested(): boolean {
  return pauseRequested;
}

/**
 * 取出"这次停下是不是用户点了暂停"（取一次就清掉）✓
 * 运行记录据此标成 `paused` 而不是 `cancelled` —— 两者在库里可区分。
 */
export function consumePauseRequest(): boolean {
  if (!pauseRequested) {
    return false;
  }
  pauseRequested = false;
  return true;
}

export interface DuplicateScanContext {
  assertCurrent: () => void;
  report: (
    stage: DuplicateScanProgress["stage"],
    processed: number,
    total: number
  ) => void;
}

/** Same requests share work; different requests supersede and serialize. */
export function runDuplicateScan<T>(
  key: string,
  task: (context: DuplicateScanContext) => Promise<T>
): Promise<T> {
  if (pending?.key === key && pending.generation === generation) {
    console.log("[DupScan] join: 已经在跑，直接加入这次扫描 ✓");
    return pending.promise as Promise<T>;
  }
  const current = ++generation;
  // 自用（2026-10-17）：新一轮开始 → 清掉上一次的"暂停"标记，避免误判下一轮 ✓
  pauseRequested = false;
  const assertCurrent = () => {
    if (current !== generation) {
      throw new Error(
        "SCAN_CANCELLED: Duplicate scan was superseded or cancelled"
      );
    }
  };
  progress = { stage: "queued", processed: 0, total: 0 };
  console.log(`[DupScan] start: 新一轮扫描开始（key=${key}）`);
  const promise = tail
    .catch(() => undefined)
    .then(async () => {
      assertCurrent();
      try {
        const result = await task({
          assertCurrent,
          report: (stage, processed, total) => {
            assertCurrent();
            progress = { stage, processed, total };
          },
        });
        assertCurrent();
        progress = { ...progress, stage: "completed" };
        return result;
      } catch (error) {
        if (current === generation) {
          progress = { ...progress, stage: "failed" };
        }
        // 自用（2026-10-17）：留一行日志，方便排查"暂停后又自己开始 / 被谁顶掉"✓
        console.log(
          `[DupScan] stopped: ${(error as Error)?.message ?? String(error)}`
        );
        throw error;
      } finally {
        if (pending?.generation === current) {
          pending = null;
        }
      }
    });
  pending = { key, generation: current, promise };
  tail = promise.catch(() => undefined);
  return promise;
}
