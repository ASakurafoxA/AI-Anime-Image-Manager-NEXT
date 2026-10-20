import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
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
  }, [rows]);

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
                      {thumbs.slice(0, 5).map((thumb) => (
                        <img
                          alt=""
                          className="h-12 w-12 rounded-[4px] object-cover"
                          decoding="async"
                          height={48}
                          key={thumb}
                          loading="lazy"
                          src={toLocalMediaUrl(thumb)}
                          width={48}
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
                          : chosen.size > 0
                            ? t("characterDiscoveryNameSelectedApply", {
                                count: chosen.size,
                              })
                            : t("characterSuggestionApply")}
                    </button>
                  </div>

                  {/* 展开区：整组图 + 左上角勾选圈（点圈勾选、点图看大图） */}
                  {isExpanded && (
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
                              onClick={() => clearSelection(index)}
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
                                  <img
                                    alt=""
                                    className="aspect-square w-full rounded-[4px] object-cover"
                                    decoding="async"
                                    loading="lazy"
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
