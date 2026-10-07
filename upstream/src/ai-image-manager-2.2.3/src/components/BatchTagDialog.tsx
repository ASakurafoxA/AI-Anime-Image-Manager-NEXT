import { Plus, Tag as TagIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SmoothInput } from "@/components/ui/smooth-input";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";

interface TagInfo {
  id: number;
  name: string;
}

interface BatchTagDialogProps {
  elevated?: boolean;
  onClose: () => void;
  open: boolean;
  photoIds: number[];
}

/**
 * 自用版新增：**批量打标签**对话框。
 *
 * 为什么需要：WD14 tagger 只认得出约 36% 的图，剩下的原创角色 / 冷门角色必须人工补。
 * 在 8 万张规模下逐个点开打标签不可行，所以配合「以图搜图」筛出疑似同一角色的图
 * → 全选 → 在这里一次打上标签。
 *
 * ⚠️ 标签总数可能上万（WD14 通用标签有 8,106 个），所以列表**必须限制渲染条数**，
 * 否则一次性渲染上万个节点会卡死界面。
 */
const MAX_RENDERED = 200;

export function BatchTagDialog({
  elevated = false,
  open,
  onClose,
  photoIds,
}: BatchTagDialogProps) {
  const { t } = useTranslation();
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState("");
  const [applying, setApplying] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const requestRef = useRef(0);

  const loadTags = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setLoadError(false);
    try {
      const result = await ipc.client.photos.getTags({});
      if (requestId !== requestRef.current) {
        return;
      }
      setTags((result as TagInfo[]) ?? []);
    } catch (err) {
      if (requestId !== requestRef.current) {
        return;
      }
      console.error("[BatchTagDialog loadTags] failed:", err);
      setLoadError(true);
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!open) {
      requestRef.current += 1;
      return;
    }
    loadTags();
    setFilter("");
    setApplying(null);
    setCreating(false);
    const frame = requestAnimationFrame(() => filterInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, loadTags]);

  const busy = creating || applying !== null;

  /** 统一的落库动作：可先建标签，再批量应用。 */
  const applyTag = useCallback(
    async (tagId: number, tagName: string) => {
      if (busy) {
        return;
      }
      setApplying(tagId);
      try {
        const result = (await ipc.client.photos.batchSetPhotoTag({
          ids: photoIds,
          tagId,
        })) as { applied?: number };
        queryClient.invalidateQueries({ queryKey: ["tags"] });
        queryClient.invalidateQueries({ queryKey: ["photos"] });
        queryClient.invalidateQueries({ queryKey: ["photo-tags"] });
        toast.success(
          t("toastBatchTagSuccess", {
            count: result?.applied ?? photoIds.length,
            tag: tagName,
          })
        );
        onClose();
      } catch (err) {
        console.error("[BatchTagDialog applyTag] failed:", err);
        toast.error(t("toastBatchTagFailed"));
      } finally {
        setApplying(null);
      }
    },
    [busy, onClose, photoIds, t]
  );

  const trimmed = filter.trim();
  const filtered = useMemo(() => {
    const query = trimmed.toLocaleLowerCase();
    if (!query) {
      return tags;
    }
    return tags.filter((tag) => tag.name.toLocaleLowerCase().includes(query));
  }, [tags, trimmed]);

  /** 输入的名字是否已经存在同名标签（存在就直接用它，不再新建）。 */
  const exactMatch = useMemo(
    () =>
      trimmed
        ? tags.find(
            (tag) => tag.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase()
          )
        : undefined,
    [tags, trimmed]
  );

  const hasMore = filtered.length > MAX_RENDERED;
  const visible = hasMore ? filtered.slice(0, MAX_RENDERED) : filtered;

  async function handleCreateAndApply() {
    if (!trimmed || busy) {
      return;
    }
    if (exactMatch) {
      await applyTag(exactMatch.id, exactMatch.name);
      return;
    }
    setCreating(true);
    try {
      const created = (await ipc.client.photos.addTag({
        name: trimmed,
      })) as TagInfo | undefined;
      if (!created?.id) {
        toast.error(t("toastBatchTagFailed"));
        return;
      }
      setCreating(false);
      await applyTag(created.id, created.name ?? trimmed);
    } catch (err) {
      console.error("[BatchTagDialog createAndApply] failed:", err);
      toast.error(t("toastBatchTagFailed"));
    } finally {
      setCreating(false);
    }
  }

  let listContent: React.ReactNode;
  if (loading) {
    listContent = (
      <div className="flex items-center justify-center gap-2 px-3 py-6 text-[13px] text-muted-foreground">
        <LoadingSpinner size="sm" />
        <span>{t("loading")}</span>
      </div>
    );
  } else if (loadError) {
    listContent = (
      <div className="flex flex-col items-center gap-3 px-3 py-6 text-center text-[13px] text-muted-foreground">
        <p>{t("loadFailedRetry")}</p>
        <button
          className="rounded-[6px] border border-border px-3 py-1.5 text-foreground transition-colors hover:bg-foreground/5"
          disabled={busy}
          onClick={loadTags}
          type="button"
        >
          {t("retry")}
        </button>
      </div>
    );
  } else if (tags.length === 0) {
    listContent = (
      <p className="px-3 py-6 text-center text-[13px] text-muted-foreground/70">
        {t("batchTagNoTags")}
      </p>
    );
  } else if (filtered.length === 0) {
    listContent = (
      <p className="px-3 py-6 text-center text-[13px] text-muted-foreground/70">
        {t("batchTagNoMatch")}
      </p>
    );
  } else {
    listContent = (
      <>
        {visible.map((tag) => (
          <button
            className="flex w-full items-center gap-3 rounded-[6px] px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-50"
            disabled={busy}
            key={tag.id}
            onClick={() => applyTag(tag.id, tag.name)}
            type="button"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] bg-white/5 text-muted-foreground">
              <TagIcon className="h-4 w-4" />
            </div>
            <span className="min-w-0 flex-1 truncate">{tag.name}</span>
            {applying === tag.id && <LoadingSpinner size="sm" />}
          </button>
        ))}
        {hasMore && (
          <p className="px-3 py-3 text-center text-[12px] text-muted-foreground/70">
            {t("batchTagTooMany", {
              shown: MAX_RENDERED,
              total: filtered.length,
            })}
          </p>
        )}
      </>
    );
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!(next || busy)) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent
        className={`max-h-[calc(100dvh-1rem)] overflow-y-auto overflow-x-hidden ${
          elevated ? "z-[1101]" : ""
        }`}
        onPointerDownOutside={(event) => {
          if (busy) {
            event.preventDefault();
          }
        }}
        overlayClassName={elevated ? "z-[1100]" : undefined}
        showCloseButton={!busy}
        size="sm"
      >
        <DialogHeader>
          <DialogTitle>{t("batchTagTitle")}</DialogTitle>
          <DialogDescription>
            {t("batchTagDescription", { count: photoIds.length })}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0">
          <SmoothInput
            aria-label={t("batchTagFilterLabel")}
            className="h-8 rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
            onChange={(event) => setFilter(event.target.value)}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              setFilter((event.target as HTMLInputElement).value);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onKeyDown={(event) => {
              if (composingRef.current || event.nativeEvent.isComposing) {
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                handleCreateAndApply();
                return;
              }
              if (event.key === "Escape" && filter.length > 0) {
                event.preventDefault();
                event.stopPropagation();
                setFilter("");
              }
            }}
            placeholder={t("batchTagFilterPlaceholder")}
            ref={filterInputRef}
            type="text"
            value={filter}
            wrapperClassName="w-full min-w-0"
          />
        </div>

        <div className="-mx-1 max-h-[min(18.75rem,50dvh)] overflow-y-auto overscroll-contain">
          {listContent}

          {trimmed.length > 0 && (
            <button
              className="flex w-full items-center gap-2 rounded-[6px] px-3 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
              disabled={busy}
              onClick={handleCreateAndApply}
              type="button"
            >
              {creating ? (
                <LoadingSpinner size="sm" />
              ) : (
                <Plus className="h-4 w-4 shrink-0" />
              )}
              <span className="min-w-0 truncate">
                {exactMatch
                  ? t("batchTagUseExisting", { name: exactMatch.name })
                  : t("batchTagCreateAndApply", { name: trimmed })}
              </span>
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
