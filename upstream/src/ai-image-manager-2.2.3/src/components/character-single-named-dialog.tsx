/**
 * 「多人图里只认出一个角色」（2026-11-14 · 会话#12 新增）。
 *
 * 用户口径（最终版）：
 *   · 界面**直接照抄**「识别无标签角色并命名」（独立实现，不共用代码）；
 *   · 每组标题 = **角色名**（不是张数/相似度）；
 *   · 第一个输入框**预填已识别角色**（只读）；
 *   · 第二个输入框填**第二个角色**；
 *   · 「命名」= 应用：**第二个框为空 = 这张/这组只有一个人**（按顶部性别开关改人数标签）；
 *   · 「名字不对」放在「命名」键下面。
 *
 * 数据：`listSingleNamedMultiPersonPhotos`（按角色分组分页，一页 N 组）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { faceActions } from "@/actions/faces";
import { PhotoLightbox, type LightboxPhoto } from "@/components/PhotoLightbox";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { LazyThumb } from "@/components/ui/lazy-thumb";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toLocalMediaUrl } from "@/utils/local-media-url";

/** 一页加载多少个**角色组**（用户口径：30 → 50） */
const GROUPS_PER_PAGE = 50;

export interface SingleNamedPhoto {
  id: number;
  path: string;
  personCount: number;
  thumbnailPath: string | null;
}

export interface SingleNamedGroup {
  photos: SingleNamedPhoto[];
  tagId: number;
  tagName: string;
}

interface TagSuggestion {
  id: number;
  name: string;
  rootName: string;
}

export interface CharacterSingleNamedDialogProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function CharacterSingleNamedDialog({
  onOpenChange,
  open,
}: CharacterSingleNamedDialogProps) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<SingleNamedGroup[]>([]);
  const [totalGroups, setTotalGroups] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  /** 每组勾选了哪些图：**空集 = 整组**（与另外两个对话框一致） */
  const [selection, setSelection] = useState<Record<number, Set<number>>>({});
  /** 第二个角色的名字（每组一个输入框） */
  const [secondDraft, setSecondDraft] = useState<Record<number, string>>({});
  const [secondPicked, setSecondPicked] = useState<
    Record<number, TagSuggestion | null>
  >({});
  const [secondSuggestions, setSecondSuggestions] = useState<
    Record<number, TagSuggestion[]>
  >({});
  /** 第一个框（已识别角色）：默认 = 组名；被改过 = 纠错，用新名字替换旧名字 */
  const [firstDraft, setFirstDraft] = useState<Record<number, string>>({});
  const [firstPicked, setFirstPicked] = useState<
    Record<number, TagSuggestion | null>
  >({});
  const [firstSuggestions, setFirstSuggestions] = useState<
    Record<number, TagSuggestion[]>
  >({});
  const secondTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const firstTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const [applying, setApplying] = useState<number | null>(null);
  /** 全局性别开关：第二个框留空（=只有一个人）时，人数标签落它 */
  const [gender, setGender] = useState<"1girl" | "1boy" | "1other">("1girl");
  const [lightbox, setLightbox] = useState<{
    index: number;
    photos: LightboxPhoto[];
  } | null>(null);
  const loadedGroupsRef = useRef(0);

  const photoById = useMemo(() => {
    const map = new Map<number, SingleNamedPhoto>();
    for (const group of groups) {
      for (const photo of group.photos) {
        map.set(photo.id, photo);
      }
    }
    return map;
  }, [groups]);

  const loadPage = useCallback(async (groupOffset: number) => {
    const result = (await faceActions.listSingleNamedMultiPersonPhotos({
      limit: GROUPS_PER_PAGE,
      offset: groupOffset,
    })) as { groups?: SingleNamedGroup[]; totalGroups?: number };
    return { groups: result?.groups ?? [], totalGroups: result?.totalGroups ?? 0 };
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setSelection({});
    setExpanded(new Set());
    setSecondDraft({});
    setSecondPicked({});
    setSecondSuggestions({});
    void (async () => {
      try {
        const page = await loadPage(0);
        if (cancelled) {
          return;
        }
        setGroups(page.groups);
        setTotalGroups(page.totalGroups);
        loadedGroupsRef.current = page.groups.length;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loadPage]);

  async function handleLoadMore() {
    if (loadingMore) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await loadPage(loadedGroupsRef.current);
      setGroups((prev) => [...prev, ...page.groups]);
      setTotalGroups(page.totalGroups);
      loadedGroupsRef.current += page.groups.length;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingMore(false);
    }
  }

  function toggleSelect(tagId: number, photoId: number) {
    setSelection((prev) => {
      const next = new Set(prev[tagId] ?? []);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
      }
      return { ...prev, [tagId]: next };
    });
  }

  /** 勾了就只处理勾选的；没勾就是整组 */
  function targetIdsOf(group: SingleNamedGroup): number[] {
    const chosen = selection[group.tagId];
    return chosen && chosen.size > 0 ? [...chosen] : group.photos.map((p) => p.id);
  }

  function dropPhotos(ids: number[]) {
    const done = new Set(ids);
    let emptied = 0;
    setGroups((prev) => {
      const next: SingleNamedGroup[] = [];
      for (const group of prev) {
        const rest = group.photos.filter((photo) => !done.has(photo.id));
        if (rest.length === 0) {
          emptied += 1;
          continue;
        }
        next.push({ ...group, photos: rest });
      }
      return next;
    });
    setTotalGroups((prev) => Math.max(0, prev - emptied));
    loadedGroupsRef.current = Math.max(0, loadedGroupsRef.current - emptied);
    setSelection({});
  }

  function searchNames(
    kind: "first" | "second",
    tagId: number,
    value: string
  ) {
    const timers = kind === "first" ? firstTimers : secondTimers;
    const setSuggestions =
      kind === "first" ? setFirstSuggestions : setSecondSuggestions;
    const timer = timers.current[tagId];
    if (timer) {
      clearTimeout(timer);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setSuggestions((prev) => ({ ...prev, [tagId]: [] }));
      return;
    }
    timers.current[tagId] = setTimeout(() => {
      void (async () => {
        try {
          const result = (await faceActions.searchCharacterTags({
            limit: 20,
            query: trimmed,
          })) as { matches?: TagSuggestion[] };
          setSuggestions((prev) => ({
            ...prev,
            [tagId]: result?.matches ?? [],
          }));
        } catch {
          /* 检索失败不影响手输 */
        }
      })();
    }, 250);
  }

  function handleFirstChange(tagId: number, value: string) {
    setFirstDraft((prev) => ({ ...prev, [tagId]: value }));
    setFirstPicked((prev) => ({ ...prev, [tagId]: null }));
    searchNames("first", tagId, value);
  }

  function handleSecondChange(tagId: number, value: string) {
    setSecondDraft((prev) => ({ ...prev, [tagId]: value }));
    setSecondPicked((prev) => ({ ...prev, [tagId]: null }));
    searchNames("second", tagId, value);
  }

  /**
   * 「命名」的三种语义（用户定稿）：
   *   ⓐ 第一个框**被改过** → 纠错：加新名字，再把旧角色标签摘掉（等价于原来的"名字不对"）；
   *   ⓑ 第一个框没动、第二个框**为空** → 视为"只有一个人"，按全局性别开关把人数标签改成单人；
   *   ⓒ 第一个框没动、第二个框**有名字** → 只给多人图补第二个名字（单人图不动）。
   */
  async function applyRow(group: SingleNamedGroup) {
    if (applying != null) {
      return;
    }
    const ids = targetIdsOf(group);
    if (ids.length === 0) {
      return;
    }
    const multiIds = ids.filter(
      (id) => (photoById.get(id)?.personCount ?? 0) >= 2
    );
    const scope = multiIds.length > 0 ? multiIds : ids;

    const firstPickedTag = firstPicked[group.tagId] ?? null;
    const firstText = (firstDraft[group.tagId] ?? group.tagName).trim();
    const secondPickedTag = secondPicked[group.tagId] ?? null;
    const secondText = (secondDraft[group.tagId] ?? "").trim();
    const firstChanged =
      firstPickedTag != null ||
      (firstText.length > 0 && firstText !== group.tagName);
    const secondName = secondPickedTag
      ? secondPickedTag.name
      : secondText;

    setApplying(group.tagId);
    try {
      if (firstChanged) {
        // ⓐ 纠错：先加新名字（全部目标图），再摘掉旧标签（顺序保证失败也不丢数据）
        await faceActions.nameCharacterGroup({
          photoIds: ids,
          targets: firstPickedTag ? [{ tagId: firstPickedTag.id }] : [{ name: firstText }],
        });
        if (secondName.length > 0) {
          await faceActions.nameCharacterGroup({
            photoIds: scope,
            targets: secondPickedTag
              ? [{ tagId: secondPickedTag.id }]
              : [{ name: secondText }],
          });
        }
        await faceActions.removeTagFromPhotos(group.tagId, ids);
        toast.success(
          t("characterSingleNamedCorrected", {
            count: ids.length,
            from: group.tagName,
            to: firstPickedTag ? firstPickedTag.name : firstText,
          })
        );
        dropPhotos(ids);
      } else if (secondName.length === 0) {
        // ⓑ 只有一个人
        await faceActions.setPhotosSinglePerson({ gender, photoIds: scope });
        toast.success(
          t("characterSingleNamedOnePersonDone", { count: scope.length })
        );
        dropPhotos(ids);
      } else {
        // ⓒ 补第二个名字
        await faceActions.nameCharacterGroup({
          photoIds: scope,
          targets: secondPickedTag
            ? [{ tagId: secondPickedTag.id }]
            : [{ name: secondText }],
        });
        toast.success(
          t("characterSingleNamedDone", { count: scope.length, name: secondName })
        );
        dropPhotos(ids);
      }
      setFirstDraft((prev) => {
        const next = { ...prev };
        delete next[group.tagId];
        return next;
      });
      setFirstPicked((prev) => ({ ...prev, [group.tagId]: null }));
      setFirstSuggestions((prev) => ({ ...prev, [group.tagId]: [] }));
      setSecondDraft((prev) => ({ ...prev, [group.tagId]: "" }));
      setSecondPicked((prev) => ({ ...prev, [group.tagId]: null }));
      setSecondSuggestions((prev) => ({ ...prev, [group.tagId]: [] }));
      window.dispatchEvent(new Event("tags-changed"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(null);
    }
  }

  function groupPhotoSummary(group: SingleNamedGroup): string {
    const counts = new Map<number, number>();
    for (const photo of group.photos) {
      counts.set(photo.personCount, (counts.get(photo.personCount) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([people, count]) => `${people} ${t("characterSingleNamedPeopleUnit")} ×${count}`
      )
      .join(" · ");
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t("characterSingleNamedTitle")}</DialogTitle>
          <DialogDescription>{t("characterSingleNamedHint")}</DialogDescription>
        </DialogHeader>

        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-muted-foreground">
            {t("characterSingleNamedGroupCount", {
              loaded: groups.length,
              total: totalGroups,
            })}
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              {t("characterSingleNamedGender")}
            </span>
            {(
              [
                ["1girl", "characterSingleNamedGenderGirl"],
                ["1boy", "characterSingleNamedGenderBoy"],
                ["1other", "characterSingleNamedGenderOther"],
              ] as const
            ).map(([value, key]) => (
              <button
                className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                  gender === value
                    ? "border-primary bg-primary text-white"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
                key={value}
                onClick={() => setGender(value)}
                type="button"
              >
                {t(key)}
              </button>
            ))}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <LoadingSpinner />
            </div>
          ) : groups.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-muted-foreground">
              {t("characterSingleNamedEmpty")}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {groups.map((group) => {
                const chosen = selection[group.tagId] ?? new Set<number>();
                const isExpanded = expanded.has(group.tagId);
                const draft = secondDraft[group.tagId] ?? "";
                const pickedTag = secondPicked[group.tagId] ?? null;
                const suggestions = secondSuggestions[group.tagId] ?? [];
                const firstValue = firstDraft[group.tagId] ?? group.tagName;
                const firstPickedTag = firstPicked[group.tagId] ?? null;
                const firstSugg = firstSuggestions[group.tagId] ?? [];
                const firstChanged =
                  firstPickedTag != null ||
                  (firstValue.trim().length > 0 &&
                    firstValue.trim() !== group.tagName);
                const busy = applying === group.tagId;
                const allPhotos = group.photos.map((item) => ({
                  fileSize: 0,
                  filename: item.path.split(/[\\/]/).pop() ?? "",
                  height: 0,
                  id: item.id,
                  path: item.path,
                  thumbnailPath: item.thumbnailPath,
                  width: 0,
                }));
                return (
                  <div
                    className="flex flex-col gap-2 rounded-[6px] border border-border bg-card px-3 py-2 [contain-intrinsic-size:auto_120px] [content-visibility:auto]"
                    key={group.tagId}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex shrink-0 items-center gap-1">
                        {group.photos.slice(0, 5).map((photo, thumbIndex) => {
                          const isPicked = chosen.has(photo.id);
                          /* 只有**没有展开选项**（≤5 张）时，这排小图才需要勾选圈（用户口径） */
                          const showCircle = group.photos.length <= 5;
                          return (
                            <div className="relative" key={photo.id}>
                              {showCircle && (
                                <button
                                  aria-label={t("characterDiscoveryToggleSelect")}
                                  aria-pressed={isPicked}
                                  className={`absolute top-0.5 left-0.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border-2 shadow-sm transition-colors ${
                                    isPicked
                                      ? "border-primary bg-primary text-white"
                                      : "border-white/80 bg-black/35 hover:bg-black/60"
                                  }`}
                                  onClick={() => toggleSelect(group.tagId, photo.id)}
                                  type="button"
                                >
                                  {isPicked && (
                                    <span className="text-[10px] leading-none">✓</span>
                                  )}
                                </button>
                              )}
                              <span className="absolute top-0.5 right-0.5 z-10 rounded-full bg-black/65 px-1 py-[1px] text-[9px] font-semibold leading-none text-white">
                                {photo.personCount}
                              </span>
                              <LazyThumb
                                className={`h-12 w-12 cursor-zoom-in rounded-[4px] ${
                                  isPicked ? "ring-2 ring-primary" : ""
                                }`}
                                onClick={() =>
                                  setLightbox({ index: thumbIndex, photos: allPhotos })
                                }
                                src={toLocalMediaUrl(photo.thumbnailPath || photo.path)}
                              />
                            </div>
                          );
                        })}
                        {group.photos.length > 5 && (
                          <button
                            className="ml-1 shrink-0 rounded-[4px] border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                            onClick={() =>
                              setExpanded((prev) => {
                                const next = new Set(prev);
                                if (next.has(group.tagId)) {
                                  next.delete(group.tagId);
                                } else {
                                  next.add(group.tagId);
                                }
                                return next;
                              })
                            }
                            type="button"
                          >
                            {isExpanded
                              ? t("characterDiscoveryCollapse")
                              : t("characterDiscoveryExpand")}
                          </button>
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        {/* 标题 = 角色名（用户口径） */}
                        <p className="truncate text-[12px] font-medium text-foreground">
                          {group.tagName}
                        </p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {t("characterSingleNamedRowMeta", {
                            count: group.photos.length,
                          })}
                          {` · ${groupPhotoSummary(group)}`}
                        </p>
                        {/* 第一个框：默认填已识别角色；**改了它就等于纠错**（点命名时替换旧名字） */}
                        <input
                          className={`mt-1 w-full rounded-[4px] border bg-secondary px-2 py-1 text-[12px] outline-none focus:border-foreground/40 ${
                            firstChanged
                              ? "border-destructive text-foreground"
                              : "border-border text-foreground"
                          }`}
                          disabled={busy}
                          onChange={(event) =>
                            handleFirstChange(group.tagId, event.target.value)
                          }
                          value={firstPickedTag ? firstPickedTag.name : firstValue}
                        />
                        {firstChanged && (
                          <p className="mt-1 text-[11px] text-destructive">
                            {t("characterSingleNamedCorrectionHint", {
                              from: group.tagName,
                            })}
                          </p>
                        )}
                        {!firstPickedTag && firstSugg.length > 0 && (
                          <div className="mt-1 flex max-h-32 flex-col gap-0.5 overflow-y-auto rounded-[4px] border border-border bg-secondary/60 p-1">
                            <span className="px-1 text-[10px] text-muted-foreground">
                              {t("characterDiscoverySuggestHint")}
                            </span>
                            {firstSugg.map((suggestion) => (
                              <button
                                className="rounded-[3px] px-1 py-0.5 text-left text-[12px] text-foreground transition-colors hover:bg-foreground/10"
                                key={suggestion.id}
                                onClick={() => {
                                  setFirstPicked((prev) => ({
                                    ...prev,
                                    [group.tagId]: suggestion,
                                  }));
                                  setFirstDraft((prev) => ({
                                    ...prev,
                                    [group.tagId]: suggestion.name,
                                  }));
                                  setFirstSuggestions((prev) => ({
                                    ...prev,
                                    [group.tagId]: [],
                                  }));
                                }}
                                type="button"
                              >
                                {suggestion.name}
                              </button>
                            ))}
                          </div>
                        )}
                        {/* 第二个框：填第二个角色；留空 = 只有一个人 */}
                        <div className="mt-1 flex items-center gap-1">
                          <input
                            className="min-w-0 flex-1 rounded-[4px] border border-border bg-secondary px-2 py-1 text-[12px] text-foreground outline-none focus:border-foreground/40"
                            disabled={busy}
                            onChange={(event) =>
                              handleSecondChange(group.tagId, event.target.value)
                            }
                            placeholder={t("characterSingleNamedSecondPlaceholder")}
                            value={pickedTag ? pickedTag.name : draft}
                          />
                        </div>
                        {pickedTag && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {t("characterDiscoveryWillUse", {
                              name: pickedTag.name,
                              root: pickedTag.rootName,
                            })}
                          </p>
                        )}
                        {!pickedTag && suggestions.length > 0 && (
                          <div className="mt-1 flex max-h-32 flex-col gap-0.5 overflow-y-auto rounded-[4px] border border-border bg-secondary/60 p-1">
                            <span className="px-1 text-[10px] text-muted-foreground">
                              {t("characterDiscoverySuggestHint")}
                            </span>
                            {suggestions.map((suggestion) => (
                              <button
                                className="rounded-[3px] px-1 py-0.5 text-left text-[12px] text-foreground transition-colors hover:bg-foreground/10"
                                key={suggestion.id}
                                onClick={() => {
                                  setSecondPicked((prev) => ({
                                    ...prev,
                                    [group.tagId]: suggestion,
                                  }));
                                  setSecondDraft((prev) => ({
                                    ...prev,
                                    [group.tagId]: suggestion.name,
                                  }));
                                  setSecondSuggestions((prev) => ({
                                    ...prev,
                                    [group.tagId]: [],
                                  }));
                                }}
                                type="button"
                              >
                                {suggestion.name}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* 右侧：命名 + 名字不对（用户口径：名字不对放在命名键下面） */}
                      <div className="flex shrink-0 flex-col gap-1">
                        <button
                          className="rounded-[4px] border border-border px-3 py-1 text-[12px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
                          disabled={busy}
                          onClick={() => void applyRow(group)}
                          type="button"
                        >
                          {busy
                            ? t("characterSingleNamedApplying")
                            : t("characterDiscoveryNameApply")}
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="flex flex-col gap-1">
                        {/* 展开区的多选工具（与「发现新角色」同一位置/样式：左边说明、右边三个按钮） */}
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <span>{t("characterDiscoverySelectHint")}</span>
                          <span className="ml-auto text-foreground">
                            {t("characterSingleNamedSelected", {
                              count: chosen.size,
                              total: group.photos.length,
                            })}
                          </span>
                          <button
                            className="rounded-[3px] border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                            onClick={() =>
                              setSelection((prev) => ({
                                ...prev,
                                [group.tagId]: new Set(
                                  group.photos.map((photo) => photo.id)
                                ),
                              }))
                            }
                            type="button"
                          >
                            {t("characterSingleNamedSelectAll")}
                          </button>
                          <button
                            className="rounded-[3px] border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                            onClick={() =>
                              setSelection((prev) => {
                                const all = group.photos.map(
                                  (photo) => photo.id
                                );
                                const current = prev[group.tagId] ?? new Set();
                                return {
                                  ...prev,
                                  [group.tagId]: new Set(
                                    all.filter((id) => !current.has(id))
                                  ),
                                };
                              })
                            }
                            type="button"
                          >
                            {t("characterSingleNamedInvert")}
                          </button>
                          <button
                            className="rounded-[3px] border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                            onClick={() =>
                              setSelection((prev) => ({
                                ...prev,
                                [group.tagId]: new Set(),
                              }))
                            }
                            type="button"
                          >
                            {t("characterSingleNamedSelectNone")}
                          </button>
                        </div>
                        <div className="grid max-h-72 grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1 overflow-y-auto overscroll-contain pr-1">
                        {group.photos.map((photo, photoIndex) => {
                          const isPicked = chosen.has(photo.id);
                          return (
                            <div className="relative" key={photo.id}>
                              <button
                                aria-label={t("characterDiscoveryToggleSelect")}
                                aria-pressed={isPicked}
                                className={`absolute top-0.5 left-0.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border-2 shadow-sm transition-colors ${
                                  isPicked
                                    ? "border-primary bg-primary text-white"
                                    : "border-white/80 bg-black/35 hover:bg-black/60"
                                }`}
                                onClick={() => toggleSelect(group.tagId, photo.id)}
                                type="button"
                              >
                                {isPicked && (
                                  <span className="text-[10px] leading-none">✓</span>
                                )}
                              </button>
                              <LazyThumb
                                className={`h-16 w-full cursor-zoom-in rounded-[4px] ${
                                  isPicked ? "ring-2 ring-primary" : ""
                                }`}
                                onClick={() =>
                                  setLightbox({ index: photoIndex, photos: allPhotos })
                                }
                                src={toLocalMediaUrl(photo.thumbnailPath || photo.path)}
                              />
                            </div>
                          );
                        })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {groups.length < totalGroups && (
                <div className="flex justify-center">
                  <button
                    className="rounded-[4px] border border-border px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                    disabled={loadingMore}
                    onClick={() => void handleLoadMore()}
                    type="button"
                  >
                    {loadingMore
                      ? t("characterSingleNamedLoading")
                      : t("characterSingleNamedLoadMore")}
                  </button>
                </div>
              )}
            </div>
          )}
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

        {lightbox && (
          <PhotoLightbox
            initialIndex={lightbox.index}
            onClose={() => setLightbox(null)}
            open
            photos={lightbox.photos}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
