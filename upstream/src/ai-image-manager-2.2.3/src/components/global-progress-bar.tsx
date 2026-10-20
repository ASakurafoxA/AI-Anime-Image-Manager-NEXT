import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAiStatus } from "@/hooks/useAiStatus";
import { useGlobalAiStatus } from "@/hooks/use-global-ai-status";
import { useProgressRate } from "@/hooks/use-progress-rate";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { ipc } from "@/ipc/manager";
import { getRandomPhrase } from "@/utils/progress-phrases";

/** Smooth-transitioning global progress indicator for the header area. */
export function GlobalProgressBar() {
  const { t } = useTranslation();
  const status = useGlobalAiStatus();
  const { data: aiStatus } = useAiStatus();
  /*
   * 自用（2026-10）：**计数口径** —— 与打标那边一致。
   *
   * 本轮的 processed/total 是"这一轮做了多少 / 这一轮还要做多少" ✗，
   * 续跑时会显示成 `200/52571`，看着像从头开始 ✗。
   * 换成全库覆盖数（indexedPhotos / totalPhotos）：
   *   左边 = 累计已完成、右边 = 全库总数，续跑时接着往上数 ✓
   * 速度与预估剩余时间**仍用本轮数据** ✓（那个必须用本轮的张数与耗时才准 ✓）。
   */
  const embeddingCoverage =
    status.phase === "embedding" &&
    /*
     * 2026-10-20（会话#10）：暂停时**不能**用"全库覆盖数"顶替当前进度。
     * 建向量暂停后 indexed/total 会显示成 "1358/1358（还需 0）/ 100%"，
     * 看着像已经跑完了（用户截图里就是这个假 100%）。
     */
    status.isPaused !== true &&
    typeof aiStatus?.indexedPhotos === "number" &&
    typeof aiStatus?.totalPhotos === "number" &&
    (aiStatus?.totalPhotos ?? 0) > 0
      ? {
          indexed: aiStatus?.indexedPhotos ?? 0,
          total: aiStatus?.totalPhotos ?? 0,
        }
      : null;
  /** 自用：与计数同口径的百分比（全库覆盖），保证文字与紫线一致 ✓。 */
  const coveragePct = embeddingCoverage
    ? (embeddingCoverage.indexed / embeddingCoverage.total) * 100
    : 0;
  const countText = embeddingCoverage
    ? `AI 特征提取 ${embeddingCoverage.indexed}/${embeddingCoverage.total}（还需 ${Math.max(
        0,
        embeddingCoverage.total - embeddingCoverage.indexed
      )}）`
    : status.statusText;
  const reduceMotion = useReducedMotion();
  const queryClient = useQueryClient();
  /** 自用：暂停打标是异步的（要等循环在批次边界退出，最长 8 秒），期间禁用按钮防止重复点。 */
  const [pausingTag, setPausingTag] = useState(false);
  /** 自用（会话#9）：取消「获取角色特征」也是异步的，同样防重复点。 */
  const [cancellingCcip, setCancellingCcip] = useState(false);

  /*
   * 自用（问题 4）：顶栏右侧（百分比左边）显示"处理速度 · 预估剩余时间"。
   * 只在特征提取 / 打标这两个按张数推进的阶段有数据（其它阶段 processed/total 是 null）。
   */
  const { pending: ratePending, remainingText, speedText } = useProgressRate(
    status.isRunning &&
      status.processed !== null &&
      status.total !== null &&
      status.total > 0
      ? {
          isActive: true,
          phase: String(status.phase),
          processed: status.processed,
          total: status.total,
        }
      : null
  );

  // ── Fun phrase rotation ─────────────────────────────────────
  const [phrase, setPhrase] = useState(() => getRandomPhrase(status.phase));
  const phraseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (status.isRunning) {
      setPhrase(getRandomPhrase(status.phase));
      phraseTimerRef.current = window.setInterval(() => {
        setPhrase(getRandomPhrase(status.phase));
      }, 4000);
    } else {
      if (phraseTimerRef.current !== null) {
        clearInterval(phraseTimerRef.current);
      }
      phraseTimerRef.current = null;
    }
    return () => {
      if (phraseTimerRef.current !== null) {
        clearInterval(phraseTimerRef.current);
      }
    };
  }, [status.isRunning, status.phase]);

  // ── Smooth enter / exit ──────────────────────────────────────
  // Use a delayed unmount so the slide-out animation completes.
  const [visible, setVisible] = useState(false);
  const [render, setRender] = useState(false);
  const prevRunningRef = useRef(false);

  /*
   * 自用（2026-10）：暂停时（status.isPaused）也要继续显示这条进度条 ——
   * 否则一按暂停它就消失，用户看不到进度、也找不到恢复入口。
   */
  const shouldShow = status.isRunning || status.isPaused === true;

  useEffect(() => {
    if (reduceMotion) {
      setRender(shouldShow);
      setVisible(shouldShow);
      prevRunningRef.current = status.isRunning;
      return;
    }
    if (shouldShow && !render) {
      // Enter: render immediately, then animate in
      setRender(true);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setVisible(true))
      );
      prevRunningRef.current = true;
    } else if (shouldShow && render) {
      // A new task can start while the previous task is still in its
      // slide-out window. The exit effect cleanup cancels that timer, but
      // the bar must also be made visible again.
      setVisible(true);
      prevRunningRef.current = true;
    } else if (!shouldShow && render) {
      // Exit: animate out, then unmount after transition
      setVisible(false);
      const timer = setTimeout(() => setRender(false), 350);
      prevRunningRef.current = false;
      return () => clearTimeout(timer);
    }
    prevRunningRef.current = shouldShow;
  }, [reduceMotion, shouldShow, render]);

  // ── Percent smoothing ───────────────────────────────────────
  // Smooth the raw percentage so rapid updates don't cause jitter.
  const [smoothPct, setSmoothPct] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!status.isRunning || reduceMotion) {
      /*
       * 2026-10-20（会话#10）：**暂停时要停在当前百分比**。
       * 老代码在 !isRunning 时一律归零 → 一按暂停进度条显示 "0%"
       *（配合另一个 bug 的"假 100%"，用户看到的就是数字乱跳）。
       */
      setSmoothPct(
        reduceMotion || status.isPaused === true ? status.percent : 0
      );
      return;
    }
    // Animate toward target over ~120ms using rAF
    const target = status.percent;
    let frame = 0;
    const totalFrames = 8; // ~133ms at 60fps

    function step() {
      frame++;
      const t = Math.min(1, frame / totalFrames);
      // Ease-out quad
      const eased = 1 - (1 - t) * (1 - t);
      setSmoothPct((prev) => {
        const next = prev + (target - prev) * eased * 0.5;
        if (Math.abs(next - target) < 0.5) {
          return target;
        }
        return next;
      });
      if (frame < totalFrames && status.isRunning) {
        rafRef.current = requestAnimationFrame(step);
      }
    }
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [reduceMotion, status.percent, status.isRunning]);

  // Immediately snap on phase changes so the bar doesn't lag behind
  // a completely different task.
  const prevPhaseRef = useRef(status.phase);
  useEffect(() => {
    if (status.phase !== prevPhaseRef.current) {
      setSmoothPct(status.percent);
      prevPhaseRef.current = status.phase;
    }
  }, [status.phase, status.percent]);

  if (!render) {
    return null;
  }

  const isIndeterminate =
    (status.phase === "loading-model" && smoothPct < 1) ||
    (status.phase === "import-queue" && smoothPct < 1) ||
    // 自用（会话#9）：角色特征还在启动识别进程 / 还没拿到总数 → 走"跑马灯"，
    // 否则会定在 0% 上，看着像卡住了。
    (status.phase === "character-features" &&
      (status.isStarting === true || status.total === null));
  const showSpinner = status.phase === "loading-model" || isIndeterminate;
  const progressLabel = countText ? `${phrase} · ${countText}` : phrase;

  return (
    <div
      className={`overflow-hidden transition-all duration-300 ease-out ${visible ? "max-h-12 opacity-100" : "max-h-0 opacity-0"}
      `}
      data-reduced-motion-keep="progress-bar"
    >
      <div className="flex items-center gap-2 px-4 py-1.5">
        {showSpinner && <LoadingSpinner size="xs" />}

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {phrase}
              {countText && (
                <span className="text-muted-foreground/70">
                  {` · ${countText}`}
                </span>
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent>{progressLabel}</TooltipContent>
        </Tooltip>

        {/*
          自用：打标的「暂停」键。
          以前只有标签树那一块有，用户希望顶栏也能直接暂停 —— 位置就放在
          导入的「取消」键这里（两者互斥：正在打标时 canCancel 一定是 false）。
          phase === "tagging" 正好等价于"正在打标、可以暂停"：
          pauseTagging() 之后相位会变成 tagging-paused，而这里会把
          tagging-paused 归到 idle，所以按钮会自己消失。
        */}
        {!isIndeterminate && (
          <>
            {/* 自用（问题 4）：百分比左侧显示处理速度与预估剩余时间 */}
            {(speedText || remainingText || ratePending) && (
              <span className="shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">
                {speedText ?? ""}
                {speedText && remainingText ? " · " : ""}
                {remainingText ?? (speedText ? "" : t("aiProgressEtaCalculating"))}
              </span>
            )}
            <span className="shrink-0 font-medium text-[11px] text-primary tabular-nums">
              {Math.round(embeddingCoverage ? coveragePct : smoothPct)}%
            </span>
          </>
        )}

        {/*
          自用（2026-10）：建向量（特征提取）阶段也提供暂停。
          打标用的 pauseTagging、建向量用的 pauseAiIndexing，两者互斥。
        */}
        {status.phase === "embedding" && status.isPaused !== true && (
          <button
            className="shrink-0 rounded px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
            disabled={pausingTag}
            onClick={() => {
              setPausingTag(true);
              ipc.client.photos
                .pauseAiIndexing({})
                .then(() =>
                  queryClient.invalidateQueries({ queryKey: ["aiStatus"] })
                )
                .catch((error) => {
                  console.error("[Embedding] Failed to pause", error);
                })
                .finally(() => setPausingTag(false));
            }}
            type="button"
          >
            {t("aiPause")}
          </button>
        )}

        {status.phase === "tagging" && status.isPaused !== true && (
          <button
            className="shrink-0 rounded px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
            disabled={pausingTag}
            onClick={() => {
              setPausingTag(true);
              ipc.client.photos
                .pauseTagging({})
                // 打标暂停后 useAiStatus 的轮询会掉到 30 秒一次，
                // 这里主动失效一次，标签树那一行才能立刻变成「已暂停」。
                .then(() =>
                  queryClient.invalidateQueries({ queryKey: ["aiStatus"] })
                )
                .catch((error) => {
                  console.error("[Tagging] Failed to pause", error);
                })
                .finally(() => setPausingTag(false));
            }}
            type="button"
          >
            {t("aiPause")}
          </button>
        )}

        {status.isPaused === true && (
          <>
            <span className="shrink-0 px-2 py-0.5 text-[10px] text-muted-foreground">
              {t("aiPaused")}
            </span>
            {/*
              自用（2026-10）：暂停后的「继续」。
              直接复用打标入口 batchGenerateTags —— 它会从 app_settings 里的游标续跑，
              已打完的照片不会重打（见 pauseTagging 的注释：暂停时故意不碰 aiControlState，
              所以这里的守卫能通过）。
            */}
            <button
              className="shrink-0 rounded px-2 py-0.5 text-[10px] text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
              disabled={pausingTag}
              onClick={() => {
                setPausingTag(true);
                /*
                 * 自用（2026-10-20 · 会话#10）：**按"谁被暂停"选恢复入口**，
                 * 不要再用 `phase` 猜 —— 暂停打标的相位是 `tagging-paused`，
                 * 老代码会把它当成 embedding，于是点「继续」调的是 `resumeAiIndexing`，
                 * 打标完全没动（用户实测："点继续也不会继续"）。
                 */
                const pausedKind =
                  status.pausedKind ??
                  (status.phase === "embedding" ? "embedding" : "tagging");
                const resume =
                  pausedKind === "embedding"
                    ? ipc.client.photos.resumeAiIndexing({})
                    : ipc.client.photos.batchGenerateTags({});
                resume
                  .then(() =>
                    queryClient.invalidateQueries({ queryKey: ["aiStatus"] })
                  )
                  .catch((error) => {
                    console.error("[Tagging] Failed to resume", error);
                  })
                  .finally(() => setPausingTag(false));
              }}
              type="button"
            >
              {t("aiResume")}
            </button>
          </>
        )}

        {/*
          自用（会话#9）：CCIP「获取全库角色特征」要跑几小时，必须能中途叫停。
          取消只是停止继续算，**已经算好的特征都保留**（可续跑），
          所以这里用词是「取消」而不是「停止」，风险很低。
        */}
        {status.phase === "character-features" && (
          <button
            className="shrink-0 rounded px-2 py-0.5 text-[10px] text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
            disabled={cancellingCcip}
            onClick={() => {
              setCancellingCcip(true);
              ipc.client.photos
                .cancelCharacterFeatures({})
                .catch((error) => {
                  console.error("[CCIP] Failed to cancel", error);
                })
                .finally(() => setCancellingCcip(false));
            }}
            type="button"
          >
            {t("cancel")}
          </button>
        )}

        {status.canCancel && (
          <button
            className="shrink-0 rounded px-2 py-0.5 text-[10px] text-danger hover:bg-danger/10"
            onClick={() => {
              ipc.client.photos.stopScanning({}).catch((error) => {
                console.error("[Import] Failed to cancel current scan", error);
              });
            }}
            type="button"
          >
            {t("cancel")}
          </button>
        )}
      </div>

      <div className="mx-4 h-px rounded-full bg-foreground/10">
        <div
          className={`h-full bg-primary transition-[width] duration-300 ease-out ${isIndeterminate ? "animate-indeterminate-bar" : ""}
          `}
          data-reduced-motion-keep="progress-bar"
          style={{
            /* 宽度与上面的百分比同口径 ✓（否则会出现"文字 56%、线只有 8%"✗） */
            width: isIndeterminate
              ? "30%"
              : `${Math.max(1, embeddingCoverage ? coveragePct : smoothPct)}%`,
          }}
        />
      </div>
    </div>
  );
}
