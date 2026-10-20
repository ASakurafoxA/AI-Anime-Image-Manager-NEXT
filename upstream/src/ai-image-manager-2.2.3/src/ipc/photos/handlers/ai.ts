import { os } from "@orpc/server";
import { eq } from "drizzle-orm";
import { BrowserWindow } from "electron";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { getActiveTagger, PRIVATE_BUILD } from "@/config/private-build";
import { releaseGpu, tryAcquireGpu } from "@/services/ai/gpu-queue";
import { getSetting } from "@/services/settings-manager";
import { ensureLocalModel } from "@/services/ai/model-loader";
import {
  runWd14Tagging,
  isWd14TaggingRunning,
  isWd14TaggingSuspended,
  pauseWd14Tagging,
  resumeWd14Tagging,
  cancelWd14Tagging,
  getWd14TaggingBaseline,
} from "@/services/ai/wd14-tagger";
import {
  cancelPixaiTagging,
  getPixaiTaggingBaseline,
  isPixaiTaggingRunning,
  isPixaiTaggingSuspended,
  pausePixaiTagging,
  resumePixaiTagging,
  runPixaiTagging,
} from "@/services/ai/pixai-tagger";
import {
  activeEmbeddingRunId,
  aiControlState,
  batchSuggestTags,
  cancelEmbedding,
  checkAiHealth,
  cleanupPartialEmbedding,
  embedAllPhotos,
  finishEmbeddingRun,
  getAiReadiness,
  getEmbeddingProgress,
  isAutoTaggingActive,
  pauseEmbedding,
  rebuildVectorDB,
  resetAllAiProcessedFlags,
  resumeEmbedding,
  setAiControlState,
  setCurrentProgress,
  setWasAutoRepaired,
  stopEmbedding,
} from "@/services/ai-embedder";

export const startAiIndexing = os.handler(async () => {
  if (aiControlState !== "idle") {
    return { busy: true, started: false, state: aiControlState };
  }
  /**
   * 自用（第 10 轮·吞吐修复）：建向量与打标**共用同一块显卡**，同时跑会互相拖慢。
   *
   * 2026-10-19 修正（用户口径）：**建向量优先级更高** —— 打标可以挤占建向量，
   * 但用户点"开始/重建 AI 索引"时必须能把显卡**抢回来**，而不是静默 busy 返回
   * （表现就是"点了没反应、打标一直在跑、语义搜索一直不可用"）。
   *
   * 2026-10-20（会话#10）修正：这里原来调的是 `pausePixaiTagging()`（挂起）——
   * 挂起只是让循环在原地等，`isPixaiTaggingRunning()` **永远是 true**，
   * 于是这段要空等满 30 秒才继续，而且"打标令牌"被强行 release 之后，
   * 用户再点「继续」会在没有令牌的情况下和建向量**同时抢卡**。
   * 现在改成**取消**（同样保留游标和已经打好的标签，下次点打标按数据续跑），
   * 循环会真的退出，等它退出再交还令牌 —— 两种任务不会同时吃显卡。
   */
  const gpuBlocked = tryAcquireGpu("embedding");
  if (gpuBlocked) {
    console.warn(`[AI] 建向量抢占显卡：${gpuBlocked}`);
    if (isPixaiTaggingRunning() || isWd14TaggingRunning()) {
      if (isPixaiTaggingRunning()) {
        cancelPixaiTagging();
      }
      if (isWd14TaggingRunning()) {
        cancelWd14Tagging();
      }
      const deadline = Date.now() + 15_000;
      while (
        (isPixaiTaggingRunning() || isWd14TaggingRunning()) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      releaseGpu("tagging");
      // 顶栏同步成"已暂停"，否则它还停在"进行中 / 估算中 0%"
      const tagProgress = getEmbeddingProgress();
      setCurrentProgress({
        processed: tagProgress.processed,
        total: tagProgress.total,
        phase: "tagging-paused",
        currentFile: "",
      });
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) {
          continue;
        }
        win.webContents.send("ai-progress", {
          phase: "tagging-paused",
          processed: tagProgress.processed,
          total: tagProgress.total,
          isPaused: true,
        });
      }
    }
    const retryBlocked = tryAcquireGpu("embedding");
    if (retryBlocked) {
      return { busy: true, started: false, reason: retryBlocked };
    }
  }
  embedAllPhotos((aiProgress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ai-progress", aiProgress);
    }
  })
    .then((count) => {
      console.log(`[AI] Embedding complete: ${count} photos processed`);
    })
    .catch((err) => {
      console.error("[AI] Embedding error:", err);
    })
    .finally(() => {
      // 成功/失败/取消都要释放，否则打标会被永久挡住
      releaseGpu("embedding");
    });
  return { started: true };
});

export const stopAiIndexing = os.handler(() => {
  stopEmbedding();
  return { stopped: true };
});

export const cancelAiIndexing = os.handler(async () => {
  const runId = activeEmbeddingRunId;
  const stateBeforeCancel = aiControlState;
  cancelEmbedding();
  // Clean up any partially embedded data from the current session.
  // This covers both the case where embedAllPhotos is still running
  // (cancel flag will trigger cleanup inside the loop) and the case
  // where it was already paused (cleanup must happen here explicitly).
  await cleanupPartialEmbedding(runId);
  if (stateBeforeCancel === "paused" || stateBeforeCancel === "idle") {
    // No embedAllPhotos loop is still alive to settle this run.
    setCurrentProgress({
      processed: 0,
      total: 0,
      phase: "idle",
      currentFile: "",
      downloadPercent: undefined,
    });
    if (runId > 0) {
      finishEmbeddingRun(runId, "idle");
    } else {
      setAiControlState("idle");
    }
    // 自用（第 10 轮）：取消后立刻放开显卡，别让打标一直等着
    releaseGpu("embedding");
  }
  return { cancelled: true };
});

export const pauseAiIndexing = os.handler(() => {
  /*
   * 2026-10-20（会话#10）：**没在跑就别把界面钉在"已暂停"**。
   * 原来无条件推一条 isPaused=true（phase 为 idle 时还会改成 embedding）——
   * 如果这一刻其实没有建向量在跑（上一轮刚结束 / 还没开始），顶栏就会一直显示
   * "已暂停 + 继续"，而点「继续」什么也不会发生（resumeEmbedding 返回 false）。
   */
  if (aiControlState === "idle") {
    setCurrentProgress({
      processed: 0,
      total: 0,
      phase: "idle",
      currentFile: "",
      downloadPercent: undefined,
    });
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) {
        continue;
      }
      win.webContents.send("ai-progress", {
        channel: "ai-progress",
        phase: "idle",
        processed: 0,
        total: 0,
        isPaused: false,
      });
    }
    return { paused: false };
  }
  pauseEmbedding();
  /*
   * 自用（2026-10）：**暂停必须主动推一条进度**。
   * 暂停只是让循环停下，不会触发任何 ai-progress 推送 ✗ →
   * 前端拿不到"已暂停"，就把这次任务当成结束了 → 顶栏整条消失 ✗
   * 这里把带 isPaused 的当前进度推出去，界面才能显示"已暂停 + 继续"。
   */
  try {
    const progress = getEmbeddingProgress();
    // 相位也别改写成 embedding：暂停时循环会自己推一条 phase=embedding + isPaused，
    // 但那一刻如果任务其实在别的阶段，硬写 embedding 会张冠李戴。
    const phase = progress.phase === "idle" ? "embedding" : progress.phase;
    setCurrentProgress({
      processed: progress.processed,
      total: progress.total,
      phase,
      currentFile: progress.currentFile ?? "",
      isPaused: true,
    });
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) {
        continue;
      }
      win.webContents.send("ai-progress", {
        channel: "ai-progress",
        phase,
        processed: progress.processed,
        total: progress.total,
        isPaused: true,
      });
    }
  } catch (error) {
    // 推送只是"让顶栏显示已暂停"，失败也必须让暂停本身成功。
    console.warn(
      "[AI] Pause progress push failed:",
      error instanceof Error ? error.message : String(error)
    );
  }
  return { paused: true };
});

/**
 * 自用（需求 1）：暂停正在跑的打标。
 *
 * 与"取消特征提取"语义**不同** —— 打标天然可续跑：
 * 两个 tagger 都只在**批次边界**退出循环，并把游标留在
 * `app_settings`（`pixai.tagger.cursor` / `wd14.tagger.cursor`）。
 * 所以这里叫「暂停」：下次点「生成 AI 标签」会**从断点继续**，已打完的照片不会重打。
 *
 * 相位改成 `tagging-paused`（而不是留着 `tagging`）：否则侧边栏那一行会一直显示
 * "正在生成 AI 标签…"，看上去像卡住了；现在会明确显示"已暂停"并给出继续入口。
 *
 * ⚠️ 两个坑（用户实测踩到的"点继续没反应"）：
 *  1. **不要**用 `setAiControlState("paused")`：那是**特征提取**的状态机，
 *     而打标入口 `batchGenerateTags` 的守卫是 `aiControlState !== "idle"` 就返回 `busy`
 *     —— 于是暂停之后点"继续"永远被自己挡掉，界面毫无反应。
 *  2. 取消是**异步**的（循环要在批次边界退出）。必须等它真正停下来再返回，
 *     否则用户紧接着点"继续"仍会撞上 `isPixaiTaggingRunning()` 的 busy 判断。
 */
/**
 * 把打标的相位立刻推给所有窗口。
 *
 * 为什么需要：暂停/继续原来只改主进程内存里的进度，界面要等下一条轮询才更新，
 * 用户会觉得"点了没反应"。这里主动 send 一条。
 */
function broadcastTaggingPhase(
  phase: "tagging" | "tagging-paused",
  processed: number,
  total: number
): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) {
        continue;
      }
      win.webContents.send("ai-progress", {
        phase,
        processed,
        total,
        isPaused: phase === "tagging-paused",
      });
    }
  } catch {
    /* 没有窗口（无头测试）时忽略 */
  }
}

/**
 * 自用（2026-10-20 · 会话#10）：**"运行中 / 已挂起"只认挂起标志**。
 *
 * 为什么不能再无条件写 `phase: "tagging"`：暂停是"批边界才停"，正在跑的那一批
 * 结束时照旧会回调一次 onProgress —— 如果那次回调把相位翻回"运行中"，
 * 界面就又从"已暂停"跳回"进行中"、暂停按钮也重新出现，用户看到的就是
 * "点了暂停，又自己继续了"✗。这里让挂起标志压过在途批次。
 */
function taggingPhaseNow(): "tagging" | "tagging-paused" {
  return isPixaiTaggingSuspended() || isWd14TaggingSuspended()
    ? "tagging-paused"
    : "tagging";
}

async function waitForTaggingToStop(timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(isPixaiTaggingRunning() || isWd14TaggingRunning())) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export const pauseTagging = os.handler(async () => {
  const pixaiRunning = isPixaiTaggingRunning();
  const wd14Running = isWd14TaggingRunning();
  if (!(pixaiRunning || wd14Running)) {
    /*
     * 自用（2026-10-20 · 会话#10）：**启动窗口期的暂停不能丢**。
     *
     * 场景（用户实测的"暂停了又继续"）：点了「生成 AI 标签」之后要等
     * `ensureLocalModel()`（十几秒）和抢显卡，这段时间循环还没开始，
     * `isPixaiTaggingRunning()` 还是 false —— 老代码直接返回 paused:false，
     * 模型一加载完就**从头打到尾**，看起来就是"暂停无效、自己又跑起来"✗。
     * 现在：只要这一轮任务还在 batchGenerateTags 里（`taggingJobInFlight`），
     * 就先把挂起标志立起来；循环到第一个批边界就会停住 ✓
     */
    if (taggingJobInFlight && getActiveTagger() !== "upstream") {
      if (getActiveTagger() === "wd14") {
        pauseWd14Tagging();
      } else {
        pausePixaiTagging();
      }
      const starting = getEmbeddingProgress();
      setCurrentProgress({
        processed: starting.processed,
        total: starting.total,
        phase: "tagging-paused",
        currentFile: "",
      });
      broadcastTaggingPhase(
        "tagging-paused",
        starting.processed,
        starting.total
      );
      return { paused: true, suspended: true, starting: true };
    }
    /*
     * 2026-10-19：任务没在跑、但界面还停在"正在生成 AI 标签 / 估算中"（例如被建向量抢占，
     * 或上一轮异常退出）时，点暂停要有反馈：把相位改成 paused，返回 paused: true。
     */
    const stale = getEmbeddingProgress();
    if (
      stale.phase === "tagging" || stale.phase === "tagging-paused"
    ) {
      setCurrentProgress({
        processed: stale.processed,
        total: stale.total,
        phase: "tagging-paused",
        currentFile: "",
      });
      return { paused: true, alreadyStopped: true };
    }
    return { paused: false };
  }
  const progress = getEmbeddingProgress();
  setCurrentProgress({
    processed: progress.processed,
    total: progress.total,
    phase: "tagging-paused",
    currentFile: "",
  });
  // 立刻推一条，别让界面等轮询（用户反馈"点暂停没反应"常常就是慢了半拍）
  broadcastTaggingPhase("tagging-paused", progress.processed, progress.total);
  /*
   * 自用（2026-10-17，待办第 5 项）：**真正挂起式暂停** ✓
   * PixAI：只置挂起标志 —— 循环在批边界原地等，**worker 一个都不杀、模型一直是热的**，
   * 所以"继续"是**秒接**（以前要取消 + 等停 + 重新初始化，几秒钟）✓
   * WD14（另外两版用）：仍走老的"取消"路径（它没有挂起实现），行为不变 ✓
   */
  if (pixaiRunning) {
    pausePixaiTagging();
    return { paused: true, suspended: true };
  }
  // 自用（2026-10-17）：WD14 也改成**挂起**（不杀 worker、继续秒接）✓
  if (wd14Running) {
    pauseWd14Tagging();
    return { paused: true, suspended: true };
  }
  const stopped = await waitForTaggingToStop();
  return { paused: true, stopped };
});

export const resumeAiIndexing = os.handler(async () => {
  /*
   * 2026-10-20（会话#10）：**暂停是异步的**（循环要在批边界退出、收尾后才落到
   * `paused`），但界面在点暂停的瞬间就会显示「继续」。用户很可能在 `pausing`
   * 阶段点到它 —— 老代码直接 `resumeEmbedding()` 返回 false，界面毫无反应
   *（用户原话："点继续也不会继续"）。这里最多等 10 秒，等它真的停下来再恢复。
   */
  const deadline = Date.now() + 10_000;
  while (aiControlState === "pausing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!resumeEmbedding()) {
    return { resumed: false, state: aiControlState };
  }
  try {
    // 自用（2026-10）：恢复时也推一条，顶栏立刻从"已暂停"回到"运行中"。
    const progress = getEmbeddingProgress();
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) {
        continue;
      }
      win.webContents.send("ai-progress", {
        channel: "ai-progress",
        phase: progress.phase === "idle" ? "embedding" : progress.phase,
        processed: progress.processed,
        total: progress.total,
        isPaused: false,
      });
    }
  } catch (error) {
    console.warn(
      "[AI] Resume progress push failed:",
      error instanceof Error ? error.message : String(error)
    );
  }
  // 自用（第 10 轮·吞吐修复）：恢复建向量同样要抢显卡
  const gpuBlocked = tryAcquireGpu("embedding");
  if (gpuBlocked) {
    console.warn(`[AI] 恢复建向量未启动：${gpuBlocked}`);
    return { resumed: false, state: aiControlState, reason: gpuBlocked };
  }
  // Fire-and-forget: restart embedding
  embedAllPhotos((aiProgress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ai-progress", aiProgress);
    }
  })
    .then((count) => {
      console.log(`[AI] Resume embedding complete: ${count} photos processed`);
    })
    .catch((err) => {
      console.error("[AI] Resume embedding error:", err);
    })
    .finally(() => {
      releaseGpu("embedding");
    });
  return { resumed: true };
});

export const getAiProgress = os.handler(() => {
  const progress = getEmbeddingProgress();
  /*
   * 自用（2026-10-20 · 会话#10）：挂起期间，**轮询也必须看到"已暂停"**。
   * 界面每秒拉一次这个接口（`useAiStatus` / `AiProgressBar`）；如果它拿到的还是
   * "tagging"，那么"暂停 → 轮询 → 又变回运行中"，暂停按钮会重新出现、
   * 用户看到的就是"点了暂停又继续"✗。这里统一按挂起标志改相位。
   */
  if (
    progress.phase === "tagging" &&
    (isPixaiTaggingSuspended() || isWd14TaggingSuspended())
  ) {
    return { ...progress, phase: "tagging-paused" as const, isPaused: true };
  }
  return progress;
});

export const getAiStatus = os.handler(() => {
  return getAiReadiness();
});

export const getAiHealth = os.handler(() => {
  return checkAiHealth();
});

/**
 * 重建向量数据库并重置所有 AI 索引标志。
 * 用于修复 LanceDB 索引损坏导致的搜索闪退问题。
 * 调用方应随后调用 startAiIndexing 以自动重新索引。
 */
export const resetAiIndex = os.handler(async () => {
  if (aiControlState !== "idle" || isAutoTaggingActive()) {
    return {
      busy: true,
      success: false,
    };
  }
  const rebuildResult = await rebuildVectorDB();
  if (!rebuildResult.success) {
    return {
      success: false,
      error: rebuildResult.error ?? "Failed to rebuild vector database",
    };
  }

  const resetCount = resetAllAiProcessedFlags();
  setWasAutoRepaired(true);

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("ai-status-changed");
  }

  console.log(
    `[AI] Index reset: vector DB rebuilt, ${resetCount} isAiProcessedFlags cleared`
  );
  return { success: true };
});

/**
 * 自用（需求 1）：打标"运行令牌"。
 *
 * 场景（用户实测的"一闪而过"）：暂停 → 立刻点继续 → 新一轮已经开始，
 * 但**上一轮**的循环此刻才退出，它收尾时会把进度写成"已暂停/完成"，
 * 把新那一轮的"正在生成 AI 标签"覆盖掉 —— 看起来就是提示闪一下就没了。
 * 有了令牌，只有"当前这一轮"才允许写终态进度。
 */
let taggingRunToken = 0;

/**
 * 自用（2026-10-20 · 会话#10）：**这一轮打标任务是否还在 `batchGenerateTags` 里**。
 *
 * 从"点了按钮"到"循环真正结束"都算在内 —— 包括还在加载模型、抢显卡的那十几秒。
 * `pauseTagging` 靠它识别"暂停落在启动窗口期"，见那里的说明。
 */
let taggingJobInFlight = false;

export const batchGenerateTags = os.handler(async () => {
  /*
   * 自用（2026-10-17，待办第 5 项）：**挂起中再点"继续" = 恢复，不是开新的一轮** ✓
   * 否则会撞上后面的 busy 判断（`isPixaiTaggingRunning()` 仍为 true）→ 界面"点了没反应" ✗
   */
  if (isPixaiTaggingSuspended()) {
    resumePixaiTagging();
    const p = getEmbeddingProgress();
    broadcastTaggingPhase("tagging", p.processed, p.total);
    return { resumed: true, skipped: 0, tagged: 0, total: 0 };
  }
  if (isWd14TaggingSuspended()) {
    resumeWd14Tagging();
    return { resumed: true, skipped: 0, tagged: 0, total: 0 };
  }
  if (
    aiControlState !== "idle" ||
    isAutoTaggingActive() ||
    isWd14TaggingRunning() ||
    isPixaiTaggingRunning() ||
    // 这一轮还在启动（模型没加载完）：第二次点击直接当 busy，
    // 否则会并发起两轮打标（后一轮会在 tagger 里抛"已在进行中"）
    taggingJobInFlight
  ) {
    return { busy: true, skipped: 0, tagged: 0, total: 0 };
  }
  taggingJobInFlight = true;
  try {
    return await startTaggingJob();
  } finally {
    taggingJobInFlight = false;
    /*
     * 启动阶段就被挡下（显卡被建向量占着）或直接抛错时，把可能立起来的
     * "挂起"标志清掉 —— 否则下一次点「生成 AI 标签」会被当成"继续"，
     * 什么都不做（界面上就是点了没反应）。
     */
    if (!(isPixaiTaggingRunning() || isWd14TaggingRunning())) {
      if (getActiveTagger() === "wd14") {
        resumeWd14Tagging();
      } else {
        resumePixaiTagging();
      }
    }
  }
});

/** 真正跑一轮打标（`batchGenerateTags` 的主体，拆出来只为把"启动窗口期"包进 try/finally）。 */
async function startTaggingJob() {
  /**
   * 自用（第 10 轮·吞吐修复）：打标与"建向量"**共用同一块显卡**，同时跑会互相拖慢
   * （实测打标从 1.71 张/秒掉到 1.7 以下、建向量也从 20 张/秒掉下来）。
   * 所以这里先抢显卡：抢不到就明确拒绝，并在 `currentFile` 里说明被谁挡着。
   */
  const gpuBlocked = tryAcquireGpu("tagging");
  if (gpuBlocked) {
    console.warn(`[AI] 打标未启动：${gpuBlocked}`);
    setCurrentProgress({
      processed: getEmbeddingProgress().processed,
      total: getEmbeddingProgress().total,
      phase: "tagging",
      currentFile: gpuBlocked,
    });
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ai-progress", getEmbeddingProgress());
    }
    return { busy: true, skipped: 0, tagged: 0, total: 0 };
  }
  const runToken = ++taggingRunToken;
  const isCurrentRun = () => runToken === taggingRunToken;
  const db = getDatabase();
  const indexed = db
    .select({ id: photos.id })
    .from(photos)
    .where(eq(photos.isAiProcessed, true))
    .all()
    .map((p) => p.id);

  // PixAI / WD14 只需要缩略图、不依赖 SigLIP 嵌入，所以即便一张都没嵌入过也能打标；
  // 只有走上游 SigLIP 打标时才必须先嵌入过。
  if (indexed.length === 0 && getActiveTagger() === "upstream") {
    return { tagged: 0, skipped: 0, total: 0 };
  }

  const broadcastProgress = () => {
    const progress = getEmbeddingProgress();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ai-progress", progress);
    }
  };
  // 自用（方案 A · 问题 6）：第一帧就用**累计口径**（库里已完成 / 全库），
  // 不要先填一个"全库张数 + 0"的数字 —— 那看起来像从头重跑。
  const tagBaseline =
    getActiveTagger() === "pixai"
      ? getPixaiTaggingBaseline()
      : getWd14TaggingBaseline();
  setCurrentProgress({
    processed: tagBaseline.done,
    total: tagBaseline.total,
    // 启动窗口期可能已经被"暂停"预定过了（见 pauseTagging），别把相位翻回运行中
    phase: taggingPhaseNow(),
    currentFile: "",
  });
  broadcastProgress();
  try {
    const activeTagger = getActiveTagger();
    if (activeTagger === "pixai") {
      // NEXT（2026-10）：全库重跑 PixAI 打标。
      //
      // 与 WD14 同样的语义：persistResults 在写入前会删除这些照片的
      // `user_confirmed = 0` 标签，于是**上一个模型留下的标签会被自然替换掉**；
      // **手动标签与已确认标签一律不动**。剩下没照片的旧标签会因 `photoCount = 0`
      // 被侧边栏自动隐藏。
      const modelsDir = await ensureLocalModel();
      const pixaiResult = await runPixaiTagging(modelsDir, {
        // 自用（需求 1）：界面这条路**续跑**，不再从第 0 张重来。
        // 游标里已有进度就从那里继续；确实是全新的库（游标为 0）才等于全库扫一遍。
        // 想强制全库重扫（换模型、旧标签全部重打）请显式调用
        // `resetPixaiTaggingProgress()`，那是唯一会"从头开始"的入口。
        resetCursor: false,
        // 让界面这条路也尊重 设置 → GPU 加速（`gpu.enabled`）。
        // 之前没传这个字段，`initPixaiTagger(modelsDir, Boolean(undefined))` 恒为 false，
        // 于是界面打标是**纯 CPU**：实测 6.5 秒/张，而 DirectML 是 0.59 秒/张（差 11 倍）。
        useGpu: getSetting("gpu.enabled") === "true",
        onProgress: (p) => {
          setCurrentProgress({
            processed: p.done,
            total: p.total,
            // 暂停是"批边界才停"：在途批次收尾时可能还会回调一次，
            // 这里按挂起标志写相位，界面才不会从"已暂停"跳回"进行中"（会话#10）
            phase: taggingPhaseNow(),
            currentFile: "",
          });
          broadcastProgress();
        },
      });
      // 自用（需求 1）：只有当前这一轮才允许写终态进度（见 taggingRunToken 说明）
      if (isCurrentRun()) {
        // 暂停时的最后一次进度：保留"上次报过的已完成张数"，
        // 别用 total（那是全库张数，会显示成 100%）
        const lastTagProgress = getEmbeddingProgress();
        setCurrentProgress(
          pixaiResult.cancelled
            ? // 被暂停：保留 processed/total 与"已暂停"相位，别显示成"完成"
              {
                processed: lastTagProgress.processed,
                total: lastTagProgress.total,
                phase: "tagging-paused",
                currentFile: "",
              }
            : {
                processed: pixaiResult.total,
                total: pixaiResult.total,
                phase: "complete",
                currentFile: "",
              }
        );
        broadcastProgress();
      }
      return {
        tagged: pixaiResult.tagged,
        skipped: pixaiResult.failed,
        total: pixaiResult.total,
      };
    }
    if (activeTagger === "wd14") {
      // 自用：全库重跑 WD14 打标。
      //
      // 这一步**同时完成"清掉旧摄影标签"**：persistResults 在写入前会删除这些
      // 照片的 `user_confirmed = 0` 标签，于是上游 SigLIP 留下的 153 个摄影概念
      // 标签会被自然替换掉；**手动标签与已确认标签一律不动**。
      // 剩下没照片的旧标签会因 `photoCount = 0` 被侧边栏自动隐藏。
      const modelsDir = await ensureLocalModel();
      const result = await runWd14Tagging(modelsDir, {
        // 自用（需求 1）：同 PixAI —— 界面这条路续跑，不从头。
        // 强制全库重扫请显式调用 `resetWd14TaggingProgress()`。
        resetCursor: false,
        // 自用：界面 WD14 打标也走显卡（旧版的主力路径）
        useGpu: getSetting("gpu.enabled") === "true",
        onProgress: (p) => {
          setCurrentProgress({
            processed: p.done,
            total: p.total,
            phase: taggingPhaseNow(),
            currentFile: "",
          });
          broadcastProgress();
        },
      });
      if (isCurrentRun()) {
        const lastTagProgress = getEmbeddingProgress();
        setCurrentProgress(
          result.cancelled
            ? // 被暂停：保留"已暂停"相位（见 pauseTagging 的说明）
              {
                processed: lastTagProgress.processed,
                total: lastTagProgress.total,
                phase: "tagging-paused",
                currentFile: "",
              }
            : {
                processed: result.total,
                total: result.total,
                phase: "complete",
                currentFile: "",
              }
        );
        broadcastProgress();
      }
      return {
        tagged: result.tagged,
        skipped: result.failed,
        total: result.total,
      };
    }

    const result = await batchSuggestTags(
      indexed,
      (processed, total, photoId) => {
        setCurrentProgress({
          processed,
          total,
          phase: "tagging",
          currentFile: String(photoId),
        });
        broadcastProgress();
      },
      "refresh"
    );
    setCurrentProgress({
      processed: indexed.length,
      total: indexed.length,
      phase: "complete",
      currentFile: "",
    });
    broadcastProgress();
    return { ...result, total: indexed.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setCurrentProgress({
      processed: getEmbeddingProgress().processed,
      total: indexed.length,
      phase: "tag-error",
      currentFile: "",
      error: message,
    });
    broadcastProgress();
    throw error;
  } finally {
    // 释放显卡占用（见函数开头的 tryAcquireGpu）
    releaseGpu("tagging");
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ai-tags-done");
    }
  }
}
