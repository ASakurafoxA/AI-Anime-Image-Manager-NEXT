import { useTranslation } from "react-i18next";
import { useProgressRate } from "@/hooks/use-progress-rate";
import type { AiStatus } from "@/types/photo";

interface StatusBarProps {
  aiStatus: AiStatus | null;
  className?: string;
  selectedCount: number;
  totalPhotos: number;
}

export function StatusBar({
  totalPhotos,
  aiStatus,
  className,
}: StatusBarProps) {
  const { t } = useTranslation();
  let aiLabel: string;
  let aiColor: string;

  /*
   * 自用（需求 7）：底部状态栏同样显示"处理速度 + 预估剩余时间"，
   * 与侧边栏进度条共用同一套估算（特征提取 / 打标阶段）。
   *
   * 2026-10-20（会话#10）：**不能再要求 `isEmbedding`** —— 打标（尤其导入后的
   * 自动打标）可能挂在建向量那一轮里跑，`isEmbedding` 为 true 但阶段其实是 tagging；
   * 原来的写法会让底部永远不显示打标的速度/预估，与顶栏对不上。
   */
  const phase = aiStatus?.embeddingProgress?.phase ?? null;
  const counting =
    phase === "embedding" || phase === "tagging" || phase === "repairing";
  const { remainingText, speedText } = useProgressRate(
    counting && aiStatus
      ? {
          isActive: true,
          phase: String(phase),
          processed: aiStatus.embeddingProgress.processed,
          total: aiStatus.embeddingProgress.total,
        }
      : null
  );

  if (!aiStatus) {
    aiLabel = t("aiNotReady");
    aiColor = "text-foreground-tertiary";
  } else if (aiStatus.lastError) {
    aiLabel =
      aiStatus.lastError.length > 40
        ? `AI 索引失败: ${aiStatus.lastError.slice(0, 40)}…`
        : `AI 索引失败: ${aiStatus.lastError}`;
    aiColor = "text-red-500";
  } else if (phase === "tagging-paused") {
    /*
     * 自用（2026-10-20 · 会话#10）：**先判暂停，再判"正在索引"**。
     * 原来 `isEmbedding` 的分支在前，而导入后的自动打标是挂在建向量那一轮里的
     * （`isEmbedding` 仍为 true）→ 打标暂停时底部会显示成黄色的
     * "AI 索引中 3%"，跟顶栏的"AI 标签生成 · 已暂停"完全不是一回事。
     */
    aiLabel = `${t("aiPaused")} · ${t("tagPausedHint")}`;
    aiColor = "text-muted-foreground";
  } else if (phase === "tagging") {
    const { processed, total } = aiStatus.embeddingProgress;
    // 自用修复（2026-10-09）：原来只传 processed/total，漏了 remaining，
    // 导致界面把 `{{remaining}}` 原样显示出来（"本次还需 {{remaining}}"）。
    // 与 Sidebar.tsx 的口径保持一致：remaining = total - processed。
    aiLabel = t("tagGeneratingProgress", {
      processed,
      total,
      remaining: Math.max(0, total - processed),
    });
    aiColor = "text-warning";
  } else if (aiStatus.isEmbedding) {
    const { processed, total } = aiStatus.embeddingProgress;
    const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
    aiLabel = t("aiIndexingPercent", { pct });
    aiColor = "text-warning";
  } else if (aiStatus.indexReady) {
    aiLabel = t("aiReadyVectors", { count: aiStatus.vectorCount });
    aiColor = "text-success";
  } else {
    aiLabel = t("aiNotIndexed");
    aiColor = "text-foreground-tertiary";
  }

  return (
    <div
      className={`glass-surface flex h-7 min-w-0 items-center justify-between gap-3 overflow-hidden border-border-subtle border-t px-3 text-[11px] sm:px-4 ${className ?? ""}`}
      data-surface="statusbar"
    >
      <div className="min-w-0 text-muted-foreground">
        <span className="block truncate">
          {t("totalPhotosStatus", { count: totalPhotos.toLocaleString() })}
        </span>
      </div>
      <div className={`flex min-w-0 items-center gap-1.5 ${aiColor}`}>
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
        <span className="truncate">{aiLabel}</span>
        {(speedText || remainingText) && (
          <span className="flex-shrink-0 text-muted-foreground/70 tabular-nums">
            {speedText ?? ""}
            {speedText && remainingText ? " · " : ""}
            {remainingText ?? ""}
          </span>
        )}
      </div>
    </div>
  );
}
