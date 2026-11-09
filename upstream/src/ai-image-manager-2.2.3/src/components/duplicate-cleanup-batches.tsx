import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { duplicateActions } from "@/actions/duplicates";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function DuplicateCleanupBatches({
  onRestored,
}: {
  onRestored?: () => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [failures, setFailures] = useState<
    Record<string, Array<{ id: number; filename: string }>>
  >({});
  const batches = useQuery({
    queryKey: ["duplicate-cleanup-batches"],
    queryFn: duplicateActions.listCleanupBatches,
  });
  const restore = useMutation({
    mutationFn: duplicateActions.restoreCleanupBatch,
    onError: () => toast.error(t("duplicateCleanupRestoreFailed")),
    onSuccess: (result) => {
      setFailures((previous) => ({
        ...previous,
        [result.batchId]: result.failed,
      }));
      if (result.failed.length === 0) {
        toast.success(
          t("duplicateCleanupRestoreSuccess", {
            count: result.restoredIds.length,
          })
        );
      } else {
        toast.error(
          t("duplicateCleanupRestorePartial", {
            count: result.restoredIds.length,
            failed: result.failed.length,
          })
        );
      }
      client.invalidateQueries({ queryKey: ["duplicate-cleanup-batches"] });
      client.invalidateQueries({ queryKey: ["duplicates"] });
      onRestored?.();
    },
  });
  if (batches.isError) {
    return (
      <button
        className="px-4 py-2 text-left text-destructive text-sm"
        onClick={() => batches.refetch()}
        type="button"
      >
        {t("duplicateBatchLoadFailed")}
      </button>
    );
  }
  if (!batches.data?.length) {
    return null;
  }
  return (
    <Dialog>
      <DialogTrigger asChild>
        {/*
         * 自用（2026-11-09 · 会话#11 用户口径）「字体样式弄的和旁边三个按钮一样」：
         * 之前这里用的是 `text-muted-foreground`（灰字），而「重新扫描 / 清理全部待处理」
         * 都是 `text-foreground` + `font-medium` + 13px → 并排一眼就能看出不一样 ✗
         * 现在字号/字重/颜色全部对齐工具栏按钮 ✓
         */}
        <button
          className="flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 font-medium text-[13px] text-foreground transition-colors hover:bg-foreground/5"
          type="button"
        >
          {t("duplicateCleanupHistory", { count: batches.data.length })}
        </button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85dvh] max-w-lg flex-col gap-3 overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {t("duplicateCleanupHistory", { count: batches.data.length })}
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-relaxed">
            {t("duplicateCleanupHistoryHint")}
          </DialogDescription>
        </DialogHeader>
        <ul className="min-h-0 space-y-2 overflow-y-auto pr-1">
          {batches.data.map((batch) => (
            <li
              className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-[8px] border border-border bg-secondary/30 p-3"
              key={batch.batchId}
            >
              <div className="min-w-0 [overflow-wrap:anywhere]">
                <p className="tabular-nums text-[12.5px] text-foreground leading-relaxed">
                  {t("duplicateCleanupBatchLabel", {
                    date: new Date(batch.executedAt).toLocaleString(),
                    count: batch.remainingCount,
                    interpolation: { escapeValue: false },
                  })}
                </p>
                {failures[batch.batchId]?.length ? (
                  <div
                    className="mt-2 rounded-[6px] bg-destructive/5 p-2.5 text-[11.5px] text-destructive"
                    role="alert"
                  >
                    <p>{t("duplicateCleanupRestoreFailureHint")}</p>
                    <ul className="mt-1.5 space-y-0.5 text-foreground/90">
                      {failures[batch.batchId].map((item) => (
                        <li className="[overflow-wrap:anywhere]" key={item.id}>
                          {item.filename}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
              <Button
                aria-label={t("duplicateCleanupRestoreButtonForBatch", {
                  id: batch.batchId.slice(0, 8),
                })}
                className="shrink-0"
                disabled={restore.isPending}
                onClick={() => restore.mutate(batch.batchId)}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("duplicateCleanupRestoreButton")}
              </Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
