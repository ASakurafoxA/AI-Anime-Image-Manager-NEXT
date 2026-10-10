import { os } from "@orpc/server";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { getActiveTagger, PRIVATE_BUILD } from "@/config/private-build";
import { releaseGpu, tryAcquireGpu } from "@/services/ai/gpu-queue";
import { getSetting } from "@/services/settings-manager";
import { ensureLocalModel } from "@/services/ai/model-loader";
import { runWd14Tagging, isWd14TaggingRunning, cancelWd14Tagging, getWd14TaggingBaseline } from "@/services/ai/wd14-tagger";
import {
  cancelPixaiTagging,
  getPixaiTaggingBaseline,
  isPixaiTaggingRunning,
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

export const startAiIndexing = os.handler(() => {
  if (aiControlState !== "idle") {
    return { busy: true, started: false, state: aiControlState };
  }
  /**
   * 自用（第 10 轮·吞吐修复）：建向量与打标**共用同一块显卡**，同时跑会互相拖慢。
   * 抢不到就明确拒绝（不排队），避免"两边都慢"却看不出原因。
   */
  const gpuBlocked = tryAcquireGpu("embedding");
  if (gpuBlocked) {
    console.warn(`[AI] 建向量未启动：${gpuBlocked}`);
    return { busy: true, started: false, reason: gpuBlocked };
  }
  embedAllPhotos((aiProgress) => {
    const { BrowserWindow } = require("electron");
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
  pauseEmbedding();
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
    return { paused: false };
  }
  if (pixaiRunning) {
    cancelPixaiTagging();
  }
  if (wd14Running) {
    cancelWd14Tagging();
  }
  const progress = getEmbeddingProgress();
  setCurrentProgress({
    processed: progress.processed,
    total: progress.total,
    phase: "tagging-paused",
    currentFile: "",
  });
  const stopped = await waitForTaggingToStop();
  return { paused: true, stopped };
});

export const resumeAiIndexing = os.handler(() => {
  if (!resumeEmbedding()) {
    return { resumed: false, state: aiControlState };
  }
  // 自用（第 10 轮·吞吐修复）：恢复建向量同样要抢显卡
  const gpuBlocked = tryAcquireGpu("embedding");
  if (gpuBlocked) {
    console.warn(`[AI] 恢复建向量未启动：${gpuBlocked}`);
    return { resumed: false, state: aiControlState, reason: gpuBlocked };
  }
  // Fire-and-forget: restart embedding
  embedAllPhotos((aiProgress) => {
    const { BrowserWindow } = require("electron");
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
  return getEmbeddingProgress();
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

  const { BrowserWindow } = require("electron");
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

export const batchGenerateTags = os.handler(async () => {
  if (
    aiControlState !== "idle" ||
    isAutoTaggingActive() ||
    isWd14TaggingRunning() ||
    isPixaiTaggingRunning()
  ) {
    return { busy: true, skipped: 0, tagged: 0, total: 0 };
  }
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
    for (const win of require("electron").BrowserWindow.getAllWindows()) {
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

  const { BrowserWindow } = require("electron");
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
    phase: "tagging",
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
            phase: "tagging",
            currentFile: "",
          });
          broadcastProgress();
        },
      });
      // 自用（需求 1）：只有当前这一轮才允许写终态进度（见 taggingRunToken 说明）
      if (isCurrentRun()) {
        setCurrentProgress(
          pixaiResult.cancelled
            ? // 被暂停：保留 processed/total 与"已暂停"相位，别显示成"完成"
              {
                processed: pixaiResult.total,
                total: pixaiResult.total,
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
            phase: "tagging",
            currentFile: "",
          });
          broadcastProgress();
        },
      });
      if (isCurrentRun()) {
        setCurrentProgress(
          result.cancelled
            ? // 被暂停：保留"已暂停"相位（见 pauseTagging 的说明）
              {
                processed: result.total,
                total: result.total,
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
});
