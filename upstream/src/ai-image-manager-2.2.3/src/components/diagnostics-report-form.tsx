import {
  CheckCircle2,
  ClipboardCopy,
  FileArchive,
  FileText,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  createDiagnosticsBundle,
  dismissDiagnosticIncident,
  exportDiagnosticLog,
  getDiagnosticsOverview,
} from "@/actions/diagnostics";
import { openExternalLink, openInExplorer } from "@/actions/shell";
import { FilterDropdown } from "@/components/filter-dropdown";
import { AnimatedActionButton } from "@/components/ui/animated-action-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type {
  DiagnosticBundleResult,
  DiagnosticReproducibility,
  DiagnosticsOverview,
} from "@/types/diagnostics";

interface DiagnosticsReportFormProps {
  initialActualBehavior?: string;
  initialIncidentId?: string;
  onCompleted?: (result: DiagnosticBundleResult) => void;
}

export function DiagnosticsReportForm({
  initialActualBehavior = "",
  initialIncidentId,
  onCompleted,
}: DiagnosticsReportFormProps) {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<DiagnosticsOverview>();
  const [selectedIncidentId, setSelectedIncidentId] = useState(
    initialIncidentId ?? ""
  );
  const [lastAction, setLastAction] = useState("");
  const [actualBehavior, setActualBehavior] = useState(initialActualBehavior);
  const [reproducibility, setReproducibility] =
    useState<DiagnosticReproducibility>("once");
  const [includeNativeDump, setIncludeNativeDump] = useState(false);
  const [generating, setGenerating] = useState(false);
  /** 自用：导出单文件 Markdown 的进行中状态（与 ZIP 那个分开，避免互相禁用）。 */
  const [exportingLog, setExportingLog] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [result, setResult] = useState<DiagnosticBundleResult>();
  const [feedbackRequested, setFeedbackRequested] = useState(false);
  const [issueOpenFailed, setIssueOpenFailed] = useState(false);

  const loadOverview = useCallback(async () => {
    try {
      const next = await getDiagnosticsOverview();
      setOverview(next);
      setSelectedIncidentId(
        (current) =>
          current || initialIncidentId || next.pendingIncidents[0]?.id || ""
      );
    } catch (error) {
      console.error("[Diagnostics] Failed to load overview", error);
    }
  }, [initialIncidentId]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  const selectedIncident = useMemo(
    () =>
      overview?.pendingIncidents.find(
        (incident) => incident.id === selectedIncidentId
      ),
    [overview, selectedIncidentId]
  );

  async function dismissSelectedIncident() {
    if (!selectedIncidentId || dismissing || generating) {
      return;
    }
    setDismissing(true);
    try {
      const response = await dismissDiagnosticIncident(selectedIncidentId);
      if (response.dismissed) {
        setSelectedIncidentId("");
        await loadOverview();
        toast.success(t("diagnosticsIncidentDismissed"));
      }
    } catch (error) {
      console.error("[Diagnostics] Failed to dismiss incident", error);
      toast.error(t("diagnosticsIncidentDismissFailed"));
    } finally {
      setDismissing(false);
    }
  }

  const incidentOptions = useMemo(
    () => [
      { label: t("diagnosticsNewReport"), value: "" },
      ...(overview?.pendingIncidents.map((incident) => ({
        label: `${incident.id} · ${incident.summary}`,
        value: incident.id,
      })) ?? []),
    ],
    [overview, t]
  );

  async function openIssue(resultToOpen: DiagnosticBundleResult) {
    try {
      await openExternalLink(resultToOpen.issueUrl);
      setIssueOpenFailed(false);
    } catch (error) {
      console.error("[Diagnostics] Failed to open GitHub", error);
      setIssueOpenFailed(true);
      try {
        await navigator.clipboard.writeText(resultToOpen.issueBody);
        toast.error(t("diagnosticsIssueFallback"));
      } catch (clipboardError) {
        console.error(
          "[Diagnostics] Failed to copy issue body",
          clipboardError
        );
        toast.error(t("diagnosticsIssueFallbackCopyFailed"));
      }
    }
  }

  async function generate(shouldOpenIssue: boolean) {
    if (!lastAction.trim()) {
      toast.error(t("diagnosticsLastActionRequired"));
      return;
    }
    setGenerating(true);
    try {
      const next = await createDiagnosticsBundle({
        incidentId: selectedIncidentId || undefined,
        lastAction: lastAction.trim(),
        actualBehavior: actualBehavior.trim() || undefined,
        reproducibility,
        includeNativeDump,
      });
      setResult(next);
      setFeedbackRequested(shouldOpenIssue);
      setIssueOpenFailed(false);
      if (selectedIncidentId) {
        try {
          await dismissDiagnosticIncident(selectedIncidentId);
          await loadOverview();
        } catch (error) {
          console.warn("[Diagnostics] Failed to dismiss incident", error);
        }
      }
      if (shouldOpenIssue) {
        await openIssue(next);
      }
      try {
        await openInExplorer(next.bundlePath);
      } catch (error) {
        console.error("[Diagnostics] Failed to open File Explorer", error);
        toast.error(t("diagnosticsExplorerFailed"));
      }
      toast.success(t("diagnosticsBundleReady"));
      onCompleted?.(next);
    } catch (error) {
      console.error("[Diagnostics] Bundle generation failed", error);
      toast.error(t("diagnosticsBundleFailed"));
    } finally {
      setGenerating(false);
    }
  }

  /**
   * 自用：导出**单个 Markdown** 诊断日志。
   * `copyToClipboard` = true 时顺便复制全文（直接粘给 AI 最省事，不用找文件）。
   */
  async function exportLog(copyToClipboard: boolean) {
    if (!lastAction.trim()) {
      toast.error(t("diagnosticsLastActionRequired"));
      return;
    }
    setExportingLog(true);
    try {
      const exported = await exportDiagnosticLog({
        incidentId: selectedIncidentId || undefined,
        lastAction: lastAction.trim(),
        actualBehavior: actualBehavior.trim() || undefined,
        reproducibility,
      });
      if (copyToClipboard) {
        try {
          await navigator.clipboard.writeText(exported.markdown);
          toast.success(t("diagnosticsLogCopied"));
        } catch (clipboardError) {
          console.error(
            "[Diagnostics] Failed to copy diagnostics log",
            clipboardError
          );
          toast.error(t("diagnosticsIssueFallbackCopyFailed"));
        }
      } else {
        toast.success(t("diagnosticsLogExported"));
        try {
          await openInExplorer(exported.path);
        } catch (explorerError) {
          console.error(
            "[Diagnostics] Failed to open File Explorer",
            explorerError
          );
        }
      }
    } catch (error) {
      console.error("[Diagnostics] Log export failed", error);
      toast.error(t("diagnosticsBundleFailed"));
    } finally {
      setExportingLog(false);
    }
  }

  return (
    <div className="space-y-4">
      {/*
        自用：最上面放"给 AI 看的日志"两个按钮。
        为什么放最前：自用版出问题时主要靠自己或朋友把它交给 AI 排查，
        比"打 ZIP 再去提 issue"常用得多。复用的是同一套采集与脱敏。
      */}
      <div className="flex flex-col gap-2 rounded-[8px] border border-primary/25 bg-primary/[0.04] p-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[12px] text-foreground">
            {t("diagnosticsAiLogTitle")}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t("diagnosticsAiLogHint")}
          </p>
        </div>
        <button
          className="flex items-center justify-center gap-1.5 rounded-[6px] bg-primary px-3 py-2 font-medium text-[12px] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={exportingLog || generating || dismissing}
          onClick={() => exportLog(true)}
          type="button"
        >
          <ClipboardCopy className="h-3.5 w-3.5" />
          {t("diagnosticsCopyLog")}
        </button>
        <button
          className="flex items-center justify-center gap-1.5 rounded-[6px] border border-border px-3 py-2 font-medium text-[12px] text-foreground transition-colors hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={exportingLog || generating || dismissing}
          onClick={() => exportLog(false)}
          type="button"
        >
          <FileText className="h-3.5 w-3.5" />
          {exportingLog ? t("diagnosticsGenerating") : t("diagnosticsExportLog")}
        </button>
      </div>

      {overview && overview.pendingIncidents.length > 0 && (
        <div className="space-y-2 rounded-[8px] border border-warning/30 bg-warning/5 p-3">
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="font-medium text-[12px] text-foreground">
                {t("diagnosticsPendingTitle", {
                  count: overview.pendingIncidents.length,
                })}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t("diagnosticsPendingHint")}
              </p>
            </div>
          </div>
          <FilterDropdown
            ariaLabel={t("diagnosticsIncident")}
            className="w-full"
            onChange={(value) => {
              setSelectedIncidentId(value);
              setIncludeNativeDump(false);
            }}
            options={incidentOptions}
            placeholder={t("diagnosticsIncident")}
            showSelectedCheck
            value={selectedIncidentId}
          />
          {selectedIncidentId && (
            <button
              className="rounded-[6px] border border-border px-2.5 py-1.5 font-medium text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              disabled={dismissing || generating}
              onClick={dismissSelectedIncident}
              type="button"
            >
              {dismissing
                ? t("diagnosticsDismissingIncident")
                : t("diagnosticsDismissIncident")}
            </button>
          )}
        </div>
      )}

      <div className="grid gap-3">
        <label className="grid gap-1.5">
          <span className="font-medium text-[12px] text-foreground">
            {t("diagnosticsLastAction")}
          </span>
          <textarea
            className="min-h-20 resize-y rounded-[6px] border border-border bg-card px-3 py-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary/40"
            maxLength={4000}
            onChange={(event) => setLastAction(event.target.value)}
            placeholder={t("diagnosticsLastActionPlaceholder")}
            value={lastAction}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="font-medium text-[12px] text-foreground">
            {t("diagnosticsActualBehavior")}
          </span>
          <textarea
            className="min-h-20 resize-y rounded-[6px] border border-border bg-card px-3 py-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary/40"
            maxLength={4000}
            onChange={(event) => setActualBehavior(event.target.value)}
            placeholder={t("diagnosticsActualBehaviorPlaceholder")}
            value={actualBehavior}
          />
        </label>
        <div className="grid gap-1.5">
          <span className="font-medium text-[12px] text-foreground">
            {t("diagnosticsFrequency")}
          </span>
          <FilterDropdown
            ariaLabel={t("diagnosticsFrequency")}
            className="w-full"
            onChange={(value) =>
              setReproducibility(value as DiagnosticReproducibility)
            }
            options={[
              { label: t("diagnosticsFrequencyAlways"), value: "always" },
              {
                label: t("diagnosticsFrequencySometimes"),
                value: "sometimes",
              },
              { label: t("diagnosticsFrequencyOnce"), value: "once" },
            ]}
            placeholder={t("diagnosticsFrequency")}
            showSelectedCheck
            value={reproducibility}
          />
        </div>
      </div>

      {selectedIncident?.hasNativeDump && (
        <div className="flex items-start justify-between gap-3 rounded-[8px] border border-danger/25 bg-danger/5 p-3">
          <div className="min-w-0">
            <p className="font-medium text-[12px] text-foreground">
              {t("diagnosticsNativeDump")}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {t("diagnosticsNativeDumpWarning")}
            </p>
          </div>
          <Switch
            ariaLabel={t("diagnosticsNativeDump")}
            checked={includeNativeDump}
            onCheckedChange={setIncludeNativeDump}
          />
        </div>
      )}

      <details className="rounded-[8px] border border-border bg-card p-3">
        <summary className="cursor-pointer text-[12px] text-foreground">
          {t("diagnosticsPrivacyTitle")}
        </summary>
        <div className="mt-2 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2">
          <div className="flex gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0 text-success" />
            <span>{t("diagnosticsCollects")}</span>
          </div>
          <div className="flex gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0 text-success" />
            <span>{t("diagnosticsNeverCollects")}</span>
          </div>
        </div>
      </details>

      {result && (
        <div className="rounded-[8px] border border-success/30 bg-success/5 p-3">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <div className="min-w-0">
              <p className="font-medium text-[12px] text-foreground">
                {t("diagnosticsReadyTitle")}
              </p>
              <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                {result.bundlePath}
              </p>
              {feedbackRequested && (
                <ol className="mt-2 list-inside list-decimal space-y-1 text-[11px] text-muted-foreground">
                  <li>
                    {issueOpenFailed
                      ? t("diagnosticsIssueNotOpened")
                      : t("diagnosticsStepOne")}
                  </li>
                  <li>{t("diagnosticsStepTwo")}</li>
                  <li>{t("diagnosticsStepThree")}</li>
                </ol>
              )}
              {feedbackRequested && issueOpenFailed && (
                <button
                  className="mt-2 rounded-[6px] border border-success/30 px-2.5 py-1.5 font-medium text-[11px] text-foreground transition-colors hover:bg-success/10"
                  onClick={() => openIssue(result)}
                  type="button"
                >
                  {t("diagnosticsRetryIssue")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:items-start sm:justify-end">
        <button
          className="rounded-[6px] border border-border px-3 py-2 font-medium text-[12px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={generating || dismissing}
          onClick={() => generate(false)}
          type="button"
        >
          {t("diagnosticsExportOnly")}
        </button>
        <AnimatedActionButton
          className="py-2"
          disabled={generating || dismissing}
          icon={<FileArchive className="h-4 w-4" />}
          loading={generating}
          onClick={() => generate(true)}
        >
          {generating
            ? t("diagnosticsGenerating")
            : t("diagnosticsGenerateAndReport")}
        </AnimatedActionButton>
      </div>
    </div>
  );
}

export function DiagnosticsReportDialog({
  actualBehavior,
  incidentId,
  onOpenChange,
  open,
}: {
  actualBehavior?: string;
  incidentId?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t("diagnosticsReportProblem")}</DialogTitle>
          <DialogDescription>{t("diagnosticsDescription")}</DialogDescription>
        </DialogHeader>
        <DiagnosticsReportForm
          initialActualBehavior={actualBehavior}
          initialIncidentId={incidentId}
        />
      </DialogContent>
    </Dialog>
  );
}
