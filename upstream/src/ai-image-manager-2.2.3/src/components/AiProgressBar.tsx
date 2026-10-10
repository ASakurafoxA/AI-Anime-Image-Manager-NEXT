import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openExternalLink } from "@/actions/shell";
import { useProgressRate } from "@/hooks/use-progress-rate";
import { ipc } from "@/ipc/manager";

interface AiProgress {
  controlState?: "idle" | "running" | "pausing" | "paused" | "cancelling";
  currentFile: string;
  downloadPercent?: number;
  error?: string;
  isActive: boolean;
  isModelLoaded: boolean;
  isPaused?: boolean;
  loadingStartedAt?: number | null;
  phase:
    | "idle"
    | "loading"
    | "embedding"
    | "tagging"
    | "complete"
    | "error"
    | "tag-error"
    | "repairing";
  processed: number;
  repairReason?: string;
  total: number;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this component coordinates existing UI state and rendering branches
export function AiProgressBar({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<AiProgress | null>(null);
  const [isMutating, setIsMutating] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const pollingRef = useRef(false);

  /*
   * 自用（需求 7）：特征提取 / 打标阶段显示"处理速度 + 预估剩余时间"。
   * 只在这两个（含重建索引）阶段采样 —— 加载模型、已完成、空闲没有意义。
   * ⚠️ 必须在下面的提前 return 之前调用（React Hooks 规则）。
   */
  const counting =
    progress !== null &&
    (progress.phase === "embedding" ||
      progress.phase === "tagging" ||
      progress.phase === "repairing");
  const { pending: ratePending, remainingText, speedText } = useProgressRate(
    counting && progress
      ? {
          isActive: progress.isActive,
          phase: progress.phase,
          processed: progress.processed,
          total: progress.total,
        }
      : null
  );

  const fetchProgress = useCallback(async () => {
    try {
      const result = await ipc.client.photos.getAiProgress({});
      return result as AiProgress;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    fetchProgress().then((p) => {
      if (!disposed && p) {
        setProgress(p);
      }
    });

    return () => {
      disposed = true;
    };
  }, [fetchProgress]);

  // Poll while active (fast: 500ms)
  useEffect(() => {
    if (!progress?.isActive || pollingRef.current) {
      return;
    }

    pollingRef.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;

    const poll = async () => {
      const p = await fetchProgress();
      if (disposed) {
        return;
      }
      if (p) {
        setProgress(p);
      }
      if (p?.isActive) {
        timer = setTimeout(poll, 1000);
      } else {
        pollingRef.current = false;
      }
    };

    timer = setTimeout(poll, 1000);

    return () => {
      disposed = true;
      clearTimeout(timer);
      pollingRef.current = false;
    };
  }, [progress?.isActive, fetchProgress]);

  // Slow poll when idle — detects auto-started embeddings (e.g. after folder import)
  const slowPollRef = useRef(false);
  useEffect(() => {
    if (progress?.isActive || slowPollRef.current) {
      return;
    }

    slowPollRef.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;

    const poll = async () => {
      const p = await fetchProgress();
      if (disposed) {
        return;
      }
      if (p) {
        setProgress(p);
      }
      // Stop slow poll once embedding is detected (fast poll takes over)
      if (p?.isActive) {
        slowPollRef.current = false;
        return;
      }
      timer = setTimeout(poll, 1000);
    };

    timer = setTimeout(poll, 1000);

    return () => {
      disposed = true;
      clearTimeout(timer);
      slowPollRef.current = false;
    };
  }, [progress?.isActive, fetchProgress]);

  useEffect(() => {
    if (!progress) {
      return;
    }
    if (progress.phase === "error" || progress.phase === "tag-error") {
      setLastError(
        progress.error ||
          (progress.phase === "tag-error"
            ? t("aiTagsFailed")
            : t("aiInitFailed"))
      );
    }
  }, [progress, t]);

  async function runProgressMutation(action: () => Promise<unknown>) {
    setIsMutating(true);
    try {
      await action();
      const p = await fetchProgress();
      if (p) {
        setProgress(p);
      } else {
        setProgress(null);
      }
    } finally {
      setIsMutating(false);
    }
  }

  async function handleStart() {
    if (disabled) {
      return;
    }
    setLastError(null);
    await runProgressMutation(() => ipc.client.photos.startAiIndexing({}));
  }

  async function handlePause() {
    await runProgressMutation(() => ipc.client.photos.pauseAiIndexing({}));
  }

  async function handleResume() {
    setLastError(null);
    await runProgressMutation(() => ipc.client.photos.resumeAiIndexing({}));
  }

  async function handleCancel() {
    await runProgressMutation(() => ipc.client.photos.cancelAiIndexing({}));
  }

  if (
    progress?.phase === "error" ||
    progress?.phase === "tag-error" ||
    lastError
  ) {
    const isNetworkError =
      lastError?.includes("ENOTFOUND") ||
      lastError?.includes("timeout") ||
      lastError?.includes("ETIMEDOUT") ||
      lastError?.includes("fetch failed") ||
      lastError?.includes("network");

    return (
      <div className="mt-2 rounded-[6px] border border-danger/30 bg-danger/5 px-3 py-2">
        <p className="font-medium text-[11px] text-danger">{lastError}</p>

        {isNetworkError ? (
          <div className="mt-2 space-y-2">
            <p className="text-[10px] text-muted-foreground">
              {t("aiNetworkErrorHint")}
            </p>
            <div className="rounded-[4px] border border-border bg-card p-2">
              <p className="mb-1 text-[10px] text-muted-foreground">
                {t("aiMirrorRecommendation")}
              </p>
              <button
                className="w-full rounded-[4px] bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20"
                onClick={async () => {
                  try {
                    await openExternalLink("https://hf-mirror.com");
                  } catch {
                    // The shell action reports its own failure to the caller.
                  }
                }}
                type="button"
              >
                {t("aiOpenMirrorSite")}
              </button>
              <p className="mt-1.5 text-[9px] text-muted-foreground/70">
                {t("aiMirrorSettingsHint")}
              </p>
            </div>
          </div>
        ) : (
          <p className="mt-1 text-[10px] text-muted-foreground">
            {t("aiMirrorHint")}
            <code className="mx-0.5 rounded-[4px] bg-card px-1 text-[10px] text-muted-foreground">
              HF_MIRROR=hf-mirror.com
            </code>
          </p>
        )}

        <button
          className="mt-2 w-full rounded-[4px] bg-primary/10 px-2 py-1 font-medium text-[11px] text-primary transition-colors hover:bg-primary/20"
          onClick={handleStart}
          type="button"
        >
          {t("aiRetry")}
        </button>
      </div>
    );
  }

  // Idle state: show start button (no active embedding, nothing processed yet)
  if (
    !progress ||
    (!progress.isActive &&
      progress.processed === 0 &&
      progress.phase !== "complete")
  ) {
    return (
      <button
        className="mt-2 w-full rounded-[6px] bg-primary/10 px-3 py-1.5 font-medium text-[12px] text-primary transition-colors hover:bg-primary/15 disabled:pointer-events-none disabled:opacity-40"
        disabled={disabled || isMutating}
        onClick={handleStart}
        type="button"
      >
        {t("aiStartIndex")}
      </button>
    );
  }

  // Complete state: show re-index button for newly added photos
  if (!progress.isActive && progress.phase === "complete") {
    return (
      <div className="mt-2 rounded-[6px] border border-border bg-card px-2 py-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            {t("aiIndexComplete", {
              processed: progress.processed,
              total: progress.total,
            })}
          </span>
          <span className="font-medium text-[11px] text-primary">
            {progress.total > 0
              ? `${Math.round((progress.processed / progress.total) * 100)}%`
              : "100%"}
          </span>
        </div>
        <button
          className="mt-2 w-full rounded-[4px] bg-primary/10 px-2 py-1 font-medium text-[11px] text-primary transition-colors hover:bg-primary/20"
          disabled={isMutating}
          onClick={handleStart}
          type="button"
        >
          {t("aiIndexNewPhotos")}
        </button>
      </div>
    );
  }

  let pct = 0;
  if (progress.phase === "loading" && progress.downloadPercent != null) {
    pct = progress.downloadPercent;
  } else if (progress.total > 0) {
    pct = Math.round((progress.processed / progress.total) * 100);
  }
  const controlState = progress.controlState ?? "idle";
  const paused =
    progress.isPaused ||
    controlState === "paused" ||
    controlState === "pausing";
  const cancelling = controlState === "cancelling";
  let phaseLabel = t("aiIndexingProgress", {
    processed: progress.processed,
    total: progress.total,
  });
  if (cancelling) {
    phaseLabel = t("cancel");
  } else if (paused) {
    phaseLabel = t("aiPaused");
  } else if (progress.phase === "repairing") {
    phaseLabel = t("aiRepairingIndex");
  } else if (progress.phase === "tagging") {
    phaseLabel = t("tagGeneratingProgress", {
      processed: progress.processed,
      total: progress.total,
    });
  } else if (progress.phase === "loading") {
    phaseLabel =
      progress.downloadPercent == null
        ? t("aiLoadingEmbeddingIndeterminate")
        : t("aiLoadingEmbedding", { percent: progress.downloadPercent });
  } else if (progress.phase === "complete") {
    phaseLabel = t("aiComplete");
  }

  return (
    <div className="mt-2 rounded-[6px] border border-border bg-card px-2 py-2">
      {progress.repairReason && (
        <p className="mb-1.5 rounded-[4px] bg-primary/10 px-2 py-1 text-[10px] text-primary leading-relaxed">
          {progress.repairReason}
        </p>
      )}
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {phaseLabel}
        </span>
        <span className="flex flex-shrink-0 items-center gap-1.5">
          {/* 自用（需求 7）：百分比左侧显示处理速度与预估剩余时间 */}
          {!paused && !cancelling && (speedText || remainingText || ratePending) && (
            <span className="text-[10px] text-muted-foreground/70 tabular-nums">
              {speedText ?? ""}
              {speedText && remainingText ? " · " : ""}
              {remainingText ?? (speedText ? "" : t("aiProgressEtaCalculating"))}
            </span>
          )}
          <span className="font-medium text-[11px] text-primary">{pct}%</span>
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress.currentFile && (
        <p className="mt-1 truncate text-[10px] text-muted-foreground">
          {progress.currentFile}
        </p>
      )}
      {progress.phase === "embedding" && (
        <div className="mt-2 flex gap-1">
          {paused ? (
            <>
              <button
                className="flex-1 rounded-[4px] px-2 py-1 font-medium text-[11px] text-primary transition-colors hover:bg-primary/10"
                disabled={
                  isMutating || cancelling || controlState === "pausing"
                }
                onClick={handleResume}
                type="button"
              >
                {t("aiResume")}
              </button>
              <button
                className="flex-1 rounded-[4px] px-2 py-1 font-medium text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                disabled={isMutating || cancelling}
                onClick={handleCancel}
                type="button"
              >
                {t("cancel")}
              </button>
            </>
          ) : (
            <button
              className="flex-1 rounded-[4px] px-2 py-1 font-medium text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              disabled={isMutating || cancelling}
              onClick={handlePause}
              type="button"
            >
              {t("aiPause")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
