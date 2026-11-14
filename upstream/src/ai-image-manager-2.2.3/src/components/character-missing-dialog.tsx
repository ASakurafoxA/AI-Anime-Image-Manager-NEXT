import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
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
import { faceActions } from "@/actions/faces";
import { toLocalMediaUrl } from "@/utils/local-media-url";

/**
 * 自用（2026-10-18 · 会话#9）：右键「识别漏标签的已有角色」的结果列表。
 *
 * 样式与「识别无标签角色并命名」（`CharacterDiscoveryDialog`）**完全对齐**：
 * 标题 + 说明、每行 5 张缩略图 + 「建议补 N 张 · 相似度」+ 右侧动作按钮 + 底部「关闭」；
 * 并且**支持展开 + 勾选**（用户口径：「改的和另一个一样，可以展开复选，不选择就是全部打标」）：
 *   · 展开 → 按需拉整组照片（不展开不拉，避免一次拉几百张）；
 *   · 勾选 → 只给勾选的打标；
 *   · 一个都不勾 → 整组全打（维持默认行为）✓
 *
 * 行为仍是 B 方案（先看后打）：这里只"看"，点「打标」才写 AI 建议标签。
 */
export interface CharacterMissingRow {
  count: number;
  meanSimilarity?: number;
  photoIds?: number[];
  tagId: number;
  tagName: string;
  thumbnails?: string[];
}

type GroupPhoto = LightboxPhoto;

export interface CharacterMissingDialogProps {
  /** 正在分析（点按钮到出结果之间要十几秒，必须让用户看见在干活） */
  analyzing: boolean;
  /** 正在写标签的那一行（用来禁用按钮、防重复点） */
  applying: number | null;
  /** 已完成的角色（key = tagId） */
  applied: Record<number, boolean>;
  onApply: (row: CharacterMissingRow, photoIds: number[]) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  rows: CharacterMissingRow[];
}

export function CharacterMissingDialog({
  analyzing,
  applying,
  applied,
  onApply,
  onOpenChange,
  open,
  rows,
}: CharacterMissingDialogProps) {
  const { t } = useTranslation();
  const remaining = rows.filter((row) => !applied[row.tagId]).length;

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [groupPhotos, setGroupPhotos] = useState<Record<number, GroupPhoto[]>>(
    {}
  );
  const [loadingGroup, setLoadingGroup] = useState<number | null>(null);
  /** 每组勾选了哪些照片：**空集 = 整组** */
  const [selection, setSelection] = useState<Record<number, Set<number>>>({});
  const [lightbox, setLightbox] = useState<{
    index: number;
    photos: GroupPhoto[];
  } | null>(null);
  /** 换一批结果（重新分析）时清掉展开/勾选状态 */
  const rowsKeyRef = useRef<string>("");
  /** ≤5 张那些行已经拉过/正在拉真实照片的（防重复请求；失败会删掉以便重试） */
  const loadingSmallRef = useRef<Set<number>>(new Set());
  /*
   * 自用（2026-10-18 · 会话#9 用户反馈「这个分析有点久」）：
   * 分析要十几到几十秒，只转圈会让人以为卡死 → 显示**走到哪一步 + 已用几秒** ✓
   */
  const [progress, setProgress] = useState<{
    done: number;
    elapsedMs: number;
    phase: "idle" | "seeds" | "search";
    total: number;
  } | null>(null);

  useEffect(() => {
    if (!analyzing) {
      setProgress(null);
      return;
    }
    let stopped = false;
    const tick = async () => {
      try {
        const result = (await faceActions.getCharacterSuggestProgress()) as {
          done: number;
          elapsedMs: number;
          phase: "idle" | "seeds" | "search";
          total: number;
        };
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
  }, [analyzing]);

  useEffect(() => {
    const key = rows.map((row) => row.tagId).join(",");
    if (rowsKeyRef.current === key) {
      return;
    }
    rowsKeyRef.current = key;
    setExpanded(new Set());
    setGroupPhotos({});
    setSelection({});
    setLightbox(null);
    // 结果换了一批 → 小图的加载记录也要清（否则同名下标会被当成"已拉过"）
    loadingSmallRef.current = new Set();
  }, [rows]);

  /*
   * 自用（2026-11-08 · 会话#11 用户口径）：「≤5 张就不用再展开了，直接在小图上操作就可以了」。
   * ≤5 张的行整组就是这一排小图 → 进弹窗就把**真实照片**拉回来（每行 ≤5 张，很轻），
   * 让这排小图带勾选圈。预览缩略图只有路径、没有 photo.id，勾不了；
   * 服务端拼预览时还可能因缺缩略图而 `filter` 掉几张，下标更对不上 ✗ → 不按下标猜 id ✓
   */
  useEffect(() => {
    if (!open) {
      return;
    }
    const pending: Array<{ ids: number[]; index: number }> = [];
    rows.forEach((row, index) => {
      const ids = row.photoIds ?? [];
      if (ids.length === 0 || ids.length > 5) {
        return;
      }
      if (groupPhotos[index] || loadingSmallRef.current.has(index)) {
        return;
      }
      loadingSmallRef.current.add(index);
      pending.push({ ids, index });
    });
    if (pending.length === 0) {
      return;
    }
    void (async () => {
      const loaded: Array<[number, GroupPhoto[]]> = [];
      await Promise.all(
        pending.map(async ({ ids, index }) => {
          try {
            const result = (await faceActions.getCharacterGroupPhotos(
              ids
            )) as { photos?: GroupPhoto[] };
            loaded.push([index, result?.photos ?? []]);
          } catch {
            // 拉失败 → 该行小图退化成不可勾选（仍可点开大图）；允许下次再试
            loadingSmallRef.current.delete(index);
          }
        })
      );
      if (loaded.length === 0) {
        return;
      }
      setGroupPhotos((prev) => {
        const next = { ...prev };
        for (const [index, photos] of loaded) {
          next[index] = photos;
        }
        return next;
      });
    })();
  }, [open, rows, groupPhotos]);

  const toggleExpand = useCallback(
    async (index: number, row: CharacterMissingRow) => {
      const next = new Set(expanded);
      if (next.has(index)) {
        next.delete(index);
        setExpanded(next);
        return;
      }
      next.add(index);
      setExpanded(next);
      if (groupPhotos[index]) {
        return;
      }
      const ids = row.photoIds ?? [];
      if (ids.length === 0) {
        return;
      }
      setLoadingGroup(index);
      try {
        const result = (await faceActions.getCharacterGroupPhotos(ids)) as {
          photos?: GroupPhoto[];
        };
        setGroupPhotos((prev) => ({ ...prev, [index]: result?.photos ?? [] }));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setLoadingGroup(null);
      }
    },
    [expanded, groupPhotos]
  );

  /**
   * 自用（2026-10-23 · 会话#10）：**点缩影也能看大图**。
   * 用户反馈：少于 5 张的行没有「展开」按钮，于是没有看大图的入口。
   * 点缩略图 → 按需拉整组照片（缓存）→ 打开大图，并停在被点的那张。
   */
  const openLightboxAt = useCallback(
    async (index: number, row: CharacterMissingRow, thumbIndex: number) => {
      let photos = groupPhotos[index];
      if (!photos || photos.length === 0) {
        const ids = row.photoIds ?? [];
        if (ids.length === 0) {
          return;
        }
        setLoadingGroup(index);
        try {
          const result = (await faceActions.getCharacterGroupPhotos(ids)) as {
            photos?: GroupPhoto[];
          };
          photos = result?.photos ?? [];
          setGroupPhotos((prev) => ({ ...prev, [index]: photos as GroupPhoto[] }));
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
          return;
        } finally {
          setLoadingGroup(null);
        }
      }
      if (photos && photos.length > 0) {
        setLightbox({ index: Math.min(thumbIndex, photos.length - 1), photos });
      }
    },
    [groupPhotos]
  );

  function toggleSelect(index: number, photoId: number) {
    setSelection((prev) => {
      const next = new Set(prev[index] ?? []);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
      }
      return { ...prev, [index]: next };
    });
  }

  function clearSelection(index: number) {
    setSelection((prev) => ({ ...prev, [index]: new Set() }));
  }

  /**
   * 一键全选（2026-11-08 · 会话#11 用户口径）：
   * 「一两百张里只有几张不是的话，要把其他需要的全部选择，很麻烦」→ 先全选、再点掉那几张。
   * ⚠️ 不做"全选/全不选"切换：这里的**空集 = 整组**（不勾选就是整组打标），
   * 「全不选」会变成"反而给整组打标"，是反的、会误操作 ✗ —— 取消仍用「清空勾选」。
   */
  function selectAll(index: number, list: GroupPhoto[]) {
    setSelection((prev) => ({
      ...prev,
      [index]: new Set(list.map((photo) => photo.id)),
    }));
  }

  /**
   * 反选（2026-11-14 · 会话#12）：与另两个对话框统一（全选 / 反选 / 清空）。
   * 已勾的取消、没勾的勾上；反选后一张都不剩 → 回到「整组」。
   */
  function invertSelection(index: number, list: GroupPhoto[]) {
    setSelection((prev) => {
      const current = prev[index] ?? new Set<number>();
      return {
        ...prev,
        [index]: new Set(
          list.map((photo) => photo.id).filter((id) => !current.has(id))
        ),
      };
    });
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden"
        /* 大图是 portal 到 body 的，打开期间别让点遮罩把弹窗一起关掉 */
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
          <DialogTitle>{t("peopleFindUnnamedCharacters")}</DialogTitle>
          <DialogDescription>
            {t("peopleFindUnnamedCharactersHint")}
          </DialogDescription>
        </DialogHeader>

        {analyzing && (
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[6px] border border-border bg-secondary/40 px-3 py-2 text-[12px] text-muted-foreground">
            <LoadingSpinner size="sm" />
            <span>{t("peopleFindUnnamedCharactersBusy")}</span>
            {progress && progress.total > 0 && (
              <span>
                {progress.phase === "seeds"
                  ? t("characterSuggestProgressSeeds", {
                      done: progress.done,
                      total: progress.total,
                    })
                  : t("characterSuggestProgressSearch", {
                      done: progress.done,
                      total: progress.total,
                    })}
              </span>
            )}
            {progress && (
              <span className="text-muted-foreground/70">
                {t("characterSuggestProgressElapsed", {
                  seconds: Math.max(
                    1,
                    Math.round((progress.elapsedMs || 0) / 1000)
                  ),
                })}
              </span>
            )}
          </div>
        )}

        {!analyzing && rows.length > 0 && (
          <p className="mb-2 text-[12px] text-muted-foreground">
            {t("characterSuggestionDescription", {
              characters: rows.length,
              count: rows.reduce((sum, row) => sum + row.count, 0),
            })}
            {remaining === 0 ? ` · ${t("characterSuggestionApplied")}` : ""}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          <div className="flex flex-col gap-2">
            {rows.map((row, index) => {
              const done = Boolean(applied[row.tagId]);
              const busy = applying === row.tagId;
              const thumbs = row.thumbnails ?? [];
              const isExpanded = expanded.has(index);
              const chosen = selection[index] ?? new Set<number>();
              const photos = groupPhotos[index] ?? [];
              /** ≤5 张时整组就是这一排小图 → 要有勾选圈（>5 张仍用预览缩略图，勾选去展开区） */
              const inlinePhotos =
                (row.photoIds?.length ?? 0) <= 5 ? photos : [];
              const loadingThis = loadingGroup === index;
              const targetIds = chosen.size > 0 ? [...chosen] : row.photoIds ?? [];
              return (
                <div
                  /*
                   * 屏幕外的行先不加载（滚到哪加载到哪）：20 行 × 5 张 1024px 图，
                   * 一次全拉会让弹窗打开时卡一两秒 ✗
                   */
                  className="flex flex-col gap-2 rounded-[6px] border border-border bg-card px-3 py-2 [contain-intrinsic-size:auto_72px] [content-visibility:auto]"
                  key={row.tagId}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex shrink-0 items-center gap-1">
                      {inlinePhotos.length > 0
                        ? inlinePhotos.map((photo, inlineIndex) => {
                            const picked = chosen.has(photo.id);
                            return (
                              <div className="relative" key={photo.id}>
                                <button
                                  aria-label={t(
                                    "characterDiscoveryToggleSelect"
                                  )}
                                  aria-pressed={picked}
                                  className={`absolute top-0.5 left-0.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border-2 shadow-sm transition-colors ${
                                    picked
                                      ? "border-primary bg-primary text-white"
                                      : "border-white/80 bg-black/35 hover:bg-black/60"
                                  }`}
                                  onClick={() => toggleSelect(index, photo.id)}
                                  type="button"
                                >
                                  {picked && (
                                    <span className="text-[10px] leading-none">
                                      ✓
                                    </span>
                                  )}
                                </button>
                                <LazyThumb
                                  className={`h-12 w-12 cursor-zoom-in rounded-[4px] ${
                                    picked ? "ring-2 ring-primary" : ""
                                  }`}
                                  onClick={() =>
                                    setLightbox({
                                      index: inlineIndex,
                                      photos: inlinePhotos,
                                    })
                                  }
                                  src={toLocalMediaUrl(
                                    photo.thumbnailPath ?? photo.path
                                  )}
                                />
                              </div>
                            );
                          })
                        : thumbs.slice(0, 5).map((thumb, thumbIndex) => (
                            <LazyThumb
                              className="h-12 w-12 cursor-zoom-in rounded-[4px]"
                              key={thumb}
                              onClick={() =>
                                void openLightboxAt(index, row, thumbIndex)
                              }
                              src={toLocalMediaUrl(thumb)}
                            />
                          ))}
                      {(row.photoIds?.length ?? 0) > 5 && (
                        <button
                          className="ml-1 shrink-0 rounded-[4px] border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                          onClick={() => void toggleExpand(index, row)}
                          type="button"
                        >
                          {isExpanded
                            ? t("characterDiscoveryCollapse")
                            : t("characterDiscoveryExpand")}
                        </button>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] text-foreground">
                        {row.tagName}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {t("characterSuggestionCount", { count: row.count })}
                        {typeof row.meanSimilarity === "number" && (
                          <span className="ml-2">
                            · 相似度 {row.meanSimilarity.toFixed(2)}
                          </span>
                        )}
                      </p>
                    </div>

                    <button
                      className="shrink-0 rounded-[6px] bg-primary px-3 py-1.5 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                      disabled={done || busy || applying !== null}
                      onClick={() => onApply(row, targetIds)}
                      type="button"
                    >
                      {done
                        ? t("characterSuggestionApplied")
                        : busy
                          ? t("peopleFindUnnamedCharactersBusy")
                          : t("characterSuggestionApply")}
                    </button>
                  </div>

                  {/* 展开区：整组图 + 左上角勾选圈（点圈勾选、点图看大图） */}
                  {isExpanded && (
                    <div className="border-border border-t pt-2">
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        {/* 说明文字 + 右侧三个按钮：与另两个对话框统一（2026-11-14 · 会话#12） */}
                        <span>{t("characterDiscoverySelectHint")}</span>
                        <span className="ml-auto text-foreground">
                          {t("characterSingleNamedSelected", {
                            count: chosen.size,
                            total: photos.length,
                          })}
                        </span>
                        <button
                          className="rounded-[3px] border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                          onClick={() => selectAll(index, photos)}
                          type="button"
                        >
                          {t("characterSingleNamedSelectAll")}
                        </button>
                        <button
                          className="rounded-[3px] border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                          onClick={() => invertSelection(index, photos)}
                          type="button"
                        >
                          {t("characterSingleNamedInvert")}
                        </button>
                        <button
                          className="rounded-[3px] border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                          onClick={() => clearSelection(index)}
                          type="button"
                        >
                          {t("characterSingleNamedSelectNone")}
                        </button>
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
                                <button
                                  aria-label={t("characterDiscoveryToggleSelect")}
                                  aria-pressed={isPicked}
                                  className={`absolute top-1 left-1 z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 transition-colors shadow-sm ${
                                    isPicked
                                      ? "border-primary bg-primary text-white"
                                      : "border-white/80 bg-black/35 hover:bg-black/60"
                                  }`}
                                  onClick={() =>
                                    toggleSelect(index, photo.id)
                                  }
                                  type="button"
                                >
                                  {isPicked && (
                                    <span className="text-[10px] leading-none">
                                      ✓
                                    </span>
                                  )}
                                </button>
                                <button
                                  className="block w-full"
                                  onClick={() =>
                                    setLightbox({ index: photoIndex, photos })
                                  }
                                  type="button"
                                >
                                  <LazyThumb
                                    className="aspect-square w-full rounded-[4px]"
                                    src={toLocalMediaUrl(
                                      photo.thumbnailPath ?? photo.path
                                    )}
                                  />
                                </button>
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
            className="rounded-[6px] border border-border bg-card px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-foreground/5"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            {t("close")}
          </button>
        </DialogFooter>

        {lightbox && (
          <PhotoLightbox
            initialIndex={lightbox.index}
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
