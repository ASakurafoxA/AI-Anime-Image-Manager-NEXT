import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { ArrowLeft, Ellipsis, Eraser, Play, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { faceActions } from "@/actions/faces";
import { ipc } from "@/ipc/manager";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CharacterDiscoveryDialog } from "@/components/character-discovery-dialog";
import {
  type CharacterMissingRow,
  CharacterMissingDialog,
} from "@/components/character-missing-dialog";
import {
  ManualRolesSection,
  type ManualRole,
} from "@/components/manual-roles-section";
import { RouteError } from "@/components/RouteError";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useGlobalAiStatus } from "@/hooks/use-global-ai-status";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";

/**
 * 人物识别页（2026-10-18 · 会话#9 重写）
 *
 * 用户口径：「**直接完全剔除 SFace**」+「有在使用的功能就给他衔接到新模型上」。
 *
 * 所以这一页现在**只属于新模型（CCIP + 标签）**：
 *   · 角色 = 「角色」分类下的标签；「我创建的角色」= `manualRoles` 里记录的那些 ✓
 *   · 全库特征 = `ccip_embeddings`（768 维），算完写进这里，进度走顶栏 ✓
 *   · 两颗识别按钮分别对应「发现无标签簇并命名」「找漏标的已有角色」✓
 *
 * 删掉的东西（都是旧人脸链路 / 已经没人用）：
 *   · 人脸身份卡网格 + 隐藏人物 + 复核队列横幅 + 人物详情页跳转
 *   · 改名 / 隐藏 / 删除身份的本地实现（改名改在「我创建的角色」卡片上，直接改标签）
 *   · 旧人脸检测的暂停 / 继续 / 扫描范围（后端整条已删）
 */
export function PeoplePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  const { phase: globalAiPhase } = useGlobalAiStatus();
  /** CCIP「获取全库角色特征」是否正在跑（顶栏那条进度条同源） */
  const featureRunning = globalAiPhase === "character-features";

  /*
   * 门禁（用户口径 2026-10-17）：**全库打标完成才解锁两颗识别按钮** ✓
   * 判据 = 全库还有没有"零标签"的图（`getTaggingCoverage`）。
   */
  const { data: taggingCoverage } = useQuery({
    queryKey: ["tagging-coverage"],
    queryFn: () =>
      ipc.client.photos.getTaggingCoverage({}) as Promise<{
        complete: boolean;
        total: number;
        untagged: number;
      }>,
    refetchInterval: 20_000,
    staleTime: 10_000,
  });
  const taggingReady = taggingCoverage?.complete === true;
  const untaggedCount = taggingCoverage?.untagged ?? 0;
  const taggingGateHint = taggingReady
    ? null
    : t("peopleTaggingGateHint", { count: untaggedCount });

  /*
   * 自用（2026-10-18 · 会话#9 用户重申的逻辑）：
   *   · 角色识别**默认用 CCIP**；没放模型 → **不允许识别**，提示"放模型"或"去设置关掉 CCIP（=已知情）" ✓
   *   · 关掉 CCIP → 角色特征**复用文字搜图的 CLIP 模型**（`getPhotoVectors`）✓
   * 所以这里读一次特征源状态，用它决定按钮能不能点、以及显示哪句提示。
   */
  const { data: featureStatus } = useQuery({
    queryKey: ["character-feature-status"],
    queryFn: async () =>
      (await faceActions.getCharacterFeatureStatus()) as {
        message?: string | null;
        modelAvailable: boolean;
        preferCcip: boolean;
        reason: string;
        source: "ccip" | "clip" | "unavailable";
        vectorCount: number;
      },
    refetchInterval: 20_000,
    staleTime: 10_000,
  });
  const featureUnavailable = featureStatus?.source === "unavailable";
  /** 用户关掉了 CCIP → 角色特征走 CLIP 回退（这时"算 CCIP 特征"的按钮就不该出现） */
  const featureUsingClip = featureStatus?.source === "clip";
  /** 只是"模型没放"这一种不可用（"特征没算"时必须让按钮可点，它就是补救入口） */
  const featureModelMissing = featureStatus?.reason === "model-missing";
  /** 模型在、但一条 CCIP 特征都没算过 —— 这不是"没模型"，提示要指向「获取全库角色特征」 */
  const featureVectorsMissing = featureStatus?.reason === "vectors-missing";
  /** 向量库还在初始化 */
  const featureVectorDbNotReady = featureStatus?.reason === "vector-db-not-ready";
  const featureGateHint = featureUnavailable
    ? (featureStatus?.message ?? t("characterFeatureModelMissing"))
    : null;

  /** CCIP 开关 —— 只用于"当前使用哪个模型"这一行说明 */
  const { data: ccipCharacterOn = true } = useQuery({
    queryKey: ["setting", "ai.characterRecognitionUseCcip"],
    queryFn: async () => {
      const result = (await ipc.client.settings.getAppSetting({
        key: "ai.characterRecognitionUseCcip",
      })) as { value?: string } | undefined;
      return result?.value !== "false";
    },
    staleTime: 30_000,
  });

  /** 「我创建的角色」= 新模型下用户命名过的角色（标签） */
  const { data: manualRoles = [] } = useQuery({
    queryKey: ["faces", "manual-roles"],
    queryFn: async () => {
      const result = (await faceActions.listManualCharacterRoles()) as {
        roles?: ManualRole[];
      };
      return result?.roles ?? [];
    },
    staleTime: 30_000,
  });

  /*
   * 自用（2026-10-18 · 会话#9）：标签树变化（在任何地方命名/改名/删除角色）→ 立刻重取角色列表。
   * 否则「我创建的角色」要等 30 秒缓存过期才更新（用户实测：刚写的名字页面里没有）✗
   */
  useEffect(() => {
    const onTagsChanged = () => {
      void queryClient.invalidateQueries({ queryKey: ["faces", "manual-roles"] });
    };
    window.addEventListener("tags-changed", onTagsChanged);
    return () => window.removeEventListener("tags-changed", onTagsChanged);
  }, [queryClient]);

  const [featureBusy, setFeatureBusy] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [missingOpen, setMissingOpen] = useState(false);
  const [missingRows, setMissingRows] = useState<CharacterMissingRow[]>([]);
  const [missingBusy, setMissingBusy] = useState(false);
  const [missingApplying, setMissingApplying] = useState<number | null>(null);
  const [missingDone, setMissingDone] = useState<Record<number, boolean>>({});
  const [confirmClearUnnamed, setConfirmClearUnnamed] = useState(false);
  const [clearingUnnamed, setClearingUnnamed] = useState(false);

  async function handleBuildFeatures() {
    if (featureBusy || featureRunning) {
      return;
    }
    setFeatureBusy(true);
    try {
      const result = (await faceActions.buildCharacterFeatures({})) as {
        cancelled?: boolean;
        embedded?: number;
        failed?: number;
      };
      toast.success(
        t("characterFeatureBuildDone", {
          count: result.embedded ?? 0,
          failed: result.failed ?? 0,
        })
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setFeatureBusy(false);
    }
  }

  async function handleDetectMissing() {
    if (missingBusy) {
      return;
    }
    /* 先把弹窗打开并显示「分析中…」，分析完再填列表（分析要十几到几十秒） */
    setMissingOpen(true);
    setMissingBusy(true);
    try {
      const result = (await faceActions.analyzeUnnamedCharacters({
        dryRun: true,
      })) as { topGroups?: CharacterMissingRow[] };
      const rows = result.topGroups ?? [];
      setMissingRows(rows);
      setMissingDone({});
      if (rows.length === 0) {
        toast.info(t("characterSuggestionEmpty"));
        setMissingOpen(false);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setMissingOpen(false);
    } finally {
      setMissingBusy(false);
    }
  }

  async function handleApplyMissing(
    row: CharacterMissingRow,
    selectedPhotoIds: number[]
  ) {
    const targetIds =
      selectedPhotoIds.length > 0 ? selectedPhotoIds : (row.photoIds ?? []);
    if (targetIds.length === 0 || missingApplying !== null) {
      return;
    }
    setMissingApplying(row.tagId);
    try {
      const result = (await faceActions.nameCharacterGroup({
        name: row.tagName,
        photoIds: targetIds,
      })) as { applied?: number; attempted?: number };
      setMissingDone((prev) => ({ ...prev, [row.tagId]: true }));
      toast.success(
        t("characterSuggestionAppliedToast", {
          applied: result.applied ?? 0,
          attempted: result.attempted ?? targetIds.length,
        })
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setMissingApplying(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 页头 */}
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-2 sm:px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/*
              自用（2026-10-18 · 会话#9 用户反馈「侧边栏没有了，回不去主菜单」）：
              侧边栏**只在首页显示**（`SidebarSlot` 对非首页是 `hidden`），
              所以这一页必须自带"返回"；原来那颗 ← 在整页重写时被我漏掉了 ✗
            */}
            <button
              aria-label={t("back")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              onClick={() => navigate({ to: "/" })}
              type="button"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <h1 className="font-semibold text-[22px] text-foreground tracking-tight">
              {t("people")}
            </h1>
          </div>
          <p className="mt-0.5 text-[12px] text-muted-foreground/70">
            {manualRoles.length > 0
              ? t("peopleCount", { count: manualRoles.length })
              : t("peopleDescription")}
          </p>
        </div>
        <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
          {/*
            自用（2026-10-18 · 会话#9 用户重申的逻辑）：
              · 「获取全库角色特征」是**算 CCIP 特征**，所以：
                  模型缺失 → 禁用（先去放模型）✓
                  用户关掉 CCIP（走 CLIP 回退）→ 这按钮没意义 → 直接不显示 ✓
              · 但"特征还没算"（reason=vectors-missing）时必须**保持可点** ——
                它就是补救入口 ✗
          */}
          {!featureUsingClip && (
            <Button
              disabled={featureBusy || featureRunning || featureModelMissing}
              onClick={() => void handleBuildFeatures()}
              size="lg"
              title={
                featureModelMissing
                  ? (featureStatus?.message ?? t("characterFeatureModelMissing"))
                  : undefined
              }
              type="button"
            >
              <Play className="h-3.5 w-3.5" />
              {featureBusy || featureRunning
                ? t("characterFeatureBuilding")
                : t("characterFeatureBuild")}
            </Button>
          )}
          <span className="text-[11px] text-muted-foreground">
            {featureStatus?.source === "clip" || !ccipCharacterOn
              ? t("peopleModelClip")
              : t("peopleModelCcip")}
          </span>
          <Popover>
            <PopoverTrigger asChild>
              <Button aria-label={t("moreActions")} size="icon-lg" variant="ghost">
                <Ellipsis />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 gap-1 p-1.5">
              <button
                className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-[12px] text-destructive hover:bg-destructive/10"
                onClick={() => setConfirmClearUnnamed(true)}
                type="button"
              >
                <Eraser className="h-3.5 w-3.5" />
                <span className="min-w-0">
                  <span className="block">{t("clearUnnamedResults")}</span>
                  <span className="mt-0.5 block whitespace-normal text-[10px] text-muted-foreground leading-4">
                    {t("clearUnnamedResultsHint")}
                  </span>
                </span>
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* 工具栏：两颗识别按钮 */}
      <div className="flex flex-wrap items-center gap-2 border-border border-b px-4 py-2 sm:px-6">
        <button
          className="rounded-[6px] border border-border bg-card px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          disabled={!taggingReady || featureUnavailable}
          onClick={() => setDiscoveryOpen(true)}
          title={featureGateHint ?? taggingGateHint ?? t("characterDiscoveryHint")}
          type="button"
        >
          {t("characterDiscoveryTitle")}
        </button>
        <button
          className="rounded-[6px] border border-border bg-card px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          disabled={missingBusy || !taggingReady || featureUnavailable}
          onClick={() => void handleDetectMissing()}
          title={featureGateHint ?? taggingGateHint ?? t("peopleFindUnnamedCharactersHint")}
          type="button"
        >
          {missingBusy
            ? t("peopleFindUnnamedCharactersBusy")
            : t("peopleFindUnnamedCharacters")}
        </button>
        {featureGateHint && (
          <>
            <span
              className={
                featureModelMissing
                  ? "text-[11px] text-destructive"
                  : "text-[11px] text-muted-foreground"
              }
            >
              {featureModelMissing
                ? t("characterFeatureModelMissingShort")
                : featureVectorsMissing
                  ? t("characterFeatureVectorsMissingShort")
                  : featureVectorDbNotReady
                    ? t("characterFeatureVectorDbNotReadyShort")
                    : t("characterFeatureModelMissingShort")}
            </span>
            {featureModelMissing ? (
              <button
                className="text-[11px] text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                onClick={() => navigate({ to: "/settings/behavior" })}
                type="button"
              >
                {t("characterFeatureGoSettings")}
              </button>
            ) : (
              <button
                className="text-[11px] text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary disabled:opacity-50"
                disabled={featureBusy || featureRunning}
                onClick={() => void handleBuildFeatures()}
                type="button"
              >
                {featureBusy || featureRunning
                  ? t("characterFeatureBuilding")
                  : t("characterFeatureBuild")}
              </button>
            )}
          </>
        )}
        {!featureGateHint && taggingGateHint && (
          <span className="text-[11px] text-muted-foreground">
            {taggingGateHint}
          </span>
        )}
      </div>

      {/* 内容：「我创建的角色」；没有角色时给一句引导 */}
      <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6" ref={scrollRef}>
        {manualRoles.length > 0 ? (
          <ManualRolesSection
            onRenamed={() =>
              void queryClient.invalidateQueries({
                queryKey: ["faces", "manual-roles"],
              })
            }
            roles={manualRoles}
          />
        ) : (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground/70">
            <User className="h-12 w-12 opacity-20" />
            <div className="max-w-full rounded-lg border border-primary/20 bg-primary/[0.04] px-4 py-3 text-center sm:max-w-md">
              <p className="font-medium text-[13px] text-foreground">
                {t("peopleEnableTitle")}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground leading-5">
                {t("peopleEnableDescription")}
              </p>
            </div>
            <p className="text-[13px]">{t("noPeopleTitle")}</p>
            <p className="text-[11px] text-muted-foreground/70/60">
              {t("noPeopleDescription")}
            </p>
          </div>
        )}
      </div>

      {/* 弹窗 */}
      <CharacterDiscoveryDialog
        onOpenChange={setDiscoveryOpen}
        open={discoveryOpen}
      />
      <CharacterMissingDialog
        analyzing={missingBusy}
        applied={missingDone}
        applying={missingApplying}
        onApply={(row, photoIds) => void handleApplyMissing(row, photoIds)}
        onOpenChange={setMissingOpen}
        open={missingOpen}
        rows={missingRows}
      />
      <ConfirmDialog
        confirmText={
          clearingUnnamed
            ? t("clearingUnnamedResults")
            : t("clearUnnamedResultsConfirm")
        }
        description={t("clearUnnamedResultsBody")}
        destructive
        disabled={clearingUnnamed}
        onCancel={() => {
          if (!clearingUnnamed) {
            setConfirmClearUnnamed(false);
          }
        }}
        onConfirm={async () => {
          setClearingUnnamed(true);
          try {
            const result = (await faceActions.clearUnnamedCharacterResults()) as {
              keptGroups?: number;
              removedGroups?: number;
            };
            toast.success(
              t("clearUnnamedResultsDone", {
                removed: result?.removedGroups ?? 0,
                kept: result?.keptGroups ?? 0,
              })
            );
            setConfirmClearUnnamed(false);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
          } finally {
            setClearingUnnamed(false);
          }
        }}
        open={confirmClearUnnamed}
        title={t("clearUnnamedResultsTitle")}
      />
    </div>
  );
}

function PeopleLayout() {
  const isChildRoute = useRouterState({
    select: (state) => state.location.pathname !== "/people",
  });
  if (isChildRoute) {
    return <Outlet />;
  }
  return <PeoplePage />;
}

export const Route = createFileRoute("/people" as const)({
  component: PeopleLayout,
  errorComponent: RouteError,
});
