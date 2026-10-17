import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useGlobalAiStatus } from "@/hooks/use-global-ai-status";
import { useProgressRate } from "@/hooks/use-progress-rate";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { ipc } from "@/ipc/manager";
import { getRandomPhrase } from "@/utils/progress-phrases";

/** Smooth-transitioning global progress indicator for the header area. */
export function GlobalProgressBar() {
  const { t } = useTranslation();
  const status = useGlobalAiStatus();
  const reduceMotion = useReducedMotion();
  const queryClient = useQueryClient();
  /** 自用：暂停打标是异步的（要等循环在批次边界退出，最长 8 秒），期间禁用按钮防止重复点。 */
  const [pausingTag, setPausingTag] = useState(false);

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

  useEffect(() => {
    if (reduceMotion) {
      setRender(status.isRunning);
      setVisible(status.isRunning);
      prevRunningRef.current = status.isRunning;
      return;
    }
    if (status.isRunning && !render) {
      // Enter: render immediately, then animate in
      setRender(true);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setVisible(true))
      );
      prevRunningRef.current = true;
    } else if (status.isRunning && render) {
      // A new task can start while the previous task is still in its
      // slide-out window. The exit effect cleanup cancels that timer, but
      // the bar must also be made visible again.
      setVisible(true);
      prevRunningRef.current = true;
    } else if (!status.isRunning && render) {
      // Exit: animate out, then unmount after transition
      setVisible(false);
      const timer = setTimeout(() => setRender(false), 350);
      prevRunningRef.current = false;
      return () => clearTimeout(timer);
    }
    prevRunningRef.current = status.isRunning;
  }, [reduceMotion, status.isRunning, render]);

  // ── Percent smoothing ───────────────────────────────────────
  // Smooth the raw percentage so rapid updates don't cause jitter.
  const [smoothPct, setSmoothPct] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!status.isRunning || reduceMotion) {
      setSmoothPct(reduceMotion ? status.percent : 0);
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
    (status.phase === "import-queue" && smoothPct < 1);
  const showSpinner = status.phase === "loading-model" || isIndeterminate;
  const progressLabel = status.statusText
    ? `${phrase} · ${status.statusText}`
    : phrase;

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
              {status.statusText && (
                <span className="text-muted-foreground/70">
                  {` · ${status.statusText}`}
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
        {status.phase === "tagging" && (
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
              {Math.round(smoothPct)}%
            </span>
          </>
        )}
      </div>

      <div className="mx-4 h-px rounded-full bg-foreground/10">
        <div
          className={`h-full bg-primary transition-[width] duration-300 ease-out ${isIndeterminate ? "animate-indeterminate-bar" : ""}
          `}
          data-reduced-motion-keep="progress-bar"
          style={{
            width: isIndeterminate ? "30%" : `${Math.max(1, smoothPct)}%`,
          }}
        />
      </div>
    </div>
  );
}
