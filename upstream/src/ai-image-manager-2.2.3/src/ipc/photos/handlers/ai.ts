import { os } from "@orpc/server";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { getActiveTagger, PRIVATE_BUILD } from "@/config/private-build";
import { getSetting } from "@/services/settings-manager";
import { ensureLocalModel } from "@/services/ai/model-loader";
import { runWd14Tagging, isWd14TaggingRunning } from "@/services/ai/wd14-tagger";
import {
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
  }
  return { cancelled: true };
});

export const pauseAiIndexing = os.handler(() => {
  pauseEmbedding();
  return { paused: true };
});

export const resumeAiIndexing = os.handler(() => {
  if (!resumeEmbedding()) {
    return { resumed: false, state: aiControlState };
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

export const batchGenerateTags = os.handler(async () => {
  if (
    aiControlState !== "idle" ||
    isAutoTaggingActive() ||
    isWd14TaggingRunning() ||
    isPixaiTaggingRunning()
  ) {
    return { busy: true, skipped: 0, tagged: 0, total: 0 };
  }
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
  setCurrentProgress({
    processed: 0,
    total: indexed.length,
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
        resetCursor: true,
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
      setCurrentProgress({
        processed: pixaiResult.total,
        total: pixaiResult.total,
        phase: "complete",
        currentFile: "",
      });
      broadcastProgress();
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
        resetCursor: true,
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
      setCurrentProgress({
        processed: result.total,
        total: result.total,
        phase: "complete",
        currentFile: "",
      });
      broadcastProgress();
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
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ai-tags-done");
    }
  }
});
