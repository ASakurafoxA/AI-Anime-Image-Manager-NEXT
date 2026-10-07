// biome-ignore-all lint/a11y/useFocusableInteractive: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/style/useCollapsedElseIf: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/suspicious/useAwait: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/style/useDefaultSwitchClause: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noStaticElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/useSemanticElements: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/style/noNestedTernary: scoped component lint cleanup preserves existing UI behavior

import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  Album,
  CircleHelp,
  Folder,
  Images,
  LayoutDashboard,
  Paintbrush,
  FolderLock,
  EyeOff,
  Palette,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  ScanSearch,
  Search,
  Settings,
  Star,
  Swords,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getUpdateStatus } from "@/actions/update";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PRIVATE_BUILD } from "@/config/private-build";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SmoothInput } from "@/components/ui/smooth-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAiStatus } from "@/hooks/useAiStatus";
import { ipc } from "@/ipc/manager";
import { getTagDisplayName } from "@/localization/tag-display";
import { queryClient } from "@/providers/QueryProvider";
import type { Folder as FolderType } from "@/types/photo";
import { FolderAppearanceDialog } from "./FolderAppearanceDialog";
import { FolderBadge } from "./FolderBadge";
import {
  buildFolderTree,
  buildTagTree,
  FolderTree,
  type FolderTreeNode,
  pinFolderTreeNodes,
  renderTagTree,
  type TagInfo,
} from "./sidebar-trees";

const RESOURCE_PANEL_DEFAULT_WIDTH = 240;
const RESOURCE_PANEL_MIN_WIDTH = 192;
const RESOURCE_PANEL_MAX_WIDTH = 320;
const RESOURCE_PANEL_WIDTH_KEY = "sidebar-resource-panel-width";
const PINNED_FOLDER_IDS_KEY = "sidebar-pinned-folder-ids";
const RECENT_FOLDER_IDS_KEY = "sidebar-recent-folder-ids";
const MAX_PINNED_FOLDERS = 5;
const MAX_RECENT_FOLDERS = 3;

function loadFolderIds(key: string, limit: number): number[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(stored)) {
      return [];
    }
    return [
      ...new Set(
        stored.filter(
          (id): id is number => Number.isInteger(id) && Number(id) > 0
        )
      ),
    ].slice(0, limit);
  } catch {
    return [];
  }
}

function saveFolderIds(key: string, ids: number[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Keep the in-memory preference when storage is unavailable.
  }
}

function loadResourcePanelWidth() {
  try {
    const storedValue = localStorage.getItem(RESOURCE_PANEL_WIDTH_KEY);
    if (storedValue !== null) {
      const stored = Number(storedValue);
      if (Number.isFinite(stored)) {
        return Math.min(
          RESOURCE_PANEL_MAX_WIDTH,
          Math.max(RESOURCE_PANEL_MIN_WIDTH, stored)
        );
      }
    }
  } catch {
    // Use the default width when storage is unavailable.
  }
  return RESOURCE_PANEL_DEFAULT_WIDTH;
}

function SidebarTooltip({
  children,
  content,
}: {
  children: React.ReactElement;
  content: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{content}</TooltipContent>
    </Tooltip>
  );
}

function RailButton({
  active = false,
  badge = false,
  icon,
  label,
  onClick,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
}: {
  active?: boolean;
  badge?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  onDragEnter?: React.DragEventHandler<HTMLButtonElement>;
  onDragLeave?: React.DragEventHandler<HTMLButtonElement>;
  onDragOver?: React.DragEventHandler<HTMLButtonElement>;
  onDrop?: React.DragEventHandler<HTMLButtonElement>;
}) {
  return (
    <SidebarTooltip content={label}>
      <button
        aria-label={label}
        className={`relative flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors ${
          active
            ? "nav-item-active text-primary"
            : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        }`}
        onClick={onClick}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        type="button"
      >
        {icon}
        {badge && (
          <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-destructive ring-2 ring-sidebar" />
        )}
      </button>
    </SidebarTooltip>
  );
}

function FolderShortcutRow({
  folder,
  isActive = false,
  onSelect,
  onContextMenu,
  onUnpin,
  unpinLabel,
}: {
  folder: FolderType;
  isActive?: boolean;
  onSelect: () => void;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  onUnpin?: () => void;
  unpinLabel: string;
}) {
  return (
    <div
      className="group flex min-w-0 items-center rounded-[6px] hover:bg-foreground/5"
      onContextMenu={onContextMenu}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-current={isActive ? "page" : undefined}
            aria-label={`${folder.displayName} (${folder.totalPhotoCount ?? folder.photoCount})`}
            className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left ${
              isActive
                ? "nav-item-active bg-primary/15 text-primary"
                : "text-foreground"
            }`}
            data-folder-shortcut-id={folder.id}
            onClick={onSelect}
            type="button"
          >
            <FolderBadge className="h-6 w-6" folder={folder} />
            <span className="min-w-0 flex-1">
              <span
                className={`block truncate font-medium text-[12px] ${
                  isActive ? "text-primary" : "text-foreground"
                }`}
              >
                {folder.displayName}
              </span>
              <span className="block truncate text-[10px] text-muted-foreground/65">
                {folder.path}
              </span>
            </span>
            <span className="flex-shrink-0 text-[10px] text-muted-foreground/60">
              {(folder.totalPhotoCount ?? folder.photoCount).toLocaleString()}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{folder.path}</TooltipContent>
      </Tooltip>
      {onUnpin && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={`${unpinLabel}: ${folder.displayName}`}
              className="mr-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[5px] text-muted-foreground/60 opacity-0 transition-opacity hover:bg-foreground/8 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
              onClick={onUnpin}
              type="button"
            >
              <PinOff className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{unpinLabel}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

interface SidebarProps {
  activeFolderId: number | null;
  activeTagIds: number[];
  collapsed: boolean;
  favoriteActive?: boolean;
  folders: FolderType[];
  onAddFolder: (externalPath?: string) => void;
  onDeleteFolder: (id: number, displayName: string) => void;
  onSelectAllPhotos: () => void;
  onSelectFavorites?: () => void;
  onSelectFolder: (id: number | null) => void;
  onToggleCollapse: () => void;
  onToggleTag?: (tagId: number | null) => void;
  onToggleTagMode?: () => void;
  tagMode: "and" | "or";
  totalPhotos: number;
}

export function Sidebar({
  folders,
  activeFolderId,
  activeTagIds,
  tagMode,
  collapsed,
  favoriteActive,
  onSelectFolder,
  onSelectFavorites,
  onAddFolder,
  onDeleteFolder,
  onSelectAllPhotos,
  onToggleTag,
  onToggleTagMode,
  onToggleCollapse,
  totalPhotos,
}: SidebarProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [folderCtx, setFolderCtx] = useState<{
    folderId: number;
    displayName: string;
    x: number;
    y: number;
  } | null>(null);
  // 自用精简版：文件夹黑名单（视图级过滤，不取消索引）状态
  const [hiddenFolders, setHiddenFolders] = useState<{
    paths: string[];
    resolvedFolderIds: number[];
  }>({ paths: [], resolvedFolderIds: [] });
  // 自用版：标签黑名单。只影响侧边栏显示 —— 不删标签、不删 photo_tags，
  // 标签依然可以被搜索到；被加入的标签会从标签树移到侧边栏底部的独立区域。
  const [hiddenTags, setHiddenTags] = useState<
    { id: number; name: string; parentId: number | null }[]
  >([]);
  const [appearanceFolderId, setAppearanceFolderId] = useState<number | null>(
    null
  );
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [folderSearch, setFolderSearch] = useState("");
  const folderSearchRef = useRef<HTMLInputElement>(null);
  const pendingFolderSearchFocusRef = useRef(false);
  const hasLoadedFoldersRef = useRef(false);
  const [folderShortcutsOpen, setFolderShortcutsOpen] = useState(false);
  const [pinnedFolderIds, setPinnedFolderIds] = useState<number[]>(() =>
    loadFolderIds(PINNED_FOLDER_IDS_KEY, MAX_PINNED_FOLDERS)
  );
  const [pinnedFoldersCollapsed, setPinnedFoldersCollapsed] = useState(false);
  const [recentFolderIds, setRecentFolderIds] = useState<number[]>(() =>
    loadFolderIds(RECENT_FOLDER_IDS_KEY, MAX_RECENT_FOLDERS)
  );
  const [tagSearch, setTagSearch] = useState("");
  const [debouncedTagSearch, setDebouncedTagSearch] = useState("");
  const [trashCount, setTrashCount] = useState(0);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([ipc.client.settings.getAppPreferences({}), getUpdateStatus()])
      .then(([preferences, status]) => {
        if (active) {
          setUpdateAvailable(
            preferences.updateReminder && status.phase === "downloaded"
          );
        }
      })
      .catch(() => undefined);

    function handleUpdate(event: MessageEvent) {
      if (event.data?.channel === "update:available") {
        setUpdateAvailable(true);
        return;
      }
      if (
        event.data?.channel === "update:status" &&
        event.data.phase === "downloaded"
      ) {
        ipc.client.settings
          .getAppPreferences({})
          .then((preferences) => setUpdateAvailable(preferences.updateReminder))
          .catch(() => undefined);
        return;
      }
      if (
        event.data?.channel === "update:status" &&
        ["installing", "recovering", "restarting"].includes(event.data.phase)
      ) {
        setUpdateAvailable(false);
      }
    }
    function handleReminder(event: Event) {
      const enabled = (event as CustomEvent<boolean>).detail === true;
      if (!enabled) {
        setUpdateAvailable(false);
        return;
      }
      getUpdateStatus()
        .then((status) => setUpdateAvailable(status.phase === "downloaded"))
        .catch(() => undefined);
    }
    window.addEventListener("message", handleUpdate);
    window.addEventListener("update-reminder-changed", handleReminder);
    return () => {
      active = false;
      window.removeEventListener("message", handleUpdate);
      window.removeEventListener("update-reminder-changed", handleReminder);
    };
  }, []);

  useEffect(() => {
    const listDeletedPhotos = ipc.client.photos.listDeletedPhotos;
    if (typeof listDeletedPhotos === "function") {
      listDeletedPhotos({
        cursor: null,
        limit: 1,
        order: "desc",
        query: "",
        sort: "deletedAt",
      })
        .then((result) =>
          setTrashCount(result.trashTotalCount ?? result.totalCount)
        )
        .catch(() => undefined);
    }

    function handleTrashCount(event: Event) {
      setTrashCount((event as CustomEvent<number>).detail);
    }
    window.addEventListener("trash-count-changed", handleTrashCount);
    return () =>
      window.removeEventListener("trash-count-changed", handleTrashCount);
  }, []);
  const ctxRef = useRef<HTMLDivElement>(null);
  const [dragOverTagId, setDragOverTagId] = useState<number | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<number | null>(null);
  const [dragOverAlbumNav, setDragOverAlbumNav] = useState(false);
  const [resourcePanelWidth, setResourcePanelWidth] = useState(
    loadResourcePanelWidth
  );
  const [resourceView, setResourceView] = useState<"folders" | "tags">(
    "folders"
  );
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<number>>(
    new Set()
  );
  const [expandedTagIds, setExpandedTagIds] = useState<Set<number>>(new Set());
  const [deleteTagTarget, setDeleteTagTarget] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [tagCtx, setTagCtx] = useState<{
    tagId: number;
    tagName: string;
    x: number;
    y: number;
  } | null>(null);
  const [childTagParent, setChildTagParent] = useState<{
    parentId: number;
    parentName: string;
  } | null>(null);
  const [newChildTagName, setNewChildTagName] = useState("");
  const childInputRef = useRef<HTMLInputElement>(null);
  const childComposingRef = useRef(false);
  // 自用版：重命名标签（WD14 角色标签没有中文来源，需要手动改）
  const [renameTagTarget, setRenameTagTarget] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [renameTagName, setRenameTagName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameComposingRef = useRef(false);
  // 自用版：自定义标签小点颜色（支持十六进制与 RGB）
  const [tagColorTarget, setTagColorTarget] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [tagColorHex, setTagColorHex] = useState("#f97316");
  const [tagColorInput, setTagColorInput] = useState("#f97316");
  const tagTreeScrollRef = useRef<HTMLDivElement>(null);
  const [tagTreeHasMoreBelow, setTagTreeHasMoreBelow] = useState(false);
  const [_tagPopoverOpen, _setTagPopoverOpen] = useState(false);
  const [batchTagLoading, setBatchTagLoading] = useState(false);
  const { data: aiStatus } = useAiStatus();
  const aiTagging = aiStatus?.embeddingProgress.phase === "tagging";
  const aiTagPipelineActive = Boolean(
    batchTagLoading || aiTagging || aiStatus?.isEmbedding
  );

  const updatePinnedFolderIds = useCallback((next: number[]) => {
    const normalized = [...new Set(next)].slice(0, MAX_PINNED_FOLDERS);
    setPinnedFolderIds(normalized);
    saveFolderIds(PINNED_FOLDER_IDS_KEY, normalized);
  }, []);

  const togglePinnedFolder = useCallback(
    (folderId: number) => {
      if (pinnedFolderIds.includes(folderId)) {
        updatePinnedFolderIds(pinnedFolderIds.filter((id) => id !== folderId));
        return true;
      }
      if (pinnedFolderIds.length >= MAX_PINNED_FOLDERS) {
        toast.error(t("folderPinLimit", { count: MAX_PINNED_FOLDERS }));
        return false;
      }
      updatePinnedFolderIds([...pinnedFolderIds, folderId]);
      return true;
    },
    [pinnedFolderIds, t, updatePinnedFolderIds]
  );

  useEffect(() => {
    if (activeFolderId === null) {
      return;
    }
    setRecentFolderIds((previous) => {
      const next = [
        activeFolderId,
        ...previous.filter((id) => id !== activeFolderId),
      ].slice(0, MAX_RECENT_FOLDERS);
      saveFolderIds(RECENT_FOLDER_IDS_KEY, next);
      return next;
    });
  }, [activeFolderId]);

  useEffect(() => {
    if (folders.length > 0) {
      hasLoadedFoldersRef.current = true;
    } else if (!hasLoadedFoldersRef.current) {
      return;
    }
    const validIds = new Set(folders.map((folder) => folder.id));
    setPinnedFolderIds((previous) => {
      const next = previous.filter((id) => validIds.has(id));
      if (next.length !== previous.length) {
        saveFolderIds(PINNED_FOLDER_IDS_KEY, next);
        return next;
      }
      return previous;
    });
    setRecentFolderIds((previous) => {
      const next = previous.filter((id) => validIds.has(id));
      if (next.length !== previous.length) {
        saveFolderIds(RECENT_FOLDER_IDS_KEY, next);
        return next;
      }
      return previous;
    });
  }, [folders]);

  useEffect(() => {
    if (
      collapsed ||
      resourceView !== "folders" ||
      !pendingFolderSearchFocusRef.current
    ) {
      return;
    }
    pendingFolderSearchFocusRef.current = false;
    requestAnimationFrame(() => folderSearchRef.current?.focus());
  }, [collapsed, resourceView]);
  let aiTagStatusText = t("tagWaitingForIndex");
  if (batchTagLoading && !aiTagging) {
    aiTagStatusText = t("tagUpdating");
  } else if (aiTagging) {
    aiTagStatusText = t("tagGeneratingProgress", {
      processed: aiStatus?.embeddingProgress.processed ?? 0,
      total: aiStatus?.embeddingProgress.total ?? 0,
    });
  }

  async function handleBatchGenerateTags() {
    if (batchTagLoading || aiTagPipelineActive) {
      return;
    }
    setBatchTagLoading(true);
    try {
      const result = (await ipc.client.photos.batchGenerateTags({})) as {
        busy?: boolean;
        total?: number;
      };
      if (result.busy) {
        return;
      }
      if (result.total === 0) {
        toast.info(t("aiTagsNoPhotos"));
        return;
      }
      const updated = await ipc.client.photos.getTags({
        folderId: activeFolderId ?? undefined,
      });
      setTags((updated as TagInfo[]) || []);
      toast.success(t("aiTagsGenerated"));
    } catch {
      toast.error(t("aiTagsFailed"));
    } finally {
      setBatchTagLoading(false);
    }
  }

  // Debounce tag search to avoid rebuilding the tree on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTagSearch(tagSearch), 150);
    return () => clearTimeout(timer);
  }, [tagSearch]);

  // Auto-expand parent nodes during tag search so matching children are visible
  const preSearchExpandedRef = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (debouncedTagSearch) {
      // Save current expand state before modifying it (only on first keystroke)
      if (preSearchExpandedRef.current === null) {
        preSearchExpandedRef.current = new Set(expandedTagIds);
      }
      // Find all ancestors of matching tags and auto-expand them.
      // 自用改动：与标签树保持一致，只统计"有照片"的标签 ——
      // 否则 WD14 的一万多个标签里任意常见子串都会命中几千个，
      // 导致所有类型节点被一次性展开、界面卡死。
      const hiddenTagIdSet = expandHiddenTagIdSet();
      const matchingIds = new Set(
        tags
          .filter(
            (t) =>
              t.photoCount > 0 &&
              !hiddenTagIdSet.has(t.id) &&
              t.name.toLowerCase().includes(debouncedTagSearch.toLowerCase())
          )
          .map((t) => t.id)
      );
      const tagMap = new Map(tags.map((t) => [t.id, t]));
      const ancestorsToExpand = new Set<number>();
      for (const id of matchingIds) {
        let cur = tagMap.get(id)?.parentId ?? null;
        while (cur) {
          if (ancestorsToExpand.has(cur)) {
            break;
          }
          ancestorsToExpand.add(cur);
          cur = tagMap.get(cur)?.parentId ?? null;
        }
      }
      if (ancestorsToExpand.size > 0) {
        setExpandedTagIds((prev) => {
          const next = new Set(prev);
          for (const id of ancestorsToExpand) {
            next.add(id);
          }
          return next;
        });
      }
    } else {
      // Search cleared — restore previous expand state
      if (preSearchExpandedRef.current !== null) {
        setExpandedTagIds(preSearchExpandedRef.current);
        preSearchExpandedRef.current = null;
      }
    }
  }, [debouncedTagSearch, tags, expandedTagIds, hiddenTags]);

  // Drag-and-drop: keep application photo organization targets local to the sidebar
  function handleSidebarDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes("application/x-photo-ids")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  }

  function handleFolderDragOver(e: React.DragEvent, folderId: number) {
    if (e.dataTransfer.types.includes("application/x-photo-ids")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverFolderId(folderId);
    }
  }

  function handleFolderDragLeave() {
    setDragOverFolderId(null);
  }

  async function handleFolderDrop(e: React.DragEvent, folderId: number) {
    setDragOverFolderId(null);
    const raw = e.dataTransfer.getData("application/x-photo-ids");
    if (!raw) {
      return;
    }
    const ids: number[] = JSON.parse(raw);
    if (ids.length === 0) {
      return;
    }
    try {
      const result = (await ipc.client.photos.movePhotos({
        ids,
        targetFolderId: folderId,
      })) as { moved: number };
      if (result.moved > 0) {
        toast.success(t("photosMoved", { count: result.moved }));
        queryClient.invalidateQueries({
          queryKey: ["photos"],
          refetchType: "active",
        });
        queryClient.invalidateQueries({ queryKey: ["folders"] });
      }
    } catch {
      toast.error(t("movePhotosFailed"));
    }
  }

  async function handleDropOnTag(e: React.DragEvent, tagId: number) {
    setDragOverTagId(null);
    const raw = e.dataTransfer.getData("application/x-photo-ids");
    if (!raw) {
      return;
    }
    const ids: number[] = JSON.parse(raw);
    const tag = tags.find((t) => t.id === tagId);
    let failed = 0;
    for (const photoId of ids) {
      try {
        await ipc.client.photos.setPhotoTag({ photoId, tagId });
      } catch (err) {
        console.error("[handleDropOnTag] failed to add tag to photo:", err);
        failed++;
      }
    }
    queryClient.invalidateQueries({
      queryKey: ["photos"],
      refetchType: "active",
    });
    // Refresh tag counts
    try {
      const updated = await ipc.client.photos.getTags({
        folderId: activeFolderId ?? undefined,
      });
      setTags((updated as TagInfo[]) || []);
    } catch (err) {
      console.error("[handleDropOnTag] failed to refresh tags:", err);
    }
    const displayName = tag?.name
      ? getTagDisplayName(tag.name, i18n.language)
      : "";
    if (failed > 0) {
      toast.success(
        t("tagAddedToPhotos", {
          count: ids.length - failed,
          name: displayName,
        })
      );
    } else {
      toast.success(
        t("tagAddedToPhotos", { count: ids.length, name: displayName })
      );
    }
  }

  async function handleDropOnAlbumNav(e: React.DragEvent) {
    setDragOverAlbumNav(false);
    const raw = e.dataTransfer.getData("application/x-photo-ids");
    if (!raw) {
      return;
    }
    const ids: number[] = JSON.parse(raw);
    // Open AddToAlbumDialog — for now navigate to albums page as fallback
    // Dispatch a custom event so the parent can intercept it
    window.dispatchEvent(
      new CustomEvent("photo-drop:album", { detail: { photoIds: ids } })
    );
  }

  useEffect(() => {
    let running = true;
    let interval: ReturnType<typeof setInterval> | null = null;

    async function loadTags() {
      try {
        const result = await ipc.client.photos.getTags({
          folderId: activeFolderId ?? undefined,
        });
        if (!running) {
          return;
        }
        const tagList = (result as TagInfo[]) || [];
        setTags(tagList);
        // Clear active tags that are no longer in the filtered list
        if (
          activeTagIds.length > 0 &&
          activeTagIds.some((id) => !tagList.some((t) => t.id === id))
        ) {
          for (const id of activeTagIds) {
            if (!tagList.some((t) => t.id === id)) {
              onToggleTag?.(id);
            }
          }
        }
        // Stop polling once tags appear
        if (tagList.length > 0 && interval) {
          clearInterval(interval);
          interval = null;
        }
      } catch (err) {
        console.error("[Sidebar loadTags] failed:", err);
      }
    }

    loadTags();
    // Poll for tags if photos exist but tags haven't loaded yet
    if (totalPhotos > 0) {
      interval = setInterval(loadTags, 5000);
    }

    return () => {
      running = false;
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [totalPhotos, activeFolderId, activeTagIds, onToggleTag]);

  useEffect(() => {
    function handler(event: MessageEvent) {
      if (
        event.data?.channel === "ai-embedding-done" ||
        event.data?.channel === "ai-tags-done"
      ) {
        queryClient.invalidateQueries({ queryKey: ["aiStatus"] });
        ipc.client.photos
          .getTags({ folderId: activeFolderId ?? undefined })
          .then((updated) => setTags((updated as TagInfo[]) || []))
          .catch(() => {
            /* ignore */
          });
      }
    }
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [activeFolderId]);

  // Listen for tag changes from other components (e.g. PhotoDetailPanel)
  useEffect(() => {
    function handleTagsChanged() {
      ipc.client.photos
        .getTags({
          folderId: activeFolderId ?? undefined,
        })
        .then((updated) => {
          setTags((updated as TagInfo[]) || []);
        })
        .catch(() => {
          /* ignore */
        });
    }
    window.addEventListener("tags-changed", handleTagsChanged);
    return () => window.removeEventListener("tags-changed", handleTagsChanged);
  }, [activeFolderId]);

  const closeCtx = useCallback(() => setFolderCtx(null), []);

  // Keyboard navigation handler for tag tree
  function handleTagTreeKeyDown(
    e: React.KeyboardEvent,
    expandedIds: Set<number>,
    setExpandedIds: (next: Set<number>) => void,
    onTagToggle: ((tagId: number | null) => void) | undefined,
    setSearch: (v: string) => void,
    setDebouncedSearch: (v: string) => void
  ) {
    const currentFocus = document.activeElement as HTMLElement;
    const treeContainer = e.currentTarget as HTMLElement;
    const allItems = Array.from(
      treeContainer.querySelectorAll('[role="treeitem"]')
    ) as HTMLElement[];
    if (allItems.length === 0) {
      return;
    }

    let currentIndex = allItems.indexOf(currentFocus);
    // If focus is not on any treeitem (e.g. on the search input),
    // default to the first visible item
    if (currentIndex === -1) {
      currentIndex = 0;
    }

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const next = allItems[Math.min(currentIndex + 1, allItems.length - 1)];
        if (next) {
          for (const item of allItems) {
            item.setAttribute("tabindex", "-1");
          }
          next.setAttribute("tabindex", "0");
          next.focus();
        }
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prev = allItems[Math.max(currentIndex - 1, 0)];
        if (prev) {
          for (const item of allItems) {
            item.setAttribute("tabindex", "-1");
          }
          prev.setAttribute("tabindex", "0");
          prev.focus();
        }
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        const currentId = Number(currentFocus?.getAttribute("data-tag-id"));
        if (currentId && !expandedIds.has(currentId)) {
          const tag = tags.find((t) => t.id === currentId);
          if (tag && tags.some((t) => t.parentId === currentId)) {
            const next = new Set(expandedIds);
            next.add(currentId);
            setExpandedIds(next);
          }
        }
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const curId = Number(currentFocus?.getAttribute("data-tag-id"));
        if (curId && expandedIds.has(curId)) {
          const nxt = new Set(expandedIds);
          nxt.delete(curId);
          setExpandedIds(nxt);
        }
        break;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        const id = Number(currentFocus?.getAttribute("data-tag-id"));
        if (id && !Number.isNaN(id)) {
          onTagToggle?.(id);
        }
        break;
      }
      case "Escape": {
        e.preventDefault();
        setSearch("");
        setDebouncedSearch("");
        treeContainer.focus();
        break;
      }
      case "/":
      case "f": {
        // Ctrl+F or / key: focus search input
        if (e.key === "f" && !e.ctrlKey && !e.metaKey) {
          break;
        }
        e.preventDefault();
        const input = treeContainer
          .closest(".flex.flex-col, .p-1\\.5")
          ?.querySelector('input[role="searchbox"]') as HTMLInputElement | null;
        input?.focus();
        input?.select();
        break;
      }
    }
  }

  async function handleCreateChildTag() {
    const name = newChildTagName.trim();
    if (!(name && childTagParent)) {
      return;
    }
    const { parentId, parentName } = childTagParent;
    setChildTagParent(null);
    setNewChildTagName("");
    try {
      await ipc.client.photos.addTag({
        name,
        color: undefined,
        parentId,
      });
      window.dispatchEvent(new CustomEvent("tags-changed"));
      const updated = await ipc.client.photos.getTags({
        folderId: activeFolderId ?? undefined,
      });
      setTags((updated as TagInfo[]) || []);
      // Auto-expand parent
      setExpandedTagIds((prev) => new Set(prev).add(parentId));
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      toast.success(t("childTagCreated", { name, parent: parentName }));
    } catch {
      toast.error(t("createChildTagFailed"));
    }
  }

  /**
   * 自用版：重命名标签 —— **只改中文显示名，英文标识保持不动**。
   *
   * 为什么这样设计：标签的英文名是它的"身份"，打标逻辑与检索都靠它。
   * 所以落库格式永远是 `中文 (english)`：
   *  - 输入框里**只显示/编辑中文部分**（不显示括号与英文，避免误删）
   *  - 保存时自动把英文标识拼回括号里
   *  - 留空则去掉中文名，退回纯英文
   * 于是无论中文名怎么改，标签身份都不变，中文和英文都能搜到。
   */
  function splitTagName(stored: string): { chinese: string; english: string } {
    const matched = /^(.+?) \(([^()]+)\)$/.exec(stored);
    return matched
      ? { chinese: matched[1], english: matched[2] }
      : { chinese: "", english: stored };
  }

  async function handleRenameTag() {
    const target = renameTagTarget;
    if (!target) {
      return;
    }
    const name = renameTagName.trim();
    const { english } = splitTagName(target.name);
    const finalName = name ? `${name} (${english})` : english;
    if (finalName === target.name) {
      setRenameTagTarget(null);
      setRenameTagName("");
      return;
    }
    try {
      await ipc.client.photos.renameTag({ id: target.id, name: finalName });
      window.dispatchEvent(new CustomEvent("tags-changed"));
      const updated = await ipc.client.photos.getTags({
        folderId: activeFolderId ?? undefined,
      });
      setTags((updated as TagInfo[]) || []);
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      toast.success(t("tagRenamed", { name: finalName }));
      setRenameTagTarget(null);
      setRenameTagName("");
    } catch {
      // 同名冲突等：保持对话框打开，让用户改个名字
      toast.error(t("tagRenameFailed"));
    }
  }

  /* ── 自用版：标签小点颜色 ────────────────────────────────── */

  /** 把 `#RGB` / `rgb(r,g,b)` / `#RRGGBB` 统一成 `#rrggbb`；无法解析返回 null。 */
  function normalizeColor(input: string): string | null {
    const value = input.trim();
    const rgbMatch =
      /^rgba?\(\s*(-?\d{1,3})\s*[,\s]\s*(-?\d{1,3})\s*[,\s]\s*(-?\d{1,3})/i.exec(
        value
      );
    if (rgbMatch) {
      return rgbToHex(
        Number(rgbMatch[1]),
        Number(rgbMatch[2]),
        Number(rgbMatch[3])
      );
    }
    const shortHex = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
    if (shortHex) {
      return `#${shortHex[1]}${shortHex[1]}${shortHex[2]}${shortHex[2]}${shortHex[3]}${shortHex[3]}`.toLowerCase();
    }
    const fullHex = /^#?([0-9a-f]{6})$/i.exec(value);
    return fullHex ? `#${fullHex[1].toLowerCase()}` : null;
  }

  function hexToRgb(hex: string): { b: number; g: number; r: number } {
    const parsed = normalizeColor(hex);
    if (!parsed) {
      return { b: 0, g: 0, r: 0 };
    }
    const value = Number.parseInt(parsed.slice(1), 16);
    return { b: value & 255, g: (value >> 8) & 255, r: (value >> 16) & 255 };
  }

  function rgbToHex(r: number, g: number, b: number): string {
    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    return `#${[r, g, b]
      .map((v) => clamp(v).toString(16).padStart(2, "0"))
      .join("")}`;
  }

  function openTagColorPicker(id: number, name: string, current: string | null) {
    setTagColorTarget({ id, name });
    setTagColorHex(current ?? "#f97316");
    setTagColorInput(current ?? "#f97316");
  }

  async function applyTagColor(color: string | null) {
    const target = tagColorTarget;
    if (!target) {
      return;
    }
    try {
      await ipc.client.photos.setTagColor({ id: target.id, color });
      window.dispatchEvent(new CustomEvent("tags-changed"));
      const updated = await ipc.client.photos.getTags({
        folderId: activeFolderId ?? undefined,
      });
      setTags((updated as TagInfo[]) || []);
      toast.success(t("tagColorSaved"));
      setTagColorTarget(null);
    } catch {
      toast.error(t("tagColorFailed"));
    }
  }

  async function handleDeleteTag() {
    if (!deleteTagTarget) {
      return;
    }
    const { id, name } = deleteTagTarget;
    setDeleteTagTarget(null);
    try {
      await ipc.client.photos.deleteTag({ id });
      window.dispatchEvent(new CustomEvent("tags-changed"));
      const updated = await ipc.client.photos.getTags({
        folderId: activeFolderId ?? undefined,
      });
      setTags((updated as TagInfo[]) || []);
      if (activeTagIds.includes(id)) {
        onToggleTag?.(id);
      }
      toast.success(t("tagDeleted", { name }));
    } catch {
      toast.error(t("deleteTagFailed"));
    }
  }

  useEffect(() => {
    if (!(folderCtx || tagCtx)) {
      return;
    }
    function handleClick(e: MouseEvent) {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        closeCtx();
        setTagCtx(null);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeCtx();
        setTagCtx(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [folderCtx, tagCtx, closeCtx]);

  // Global keyboard shortcut: [ toggles sidebar collapse
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "[" && !e.ctrlKey && !e.metaKey) {
      if (PRIVATE_BUILD.slimWindowShortcuts) {
        return;
      }
        const target = e.target as HTMLElement;
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        onToggleCollapse();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onToggleCollapse]);

  const folderById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders]
  );
  const validPinnedFolderIds = useMemo(
    () => pinnedFolderIds.filter((id) => folderById.has(id)),
    [folderById, pinnedFolderIds]
  );
  const folderTree = useMemo(
    () => pinFolderTreeNodes(buildFolderTree(folders), validPinnedFolderIds),
    [folders, validPinnedFolderIds]
  );
  const folderSearchResult = useMemo(() => {
    const query = folderSearch.trim().toLocaleLowerCase();
    if (!query) {
      return { ancestorIds: new Set<number>(), nodes: folderTree };
    }

    const ancestorIds = new Set<number>();
    const filterNodes = (nodes: FolderTreeNode[]): FolderTreeNode[] =>
      nodes.flatMap((node) => {
        const children = filterNodes(node.children);
        const matches = node.folder.displayName
          .toLocaleLowerCase()
          .includes(query);
        if (!(matches || children.length > 0)) {
          return [];
        }
        if (children.length > 0) {
          ancestorIds.add(node.folder.id);
        }
        return [{ ...node, children }];
      });

    return { ancestorIds, nodes: filterNodes(folderTree) };
  }, [folderSearch, folderTree]);
  const visibleExpandedFolderIds = useMemo(() => {
    if (!folderSearch.trim()) {
      return expandedFolderIds;
    }
    return new Set([...expandedFolderIds, ...folderSearchResult.ancestorIds]);
  }, [expandedFolderIds, folderSearch, folderSearchResult.ancestorIds]);
  const appearanceFolder =
    folders.find((folder) => folder.id === appearanceFolderId) ?? null;
  const activeShortcutFolder =
    activeFolderId === null ? null : (folderById.get(activeFolderId) ?? null);
  const pinnedShortcutFolders = pinnedFolderIds
    .filter((id) => id !== activeFolderId)
    .map((id) => folderById.get(id))
    .filter((folder): folder is FolderType => folder !== undefined);
  const shortcutIds = new Set([
    ...(activeFolderId === null ? [] : [activeFolderId]),
    ...pinnedFolderIds,
  ]);
  const recentShortcutFolders = recentFolderIds
    .filter((id) => !shortcutIds.has(id))
    .map((id) => folderById.get(id))
    .filter((folder): folder is FolderType => folder !== undefined);
  const hasFolderShortcuts = Boolean(
    activeShortcutFolder ||
      pinnedShortcutFolders.length > 0 ||
      recentShortcutFolders.length > 0
  );

  const selectShortcutFolder = useCallback(
    (folderId: number) => {
      onSelectFolder(folderId);
      setFolderShortcutsOpen(false);
    },
    [onSelectFolder]
  );

  const showAllFolders = useCallback(() => {
    setFolderShortcutsOpen(false);
    setResourceView("folders");
    pendingFolderSearchFocusRef.current = true;
    if (collapsed) {
      onToggleCollapse();
    }
  }, [collapsed, onToggleCollapse]);
  // Auto-expand each root parent once without overwriting the user's choices.
  const autoExpandedFolderIdsRef = useRef(new Set<number>());
  useEffect(() => {
    const newRootParents = folderTree
      .filter(
        (node) =>
          node.children.length > 0 &&
          !autoExpandedFolderIdsRef.current.has(node.folder.id)
      )
      .map((node) => node.folder.id);
    if (newRootParents.length === 0) {
      return;
    }

    for (const id of newRootParents) {
      autoExpandedFolderIdsRef.current.add(id);
    }
    setExpandedFolderIds((previous) => {
      const next = new Set(previous);
      for (const id of newRootParents) {
        next.add(id);
      }
      return next;
    });
  }, [folderTree]);

  const updateTagTreeFade = useCallback(() => {
    const element = tagTreeScrollRef.current;
    if (!element) {
      setTagTreeHasMoreBelow(false);
      return;
    }
    setTagTreeHasMoreBelow(
      element.scrollHeight - element.scrollTop - element.clientHeight > 2
    );
  }, []);

  useEffect(() => {
    if (resourceView !== "tags") {
      return;
    }
    const element = tagTreeScrollRef.current;
    if (!element) {
      return;
    }
    updateTagTreeFade();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateTagTreeFade);
    observer.observe(element);
    return () => observer.disconnect();
  }, [resourceView, updateTagTreeFade]);

  const handleResourceResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = resourcePanelWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextWidth = Math.min(
          RESOURCE_PANEL_MAX_WIDTH,
          Math.max(
            RESOURCE_PANEL_MIN_WIDTH,
            startWidth + moveEvent.clientX - startX
          )
        );
        setResourcePanelWidth(nextWidth);
      };
      const handlePointerUp = (upEvent: PointerEvent) => {
        const nextWidth = Math.min(
          RESOURCE_PANEL_MAX_WIDTH,
          Math.max(
            RESOURCE_PANEL_MIN_WIDTH,
            startWidth + upEvent.clientX - startX
          )
        );
        setResourcePanelWidth(nextWidth);
        try {
          localStorage.setItem(RESOURCE_PANEL_WIDTH_KEY, String(nextWidth));
        } catch {
          // Keep the in-memory width when storage is unavailable.
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    },
    [resourcePanelWidth]
  );

  // 自用精简版：载入文件夹黑名单状态（纯视图过滤，不影响索引）
  useEffect(() => {
    let cancelled = false;
    ipc.client.photos
      .getHiddenFolders()
      .then((state) => {
        if (!cancelled) {
          setHiddenFolders(
            state as { paths: string[]; resolvedFolderIds: number[] }
          );
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleFolderHidden(folderId: number, hidden: boolean) {
    const state = await ipc.client.photos.setFolderHidden({
      folderId,
      hidden,
    });
    setHiddenFolders(
      state as { paths: string[]; resolvedFolderIds: number[] }
    );
    await queryClient.invalidateQueries({ queryKey: ["photos"] });
    await queryClient.invalidateQueries({ queryKey: ["folders"] });
  }

  function handleFolderContextMenu(
    e: React.MouseEvent,
    folderId: number,
    displayName: string
  ) {
    e.preventDefault();
    setFolderCtx({ folderId, displayName, x: e.clientX, y: e.clientY });
  }

  // 自用版：载入标签黑名单
  useEffect(() => {
    let cancelled = false;
    ipc.client.photos
      .getHiddenTags()
      .then((rows) => {
        if (!cancelled) {
          setHiddenTags(
            (rows as { id: number; name: string; parentId: number | null }[]) ??
              []
          );
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 把黑名单里的"根"标签展开成需要隐藏的全部 id（含各自子孙）。
   *
   * 与文件夹黑名单同理：隐藏一个类型目录时它下面的标签也要一起消失，
   * 否则目录空了、子标签还挂在那儿。
   */
  function expandHiddenTagIdSet(): Set<number> {
    const roots = new Set(hiddenTags.map((tag) => tag.id));
    if (roots.size === 0) {
      return roots;
    }
    const childrenByParent = new Map<number, number[]>();
    for (const tag of tags) {
      if (tag.parentId === null) {
        continue;
      }
      const list = childrenByParent.get(tag.parentId);
      if (list) {
        list.push(tag.id);
      } else {
        childrenByParent.set(tag.parentId, [tag.id]);
      }
    }
    const result = new Set(roots);
    const queue = [...roots];
    while (queue.length > 0) {
      const current = queue.pop() as number;
      for (const child of childrenByParent.get(current) ?? []) {
        if (!result.has(child)) {
          result.add(child);
          queue.push(child);
        }
      }
    }
    return result;
  }

  async function toggleTagHidden(tagId: number, hidden: boolean) {
    try {
      await ipc.client.photos.setTagHidden({ tagId, hidden });
      const rows = await ipc.client.photos.getHiddenTags();
      setHiddenTags(
        (rows as { id: number; name: string; parentId: number | null }[]) ?? []
      );
    } catch {
      // 失败时保持原状，避免界面与后端不一致
    }
  }

  // Collapsed: icon-only bar

  return (
    <>
      <div
        className="sidebar-bg relative flex h-full flex-row overflow-hidden"
        data-surface="sidebar-shell"
        onDragOver={handleSidebarDragOver}
        style={{ width: collapsed ? 48 : 48 + resourcePanelWidth }}
      >
        <nav
          aria-label={t("appName")}
          className="sidebar-rail flex h-full w-12 flex-shrink-0 flex-col items-center border-foreground/8 border-r py-2"
          data-surface="sidebar-rail"
        >
          <SidebarTooltip
            content={collapsed ? t("expandSidebar") : t("collapseSidebar")}
          >
            <button
              aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
              className="mb-2 flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
              onClick={onToggleCollapse}
              type="button"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </button>
          </SidebarTooltip>

          <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-1.5">
            <RailButton
              active={location.pathname === "/"}
              icon={<Images className="h-4 w-4" />}
              label={t("sidebarAllPhotos")}
              onClick={() => {
                if (collapsed) {
                  onToggleCollapse();
                } else {
                  onSelectAllPhotos();
                }
              }}
            />
            {collapsed && (
              <Popover
                onOpenChange={setFolderShortcutsOpen}
                open={folderShortcutsOpen}
              >
                <SidebarTooltip content={t("folderShortcuts")}>
                  <PopoverTrigger asChild>
                    <button
                      aria-label={t("folderShortcuts")}
                      aria-pressed={folderShortcutsOpen}
                      className={`relative flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors ${
                        activeFolderId !== null || folderShortcutsOpen
                          ? "nav-item-active text-primary"
                          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                      }`}
                      type="button"
                    >
                      <Folder className="h-4 w-4" />
                    </button>
                  </PopoverTrigger>
                </SidebarTooltip>
                <PopoverContent
                  align="start"
                  aria-label={t("folderShortcuts")}
                  className="w-72 gap-2 p-2"
                  side="right"
                  sideOffset={8}
                >
                  <div className="px-2 pt-1 font-medium text-[12px] text-foreground">
                    {t("folderShortcuts")}
                  </div>
                  {activeShortcutFolder && (
                    <section aria-label={t("currentFolder")}>
                      <p className="px-2 py-1 text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                        {t("currentFolder")}
                      </p>
                      <FolderShortcutRow
                        folder={activeShortcutFolder}
                        isActive
                        onContextMenu={(event) =>
                          handleFolderContextMenu(
                            event,
                            activeShortcutFolder.id,
                            activeShortcutFolder.displayName
                          )
                        }
                        onSelect={() =>
                          selectShortcutFolder(activeShortcutFolder.id)
                        }
                        onUnpin={
                          pinnedFolderIds.includes(activeShortcutFolder.id)
                            ? () => togglePinnedFolder(activeShortcutFolder.id)
                            : undefined
                        }
                        unpinLabel={t("unpinFolder")}
                      />
                    </section>
                  )}
                  {pinnedShortcutFolders.length > 0 && (
                    <section aria-label={t("pinnedFolders")}>
                      <p className="px-2 py-1 text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                        {t("pinnedFolders")}
                      </p>
                      {pinnedShortcutFolders.map((folder) => (
                        <FolderShortcutRow
                          folder={folder}
                          key={folder.id}
                          onContextMenu={(event) =>
                            handleFolderContextMenu(
                              event,
                              folder.id,
                              folder.displayName
                            )
                          }
                          onSelect={() => selectShortcutFolder(folder.id)}
                          onUnpin={() => togglePinnedFolder(folder.id)}
                          unpinLabel={t("unpinFolder")}
                        />
                      ))}
                    </section>
                  )}
                  {recentShortcutFolders.length > 0 && (
                    <section aria-label={t("recentFolders")}>
                      <p className="px-2 py-1 text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                        {t("recentFolders")}
                      </p>
                      {recentShortcutFolders.map((folder) => (
                        <FolderShortcutRow
                          folder={folder}
                          key={folder.id}
                          onContextMenu={(event) =>
                            handleFolderContextMenu(
                              event,
                              folder.id,
                              folder.displayName
                            )
                          }
                          onSelect={() => selectShortcutFolder(folder.id)}
                          unpinLabel={t("unpinFolder")}
                        />
                      ))}
                    </section>
                  )}
                  {!hasFolderShortcuts && (
                    <p className="px-2 py-3 text-[11px] text-muted-foreground leading-relaxed">
                      {t("folderShortcutsEmpty")}
                    </p>
                  )}
                  <div className="border-border border-t pt-1">
                    <button
                      className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                      onClick={showAllFolders}
                      type="button"
                    >
                      <Search className="h-3.5 w-3.5" />
                      {t("viewAllFolders")}
                    </button>
                  </div>
                </PopoverContent>
              </Popover>
            )}
            {!PRIVATE_BUILD.hideDashboard && (
              <RailButton
                active={location.pathname === "/dashboard"}
                icon={<LayoutDashboard className="h-4 w-4" />}
                label={t("sidebarDashboard")}
                onClick={() => navigate({ to: "/dashboard" })}
              />
            )}
            {!PRIVATE_BUILD.hideAlbums && (
              <RailButton
                active={
                  dragOverAlbumNav || location.pathname.startsWith("/albums")
                }
                icon={<Album className="h-4 w-4" />}
                label={t("sidebarAlbums")}
                onClick={() => navigate({ to: "/albums" as const })}
                onDragEnter={() => setDragOverAlbumNav(true)}
                onDragLeave={(event) => {
                  if (
                    !event.currentTarget.contains(event.relatedTarget as Node)
                  ) {
                    setDragOverAlbumNav(false);
                  }
                }}
                onDragOver={handleSidebarDragOver}
                onDrop={handleDropOnAlbumNav}
              />
            )}
            <RailButton
              active={location.pathname === "/people"}
              icon={<Users className="h-4 w-4" />}
              label={t("people")}
              onClick={() => navigate({ to: "/people" })}
            />

            <div className="my-1 h-px w-6 bg-foreground/8" />

            <RailButton
              active={location.pathname === "/duplicates"}
              icon={<ScanSearch className="h-4 w-4" />}
              label={t("duplicates")}
              onClick={() => navigate({ to: "/duplicates" })}
            />
            {!PRIVATE_BUILD.hideCull && (
              <RailButton
                active={location.pathname.startsWith("/cull")}
                icon={<Swords className="h-4 w-4" />}
                label={t("cull")}
                onClick={() => navigate({ to: "/cull" })}
              />
            )}
            <RailButton
              active={location.pathname === "/trash"}
              badge={trashCount > 0}
              icon={<Trash2 className="h-4 w-4" />}
              label={t("trash")}
              onClick={() => navigate({ to: "/trash" })}
            />
          </div>

          <div className="flex flex-col items-center gap-1 px-1.5">
            {!PRIVATE_BUILD.hideUpdateBadge && updateAvailable && (
              <RailButton
                active={location.pathname === "/settings/update"}
                badge
                icon={<RefreshCw className="h-4 w-4" />}
                label={t("settingsUpdate")}
                onClick={() => navigate({ to: "/settings/update" })}
              />
            )}
            <RailButton
              active={location.pathname.startsWith("/settings")}
              icon={<Settings className="h-4 w-4" />}
              label={t("sidebarSettings")}
              onClick={() => navigate({ to: "/settings" })}
            />
            <RailButton
              icon={<CircleHelp className="h-4 w-4" />}
              label={t("keyboardHelpTitle")}
              onClick={() =>
                document.dispatchEvent(
                  new KeyboardEvent("keydown", { key: "?" })
                )
              }
            />
          </div>
        </nav>

        {!collapsed && (
          <div
            className="flex h-full select-none flex-col"
            data-surface="sidebar-resources"
            style={{ width: resourcePanelWidth }}
          >
            {/* Content area — dual flex-1 sections */}
            <div className="flex min-h-0 flex-1 flex-col px-3 pt-3">
              {/* All Photos + Favorites — content filters */}
              <button
                className={`flex w-full items-center gap-2 rounded-[6px] px-3 py-1.5 text-left text-[13px] transition-colors ${
                  activeFolderId === null && !favoriteActive
                    ? "nav-item-active bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                }`}
                onClick={() => {
                  onSelectAllPhotos();
                }}
                type="button"
              >
                <Images className="h-3.5 w-3.5" />
                {t("sidebarAllPhotos")}
              </button>
              {onSelectFavorites && (
                <button
                  className={`flex w-full items-center gap-2 rounded-[6px] px-3 py-1.5 text-left text-[13px] transition-colors ${
                    favoriteActive
                      ? "nav-item-active bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  }`}
                  onClick={() => {
                    if (favoriteActive) {
                      return;
                    }
                    onSelectFavorites?.();
                  }}
                  type="button"
                >
                  <Star className="h-3.5 w-3.5" />
                  {t("favorite")}
                </button>
              )}

              <div className="my-2 border-border border-t" />

              <div
                className="mb-2 grid grid-cols-2 rounded-[6px] bg-foreground/5 p-0.5"
                data-surface="segmented-control"
              >
                <button
                  aria-pressed={resourceView === "folders"}
                  className={`rounded-[5px] px-2 py-1 text-[11px] transition-colors ${
                    resourceView === "folders"
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setResourceView("folders")}
                  type="button"
                >
                  {t("sidebarFolders")}
                </button>
                <button
                  aria-pressed={resourceView === "tags"}
                  className={`rounded-[5px] px-2 py-1 text-[11px] transition-colors ${
                    resourceView === "tags"
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setResourceView("tags")}
                  type="button"
                >
                  {t("sidebarTags")}
                </button>
              </div>

              {/* Folders */}
              <div
                className={`${resourceView === "folders" ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}
              >
                <div className="mb-1 flex flex-shrink-0 items-center gap-1 px-1">
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2 text-muted-foreground/60" />
                    <SmoothInput
                      aria-label={t("folderSearchPlaceholder")}
                      className="rounded-[4px] bg-card py-1 pr-6 pl-7 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:ring-1 focus:ring-primary/50"
                      data-surface="control"
                      onChange={(event) => setFolderSearch(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setFolderSearch("");
                        }
                      }}
                      placeholder={t("folderSearchPlaceholder")}
                      ref={folderSearchRef}
                      role="searchbox"
                      value={folderSearch}
                      wrapperClassName="w-full"
                    />
                    {folderSearch && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            aria-label={t("clearSearch")}
                            className="absolute top-1/2 right-1.5 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-[3px] text-muted-foreground/70 hover:text-foreground"
                            onClick={() => setFolderSearch("")}
                            type="button"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t("clearSearch")}</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label={t("sidebarAddFolder")}
                        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[4px] text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
                        onClick={() => onAddFolder()}
                        type="button"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("sidebarAddFolder")}</TooltipContent>
                  </Tooltip>
                </div>
                {folderTree.length === 0 ? (
                  <p className="px-3 py-2 text-[12px] text-muted-foreground/70">
                    {t("sidebarNoFolders")}
                  </p>
                ) : folderSearchResult.nodes.length === 0 ? (
                  <p className="px-3 py-2 text-[12px] text-muted-foreground/70">
                    {t("folderSearchEmpty")}
                  </p>
                ) : (
                  <FolderTree
                    activeId={activeFolderId}
                    dragOverId={dragOverFolderId}
                    expandedIds={visibleExpandedFolderIds}
                    label={t("sidebarFolders")}
                    nodes={folderSearchResult.nodes}
                    onContextMenu={handleFolderContextMenu}
                    onDragLeave={handleFolderDragLeave}
                    onDragOver={handleFolderDragOver}
                    onDrop={handleFolderDrop}
                    onSelect={onSelectFolder}
                    onToggle={(id) => {
                      const next = new Set(expandedFolderIds);
                      if (next.has(id)) {
                        next.delete(id);
                      } else {
                        next.add(id);
                      }
                      setExpandedFolderIds(next);
                    }}
                    onTogglePinned={() =>
                      setPinnedFoldersCollapsed((collapsed) => !collapsed)
                    }
                    pinnedBoundaryLabel={t("pinnedBoundaryLabel")}
                    pinnedCollapsed={pinnedFoldersCollapsed}
                    pinnedFolderIds={validPinnedFolderIds}
                    pinnedLabel={t("pinnedSectionLabel")}
                  />
                )}
              </div>

              {/* Tags */}
              {resourceView === "tags" &&
                (tags.length > 0 || totalPhotos > 0) && (
                  <div className="flex min-h-0 flex-1 flex-col">
                    {aiTagPipelineActive &&
                      tags.some((tag) => tag.photoCount > 0) && (
                        <div className="flex items-center gap-1 px-3 py-1 text-[10px] text-primary/80">
                          <ScanSearch className="h-3 w-3 animate-pulse" />
                          {aiTagging ? aiTagStatusText : t("tagUpdating")}
                        </div>
                      )}
                    {tags.length > 0 ? (
                      <>
                        {/* Active tag chips */}
                        {activeTagIds.length > 0 && (
                          <div className="flex flex-wrap gap-1 px-1 pb-1">
                            {activeTagIds.slice(0, 3).map((id) => {
                              const tag = tags.find((t) => t.id === id);
                              return (
                                <span
                                  className="inline-flex items-center gap-1 rounded-[4px] border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[10px]"
                                  key={id}
                                >
                                  <span
                                    className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
                                    style={{
                                      backgroundColor: tag?.color ?? "#888",
                                    }}
                                  />
                                  <span className="max-w-[90px] truncate">
                                    {getTagDisplayName(
                                      tag?.name ?? "",
                                      i18n.language
                                    )}
                                  </span>
                                  <button
                                    aria-label={
                                      t("clickToRemove") +
                                      " " +
                                      getTagDisplayName(
                                        tag?.name ?? "",
                                        i18n.language
                                      )
                                    }
                                    className="ml-0.5 flex h-3 w-3 items-center justify-center rounded-[3px] text-muted-foreground/70 hover:text-foreground"
                                    onClick={() => onToggleTag?.(id)}
                                    type="button"
                                  >
                                    <X className="h-2 w-2" />
                                  </button>
                                </span>
                              );
                            })}
                            {activeTagIds.length > 3 && (
                              <span className="inline-flex items-center rounded-[4px] border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                {t("andMore", {
                                  count: activeTagIds.length - 3,
                                })}
                              </span>
                            )}
                          </div>
                        )}
                        {activeTagIds.length >= 2 && onToggleTagMode && (
                          <div className="flex items-center justify-between px-1 pb-1">
                            <span className="text-[10px] text-muted-foreground/70">
                              {t("tagFilterMode")}
                            </span>
                            <button
                              aria-label={t("tagFilterMode")}
                              aria-pressed={tagMode === "and"}
                              className="rounded-[3px] border border-border px-1.5 py-0 font-medium text-[10px] text-primary transition-colors hover:bg-primary/10"
                              onClick={onToggleTagMode}
                              type="button"
                            >
                              {tagMode.toUpperCase()}
                            </button>
                          </div>
                        )}
                        <div className="px-1 pb-1">
                          <div className="relative">
                            <SmoothInput
                              aria-label={t("tagSearchPlaceholder")}
                              className="rounded-[4px] bg-card py-1 pr-6 pl-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70"
                              data-surface="control"
                              onChange={(e) => setTagSearch(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  setTagSearch("");
                                  setDebouncedTagSearch("");
                                  const tree = (
                                    e.currentTarget as HTMLElement
                                  ).closest(
                                    '[role="tree"]'
                                  ) as HTMLElement | null;
                                  tree?.focus();
                                }
                              }}
                              placeholder={t("tagSearchPlaceholder")}
                              role="searchbox"
                              value={tagSearch}
                              wrapperClassName="w-full"
                            />
                            {tagSearch && (
                              <button
                                className="absolute top-1/2 right-1.5 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-[3px] text-muted-foreground/70 hover:text-foreground"
                                onClick={() => {
                                  setTagSearch("");
                                  setDebouncedTagSearch("");
                                }}
                                type="button"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        </div>
                        <div
                          aria-label={t("sidebarTags")}
                          className="resource-tree-scroll flex-1 overflow-y-auto"
                          data-bottom-fade={tagTreeHasMoreBelow}
                          data-resource-tree-scroll="true"
                          data-surface="resource-tree"
                          onFocus={(e) => {
                            const container = e.currentTarget;
                            const currentFocus = document.activeElement;
                            if (
                              currentFocus === container ||
                              !container.contains(currentFocus)
                            ) {
                              const first = container.querySelector(
                                '[role="treeitem"]'
                              ) as HTMLElement | null;
                              if (first) {
                                const items =
                                  container.querySelectorAll(
                                    '[role="treeitem"]'
                                  );
                                for (const item of items) {
                                  (item as HTMLElement).setAttribute(
                                    "tabindex",
                                    "-1"
                                  );
                                }
                                first.setAttribute("tabindex", "0");
                                first.focus();
                              }
                            }
                          }}
                          onKeyDown={(e) => {
                            handleTagTreeKeyDown(
                              e,
                              expandedTagIds,
                              setExpandedTagIds,
                              onToggleTag,
                              setTagSearch,
                              setDebouncedTagSearch
                            );
                          }}
                          onScroll={updateTagTreeFade}
                          ref={tagTreeScrollRef}
                          role="tree"
                          tabIndex={0}
                        >
                          {(() => {
                            // 自用改动：**只显示"有照片"的标签**。
                            // WD14 词表有 10,861 个标签，若把没有命中的也列出来，
                            // 侧边栏会被几千个空标签塞满并明显变慢。
                            // 父节点（角色 / 通用 / 各类型）的 photoCount 是聚合值，
                            // 只要有子孙命中就 > 0，所以目录结构不会塌掉；
                            // 被过滤掉的祖先会由下面那段循环补回来。
                            const hiddenSet = expandHiddenTagIdSet();
                            const filtered = tags.filter(
                              (t) =>
                                t.photoCount > 0 &&
                                !hiddenSet.has(t.id) &&
                                (debouncedTagSearch
                                  ? t.name
                                      .toLowerCase()
                                      .includes(
                                        debouncedTagSearch.toLowerCase()
                                      )
                                  : true)
                            );
                            const allIds = new Set(filtered.map((t) => t.id));
                            for (const t of filtered) {
                              let cur: number | null = t.parentId;
                              while (cur !== null) {
                                const currentId = cur;
                                if (allIds.has(currentId)) {
                                  break;
                                }
                                const parent = tags.find(
                                  (p) => p.id === currentId
                                );
                                if (parent) {
                                  allIds.add(cur);
                                  cur = parent.parentId;
                                } else {
                                  break;
                                }
                              }
                            }
                            const visible = tags.filter((t) =>
                              allIds.has(t.id)
                            );
                            const tree = buildTagTree(visible);
                            return renderTagTree(
                              tree,
                              0,
                              expandedTagIds,
                              (id) => {
                                const next = new Set(expandedTagIds);
                                if (next.has(id)) {
                                  next.delete(id);
                                } else {
                                  next.add(id);
                                }
                                setExpandedTagIds(next);
                              },
                              activeTagIds,
                              (nextId) => {
                                if (nextId !== null) {
                                  onToggleTag?.(nextId);
                                }
                              },
                              (e, id, name) => {
                                e.preventDefault();
                                setTagCtx({
                                  tagId: id,
                                  tagName: name,
                                  x: e.clientX,
                                  y: e.clientY,
                                });
                              },
                              handleSidebarDragOver,
                              (id) => setDragOverTagId(id),
                              (e) => {
                                if (
                                  !(e.currentTarget as HTMLElement).contains(
                                    e.relatedTarget as Node
                                  )
                                ) {
                                  setDragOverTagId(null);
                                }
                              },
                              (e, id) => handleDropOnTag(e, id),
                              dragOverTagId,
                              i18n.language
                            );
                          })()}
                        </div>
                        {/* 自用：**常驻**显示「生成 AI 标签」按钮（= 全库重跑入口）。
                            上游把它藏在"一个带照片的标签都没有"的条件里，
                            于是库里一旦有标签，这个按钮就彻底消失了 —— 用户根本找不到。
                            现在改为：不在打标时显示按钮，打标中显示进度。 */}
                        <div className="px-1 py-1">
                            {aiTagPipelineActive ? (
                              <div className="flex items-center gap-1.5 rounded-[6px] border border-primary/20 bg-primary/5 px-2 py-1.5 text-[11px] text-primary">
                                <ScanSearch className="h-3.5 w-3.5 animate-pulse" />
                                {aiTagStatusText}
                              </div>
                            ) : (
                              <button
                                className="flex w-full items-center justify-center gap-1.5 rounded-[6px] border border-primary/30 bg-primary/10 px-2 py-1.5 text-[11px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-60"
                                disabled={batchTagLoading}
                                onClick={handleBatchGenerateTags}
                                type="button"
                              >
                                <ScanSearch className="h-3.5 w-3.5" />
                                {t("tagBatchGenerate")}
                              </button>
                            )}
                        </div>
                        {/* 自用版：标签黑名单。
                            刻意放在上面那个滚动容器**之外**，所以它固定在底部、
                            不随标签树一起滚动。点条目即可移出黑名单。 */}
                        {hiddenTags.length > 0 && (
                          <div className="mt-1 shrink-0 border-border/60 border-t px-1 pt-1">
                            <div className="flex items-center gap-1.5 px-1.5 py-1 font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                              <EyeOff className="h-3 w-3" />
                              {t("tagBlacklistTitle")} ({hiddenTags.length})
                            </div>
                            <div className="max-h-[7.5rem] overflow-y-auto overscroll-contain">
                              {hiddenTags.map((tag) => (
                                <button
                                  className="flex w-full items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                                  key={tag.id}
                                  // 左键：与标签树里的行为一致 —— 按该标签筛选照片
                                  onClick={() => onToggleTag?.(tag.id)}
                                  // 右键：打开与标签树相同的右键菜单（内含「移出标签黑名单」）
                                  onContextMenu={(event) => {
                                    event.preventDefault();
                                    setTagCtx({
                                      tagId: tag.id,
                                      tagName: tag.name,
                                      x: event.clientX,
                                      y: event.clientY,
                                    });
                                  }}
                                  title={t("tagBlacklistHint")}
                                  type="button"
                                >
                                  <EyeOff className="h-3 w-3 shrink-0" />
                                  <span className="min-w-0 truncate">
                                    {tag.name}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="px-3 py-1">
                        {aiTagPipelineActive ? (
                          <div className="flex items-center gap-1.5 rounded-[6px] border border-primary/20 bg-primary/5 px-2 py-1.5 text-[11px] text-primary">
                            <ScanSearch className="h-3.5 w-3.5 animate-pulse" />
                            {aiTagStatusText}
                          </div>
                        ) : (
                          <button
                            className="flex w-full items-center gap-1.5 rounded-[6px] border border-border px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-60"
                            disabled={batchTagLoading}
                            onClick={handleBatchGenerateTags}
                            type="button"
                          >
                            <ScanSearch className="h-3.5 w-3.5" />
                            {t("tagBatchGenerate")}
                          </button>
                        )}
                      </div>
                    )}
                    {/* 自用：隐藏「AI 标签由本地模型自动生成，仅供辅助参考」说明
                        （见 private-build.ts 的 hideAiTagUi） */}
                    {!PRIVATE_BUILD.hideAiTagUi && (
                      <p className="mt-1 px-1 text-[10px] text-muted-foreground/40">
                        {t("aiTagDisclaimer")}
                      </p>
                    )}
                  </div>
                )}
            </div>
          </div>
        )}
        {!collapsed && (
          <div
            aria-label={t("resizeSidebar")}
            aria-orientation="vertical"
            aria-valuemax={RESOURCE_PANEL_MAX_WIDTH}
            aria-valuemin={RESOURCE_PANEL_MIN_WIDTH}
            aria-valuenow={resourcePanelWidth}
            className="sidebar-resize-handle absolute top-0 right-0 bottom-0 z-20 w-1 cursor-col-resize"
            onDoubleClick={() => {
              setResourcePanelWidth(RESOURCE_PANEL_DEFAULT_WIDTH);
              try {
                localStorage.setItem(
                  RESOURCE_PANEL_WIDTH_KEY,
                  String(RESOURCE_PANEL_DEFAULT_WIDTH)
                );
              } catch {
                // Keep the in-memory width when storage is unavailable.
              }
            }}
            onPointerDown={handleResourceResizePointerDown}
            role="separator"
          />
        )}
      </div>

      {/* Delete tag confirmation dialog */}
      <ConfirmDialog
        confirmText={t("delete")}
        description={t("tagDeleteDescription", {
          name: deleteTagTarget
            ? getTagDisplayName(deleteTagTarget.name, i18n.language)
            : "",
        })}
        destructive
        onCancel={() => setDeleteTagTarget(null)}
        onConfirm={handleDeleteTag}
        open={deleteTagTarget !== null}
        title={t("tagDeleteTitle")}
      />

      {/* Folder context menu */}
      {folderCtx &&
        createPortal(
          <div
            className="fixed z-[200] max-h-[calc(100dvh-1rem)] min-w-[140px] max-w-[calc(100dvw-1rem)] animate-context-menu-enter overflow-y-auto overflow-x-hidden overscroll-contain rounded-[8px] border border-border bg-popover py-1 ring-1 ring-foreground/5"
            data-overlay-kind="context-menu"
            data-surface="overlay"
            ref={ctxRef}
            style={{
              left: Math.min(folderCtx.x, window.innerWidth - 160),
              top: Math.min(folderCtx.y, window.innerHeight - 180),
            }}
          >
            <div className="truncate px-3 py-1 font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
              {folderCtx.displayName}
            </div>
            <div className="mx-2 my-1 border-border border-t" />
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-foreground/5"
              onClick={() => {
                if (togglePinnedFolder(folderCtx.folderId)) {
                  closeCtx();
                }
              }}
              type="button"
            >
              {pinnedFolderIds.includes(folderCtx.folderId) ? (
                <PinOff className="h-3.5 w-3.5" />
              ) : (
                <Pin className="h-3.5 w-3.5" />
              )}
              {pinnedFolderIds.includes(folderCtx.folderId)
                ? t("unpinFolder")
                : t("pinFolder")}
            </button>
            {/* 自用精简版：把该文件夹加入/移出「不在主界面显示」的黑名单。
                只影响浏览视图，照片仍保留在索引里并且依然可以被搜索到。 */}
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-foreground/5"
              onClick={() => {
                const isHidden = hiddenFolders.resolvedFolderIds.includes(
                  folderCtx.folderId
                );
                toggleFolderHidden(folderCtx.folderId, !isHidden).catch(
                  () => undefined
                );
                closeCtx();
              }}
              type="button"
            >
              <FolderLock className="h-3.5 w-3.5" />
              {hiddenFolders.resolvedFolderIds.includes(folderCtx.folderId)
                ? t("unhideFolderFromGallery")
                : t("hideFolderFromGallery")}
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-foreground/5"
              onClick={() => {
                setAppearanceFolderId(folderCtx.folderId);
                closeCtx();
              }}
              type="button"
            >
              <Paintbrush className="h-3.5 w-3.5" />
              {t("customizeFolderAppearance")}
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-destructive transition-colors hover:bg-destructive/10"
              onClick={() => {
                onDeleteFolder(folderCtx.folderId, folderCtx.displayName);
                closeCtx();
              }}
              type="button"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("removeFromIndex")}
            </button>
          </div>,
          document.body
        )}

      <FolderAppearanceDialog
        folder={appearanceFolder}
        onOpenChange={(open) => {
          if (!open) {
            setAppearanceFolderId(null);
          }
        }}
        onSave={async ({ color, icon }) => {
          if (appearanceFolderId === null) {
            return;
          }
          try {
            await ipc.client.photos.updateFolderAppearance({
              color,
              icon,
              id: appearanceFolderId,
            });
            await queryClient.invalidateQueries({ queryKey: ["folders"] });
            toast.success(t("folderAppearanceSaved"));
            setAppearanceFolderId(null);
          } catch {
            toast.error(t("folderAppearanceSaveFailed"));
            throw new Error("Failed to save folder appearance");
          }
        }}
      />

      {/* Tag context menu */}
      {tagCtx &&
        createPortal(
          <div
            className="fixed z-[200] min-w-[140px] animate-context-menu-enter overflow-hidden rounded-[8px] border border-border bg-popover py-1 ring-1 ring-foreground/5"
            data-overlay-kind="context-menu"
            data-surface="overlay"
            ref={ctxRef}
            style={{
              left: Math.min(tagCtx.x, window.innerWidth - 160),
              top: Math.min(tagCtx.y, window.innerHeight - 140),
            }}
          >
            <div className="truncate px-3 py-1 font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
              {tagCtx.tagName}
            </div>
            <div className="mx-2 my-1 border-border border-t" />
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-foreground/5"
              onClick={() => {
                setChildTagParent({
                  parentId: tagCtx.tagId,
                  parentName: tagCtx.tagName,
                });
                setTagCtx(null);
              }}
              type="button"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("tagCreateChild")}
            </button>
            {/* 自用版：重命名标签（主要给 WD14 角色标签补中文） */}
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-foreground/5"
              onClick={() => {
                setRenameTagTarget({ id: tagCtx.tagId, name: tagCtx.tagName });
                // 输入框只显示**中文部分**：括号与英文标识不展示，避免被误删
                setRenameTagName(splitTagName(tagCtx.tagName).chinese);
                setTagCtx(null);
              }}
              type="button"
            >
              <Pencil className="h-3.5 w-3.5" />
              {t("tagRename")}
            </button>
            {/* 自用版：自定义标签小点颜色（十六进制 / RGB） */}
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-foreground/5"
              onClick={() => {
                const current = tags.find((item) => item.id === tagCtx.tagId);
                openTagColorPicker(
                  tagCtx.tagId,
                  tagCtx.tagName,
                  current?.color ?? null
                );
                setTagCtx(null);
              }}
              type="button"
            >
              <Palette className="h-3.5 w-3.5" />
              {t("tagColor")}
            </button>
            {/* 自用版：把该标签（含其子树）移入/移出标签黑名单。
                只影响侧边栏显示，标签仍保留在库里并且依然可以被搜索到。 */}
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-foreground/5"
              onClick={() => {
                const isHidden = hiddenTags.some(
                  (tag) => tag.id === tagCtx.tagId
                );
                toggleTagHidden(tagCtx.tagId, !isHidden).catch(
                  () => undefined
                );
                setTagCtx(null);
              }}
              type="button"
            >
              <EyeOff className="h-3.5 w-3.5" />
              {hiddenTags.some((tag) => tag.id === tagCtx.tagId)
                ? t("unhideTagFromTree")
                : t("hideTagFromTree")}
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-destructive transition-colors hover:bg-destructive/10"
              onClick={() => {
                setDeleteTagTarget({ id: tagCtx.tagId, name: tagCtx.tagName });
                setTagCtx(null);
              }}
              type="button"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("tagDeleteTitle")}
            </button>
          </div>,
          document.body
        )}

      {/* 自用版：标签颜色对话框（十六进制 + RGB 双输入） */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setTagColorTarget(null);
          }
        }}
        open={tagColorTarget !== null}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("tagColor")}</DialogTitle>
            <DialogDescription>
              {t("tagColorHint", { name: tagColorTarget?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <span
              className="h-7 w-7 flex-shrink-0 rounded-full border border-border"
              style={{ background: tagColorHex }}
            />
            <input
              className="h-9 w-12 flex-shrink-0 cursor-pointer rounded-[6px] border border-border bg-card"
              onChange={(event) => {
                setTagColorHex(event.target.value);
                setTagColorInput(event.target.value);
              }}
              type="color"
              value={tagColorHex}
            />
            <SmoothInput
              className="rounded-[6px] border border-border bg-card px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/50"
              onChange={(event) => {
                setTagColorInput(event.target.value);
                const normalized = normalizeColor(event.target.value);
                if (normalized) {
                  setTagColorHex(normalized);
                }
              }}
              placeholder={t("tagColorPlaceholder")}
              value={tagColorInput}
              wrapperClassName="w-full"
            />
          </div>
          <div className="flex items-center gap-2">
            {(["r", "g", "b"] as const).map((channel) => (
              <label
                className="flex flex-1 items-center gap-1 text-[11px] text-muted-foreground"
                key={channel}
              >
                {channel.toUpperCase()}
                <input
                  className="w-full rounded-[6px] border border-border bg-card px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-primary/50"
                  max={255}
                  min={0}
                  onChange={(event) => {
                    const rgb = hexToRgb(tagColorHex);
                    const next = {
                      ...rgb,
                      [channel]: Number(event.target.value),
                    };
                    const hex = rgbToHex(next.r, next.g, next.b);
                    setTagColorHex(hex);
                    setTagColorInput(hex);
                  }}
                  type="number"
                  value={hexToRgb(tagColorHex)[channel]}
                />
              </label>
            ))}
          </div>
          <DialogFooter>
            <button
              className="mr-auto rounded-md border border-border px-3 py-1.5 font-medium text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5"
              onClick={() => applyTagColor(null)}
              type="button"
            >
              {t("tagColorReset")}
            </button>
            <button
              className="rounded-md border border-border px-4 py-1.5 font-medium text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5"
              onClick={() => setTagColorTarget(null)}
              type="button"
            >
              {t("cancel")}
            </button>
            <button
              className="rounded-md bg-primary px-4 py-1.5 font-medium text-[13px] text-primary-foreground transition-opacity hover:opacity-90"
              onClick={() => applyTagColor(tagColorHex)}
              type="button"
            >
              {t("confirm")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 自用版：重命名标签对话框（主要给 WD14 角色标签补中文） */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setRenameTagTarget(null);
            setRenameTagName("");
          }
        }}
        open={renameTagTarget !== null}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("tagRename")}</DialogTitle>
            <DialogDescription>{t("tagRenameHint")}</DialogDescription>
          </DialogHeader>
          <SmoothInput
            autoFocus
            className="rounded-[6px] border border-border bg-card px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/50"
            onChange={(e) => setRenameTagName(e.target.value)}
            onCompositionEnd={(e) => {
              renameComposingRef.current = false;
              setRenameTagName((e.target as HTMLInputElement).value);
            }}
            onCompositionStart={() => {
              renameComposingRef.current = true;
            }}
            onKeyDown={(e) => {
              if (renameComposingRef.current) {
                return;
              }
              if (e.key === "Enter") {
                handleRenameTag();
              }
            }}
            placeholder={t("tagRenamePlaceholder")}
            ref={renameInputRef}
            value={renameTagName}
            wrapperClassName="w-full"
          />
          <DialogFooter>
            <button
              className="rounded-md border border-border px-4 py-1.5 font-medium text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5"
              onClick={() => {
                setRenameTagTarget(null);
                setRenameTagName("");
              }}
              type="button"
            >
              {t("cancel")}
            </button>
            <button
              className="rounded-md bg-primary px-4 py-1.5 font-medium text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              disabled={
                // 允许清空（= 去掉中文名、退回纯英文），所以只在"没改动"时禁用
                renameTagName.trim() ===
                splitTagName(renameTagTarget?.name ?? "").chinese
              }
              onClick={handleRenameTag}
              type="button"
            >
              {t("confirm")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create child tag dialog */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setChildTagParent(null);
            setNewChildTagName("");
          }
        }}
        open={childTagParent !== null}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("tagCreateChild")}</DialogTitle>
            <DialogDescription>
              {t("parentTag", { name: childTagParent?.parentName ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <SmoothInput
            autoFocus
            className="rounded-[6px] border border-border bg-card px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/50"
            onChange={(e) => setNewChildTagName(e.target.value)}
            onCompositionEnd={(e) => {
              childComposingRef.current = false;
              setNewChildTagName((e.target as HTMLInputElement).value);
            }}
            onCompositionStart={() => {
              childComposingRef.current = true;
            }}
            onKeyDown={(e) => {
              if (childComposingRef.current) {
                return;
              }
              if (e.key === "Enter") {
                handleCreateChildTag();
              }
            }}
            placeholder={t("childTagPlaceholder")}
            ref={childInputRef}
            value={newChildTagName}
            wrapperClassName="w-full"
          />
          <DialogFooter>
            <button
              className="rounded-md border border-border px-4 py-1.5 font-medium text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5"
              onClick={() => {
                setChildTagParent(null);
                setNewChildTagName("");
              }}
              type="button"
            >
              {t("cancel")}
            </button>
            <button
              className="rounded-md bg-primary px-4 py-1.5 font-medium text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              disabled={!newChildTagName.trim()}
              onClick={handleCreateChildTag}
              type="button"
            >
              {t("confirm")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
