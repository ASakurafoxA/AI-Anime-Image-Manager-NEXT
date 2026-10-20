/**
 * 「发现没有标签的角色」对话框（NEXT 版新增）。
 *
 * 用户需求的后一半：把**没有角色标签**的图里、彼此像一个角色的图归成一组，
 * 用户给一组起个名字 → 批量写「AI 建议标签」（不覆盖任何已有标签）。
 *
 * 用户实测反馈后补齐的四件事（2026-10）：
 *   ① **能滚动** —— DialogContent 得显式 `flex flex-col`，否则内层 `flex-1` 无效、
 *      内容被 `overflow-hidden` 裁掉且滚不动（60 组只能看到前几组 ✗）；
 *   ② **结果存盘** —— 聚类一次几分钟，退出后下次进来直接显示上次结果，不用重跑；
 *   ③ **记住命名进度** —— 已命名的组显示"已命名"，中途关掉再回来接着命名；
 *   ④ **命名时检索已有标签** —— 有些图其实已有该角色的标签（只是打标没认出来，
 *      例："铃兰"）：输入时给建议，命中就**直接用已有标签**，没有才新建。
 *
 * 三种入口状态（与 `ccip-model.ts` 的判定一致）：
 *   · 缺模型  → 明确告知去哪放模型 / 或去设置里关掉「优先 CCIP」
 *   · 缺特征  → 提供「生成角色特征」按钮（全库一次性，可能几小时，带进度与取消）
 *   · 可用    → 「开始分析」（全库聚类，实测约 5 分钟，带进度）
 */
import { useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { faceActions } from "@/actions/faces";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PhotoLightbox, type LightboxPhoto } from "@/components/PhotoLightbox";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toLocalMediaUrl } from "@/utils/local-media-url";

interface CharacterFeatureStatus {
  message: string | null;
  modelAvailable: boolean;
  preferCcip: boolean;
  reason: string;
  source: "ccip" | "clip" | "unavailable";
  vectorCount: number;
}

interface CharacterGroupView {
  photoIds: number[];
  size: number;
  meanSimilarity: number;
  representativeId: number;
  thumbnails: string[];
  namedTagId: number | null;
  namedTagName: string | null;
}

interface TagSuggestion {
  id: number;
  name: string;
  rootName: string;
}

interface CharacterBuildProgress {
  running: boolean;
  done: number;
  total: number;
  embedded: number;
  failed: number;
  photosPerSecond: number | null;
  etaSeconds: number | null;
  lastSummary: string | null;
}

interface ClusterProgressView {
  done: number;
  total: number;
  photosPerSecond: number | null;
  etaSeconds: number | null;
}

/** 展开某组时拿到的整组照片（字段与 PhotoLightbox 要求的 LightboxPhoto 对齐）。 */
type GroupPhoto = LightboxPhoto;

/** 把秒数说成人话（几小时几分钟），避免用户看到 21780 这种数字。 */
function humanEta(seconds: number | null): string {
  if (seconds == null || seconds <= 0) {
    return "—";
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours > 0) {
    return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  }
  if (minutes > 0) {
    return `${minutes} 分`;
  }
  return "不到 1 分";
}

export interface CharacterDiscoveryDialogProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function CharacterDiscoveryDialog({
  open,
  onOpenChange,
}: CharacterDiscoveryDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<CharacterFeatureStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [building, setBuilding] = useState(false);
  const [groups, setGroups] = useState<CharacterGroupView[] | null>(null);
  const [names, setNames] = useState<Record<number, string>>({});
  const [picked, setPicked] = useState<Record<number, TagSuggestion | null>>({});
  const [suggestions, setSuggestions] = useState<Record<number, TagSuggestion[]>>(
    {}
  );
  const [namingIndex, setNamingIndex] = useState<number | null>(null);
  /**
   * 「导入已有标签」的二次确认。
   *
   * 用户口径：这一步会**一次给整组（几十上百张）图打上标签**，误点代价大，
   * 所以必须先确认；而"手动新建角色"不弹确认（用户就是那个意思）。
   */
  const [confirmImport, setConfirmImport] = useState<{
    count: number;
    index: number;
    suggestion: TagSuggestion;
  } | null>(null);
  /**
   * 自用（用户要求）：「展开看整组图 + 勾选部分图」。
   *   · `expandedGroups`：哪些组展开了；
   *   · `groupPhotos`：展开时按需拉到的整组照片（懒加载，不展开不拉）；
   *   · `selection`：每组勾选了哪些照片 —— **空集 = 整组**（维持原行为）✓；
   *   · `lightbox`：点图片看大图。
   */
  /*
   * 自用（2026-10-18 · 会话#9 用户反馈「写入了标签之后，展开的相册还会保留」）：
   * 这三份状态原来按**数组下标**存，而"命名成功后该组会从列表里删掉"→ 下标整体前移，
   * 展开状态就错位到了别的组上（看起来就是"条目没了、相册还挂着"）✗
   * 现在统一按 **`representativeId`（代表图 id，稳定不变）** 存 ✓
   */
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [groupPhotos, setGroupPhotos] = useState<Record<number, GroupPhoto[]>>({});
  const [selection, setSelection] = useState<Record<number, Set<number>>>({});
  const [loadingGroup, setLoadingGroup] = useState<number | null>(null);
  const [lightbox, setLightbox] = useState<{
    index: number;
    photos: GroupPhoto[];
  } | null>(null);
  const [progress, setProgress] = useState<CharacterBuildProgress | null>(null);
  const [clusterProgress, setClusterProgress] = useState<ClusterProgressView | null>(
    null
  );
  /** 标签检索的防抖计时器（每个输入框一个） */
  const searchTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const refreshStatus = useCallback(async () => {
    try {
      const result =
        (await faceActions.getCharacterFeatureStatus()) as CharacterFeatureStatus;
      setStatus(result);
      setStatusError(null);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  /** 打开时：读状态 + 读上次的分组结果（有就直接显示，不用重跑）。 */
  useEffect(() => {
    if (!open) {
      return;
    }
    setNames({});
    setPicked({});
    setSuggestions({});
    void refreshStatus();
    void (async () => {
      try {
        const stored = (await faceActions.getStoredCharacterGroups()) as {
          groups: CharacterGroupView[];
        };
        // 已命名的组**不再显示**（用户口径：命名过的就从"发现"列表里消失）
        const pending = (stored?.groups ?? []).filter(
          (group) => group.namedTagId == null
        );
        setGroups(pending.length > 0 ? pending : []);
      } catch {
        setGroups(null);
      }
    })();
  }, [open, refreshStatus]);

  /** 生成特征期间每秒拉一次进度（全库几小时，不能是黑箱）。 */
  useEffect(() => {
    if (!building) {
      return;
    }
    let stopped = false;
    const tick = async () => {
      try {
        const result =
          (await faceActions.getCharacterFeatureProgress()) as CharacterBuildProgress;
        if (!stopped) {
          setProgress(result);
        }
      } catch {
        /* 轮询失败不打扰用户 */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [building]);

  /** 聚类期间每秒拉一次进度（全库约几分钟）。 */
  useEffect(() => {
    if (!analyzing) {
      return;
    }
    let stopped = false;
    const tick = async () => {
      try {
        const result =
          (await faceActions.getCharacterClusterProgress()) as ClusterProgressView;
        if (!stopped) {
          setClusterProgress(result);
        }
      } catch {
        /* 轮询失败不打扰用户 */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [analyzing]);

  async function handleBuildFeatures() {
    if (building) {
      return;
    }
    setBuilding(true);
    toast.info(t("characterDiscoveryBuildingToast"));
    try {
      const result = (await faceActions.buildCharacterFeatures({})) as {
        embedded: number;
        failed: number;
        cancelled: boolean;
      };
      toast.success(
        t("characterDiscoveryBuildDone", {
          count: result.embedded,
          failed: result.failed,
        })
      );
      await refreshStatus();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBuilding(false);
    }
  }

  async function handleCancelFeatures() {
    try {
      await faceActions.cancelCharacterFeatures();
      toast.info(t("characterDiscoveryCancelSent"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleAnalyze(force = false) {
    if (analyzing) {
      return;
    }
    setAnalyzing(true);
    try {
      if (force) {
        await faceActions.clearStoredCharacterGroups();
      }
      const result = (await faceActions.discoverUnnamedCharacterGroups({})) as {
        groups: CharacterGroupView[];
        groupCount: number;
      };
      setGroups(result.groups);
      setNames({});
      setPicked({});
      setSuggestions({});
      if (result.groupCount === 0) {
        toast.info(t("characterDiscoveryNone"));
      } else {
        toast.success(t("characterDiscoveryFound", { count: result.groupCount }));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setAnalyzing(false);
    }
  }

  /**
   * 输入名字时**检索已有标签**：命中就显示建议，用户点一下就"用已有标签"
   * （保留它在标签树里原来的位置），不必新建重名标签。
   */
  function handleNameChange(index: number, value: string) {
    setNames((prev) => ({ ...prev, [index]: value }));
    setPicked((prev) => ({ ...prev, [index]: null }));
    const timer = searchTimers.current[index];
    if (timer) {
      clearTimeout(timer);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setSuggestions((prev) => ({ ...prev, [index]: [] }));
      return;
    }
    searchTimers.current[index] = setTimeout(() => {
      void (async () => {
        try {
          const result = (await faceActions.searchCharacterTags({
            query: trimmed,
          })) as { matches: TagSuggestion[] };
          setSuggestions((prev) => ({
            ...prev,
            [index]: result?.matches ?? [],
          }));
        } catch {
          /* 检索失败不影响手输新名字 */
        }
      })();
    }, 250);
  }

  function pickSuggestion(index: number, suggestion: TagSuggestion) {
    setPicked((prev) => ({ ...prev, [index]: suggestion }));
    setNames((prev) => ({ ...prev, [index]: suggestion.name }));
    setSuggestions((prev) => ({ ...prev, [index]: [] }));
  }

  /** 展开/收起某组；展开时**按需**拉整组照片（不展开不拉，避免一次拉几千张）。 */
  async function toggleExpand(index: number, group: CharacterGroupView) {
    const key = group.representativeId;
    const next = new Set(expandedGroups);
    if (next.has(key)) {
      next.delete(key);
      setExpandedGroups(next);
      return;
    }
    next.add(key);
    setExpandedGroups(next);
    if (groupPhotos[key]) {
      return;
    }
    setLoadingGroup(key);
    try {
      const result = (await faceActions.getCharacterGroupPhotos(
        group.photoIds
      )) as { photos?: GroupPhoto[] };
      setGroupPhotos((prev) => ({ ...prev, [key]: result?.photos ?? [] }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingGroup(null);
    }
  }

  /** 勾选 / 取消勾选一张图。 */
  function toggleSelect(key: number, photoId: number) {
    setSelection((prev) => {
      const next = new Set(prev[key] ?? []);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
      }
      return { ...prev, [key]: next };
    });
  }

  function clearSelection(key: number) {
    setSelection((prev) => ({ ...prev, [key]: new Set() }));
  }

  /**
   * 这一组最终要打标签的照片：
   *   · 有勾选 → **只打勾选的**；· 没勾选 → 整组（维持原来的行为）✓
   * 这正是用户要的："选中的已命名，未选中维持原样"。
   */
  function targetPhotoIds(_index: number, group: CharacterGroupView): number[] {
    const chosen = selection[group.representativeId];
    return chosen && chosen.size > 0 ? [...chosen] : group.photoIds;
  }

  /** 点「命名」：导入已有标签要先二次确认；手动新建直接执行。 */
  function requestName(index: number) {
    const group = groups?.[index];
    const choice = picked[index] ?? null;
    if (!group) {
      return;
    }
    if (choice) {
      setConfirmImport({ index, suggestion: choice, count: group.size });
      return;
    }
    void handleName(index);
  }

  async function handleName(index: number) {
    const group = groups?.[index];
    if (!group || group.namedTagId != null) {
      return;
    }
    const choice = picked[index] ?? null;
    const typed = (names[index] ?? "").trim();
    if (!choice && typed.length === 0) {
      return;
    }
    setNamingIndex(index);
    try {
      const result = (await faceActions.nameCharacterGroup({
        ...(choice ? { tagId: choice.id } : { name: typed }),
        // 有勾选就只命名勾选的；没勾选是整组（用户口径：未选中维持原样）
        photoIds: targetPhotoIds(index, group),
        confidence: group.meanSimilarity,
        groupIndex: index,
      })) as {
        applied: number;
        attempted: number;
        tagId: number;
        tagName: string;
      };
      /*
       * 提示要说**实话**（用户反馈"导入了但不确定有没有生效"）：
       * 组里的图有一部分**本来就带这个标签**（打标时就打过），会被去重跳过 ——
       * 所以"新增"和"本来就有"要分开报，不能只报组里的总张数 ✗。
       */
      const kept = Math.max(0, (result.attempted ?? 0) - result.applied);
      toast.success(
        kept > 0
          ? t("characterDiscoveryNamedPartial", {
              name: result.tagName,
              applied: result.applied,
              kept,
            })
          : t("characterDiscoveryNamed", {
              name: result.tagName,
              count: result.applied,
            })
      );
      /*
       * ⚠️ 关键：**通知侧边栏刷新标签树**。
       * 侧边栏的标签不是 react-query 拉的，而是靠 `tags-changed` 事件重新请求
       * （见 Sidebar.tsx）。不派发这个事件的话，数据虽然写进去了、界面数字却不变，
       * 用户就会以为"没加进去" ✗（实测反馈正是如此）。
       */
      window.dispatchEvent(new Event("tags-changed"));
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      /*
       * 自用（2026-10-18 · 会话#9 用户反馈「已经写入名字的自定义角色，界面里没有展示出来」）：
       * 人物页的「我创建的角色」读的是 `["faces","manual-roles"]`，这里原来**没有失效它** ✗
       * → 刚命名的角色要等 30 秒 staleTime 或手动刷新才出现。命名成功就立刻失效 ✓
       */
      queryClient.invalidateQueries({ queryKey: ["faces", "manual-roles"] });
      // 用户口径：命名过的组**从"发现"列表里消失**（不再显示）
      setGroups((prev) =>
        prev ? prev.filter((_, i) => i !== index) : prev
      );
      setNames((prev) => ({ ...prev, [index]: "" }));
      setPicked((prev) => ({ ...prev, [index]: null }));
      setSuggestions((prev) => ({ ...prev, [index]: [] }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setNamingIndex(null);
    }
  }

  const unavailable = status?.source === "unavailable";
  const needsFeatures = status?.reason === "vectors-missing";
  const totalPhotos = (groups ?? []).reduce((sum, group) => sum + group.size, 0);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {/*
        ⚠️ 必须显式 `flex flex-col`：DialogContent 自带 `grid`，而下面的内容区用
        `flex-1 min-h-0 overflow-y-auto` 当滚动容器 —— grid 父容器下 flex-1 不生效，
        内容会被 `overflow-hidden` 裁掉且**滚不动**（用户实测反馈）。
      */}
      <DialogContent
        className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden"
        /*
         * 用户实测反馈："进大图后点空白区域直接就回到人物识别界面了，只有点右上角的 X 才回到列表"。
         *
         * 原因：`PhotoLightbox` 是 `createPortal` 渲染到 body 的（z-[1000]），
         * **在 Dialog 的 DOM 之外** —— 于是点它的遮罩（或按 Esc）会被 Radix 判定成
         * "与弹窗外部交互" → 顺手把整个对话框也关了 ✗（两级同时响应）。
         * 所以大图打开期间把这几条路拦掉：此时只有大图自己的 X / Esc 会关掉大图 ✓。
         */
        onEscapeKeyDown={(event) => {
          if (lightbox) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (lightbox) {
            event.preventDefault();
          }
        }}
        onPointerDownOutside={(event) => {
          if (lightbox) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("characterDiscoveryTitle")}</DialogTitle>
          <DialogDescription>
            {t("characterDiscoveryDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          {statusError && (
            <p className="rounded-[6px] bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {statusError}
            </p>
          )}

          {unavailable && (
            <div className="mb-3 rounded-[6px] border border-border bg-secondary/40 px-3 py-2 text-[12px] text-muted-foreground">
              {status?.message ?? t("characterDiscoveryUnavailable")}
            </div>
          )}

          {!status && !statusError && (
            <div className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
              <LoadingSpinner size="sm" />
              {t("characterDiscoveryChecking")}
            </div>
          )}

          {status && !unavailable && (
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <button
                className="rounded-[6px] border border-border bg-card px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-50"
                disabled={analyzing || building}
                onClick={() => void handleAnalyze(groups != null)}
                type="button"
              >
                {analyzing
                  ? t("characterDiscoveryRunning")
                  : groups != null
                    ? t("characterDiscoveryReanalyze")
                    : t("characterDiscoveryStart")}
              </button>
              <span className="text-[11px] text-muted-foreground">
                {t("characterDiscoverySource", {
                  source:
                    status.source === "ccip"
                      ? "CCIP"
                      : t("characterDiscoverySourceClip"),
                  count: status.vectorCount,
                })}
              </span>
              {analyzing && clusterProgress && clusterProgress.total > 0 && (
                <span className="text-[11px] text-muted-foreground">
                  {t("characterDiscoveryClusterProgress", {
                    done: clusterProgress.done,
                    total: clusterProgress.total,
                    eta: humanEta(clusterProgress.etaSeconds),
                  })}
                </span>
              )}
            </div>
          )}

          {needsFeatures && (
            <div className="mb-3 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="rounded-[6px] border border-border bg-card px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-50"
                  disabled={building}
                  onClick={() => void handleBuildFeatures()}
                  type="button"
                >
                  {building
                    ? t("characterDiscoveryBuilding")
                    : t("characterDiscoveryBuildFeatures")}
                </button>
                {building && (
                  <button
                    className="rounded-[6px] border border-border bg-secondary px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-foreground/5"
                    onClick={() => void handleCancelFeatures()}
                    type="button"
                  >
                    {t("characterDiscoveryCancel")}
                  </button>
                )}
              </div>
              {building && progress && progress.total > 0 && (
                <div className="rounded-[6px] border border-border bg-secondary/40 px-3 py-2 text-[12px] text-muted-foreground">
                  <div>
                    {t("characterDiscoveryProgress", {
                      done: progress.done,
                      total: progress.total,
                      embedded: progress.embedded,
                      failed: progress.failed,
                    })}
                  </div>
                  <div className="mt-1">
                    {t("characterDiscoveryProgressEta", {
                      speed: progress.photosPerSecond ?? "—",
                      eta: humanEta(progress.etaSeconds),
                    })}
                  </div>
                </div>
              )}
              {!building && progress?.lastSummary && (
                <p className="text-[11px] text-muted-foreground">
                  {progress.lastSummary}
                </p>
              )}
            </div>
          )}

          {groups && groups.length > 0 && (
            <p className="mb-2 text-[12px] text-muted-foreground">
              {t("characterDiscoverySummary", {
                groups: groups.length,
                photos: totalPhotos,
              })}
            </p>
          )}

          {/* 缓存里有分组、但都已经命名完了 —— 明确告诉用户，而不是一片空白 */}
          {groups && groups.length === 0 && (
            <p className="py-4 text-[12px] text-muted-foreground">
              {t("characterDiscoveryAllNamed")}
            </p>
          )}

          <div className="flex flex-col gap-2">
            {(groups ?? []).map((group, index) => {
              const done = group.namedTagId != null;
              const list = suggestions[index] ?? [];
              const choice = picked[index] ?? null;
              const typedName = (names[index] ?? "").trim();
              /**
               * 手动输入的名字**正好撞上已有标签**：提前提醒（提交时服务端也会拦 ✗）。
               * 用户口径：不同作品会有同名角色，不能让它们被静默当成同一个。
               */
              const exactMatch =
                !choice && typedName.length > 0
                  ? list.find((item) => item.name === typedName)
                  : undefined;
              const groupKey = group.representativeId;
              const expanded = expandedGroups.has(groupKey);
              const chosen = selection[groupKey] ?? new Set<number>();
              const photos = groupPhotos[groupKey] ?? [];
              const loadingThis = loadingGroup === groupKey;
              return (
                <div
                  /*
                   * 自用（2026-10-18 · 会话#9 用户反馈「缩略图加载好慢」）：
                   * 这里最多 200 组 × 5 张 = **1000 张 1024px webp**，打开时要等很久 ✗
                   * `content-visibility: auto` 让屏幕外的组先不加载（滚到哪加载到哪），
                   * 打开时只请求可见的几组 ✓；`contain-intrinsic-size` 稳住滚动条。
                   */
                  className="flex flex-col gap-2 rounded-[6px] border border-border bg-card px-3 py-2 [content-visibility:auto] [contain-intrinsic-size:auto_72px]"
                  key={`${group.representativeId}-${index}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex shrink-0 items-center gap-1">
                      {group.thumbnails.slice(0, 5).map((thumb) => (
                        <img
                          alt=""
                          className="h-12 w-12 rounded-[4px] object-cover"
                          height={48}
                          key={thumb}
                          loading="lazy"
                          src={toLocalMediaUrl(thumb)}
                          width={48}
                        />
                      ))}
                      {/* 展开/收起：看整组图 + 勾选部分图（用户要求） */}
                      {group.size > 5 && (
                        <button
                          className="ml-1 shrink-0 rounded-[4px] border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                          onClick={() => void toggleExpand(index, group)}
                          type="button"
                        >
                          {expanded
                            ? t("characterDiscoveryCollapse")
                            : t("characterDiscoveryExpand")}
                        </button>
                      )}
                    </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] text-foreground">
                      {t("characterDiscoveryGroupMeta", {
                        count: group.size,
                        similarity: group.meanSimilarity.toFixed(2),
                      })}
                    </p>
                    {done ? (
                      <p className="mt-1 text-[12px] text-muted-foreground">
                        {t("characterDiscoveryGroupNamed", {
                          name: group.namedTagName ?? "",
                        })}
                      </p>
                    ) : (
                      <>
                        <input
                          className="mt-1 w-full rounded-[4px] border border-border bg-secondary px-2 py-1 text-[12px] text-foreground outline-none focus:border-foreground/40"
                          onChange={(event) =>
                            handleNameChange(index, event.target.value)
                          }
                          placeholder={t("characterDiscoveryNamePlaceholder")}
                          value={names[index] ?? ""}
                        />
                        {choice && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {t("characterDiscoveryWillUse", {
                              name: choice.name,
                              root: choice.rootName,
                            })}
                          </p>
                        )}
                        {exactMatch && (
                          <p className="mt-1 text-[11px] text-destructive">
                            {t("characterDiscoveryNameConflict", {
                              name: exactMatch.name,
                            })}
                          </p>
                        )}
                        {!choice && list.length > 0 && (
                          <div className="mt-1 flex flex-col gap-0.5 rounded-[4px] border border-border bg-secondary/60 p-1">
                            <span className="px-1 text-[10px] text-muted-foreground">
                              {t("characterDiscoverySuggestHint")}
                            </span>
                            {list.slice(0, 6).map((suggestion) => (
                              <button
                                className="rounded-[3px] px-1 py-0.5 text-left text-[12px] text-foreground transition-colors hover:bg-foreground/10"
                                key={suggestion.id}
                                onClick={() => pickSuggestion(index, suggestion)}
                                type="button"
                              >
                                {suggestion.name}
                                {suggestion.rootName && (
                                  <span className="ml-2 text-[10px] text-muted-foreground">
                                    {suggestion.rootName}
                                  </span>
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <button
                    className="mt-1 shrink-0 rounded-[6px] border border-border bg-secondary px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-50"
                    disabled={
                      done ||
                      namingIndex !== null ||
                      (!choice && (names[index] ?? "").trim() === "")
                    }
                    onClick={() => requestName(index)}
                    type="button"
                  >
                    {done
                      ? t("characterDiscoveryGroupNamedShort")
                      : namingIndex === index
                        ? t("characterDiscoveryNaming")
                        : chosen.size > 0
                          ? t("characterDiscoveryNameSelectedApply", {
                              count: chosen.size,
                            })
                          : t("characterDiscoveryNameApply")}
                  </button>
                  </div>

                  {/* 展开区：整组图 + 左上角勾选圈（点圈勾选、点图看大图） */}
                  {expanded && (
                    <div className="border-border border-t pt-2">
                      <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                        <span>{t("characterDiscoverySelectHint")}</span>
                        {chosen.size > 0 && (
                          <>
                            <span className="text-foreground">
                              {t("characterDiscoverySelected", {
                                count: chosen.size,
                              })}
                            </span>
                            <button
                              className="underline transition-colors hover:text-foreground"
                              onClick={() => clearSelection(groupKey)}
                              type="button"
                            >
                              {t("characterDiscoveryClearSelection")}
                            </button>
                          </>
                        )}
                      </div>
                      {loadingThis ? (
                        <div className="flex items-center gap-2 py-3 text-[12px] text-muted-foreground">
                          <LoadingSpinner size="sm" />
                          {t("characterDiscoveryLoadingPhotos")}
                        </div>
                      ) : (
                        <div className="grid max-h-[320px] grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-1.5 overflow-y-auto overscroll-contain pr-1">
                          {photos.map((photo, photoIndex) => {
                            const isPicked = chosen.has(photo.id);
                            return (
                              <div className="relative" key={photo.id}>
                                {/* 左上角小圈：点它 = 勾选（不打开大图） */}
                                <button
                                  aria-label={t("characterDiscoveryToggleSelect")}
                                  aria-pressed={isPicked}
                                  className={`absolute top-1 left-1 z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 transition-colors shadow-sm ${
                                    isPicked
                                      ? "border-primary bg-primary text-white"
                                      : "border-white/80 bg-black/35 hover:bg-black/60"
                                  }`}
                                  onClick={() => toggleSelect(groupKey, photo.id)}
                                  type="button"
                                >
                                  {isPicked && <Check className="h-3.5 w-3.5" />}
                                </button>
                                {/* 点图片 = 看大图 */}
                                <img
                                  alt=""
                                  className={`h-[76px] w-full cursor-zoom-in rounded-[4px] object-cover ${
                                    isPicked ? "ring-2 ring-primary" : ""
                                  }`}
                                  loading="lazy"
                                  onClick={() =>
                                    setLightbox({ index: photoIndex, photos })
                                  }
                                  src={toLocalMediaUrl(
                                    photo.thumbnailPath || photo.path
                                  )}
                                />
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <DialogFooter>
          <button
            className="rounded-[6px] border border-border bg-secondary px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-foreground/5"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            {t("close")}
          </button>
        </DialogFooter>

        {/* 导入已有标签：二次确认（一次给整组图打标签，防误点） */}
        {confirmImport && (
          <ConfirmDialog
            confirmText={t("manualImportConfirm")}
            description={t("manualImportBody", {
              count: confirmImport.count,
              name: confirmImport.suggestion.name,
              root: confirmImport.suggestion.rootName || "—",
            })}
            onCancel={() => setConfirmImport(null)}
            onConfirm={() => {
              const target = confirmImport.index;
              setConfirmImport(null);
              void handleName(target);
            }}
            open
            title={t("manualImportTitle")}
          />
        )}

        {/* 点展开区里的图片 → 用主图库那套大图查看器（左右翻、缩放都能用） */}
        {lightbox && (
          <PhotoLightbox
            initialIndex={lightbox.index}
            /* 用户口径：点图片以外的空白 = 退出大图、回到分组列表（弹窗留着） */
            onBackdropClick={() => setLightbox(null)}
            onClose={() => setLightbox(null)}
            open
            photos={lightbox.photos}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}