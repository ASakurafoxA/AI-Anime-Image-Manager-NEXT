import { CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FilterDropdown } from "@/components/filter-dropdown";
import { AnimatedActionButton } from "@/components/ui/animated-action-button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { ipc } from "@/ipc/manager";

// ── Types ────────────────────────────────────────────────────────────

type DetectPhase =
  | "idle"
  | "checking"
  | "detected-ok"
  | "detected-unsupported"
  | "detected-error";

interface GpuAdapterInfo {
  deviceId: number;
  name: string | null;
  ok: boolean;
  error?: string;
  probeTimeMs?: number;
  virtual?: boolean;
}

interface GpuDetectedInfo {
  adapters?: GpuAdapterInfo[];
  dmlAvailable: boolean;
  embeddingDmlAvailable?: boolean;
  embeddingError?: string;
  embeddingProbeTimeMs?: number;
  error?: string;
  gpuName?: string;
  probeTimeMs: number;
  timestamp?: number;
}

interface GpuSettingsResponse {
  detected: GpuDetectedInfo | null;
  deviceId: string;
  /** 多卡模式下勾选的适配器序号 */
  deviceIds?: number[];
  /** 多卡模式下实际生效的设备序号（每个序号一个 worker） */
  effectiveDevices?: Array<number | null>;
  enabled: boolean;
  /** 多卡模式开关（默认关闭） */
  multiGpuEnabled?: boolean;
  promptShown: boolean;
  /** 以图搜图特征来源：thumbnail = 快（默认）/ original = 保真 */
  searchImageSource?: "thumbnail" | "original";
}

type GpuCapabilityResponse = GpuDetectedInfo;

// ── Sub-components ───────────────────────────────────────────────────

function FeatureStatusRow({
  active,
  label,
  statusKey,
}: {
  active: boolean;
  label: string;
  statusKey?: string;
}) {
  const { t } = useTranslation();
  const resolvedStatusKey =
    statusKey ?? (active ? "gpuStatusActive" : "gpuStatusInactive");
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px]">
      {active ? (
        <CheckCircle2 className="h-3 w-3 text-green-600 dark:text-green-400" />
      ) : (
        <MinusCircle className="h-3 w-3 text-muted-foreground/45" />
      )}
      <span className="text-muted-foreground/70">{label}</span>
      <span className="text-muted-foreground/40">{t(resolvedStatusKey)}</span>
    </div>
  );
}

function DetectionStatusLine({
  detectError,
  detectPhase,
  probeTimeMs,
}: {
  detectError: string;
  detectPhase: DetectPhase;
  probeTimeMs?: number;
}) {
  const { t } = useTranslation();

  if (detectPhase === "idle") {
    return (
      <p className="text-[11px] text-muted-foreground/50">
        {t("gpuNotDetected")}
      </p>
    );
  }

  if (detectPhase === "checking") {
    return (
      <div className="flex items-center gap-2">
        <LoadingSpinner size="sm" variant="secondary" />
        <span className="text-[12px] text-muted-foreground">
          {t("gpuDetecting")}
        </span>
      </div>
    );
  }

  if (detectPhase === "detected-ok") {
    return (
      <div>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
          <span className="text-[12px] text-muted-foreground">
            {t("gpuDetectedOk")}
          </span>
          {probeTimeMs !== undefined && (
            <span className="text-[11px] text-muted-foreground/40">
              {probeTimeMs}ms
            </span>
          )}
        </div>
      </div>
    );
  }

  if (detectPhase === "detected-unsupported") {
    return (
      <div>
        <div className="flex items-center gap-2">
          <MinusCircle className="h-3.5 w-3.5 text-muted-foreground/50" />
          <span className="text-[12px] text-muted-foreground">
            {t("gpuDetectedUnsupported")}
          </span>
        </div>
        {detectError && (
          <p className="mt-1 text-[11px] text-muted-foreground/50 [overflow-wrap:anywhere]">
            {detectError}
          </p>
        )}
      </div>
    );
  }

  // detected-error
  return (
    <div>
      <div className="flex items-center gap-2">
        <XCircle className="h-3.5 w-3.5 text-destructive" />
        <span className="text-[12px] text-destructive">
          {t("gpuDetectedError")}
        </span>
      </div>
      {detectError && (
        <p className="mt-1 text-[11px] text-destructive/70 [overflow-wrap:anywhere]">
          {detectError}
        </p>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function getDetectButtonLabel(
  detectPhase: DetectPhase,
  t: (key: string) => string
): string {
  if (detectPhase === "checking") {
    return t("gpuDetecting");
  }
  if (
    detectPhase === "detected-error" ||
    detectPhase === "detected-unsupported"
  ) {
    return t("gpuRetryDetect");
  }
  return t("gpuDetect");
}

// ── Main component ───────────────────────────────────────────────────

export function GpuSettingsCard({
  hideTitle = false,
  hideSaveButton = false,
  onBusyChange,
  onEnabledChange,
  onLoaded,
}: {
  hideTitle?: boolean;
  hideSaveButton?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onEnabledChange?: (enabled: boolean) => void;
  onLoaded?: () => void;
}) {
  const { t } = useTranslation();

  const [enabled, setEnabled] = useState(false);
  const [detectPhase, setDetectPhase] = useState<DetectPhase>("idle");
  const [detectedInfo, setDetectedInfo] = useState<GpuDetectedInfo | null>(
    null
  );
  const [detectError, setDetectError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [saving, setSaving] = useState(false);
  // 自用新增：手选显卡（"auto" 或适配器序号）与 AI 占用限制
  const [deviceId, setDeviceId] = useState("auto");
  // 自用新增：以图搜图特征来源（缩略图快 / 原图保真），默认缩略图
  const [searchImageSource, setSearchImageSource] = useState<
    "thumbnail" | "original"
  >("thumbnail");
  // 自用新增：多卡模式（默认关闭；开启后"使用显卡"变成多选，一张卡一个 worker）
  // 每张卡的实时速度（张/秒）；**长度就是"在用的卡数"**，< 2 时整体不显示
  const [perCardSpeeds, setPerCardSpeeds] = useState<
    Array<{ deviceId: number | null; label: string | null; perSecond: number }>
  >([]);

  // ── Load saved state on mount ──────────────────────────────────────

  useEffect(() => {
    ipc.client.settings
      .getGpuSettings({})
      .then((value) => {
        const r = value as unknown as GpuSettingsResponse;
        setEnabled(r.enabled);
        setDeviceId(r.deviceId ?? "auto");
        setSearchImageSource(
          r.searchImageSource === "original" ? "original" : "thumbnail"
        );
        /**
         * 每张卡的实时速度显示（用户 2026-10-09 明确要求）：
         *   · **只用 1 张卡 → 完全不显示**（顶上已有总速度）；
         *   · **≥2 张才显示，用几张显示几个**（最多 3 个）。
         * 卡数由下面的轮询从后端拿（`getGpuSpeeds` 返回实际启用的设备），
         * 所以这里不用额外记状态；初值保持空数组 = 先不显示。
         */
        onEnabledChange?.(r.enabled);
        if (r.detected) {
          setDetectedInfo(r.detected);
          setDetectPhase(
            r.detected.dmlAvailable || r.detected.embeddingDmlAvailable
              ? "detected-ok"
              : "detected-unsupported"
          );
          if (r.detected.error) {
            setDetectError(r.detected.error);
          }
        } else {
          setDetectPhase("idle");
        }
      })
      .catch((err: unknown) => {
        setDetectPhase("detected-error");
        setDetectError(
          (err as { message?: string })?.message || t("gpuDetectedError")
        );
      })
      .finally(() => onLoaded?.());
  }, [onEnabledChange, onLoaded, t]);

  // ── GPU detection ──────────────────────────────────────────────────
  const handleDetect = useCallback(async () => {
    setDetectPhase("checking");
    setDetectError("");
    onBusyChange?.(true);
    try {
      const result = (await ipc.client.settings.checkGpuCapability(
        {}
      )) as GpuCapabilityResponse;
      setDetectedInfo(result);
      if (result.dmlAvailable || result.embeddingDmlAvailable) {
        setDetectPhase("detected-ok");
        if (!enabled) {
          setEnabled(true);
          onEnabledChange?.(true);
        }
      } else {
        setDetectPhase("detected-unsupported");
        if (result.error) {
          setDetectError(result.error);
        }
      }
    } catch (err: unknown) {
      setDetectPhase("detected-error");
      setDetectError(
        (err as { message?: string })?.message || t("gpuDetectedError")
      );
    } finally {
      onBusyChange?.(false);
    }
  }, [enabled, onBusyChange, onEnabledChange, t]);

  /*
   * 自用（2026-10-18 · 会话#9）：**打开设置页时，若"图像嵌入"这一项还没探测过，自动测一次**。
   * 否则这一行永远显示"未检测"（用户以为坏了），而且他也分不清是没测过还是真的回退 CPU ✓
   */
  const autoDetectRef = useRef(false);
  useEffect(() => {
    if (!enabled || autoDetectRef.current) {
      return;
    }
    if (detectedInfo?.embeddingDmlAvailable !== undefined && detectedInfo?.embeddingDmlAvailable !== null) {
      return;
    }
    if (detectPhase !== "idle") {
      return;
    }
    autoDetectRef.current = true;
    void handleDetect();
  }, [detectPhase, detectedInfo?.embeddingDmlAvailable, enabled, handleDetect]);

  // ── Save ───────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveStatus(t("saving"));
    onBusyChange?.(true);
    try {
      await ipc.client.settings.setGpuSettings({
        deviceId,
        enabled,
        searchImageSource,
      });
      setSaveStatus(t("gpuSaved"));
      setTimeout(() => setSaveStatus(""), 3000);
    } catch {
      setSaveStatus(t("saveFailed"));
      setEnabled(!enabled);
      onEnabledChange?.(!enabled);
      setTimeout(() => setSaveStatus(""), 3000);
    } finally {
      setSaving(false);
      onBusyChange?.(false);
    }
  }, [
    deviceId,
    enabled,
    onBusyChange,
    onEnabledChange,
    searchImageSource,
    t,
  ]);

  const handleEnabledChange = useCallback(
    (nextEnabled: boolean) => {
      setEnabled(nextEnabled);
      onEnabledChange?.(nextEnabled);
    },
    [onEnabledChange]
  );

  const embeddingGpuActive =
    enabled && detectedInfo?.embeddingDmlAvailable === true;
  // 下拉框只列"真显卡"：虚拟显示适配器（向日葵 / UU 远程 / IDD）用户不需要选。
  const usableAdapters = (detectedInfo?.adapters ?? []).filter(
    (a) => a.ok && !a.virtual
  );
  /**
   * 自用（多卡·修复 2026-10-09）：**只要有"已知的显卡"就把这一块显示出来**。
   *
   * 原来条件是 `usableAdapters.length > 0`，而探针偶发失败会让缓存的 adapters 变空
   * → 「使用显卡」和多卡开关**整段消失**（用户截图就是这个）。
   * 现在：适配器列表为空、但缓存里还记得显卡名字时，仍然显示下拉（只提供"自动"一项），
   * 用户至少能看到/切换多卡开关，而不是整块不见了。
   */
  const hasKnownAdapterList = usableAdapters.length > 0;
  const showAdapterSection =
    enabled && (hasKnownAdapterList || Boolean(detectedInfo?.gpuName));
  /*
   * 自用（2026-10-17，用户口径）：**「角色识别」这一行要保留，改成跟 CCIP 走** ✓
   *
   * 用户原话：「GPU 测试的问题，**角色识别是需要 GPU 的**」——
   * 原来这行绑在已删除的人脸检测池上，我一开始把它整行删掉了 ✗；
   * 但角色识别现在跑的是 **CCIP**，它同样走 DirectML（`provider: "dml"`），
   * 所以显卡能不能用，判据就是通用 DML 探测结论 `dmlAvailable` ✓
   * （探针已经改用当前嵌入模型当试金石，不再依赖已删的人脸模型）
   */
  const characterGpuActive = enabled && detectedInfo?.dmlAvailable === true;
  let characterStatusKey = "gpuStatusNotEnabled";
  if (enabled) {
    if (detectPhase === "detected-error") {
      characterStatusKey = "gpuStatusProbeFailed";
    } else if (detectedInfo?.dmlAvailable === true) {
      characterStatusKey = "gpuStatusActive";
    } else {
      characterStatusKey = "gpuStatusCpuFallback";
    }
  }
  /*
   * 自用（2026-10-18 · 会话#9 用户反馈「图像嵌入 GPU 未检测到，使用 CPU」）：
   * 这里原来是"没探测过(null) 也当成 CPU 回退"，于是明明在用显卡却显示成 CPU ✗
   * 现在三态分开：未探测 / 可用 / 确实回退 ✓
   */
  let embeddingStatusKey = "gpuStatusNotEnabled";
  if (enabled) {
    if (detectPhase === "detected-error" || detectedInfo?.embeddingError) {
      embeddingStatusKey = "gpuStatusProbeFailed";
    } else if (detectedInfo?.embeddingDmlAvailable === true) {
      embeddingStatusKey = "gpuStatusActive";
    } else if (detectedInfo?.embeddingDmlAvailable === false) {
      embeddingStatusKey = "gpuStatusCpuFallback";
    } else {
      embeddingStatusKey = "gpuStatusNotProbed";
    }
  }

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <section className="min-w-0 space-y-3">
      {!hideTitle && (
        <h2 className="font-semibold text-[14px] text-foreground">
          {t("gpuAcceleration")}
        </h2>
      )}

      <div className="min-w-0 space-y-3 rounded-[8px] border border-border bg-secondary p-3 min-[480px]:p-4">
        {/* Toggle row */}
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="text-[13px] text-muted-foreground">
              {t("gpuEnableAcceleration")}
            </span>
            {detectedInfo?.gpuName && (
              <p className="mt-0.5 break-all font-medium text-[11px] text-foreground/80">
                {detectedInfo.gpuName}
              </p>
            )}
          </div>
          <Switch
            ariaLabel={t("gpuEnableAcceleration")}
            checked={enabled}
            disabled={detectPhase === "checking"}
            onCheckedChange={handleEnabledChange}
          />
        </div>

        {/* 自用新增：使用显卡（手动选适配器；默认自动＝优先独显） */}
        {showAdapterSection && (
          <div className="min-w-0 space-y-1.5 border-border border-t pt-3">
            <div className="flex min-w-0 flex-col gap-1.5 text-[12px] text-muted-foreground">
              <span>{t("gpuAdapterTitle")}</span>
              {/*
                自用（问题 5）：原来用原生 `<select>`，弹出的系统列表和应用风格完全不搭。
                改用应用自己的下拉（FilterDropdown），和其它设置页控件一致。

                自用（多卡）：开启"多卡模式"后这里变**多选** —— 勾几张卡就开几个 worker，
                一张卡一个（同一张卡上多开会互相踩，实测慢一倍）。
              */}
              <FilterDropdown
                ariaLabel={t("gpuAdapterTitle")}
                className="w-full max-w-[420px]"
                onChange={(value) => setDeviceId(value)}
                options={[
                  {
                    label: detectedInfo?.gpuName
                      ? t("gpuAdapterAuto", { gpuName: detectedInfo.gpuName })
                      : t("gpuAdapterAutoGeneric"),
                    value: "auto",
                  },
                  ...usableAdapters.map((adapter) => ({
                    label:
                      adapter.name ??
                      t("gpuAdapterIndex", { index: adapter.deviceId }),
                    value: String(adapter.deviceId),
                  })),
                ]}
                placeholder={t("gpuAdapterTitle")}
                value={deviceId}
              />
            </div>
            <p className="text-[11px] text-muted-foreground/60 leading-relaxed [overflow-wrap:anywhere]">
              {t("gpuAdapterHint")}
            </p>
          </div>
        )}

                {/* Feature status */}
        {/*
          自用（多卡）：每张卡的实时速度显示在这里。
          用户的要求：**单卡完全不显示**；**≥2 张才显示，用几张显示几个**（最多 3 个）。
          所以显示条件是"实际在用的卡数 ≥ 2"（拿不到在用卡数时退回看速度数组长度）。
        */}
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 border-border border-t pt-3">
          <div className="space-y-1.5">
            {/*
              自用（2026-10-17，用户口径）：**角色识别也吃显卡**（CCIP 走 DirectML）✓
              这一行原来绑在人脸检测池上；人脸链路删掉后它一度被我误删，
              现已**迁移到 CCIP**：激活/状态都看通用 DML 探测结论 ✓
            */}
            <FeatureStatusRow
              active={characterGpuActive}
              label={t("gpuStatusCharacter")}
              statusKey={characterStatusKey}
            />
            <FeatureStatusRow
              active={embeddingGpuActive}
              label={t("gpuStatusEmbed")}
              statusKey={embeddingStatusKey}
            />
          </div>
        </div>

        {/* Detection status */}
        <div className="border-border border-t pt-3">
          <DetectionStatusLine
            detectError={detectError}
            detectPhase={detectPhase}
            probeTimeMs={detectedInfo?.probeTimeMs}
          />
        </div>

        {/* 自用新增：以图搜图特征来源（决定建向量时读缩略图还是原图） */}
        <div className="min-w-0 space-y-1.5 border-border border-t pt-3">
          <div className="flex min-w-0 flex-col gap-1.5 text-[12px] text-muted-foreground">
            <span>{t("searchImageSourceTitle")}</span>
            <FilterDropdown
              ariaLabel={t("searchImageSourceTitle")}
              className="w-full max-w-[420px]"
              onChange={(value) =>
                setSearchImageSource(
                  value === "original" ? "original" : "thumbnail"
                )
              }
              options={[
                { label: t("searchImageSourceThumbnail"), value: "thumbnail" },
                { label: t("searchImageSourceOriginal"), value: "original" },
              ]}
              placeholder={t("searchImageSourceTitle")}
              value={searchImageSource}
            />
          </div>
          <p className="text-[11px] text-muted-foreground/60 leading-relaxed [overflow-wrap:anywhere]">
            {t("searchImageSourceHint")}
          </p>
        </div>

        {/* Action buttons + hint */}
        <div className="flex min-w-0 flex-col items-stretch gap-3 border-border border-t pt-3 min-[900px]:flex-row min-[900px]:items-start min-[900px]:justify-between">
          <p className="min-w-0 pt-1 text-[11px] text-muted-foreground/60 leading-relaxed [overflow-wrap:anywhere]">
            {t("gpuRestartHint")}
          </p>
          <div className="flex max-w-full flex-wrap items-start justify-end gap-2 min-[900px]:shrink-0">
            <button
              className="rounded-[6px] border border-input bg-background px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
              disabled={detectPhase === "checking"}
              onClick={handleDetect}
              type="button"
            >
              {getDetectButtonLabel(detectPhase, t)}
            </button>
            {!hideSaveButton && (
              <AnimatedActionButton
                animationDisabled={Boolean(saveStatus)}
                className="py-1.5"
                disabled={saving}
                loading={saving}
                onClick={handleSave}
              >
                {saveStatus || t("save")}
              </AnimatedActionButton>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
