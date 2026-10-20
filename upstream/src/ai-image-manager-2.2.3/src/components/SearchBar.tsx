// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/style/noNestedTernary: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noStaticElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: scoped component lint cleanup preserves existing UI behavior
import {
  ClipboardPaste,
  Clock,
  Eye,
  EyeOff,
  Filter,
  ImageUp,
  Search,
  X,
} from "lucide-react";
import { resolveTagDotColor } from "@/components/sidebar-trees";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  type Dispatch,
  forwardRef,
  memo,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { SmoothInput } from "@/components/ui/smooth-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ipc } from "@/ipc/manager";
import type {
  AdvancedExifFilterField,
  ExifFilters,
  SearchMode,
} from "@/types/search";
import { getSearchSuggestions } from "@/utils/search-suggestions";
import { cn } from "@/utils/tailwind";
import { PRIVATE_BUILD } from "@/config/private-build";
import { FilterBreadcrumb } from "./FilterBreadcrumb";
import { FilterPresets } from "./FilterPresets";
import { FilterDropdown } from "./filter-dropdown";
import {
  clearSavedHistory,
  getFilterLabel,
  getTimePresets,
  loadHistory,
  MAX_HISTORY,
  type SearchSuggestion,
  saveHistory,
  type TagInfo,
} from "./search-bar-utils";
import {
  SemanticSearchDiagnostics,
  type SemanticSearchDiagnosticsProps,
} from "./semantic-search-diagnostics";

const ADVANCED_EXIF_FILTERS: AdvancedExifFilterField[] = [
  "vendor",
  "captureMode",
  "exposureProgram",
  "meteringMode",
  "whiteBalance",
  "focusMode",
  "subjectTarget",
  "driveMode",
  "stabilizationMode",
  "computationalMode",
  "inCameraLook",
  "provenanceStatus",
];

const PATH_SEPARATOR_PATTERN = /[\\/]/;
const MODAL_SURFACE_SELECTOR =
  '[aria-modal="true"], [role="alertdialog"], [data-slot="dialog-content"], [data-slot="alert-dialog-content"]';

interface ImageSearchReference {
  imagePath: string;
  previewDataUrl: string | null;
}

function getFileName(filePath: string): string {
  return (
    filePath.split(PATH_SEPARATOR_PATTERN).filter(Boolean).at(-1) ?? filePath
  );
}

interface ExifCandidateResult {
  advancedCategories?: Record<string, string[]>;
  cameraModels?: Array<string | null>;
  creators?: string[];
  lensModels?: Array<string | null>;
}

interface SearchBarProps {
  activeTagIds?: number[];
  aiStatus?: {
    coverageState?: "ready" | "partial" | "unavailable" | "error";
    model: string;
    vectorDB: string;
    hasVectors: boolean;
    vectorCount: number;
    indexReady: boolean;
    indexedPhotos?: number;
    isEmbedding: boolean;
    totalPhotos?: number;
    embeddingProgress: { processed: number; total: number; phase: string };
  } | null;
  colorHex?: string | null;
  drillDownFilters?: ExifFilters;
  filterBarLeadingContent?: ReactNode;
  filterBarTrailingContent?: ReactNode;
  filters: ExifFilters;
  /** 自用：是否在按标签检索时也排除隐藏文件夹（开关在搜索栏右侧）。 */
  hideHiddenFolders?: boolean;
  onToggleHideHiddenFolders?: () => void;
  imageSearchActive?: boolean;
  imageSearchReference?: ImageSearchReference;
  leadingContent?: ReactNode;
  onClear: () => void;
  onFiltersChange: Dispatch<SetStateAction<ExifFilters>>;
  onImageSearch?: (imagePath: string) => void;
  onQueryChange: (query: string) => void;
  onSearch: (query: string, filters?: ExifFilters) => void;
  /** 自用（问题 3）：一键清空已选标签。 */
  onTagClear?: () => void;
  onTagRemove?: (tagId: number) => void;
  onTagSelect?: (tag: TagInfo) => void;
  query: string;
  resetVersion?: number;
  resultCount?: number;
  searchMode?: SearchMode | null;
  searchTime?: number;
  semanticDiagnostics?: SemanticSearchDiagnosticsProps;
  trailingContent?: ReactNode;
}

export const SearchBar = memo(
  forwardRef<HTMLElement, SearchBarProps>(
    (
      {
        activeTagIds,
        aiStatus,
        colorHex,
        drillDownFilters,
        filterBarLeadingContent,
        filterBarTrailingContent,
        filters,
        hideHiddenFolders = false,
  onToggleHideHiddenFolders,
  imageSearchActive,
        imageSearchReference,
        leadingContent,
        onFiltersChange: setFilters,
        onQueryChange: setQuery,
        onSearch,
        onTagClear,
        onTagRemove,
        onTagSelect,
        onClear,
        onImageSearch,
        query,
        resetVersion,
        resultCount,
        searchMode,
        searchTime,
        semanticDiagnostics,
        trailingContent,
      }: SearchBarProps,
      ref
    ) => {
      const { t } = useTranslation();
      const timePresets = useMemo(() => getTimePresets(t), [t]);
      const [history, setHistory] = useState<string[]>(loadHistory);
      const [showSuggestions, setShowSuggestions] = useState(false);
      const [inputFocused, setInputFocused] = useState(false);
      const [showFilters, setShowFilters] = useState(false);
      const [tags, setTags] = useState<TagInfo[]>([]);
      const [cameraModels, setCameraModels] = useState<string[]>([]);
      const [creators, setCreators] = useState<string[]>([]);
      const [lensModels, setLensModels] = useState<string[]>([]);
      const [advancedCategories, setAdvancedCategories] = useState<
        Record<string, string[]>
      >({});
      // 自用（2026-10-17）：`useNavigate` 原来只用于"人物建议 → 人物详情页"，
      // 那条链路已随 SFace 移除 → 这里不再需要 ✓
      const [dictSuggestionsEnabled, setDictSuggestionsEnabled] =
        useState(false);

      // 自用版：置空示例搜索词（见 private-build.ts 的 hideSearchHints）
      const searchExamples = useMemo<SearchSuggestion[]>(
        () =>
          PRIVATE_BUILD.hideSearchHints
            ? []
            : [
                { type: "example", text: t("searchExampleAutumnLeaves") },
                { type: "example", text: t("searchExampleSeasideSunset") },
                { type: "example", text: t("searchExampleCuteCat") },
                { type: "example", text: t("searchExampleNightCity") },
              ],
        [t]
      );

      // 自用（2026-10-17，用户口径）：**SFace 人脸链路已整体剔除** ✗
      // 这里原来会通过 `ipc.client.faces.listFaceIdentities` 拉"人物身份"，
      // 用来在搜索建议里显示人物头像并点击跳转 `/people/$identityId`。
      // 人物页现在只用 CCIP 三条功能、不再有"身份"这个概念，
      // 那条 IPC 通道也删了 → 整块去掉 ✓（人物名建议不再出现，其余建议不受影响）

      // Enable AI dictionary suggestions once tags are loaded
      useEffect(() => {
        if (tags.length > 0) {
          setDictSuggestionsEnabled(true);
        }
      }, [tags]);

      useEffect(() => {
        let generation = 0;
        function refreshTags() {
          const current = ++generation;
          ipc.client.photos
            .getTags({})
            .then((result) => {
              if (current === generation) {
                setTags((result as TagInfo[]) || []);
              }
            })
            .catch(() => {
              /* keep the last successful list */
            });
        }
        window.addEventListener("tags-changed", refreshTags);
        refreshTags();
        return () => {
          generation++;
          window.removeEventListener("tags-changed", refreshTags);
        };
      }, []);

      useEffect(() => {
        ipc.client.photos
          .getExifCandidates({})
          .then((r: ExifCandidateResult) => {
            setCameraModels(
              (r.cameraModels || []).filter(
                (model): model is string => model !== null
              )
            );
            setCreators(r.creators || []);
            setLensModels(
              (r.lensModels || []).filter(
                (model): model is string => model !== null
              )
            );
            setAdvancedCategories(r.advancedCategories || {});
          })
          .catch(() => {
            /* ignore */
          });
      }, []);

      // Filter suggestions: dictionary + tags + recent searches
      const suggestions = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) {
          return [];
        }

        const all: SearchSuggestion[] = [];

        // 自用（2026-10-17）：人物身份建议已随 SFace 链路一起移除 ✗
        const seen = new Set<string>();

        // 2) AI dictionary suggestions (from search-suggestions)
        // Allow single-char for pinyin matching (e.g. "h" → "海")
        if (dictSuggestionsEnabled && q.length >= 1) {
          const dictSuggestions = getSearchSuggestions(q, 4);
          for (const s of dictSuggestions) {
            if (seen.has(s.word.toLowerCase())) {
              continue;
            }
            all.push({
              type: "dictionary",
              text: s.word,
              category: s.category,
            });
          }
        }

        // 3) Tag matches
        const matchingTags = tags
          .filter((t) => t.name.toLowerCase().includes(q))
          .slice(0, 4)
          .map((t) => ({
            type: "tag" as const,
            tagId: t.id,
            text: t.name,
            color: t.color || "var(--primary)",
          }));
        all.push(...matchingTags);

        // 4) History matches
        const matchingHistory = history
          .filter((h) => h.toLowerCase().includes(q) && h !== q)
          .slice(0, 3)
          .map((h) => ({ type: "history" as const, text: h }));
        all.push(...matchingHistory);

        return all;
      }, [query, tags, history, dictSuggestionsEnabled]);

      const examplesDisabled = Boolean(
        aiStatus &&
          (aiStatus.isEmbedding ||
            aiStatus.model === "loading" ||
            aiStatus.model === "error" ||
            aiStatus.vectorDB !== "ready" ||
            !aiStatus.hasVectors ||
            !aiStatus.indexReady)
      );
      const recentSuggestions = useMemo<SearchSuggestion[]>(
        () => history.slice(0, 5).map((text) => ({ type: "history", text })),
        [history]
      );
      const displayedSuggestions = query.trim()
        ? suggestions
        : [...(examplesDisabled ? [] : searchExamples), ...recentSuggestions];
      /*
       * 自用：搜索框为空时，面板里本来只有三类"提示"（搜索示例 / 时间预设 / 最近搜索）✗。
       * 前两类已被 hideSearchHints 关掉（用户口径："去掉这个提示"），
       * 所以只剩"最近搜索"——一条都没有时**不要弹空面板** ✓。
       */
      const hasEmptyQueryContent =
        recentSuggestions.length > 0 ||
        (!examplesDisabled && searchExamples.length > 0) ||
        !PRIVATE_BUILD.hideSearchHints;
      const showSuggestionPanel =
        showSuggestions &&
        !imageSearchActive &&
        !showFilters &&
        (query.trim() ? suggestions.length > 0 : hasEmptyQueryContent);

      const inputRef = useRef<HTMLInputElement>(null);
      const fileInputRef = useRef<HTMLInputElement>(null);
      const dropdownRef = useRef<HTMLDivElement>(null);
      const toolbarRef = useRef<HTMLElement>(null);
      const suggestionListRef = useRef<HTMLDivElement>(null);
      const [_locallyDragging, _setLocallyDragging] = useState(false);
      const [suggestionIndex, setSuggestionIndex] = useState(-1);
      const [floatingPanelMaxHeight, setFloatingPanelMaxHeight] = useState(440);
      const [failedImagePreviewUrl, setFailedImagePreviewUrl] = useState<
        string | null
      >(null);
      /** 自用：以图搜图输入小窗口是否展开。 */
  const [imageSearchOpen, setImageSearchOpen] = useState(false);
  /** 小窗口连同按钮的外层容器：用来判断"点在小窗外面"从而收起。 */
  const imageSearchWrapRef = useRef<HTMLSpanElement | null>(null);
  /*
   * 自用（2026-10-20 · 会话#10）：「重建向量索引」前先确认。
   * 原因：它会把 `vectors\` 整个目录删掉重建 —— **包括角色特征表 ccip_embeddings**，
   * 但按钮就在搜索栏上、点一下就走，用户（实测）以为只是"重建搜图向量"，
   * 结果角色识别直接变成"还没算过角色特征"。
   */
  const [rebuildConfirmOpen, setRebuildConfirmOpen] = useState(false);

  /** 自用（会话#10）：真正执行"重建 → 重新索引"，确认框和原来的一步走共用。 */
  function runRebuildIndex() {
    ipc.client.photos
      .resetAiIndex({})
      .then(() => ipc.client.photos.startAiIndexing({}))
      .catch((error: unknown) => {
        console.error("[AI] Failed to rebuild index", error);
      });
  }

  /**
   * 自用：拖进来的图片 —— 优先取它的本地路径（从资源管理器拖）；
   * 拿不到路径（比如从网页拖来的位图）就退回读剪贴板。
   */
  function handleImageDrop(event: React.DragEvent) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    const droppedPath = file
      ? window.electronAPI?.getFilePath?.(file)
      : undefined;
    if (droppedPath && onImageSearch) {
      setImageSearchOpen(false);
      onImageSearch(droppedPath);
      return;
    }
    void handlePasteImage();
  }

  /**
   * 自用：小窗口打开期间，Ctrl+V 直接粘贴、Esc 关闭。
   * 读的是**系统剪贴板**（走主进程），所以截图/复制的图都能用。
   */
  useEffect(() => {
    if (!imageSearchOpen) {
      return;
    }
    const onPaste = (event: ClipboardEvent) => {
      const hasImage = Array.from(event.clipboardData?.items ?? []).some(
        (item) => item.type.startsWith("image/")
      );
      if (hasImage) {
        event.preventDefault();
        void handlePasteImage();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setImageSearchOpen(false);
      }
    };
    const onMouseDown = (event: MouseEvent) => {
      const root = imageSearchWrapRef.current;
      if (root && !root.contains(event.target as Node)) {
        setImageSearchOpen(false);
      }
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageSearchOpen]);

  /**
   * 自用：把剪贴板里的图片交给主进程落成临时文件，再走原来的以图搜图流程。
   * 为什么要落文件：搜索接口收的是**图片路径**，而剪贴板里只有位图。
   */
  async function handlePasteImage() {
    if (!onImageSearch) {
      return;
    }
    try {
      const result = (await ipc.client.photos.saveClipboardImage({})) as {
        path: string | null;
      };
      if (result?.path) {
        onImageSearch(result.path);
        return;
      }
      toast.error(t("pasteImageEmpty"));
    } catch (error) {
      console.error("[SearchBar] paste image failed", error);
      toast.error(t("pasteImageFailed"));
    }
  }

  const imageSearchFileName = imageSearchReference
        ? getFileName(imageSearchReference.imagePath)
        : "";

      useEffect(() => {
        if (!(showFilters || showSuggestionPanel)) {
          return;
        }

        const updateAvailableHeight = () => {
          const toolbarBottom =
            toolbarRef.current?.getBoundingClientRect().bottom ?? 0;
          setFloatingPanelMaxHeight(
            Math.max(120, Math.floor(window.innerHeight - toolbarBottom - 12))
          );
        };

        updateAvailableHeight();
        window.addEventListener("resize", updateAvailableHeight);
        const observer =
          typeof ResizeObserver === "undefined"
            ? null
            : new ResizeObserver(updateAvailableHeight);
        if (toolbarRef.current) {
          observer?.observe(toolbarRef.current);
        }

        return () => {
          window.removeEventListener("resize", updateAvailableHeight);
          observer?.disconnect();
        };
      }, [showFilters, showSuggestionPanel]);

      function clearHistory() {
        clearSavedHistory();
        setHistory([]);
        setSuggestionIndex(-1);
      }

      const [drillOriginFilters, setDrillOriginFilters] = useState<
        Set<keyof ExifFilters>
      >(new Set());

      useEffect(() => {
        setDrillOriginFilters(
          new Set(
            Object.keys(drillDownFilters ?? {}) as Array<keyof ExifFilters>
          )
        );
      }, [drillDownFilters]);

      const hasActiveFilters = Object.values(filters).some(
        (v) => v && v.length > 0
      );
      const activeFilterCount = [
        filters.dateFrom,
        filters.dateTo,
        filters.dateMonth,
        filters.dateHour,
        filters.cameraModel,
        filters.creator,
        filters.lensModel,
        filters.advancedField && filters.advancedValue,
        filters.isoMin,
        filters.isoMax,
        filters.apertureMin,
        filters.apertureMax,
        filters.focalMin,
        filters.focalMax,
        filters.shutterMin || filters.shutterMax,
      ].filter(Boolean).length;

      useEffect(() => {
        setDrillOriginFilters(new Set());
        setShowSuggestions(false);
        setShowFilters(false);
        setSuggestionIndex(-1);
        setInputFocused(false);
      }, []);

      const cameraSuggestions = useMemo(() => {
        if (!filters.cameraModel) {
          return cameraModels.slice(0, 20);
        }
        const q = filters.cameraModel.toLowerCase();
        return cameraModels
          .filter((m) => m.toLowerCase().includes(q))
          .slice(0, 20);
      }, [filters.cameraModel, cameraModels]);

      const lensSuggestions = useMemo(() => {
        if (!filters.lensModel) {
          return lensModels.slice(0, 20);
        }
        const q = filters.lensModel.toLowerCase();
        return lensModels
          .filter((m) => m.toLowerCase().includes(q))
          .slice(0, 20);
      }, [filters.lensModel, lensModels]);

      const creatorSuggestions = useMemo(() => {
        if (!filters.creator) {
          return creators.slice(0, 20);
        }
        const query = filters.creator.toLocaleLowerCase();
        return creators
          .filter((creator) => creator.toLocaleLowerCase().includes(query))
          .slice(0, 20);
      }, [creators, filters.creator]);

      useEffect(() => {
        function handleGlobalShortcut(e: MessageEvent) {
          if (e.data === "global-shortcut:search") {
            inputRef.current?.focus();
          }
        }
        window.addEventListener("message", handleGlobalShortcut);
        return () => {
          window.removeEventListener("message", handleGlobalShortcut);
        };
      }, []);

      useEffect(() => {
        function handleFocusShortcut(event: KeyboardEvent) {
        if (PRIVATE_BUILD.slimWindowShortcuts) {
          return;
        }
          if (event.defaultPrevented) {
            return;
          }
          if (
            !(event.ctrlKey || event.metaKey) ||
            event.shiftKey ||
            event.altKey ||
            event.key.toLowerCase() !== "f"
          ) {
            return;
          }

          const target = event.target;
          const targetElement =
            target instanceof HTMLElement ? target : undefined;
          const searchInput = inputRef.current;

          // Keep native editing controls and content-editable regions in charge
          // of their own shortcuts. The gallery search input is the one
          // editing control intentionally handled here.
          if (
            targetElement &&
            targetElement !== searchInput &&
            (targetElement.tagName === "INPUT" ||
              targetElement.tagName === "TEXTAREA" ||
              targetElement.tagName === "SELECT" ||
              targetElement.isContentEditable)
          ) {
            return;
          }

          // SearchBar lives in the page shell, so do not pull focus through an
          // open modal surface. The desktop sidebar also uses role="dialog",
          // but is non-modal until aria-modal is true.
          if (
            targetElement?.closest(MODAL_SURFACE_SELECTOR) ||
            document.querySelector(MODAL_SURFACE_SELECTOR)
          ) {
            return;
          }

          if (!searchInput) {
            return;
          }

          event.preventDefault();
          searchInput.focus();
          searchInput.select();
        }

        document.addEventListener("keydown", handleFocusShortcut);
        return () => {
          document.removeEventListener("keydown", handleFocusShortcut);
        };
      }, []);

      useEffect(() => {
        function closeMenus(event: PointerEvent) {
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest('[data-overlay-kind="filter-presets"]')
          ) {
            return;
          }
          if (!toolbarRef.current?.contains(target as Node)) {
            setShowSuggestions(false);
            setShowFilters(false);
            setSuggestionIndex(-1);
          }
        }
        function handleEscape(event: KeyboardEvent) {
          if (event.key === "Escape") {
            setShowSuggestions(false);
            setShowFilters(false);
            setSuggestionIndex(-1);
          }
        }
        document.addEventListener("pointerdown", closeMenus);
        document.addEventListener("keydown", handleEscape);
        return () => {
          document.removeEventListener("pointerdown", closeMenus);
          document.removeEventListener("keydown", handleEscape);
        };
      }, []);

      function handleInputBlur(e: React.FocusEvent<HTMLInputElement>) {
        setInputFocused(false);
        const related = e.relatedTarget as Node | null;
        if (related && suggestionListRef.current?.contains(related)) {
          return;
        }
        setTimeout(() => {
          setShowSuggestions(false);
          setSuggestionIndex(-1);
        }, 150);
      }

      function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (
          e.key === "ArrowDown" &&
          showSuggestionPanel &&
          displayedSuggestions.length > 0
        ) {
          e.preventDefault();
          setSuggestionIndex(0);
          suggestionListRef.current?.focus();
          return;
        }
        if (e.key === "Escape") {
          if (showSuggestions) {
            e.preventDefault();
            setShowSuggestions(false);
            setSuggestionIndex(-1);
            return;
          }
          if (query.trim()) {
            e.preventDefault();
            handleClear();
          }
        }
      }

      function handleSuggestionKeyDown(e: React.KeyboardEvent) {
        const len = displayedSuggestions.length;
        if (len === 0) {
          return;
        }

        switch (e.key) {
          case "ArrowDown":
            e.preventDefault();
            setSuggestionIndex((prev) => (prev + 1) % len);
            break;
          case "ArrowUp":
            e.preventDefault();
            setSuggestionIndex((prev) => (prev - 1 + len) % len);
            break;
          case "Enter":
            e.preventDefault();
            if (suggestionIndex >= 0 && suggestionIndex < len) {
              handleSuggestionClick(displayedSuggestions[suggestionIndex]);
            }
            break;
          case "Escape":
            e.preventDefault();
            setShowSuggestions(false);
            setSuggestionIndex(-1);
            inputRef.current?.focus();
            break;
          case "Tab":
            e.preventDefault();
            setSuggestionIndex((prev) => (prev + 1) % len);
            break;
          default:
            break;
        }
      }

      useEffect(() => {
        if (suggestionIndex < 0 || !suggestionListRef.current) {
          return;
        }
        const activeEl = suggestionListRef.current.querySelector(
          `[data-suggestion-index="${suggestionIndex}"]`
        );
        if (activeEl) {
          activeEl.scrollIntoView?.({ block: "nearest" });
        }
      }, [suggestionIndex]);

      const addToHistory = useCallback((q: string) => {
        if (!q.trim()) {
          return;
        }
        setHistory((prev) => {
          const next = [q, ...prev.filter((h) => h !== q)].slice(
            0,
            MAX_HISTORY
          );
          saveHistory(next);
          return next;
        });
      }, []);

      function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!(query.trim() || hasActiveFilters)) {
          return;
        }
        if (query.trim()) {
          addToHistory(query.trim());
        }
        onSearch(query.trim(), hasActiveFilters ? filters : undefined);
        setShowSuggestions(false);
      }

      function handleClear() {
        setQuery("");
        onClear();
        requestAnimationFrame(() => inputRef.current?.focus());
      }

      function handleSuggestionClick(suggestion: SearchSuggestion) {
        // 自用（2026-10-17）：人物身份建议已随 SFace 链路移除，
        // 不再有 `/people/$identityId` 这个页面可跳 ✓
        if (
          suggestion.type === "tag" &&
          suggestion.tagId !== undefined &&
          onTagSelect
        ) {
          const tag = tags.find((item) => item.id === suggestion.tagId);
          setQuery("");
          onTagSelect(
            tag ?? {
              id: suggestion.tagId,
              name: suggestion.text,
              color: suggestion.color ?? null,
            }
          );
          setShowSuggestions(false);
          setSuggestionIndex(-1);
          return;
        }
        setQuery(suggestion.text);
        addToHistory(suggestion.text);
        onSearch(suggestion.text, hasActiveFilters ? filters : undefined);
        setShowSuggestions(false);
      }

      function updateFilter(
        key: keyof ExifFilters,
        value: string,
        triggerSearch = false
      ) {
        setFilters((prev) => {
          const next = { ...prev, [key]: value };
          if (triggerSearch) {
            const hasAny = Object.values(next).some((v) => v);
            queueMicrotask(() =>
              onSearch(query.trim(), hasAny ? next : undefined)
            );
          }
          return next;
        });
      }

      function applyIsoPreset(preset: string) {
        const map: Record<string, [string, string]> = {
          "100-400": ["100", "400"],
          "400-1600": ["400", "1600"],
          "1600-6400": ["1600", "6400"],
          "6400+": ["6400", ""],
        };
        const [min, max] = map[preset];
        updateFilter("isoMin", min);
        updateFilter("isoMax", max);
      }

      function applyAperturePreset(preset: string) {
        const map: Record<string, [string, string]> = {
          "f/1.4-2.8": ["1.4", "2.8"],
          "f/2.8-5.6": ["2.8", "5.6"],
          "f/5.6-11": ["5.6", "11"],
          "f/11+": ["11", ""],
        };
        const [min, max] = map[preset];
        updateFilter("apertureMin", min);
        updateFilter("apertureMax", max);
      }

      function applyFocalPreset(preset: string) {
        const map: Record<string, [string, string]> = {
          "<35mm": ["", "35"],
          "35-85mm": ["35", "85"],
          "85-200mm": ["85", "200"],
          ">200mm": ["200", ""],
        };
        const [min, max] = map[preset];
        updateFilter("focalMin", min);
        updateFilter("focalMax", max);
      }

      function applyShutterPreset(preset: string) {
        const map: Record<string, [string, string]> = {
          "1/1000+": ["0.001", ""],
          "1/100-1/10": ["0.001", "0.1"],
          "1s+": ["1", ""],
          "30s+": ["30", ""],
        };
        const [min, max] = map[preset];
        updateFilter("shutterMin", min);
        updateFilter("shutterMax", max);
      }

      function clearFilters() {
        setFilters({});
        setDrillOriginFilters(new Set());
        if (query.trim()) {
          onSearch(query.trim(), undefined);
        } else {
          onClear();
        }
      }

      function handleFilterKeyDown(e: React.KeyboardEvent) {
        if (e.key === "Enter") {
          e.preventDefault();
          onSearch(query.trim(), hasActiveFilters ? filters : undefined);
          setShowFilters(false);
        }
      }

      // Determine search placeholder based on AI status
      function getPlaceholder(): string {
        if (imageSearchActive) {
          return t("imageSearchMode");
        }
        if (!aiStatus) {
          return t("searchPlaceholder");
        }
        if (aiStatus.isEmbedding) {
          const p = aiStatus.embeddingProgress;
          return t("aiEmbeddingSearchReady", {
            processed: p.processed,
            total: p.total,
          });
        }
        if (aiStatus.model === "loading") {
          return t("aiModelLoading");
        }
        if (aiStatus.model === "error") {
          return t("aiModelError");
        }
        if (aiStatus.vectorDB !== "ready") {
          return t("vectorDbNotReady");
        }
        if (!aiStatus.hasVectors) {
          return t("aiNoIndexHint");
        }
        return t("searchPlaceholder");
      }

      const filterInputClass =
        "h-8 w-full rounded-[4px] border border-border bg-card px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary/40";
      const filterDropdownClass = "w-full placeholder:text-muted-foreground/70";
      const selectedTags = useMemo(() => {
        if (!activeTagIds?.length) {
          return [];
        }
        const selected = new Set(activeTagIds);
        return tags.filter((tag) => selected.has(tag.id));
      }, [activeTagIds, tags]);
      /*
       * 自用（问题 2）：已选标签的小点颜色必须与标签树一致 ——
       * 颜色代表"属于哪个主类"，所以统一走 resolveTagDotColor（标签树用的同一套规则）。
       */
      const tagById = useMemo(
        () => new Map(tags.map((tag) => [tag.id, tag])),
        [tags]
      );

      return (
        <search
          aria-label={t("searchPlaceholder")}
          className="home-unified-toolbar relative min-w-0 border-border border-b transition-colors"
          data-surface="toolbar-content"
          ref={(node) => {
            toolbarRef.current = node;
            if (typeof ref === "function") {
              ref(node);
            } else if (ref) {
              ref.current = node;
            }
          }}
        >
          <div className="home-toolbar-inner px-3 py-2">
            {/* Search input row */}
            <div className="home-toolbar-primary-row flex min-h-9 min-w-0 flex-wrap items-center gap-2">
              {leadingContent && (
                <div className="home-toolbar-context min-w-0 flex-shrink-0">
                  {leadingContent}
                </div>
              )}
              <form
                /*
                 * 自用（用户实测反馈）：这里原来写死 `xl:max-w-[720px]`，
                 * 于是宽屏下搜索框只有 720px、右边空出一大块，而框里"以图搜图 + 长文件名"
                 * 又挤在一起 ✗。
                 * 而 `.home-search-form`（global.css）本身就是 `flex: 1 1 0%`，即"占满剩余空间"
                 * —— 所以把 max-width 放开，空隙自然被搜索框吃掉，右侧那几个按钮随之右移 ✓。
                 * 只留一个宽松上限，免得超宽屏上拉成一条。
                 */
                className="home-search-form relative min-w-0 2xl:max-w-[1100px]"
                onSubmit={handleSubmit}
              >
                {imageSearchActive && imageSearchReference ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label={t("imageSearchReferenceHint", {
                          filename: imageSearchFileName,
                        })}
                        className="home-image-search-reference home-search-input is-active flex h-9 w-full min-w-0 items-center gap-2 rounded-[6px] border border-border pr-10 pl-1.5 text-left text-[14px] text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-ring"
                        data-surface="control"
                        onClick={() => fileInputRef.current?.click()}
                        type="button"
                      >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-[4px] bg-foreground/5 text-muted-foreground">
                          {imageSearchReference.previewDataUrl &&
                          failedImagePreviewUrl !==
                            imageSearchReference.previewDataUrl ? (
                            <img
                              alt=""
                              aria-hidden="true"
                              className="h-full w-full object-cover"
                              height={28}
                              onError={() =>
                                setFailedImagePreviewUrl(
                                  imageSearchReference.previewDataUrl
                                )
                              }
                              src={imageSearchReference.previewDataUrl}
                              width={28}
                            />
                          ) : (
                            <ImageUp aria-hidden="true" className="h-4 w-4" />
                          )}
                        </span>
                        {/*
                          自用（用户实测反馈）："以图搜图"这四个字**不能参与收缩** ✗ ——
                          否则长文件名会把它挤扁、甚至挤出框外。
                          这里固定不缩、不换行；让**文件名**去截断（它本来就是 min-w-0 + truncate）✓。
                        */}
                        <span className="home-image-search-reference-label shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
                          {t("searchModeImage")}
                        </span>
                        <span className="home-image-search-reference-name min-w-0 truncate font-medium">
                          {imageSearchFileName}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("imageSearchReferenceHint", {
                        filename: imageSearchFileName,
                      })}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <>
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 left-0 z-[100] flex w-9 items-center justify-center"
                      style={{
                        color: "var(--muted-foreground)",
                        zIndex: 100,
                      }}
                    >
                      <Search className="h-4 w-4 shrink-0" strokeWidth={2} />
                    </span>
                    <SmoothInput
                      aria-activedescendant={
                        suggestionIndex >= 0
                          ? `search-suggestion-${suggestionIndex}`
                          : undefined
                      }
                      aria-autocomplete="list"
                      aria-controls="search-suggestions-listbox"
                      aria-expanded={showSuggestionPanel}
                      className={`home-search-input h-9 w-full rounded-[6px] border border-border pr-8 pl-9 text-[14px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-1 focus:ring-ring ${inputFocused || showSuggestionPanel || showFilters || query.trim() ? "is-active" : ""}`}
                      data-surface="control"
                      onBlur={handleInputBlur}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setShowSuggestions(true);
                        setSuggestionIndex(-1); // 输入变化时重置高亮
                      }}
                      onFocus={() => {
                        setInputFocused(true);
                        if (showFilters) {
                          setShowFilters(false);
                        }
                        setShowSuggestions(true);
                      }}
                      onKeyDown={handleInputKeyDown}
                      placeholder={getPlaceholder()}
                      ref={inputRef}
                      role="combobox"
                      type="text"
                      value={query}
                    />
                  </>
                )}
                {(query || imageSearchActive) && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label={t("clearSearch")}
                        className="absolute top-1/2 right-1 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-[5px] text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
                        onClick={handleClear}
                        type="button"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("clearSearch")}</TooltipContent>
                  </Tooltip>
                )}
              </form>

              {(searchMode || resultCount !== undefined) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="home-search-result-summary inline-flex h-7 flex-shrink-0 items-center gap-1 rounded-[5px] bg-foreground/5 px-2 text-[10px] text-muted-foreground">
                      {searchMode === "color" && colorHex && (
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: `#${colorHex}` }}
                        />
                      )}
                      {resultCount === undefined
                        ? searchMode === "image"
                          ? t("searchModeImage")
                          : searchMode === "color"
                            ? t("searchModeColor")
                            : searchMode === "exif"
                              ? t("searchModeExif")
                              : t("searchModeSemantic")
                        : resultCount > 0
                          ? t("resultCount", { count: resultCount })
                          : t("noMatchResult")}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {searchTime === undefined
                      ? t("searchSuggestions")
                      : `${searchTime < 1000 ? `${searchTime}ms` : `${(searchTime / 1000).toFixed(1)}s`}`}
                  </TooltipContent>
                </Tooltip>
              )}

              {searchMode === "text" && semanticDiagnostics?.used && (
                <SemanticSearchDiagnostics {...semanticDiagnostics} />
              )}

              {onImageSearch && (
                <span className="relative flex items-center" ref={imageSearchWrapRef}>
                  <input
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const filePath =
                          window.electronAPI?.getFilePath?.(file);
                        if (filePath) {
                          onImageSearch(filePath);
                        }
                      }
                      e.target.value = "";
                    }}
                    ref={fileInputRef}
                    type="file"
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label={t("searchModeImage")}
                        className={`flex h-9 items-center justify-center gap-1.5 rounded-[6px] px-2.5 text-[12px] transition-colors ${
                          imageSearchActive
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
                        }`}
                        onClick={() =>
                          setImageSearchOpen((previous) => !previous)
                        }
                        type="button"
                      >
                        <span className="flex items-center gap-1.5">
  <ImageUp className="h-4 w-4" />
                          <span className="home-image-search-label">
                            {t("searchModeImage")}
                          </span>
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("imageSearchTitle")}</TooltipContent>
                  </Tooltip>
                  {/* 自用：隐藏文件夹开关 —— 打开后按标签检索也排除隐藏文件夹里的图片 */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label={t("hideHiddenFolderPhotos")}
                        aria-pressed={hideHiddenFolders}
                        className={`flex h-9 items-center justify-center gap-1.5 rounded-[6px] px-2.5 text-[12px] transition-colors ${
                          hideHiddenFolders
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
                        }`}
                        onClick={onToggleHideHiddenFolders}
                        type="button"
                      >
                        {hideHiddenFolders ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {hideHiddenFolders
                        ? t("hideHiddenFolderPhotosOn")
                        : t("hideHiddenFolderPhotosOff")}
                    </TooltipContent>
                  </Tooltip>
                  {/*
                    自用：以图搜图的输入小窗口 ——
                      点击按钮展开；窗口内支持 **Ctrl+V 粘贴**、**拖入图片**、
                      以及「粘贴图片」按钮；**双击窗口**打开文件选择。
                  */}
                  {imageSearchOpen && (
                    <div
                      className="absolute top-full right-0 z-50 mt-3 w-72 rounded-[8px] border border-border bg-card p-3 shadow-lg"
                      data-testid="image-search-popover"
                      onDoubleClick={() => fileInputRef.current?.click()}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={handleImageDrop}
                    >
                      {/* 顶部一行：左「粘贴图片」，右关闭 ✕ */}
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <button
                          className="flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/10"
                          data-testid="image-search-paste"
                          onClick={handlePasteImage}
                          type="button"
                        >
                          <ClipboardPaste className="h-3.5 w-3.5" />
                          {t("pasteImageFromClipboard")}
                        </button>
                        <button
                          aria-label={t("imageSearchClose")}
                          className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
                          data-testid="image-search-close"
                          onClick={() => setImageSearchOpen(false)}
                          type="button"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="flex flex-col items-center gap-1 rounded-[6px] border border-foreground/25 border-dashed px-3 py-4 text-center">
                        <ClipboardPaste className="h-5 w-5 text-muted-foreground/70" />
                        <span className="text-[11px] text-muted-foreground">
                          {t("imageSearchDropHint")}
                        </span>
                        <span className="text-[10px] text-muted-foreground/60">
                          {t("imageSearchDoubleClickHint")}
                        </span>
                      </div>
                    </div>
                  )}
                </span>
              )}
              {/* 自用精简版：隐藏 EXIF 筛选入口（见 src/config/private-build.ts）。
                  该面板的筛选条件全部依赖 EXIF，而动漫/插画库基本没有 EXIF。 */}
              {!PRIVATE_BUILD.hideExifFilter && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      aria-expanded={showFilters}
                      aria-label={t("exifFilterTitle")}
                      className={`flex h-9 flex-shrink-0 items-center justify-center gap-1 rounded-[6px] px-2 transition-colors ${
                        showFilters || hasActiveFilters
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
                      }`}
                      onClick={() => {
                        setShowFilters((prev) => {
                          const next = !prev;
                          if (next) {
                            setShowSuggestions(false);
                            setSuggestionIndex(-1);
                          }
                          return next;
                        });
                      }}
                      type="button"
                    >
                      <Filter className="h-4 w-4" />
                      {hasActiveFilters && (
                        <span className="home-filter-summary whitespace-nowrap text-[10px]">
                          {t("exifFilterTitle")} · {activeFilterCount}
                        </span>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t("exifFilterTitle")}</TooltipContent>
                </Tooltip>
              )}
              {aiStatus?.coverageState &&
                aiStatus.coverageState !== "ready" &&
                aiStatus.coverageState !== "error" && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        aria-label={t("semanticSearchPartial", {
                          indexed: aiStatus.indexedPhotos ?? 0,
                          total: aiStatus.totalPhotos ?? 0,
                        })}
                        className="flex h-9 w-5 items-center justify-center text-amber-500"
                        role="status"
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("semanticSearchPartial", {
                        indexed: aiStatus.indexedPhotos ?? 0,
                        total: aiStatus.totalPhotos ?? 0,
                      })}
                    </TooltipContent>
                  </Tooltip>
                )}
              {/*
                自用（2026-10）：**索引入口**。
                背景：带「开始 AI 索引」按钮的那个组件（AiProgressBar）从未被渲染 ✗，
                而黄点只是指示灯 ✗ → 用户找不到任何地方能主动开始建索引 ✓。
                这里放一个小按钮，只在"索引未完成、且当前没在跑"时出现 ✓
                （正在跑的时候显示"开始"会误导 ✗）。
                点击：先 resumeAiIndexing（没暂停时返回 resumed=false），不成就 startAiIndexing。
              */}
              {/*
                自用：**常驻**语义索引入口（用户反馈：索引完成后按钮消失，找不到重触发的地方）。
                · 未完成 → 「开始 AI 索引」（先续跑，没暂停就新开）
                · 已完成 → 「重建向量索引」（清空向量与已处理标记后重来）
              */}
              {aiStatus && !aiStatus.isEmbedding && (
                  <button
                    className="flex h-9 flex-shrink-0 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
                    onClick={() => {
                      // ready / error 都走"先清空再重建"；未完成才走续跑
                      const rebuild =
                        aiStatus.coverageState === "ready" ||
                        aiStatus.coverageState === "error";
                      if (rebuild) {
                        // 自用（会话#10）：重建会清空角色特征，先让用户确认
                        setRebuildConfirmOpen(true);
                        return;
                      }
                      ipc.client.photos
                        .resumeAiIndexing({})
                        .then((result) =>
                          result?.resumed
                            ? null
                            : ipc.client.photos.startAiIndexing({})
                        )
                        .catch((error: unknown) => {
                          console.error("[AI] Failed to start indexing", error);
                        });
                    }}
                    type="button"
                  >
                    {aiStatus.coverageState === "ready" ||
                    aiStatus.coverageState === "error"
                      ? t("aiRebuildIndex")
                      : t("aiStartIndex")}
                  </button>
                )}
              {/*
                自用（会话#10）：「重建向量索引」确认框 —— 写清"会清掉什么 / 不会动什么"。
                它删的是整个 `vectors\` 目录（含角色特征表），不是只重建搜图向量。
              */}
              <ConfirmDialog
                confirmText={t("aiRebuildIndex")}
                description={t("aiRebuildIndexHint")}
                destructive
                onCancel={() => setRebuildConfirmOpen(false)}
                onConfirm={() => {
                  setRebuildConfirmOpen(false);
                  runRebuildIndex();
                }}
                open={rebuildConfirmOpen}
                title={t("aiRebuildIndexConfirmTitle")}
              />
              {trailingContent && (
                <div className="home-toolbar-actions ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
                  {trailingContent}
                </div>
              )}
            </div>

            {selectedTags.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {selectedTags.map((tag) => {
                  /*
                   * 自用（问题 2）：chip 的色**按所属标签（主类）来**，不跟主题色走。
                   */
                  const chipColor = resolveTagDotColor(tag, tagById);
                  return (
                    <span
                      className="inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-[5px] border px-2 font-medium text-[11px]"
                      key={tag.id}
                      style={{
                        backgroundColor: `color-mix(in srgb, ${chipColor} 14%, transparent)`,
                        borderColor: `color-mix(in srgb, ${chipColor} 38%, transparent)`,
                        color: chipColor,
                      }}
                    >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: resolveTagDotColor(tag, tagById),
                      }}
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="min-w-0 flex-1 truncate"
                          // biome-ignore lint/a11y/noNoninteractiveTabindex: truncated tag must expose its Tooltip to keyboard users
                          tabIndex={0}
                        >
                          {t("tagFilterChip", { name: tag.name })}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[min(28rem,calc(100vw-1rem))] break-all">
                        {t("tagFilterChip", { name: tag.name })}
                      </TooltipContent>
                    </Tooltip>
                    {onTagRemove && (
                      <button
                        aria-label={t("removeTagFilter", { name: tag.name })}
                        className="-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-primary/15"
                        onClick={() => onTagRemove(tag.id)}
                        type="button"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                  );
                })}
                {/* 自用（问题 3）：标签多了以后要能一键清空（叠一个很方便） */}
                {onTagClear && selectedTags.length > 1 && (
                  <button
                    aria-label={t("tagClearAll")}
                    className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[5px] border border-border bg-card px-2 text-[11px] text-muted-foreground transition-colors hover:border-danger/40 hover:text-danger"
                    onClick={onTagClear}
                    title={t("tagClearAll")}
                    type="button"
                  >
                    <X className="h-3 w-3" />
                    {t("tagClearAll")}
                  </button>
                )}
              </div>
            )}

            {aiStatus?.coverageState === "error" && (
              <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
                {t("semanticSearchUnavailable")}
              </div>
            )}

            {/* Active filter chips and drill-down actions */}
            {(hasActiveFilters ||
              filterBarLeadingContent ||
              filterBarTrailingContent) && (
              <div className="mt-2 flex min-w-0 max-w-full flex-wrap items-start gap-1.5">
                {filterBarLeadingContent && (
                  <div className="flex min-h-8 shrink-0 items-center border-border border-r pr-2">
                    {filterBarLeadingContent}
                  </div>
                )}
                {hasActiveFilters && (
                  <div className="flex max-h-24 min-w-0 flex-1 basis-0 flex-wrap items-center gap-1.5 overflow-y-auto overflow-x-hidden overscroll-contain pr-0.5">
                    {filters.dateFrom && (
                      <FilterChip
                        label={t("filterFrom", { value: filters.dateFrom })}
                        onRemove={() => updateFilter("dateFrom", "", true)}
                      />
                    )}
                    {filters.dateTo && (
                      <FilterChip
                        label={t("filterTo", { value: filters.dateTo })}
                        onRemove={() => updateFilter("dateTo", "", true)}
                      />
                    )}
                    {filters.dateMonth && (
                      <FilterChip
                        label={t("dateMonthValue", {
                          value: filters.dateMonth,
                        })}
                        onRemove={() => updateFilter("dateMonth", "", true)}
                      />
                    )}
                    {filters.dateHour && (
                      <FilterChip
                        label={t("dateHourValue", {
                          next: String(
                            (Number(filters.dateHour) + 1) % 24
                          ).padStart(2, "0"),
                          value: filters.dateHour.padStart(2, "0"),
                        })}
                        onRemove={() => updateFilter("dateHour", "", true)}
                      />
                    )}
                    {filters.cameraModel && (
                      <FilterChip
                        label={filters.cameraModel}
                        onRemove={() => updateFilter("cameraModel", "", true)}
                      />
                    )}
                    {filters.creator && (
                      <FilterChip
                        label={filters.creator}
                        onRemove={() => updateFilter("creator", "", true)}
                      />
                    )}
                    {filters.lensModel && (
                      <FilterChip
                        label={filters.lensModel}
                        onRemove={() => updateFilter("lensModel", "", true)}
                      />
                    )}
                    {filters.advancedField && filters.advancedValue && (
                      <FilterChip
                        label={`${t(`advancedFilter_${filters.advancedField}`)}: ${filters.advancedValue}`}
                        onRemove={() => {
                          setFilters((previous) => {
                            const next = {
                              ...previous,
                              advancedField: undefined,
                              advancedValue: undefined,
                            };
                            const hasAny = Object.values(next).some((v) => v);
                            queueMicrotask(() =>
                              onSearch(query.trim(), hasAny ? next : undefined)
                            );
                            return next;
                          });
                        }}
                      />
                    )}
                    {filters.isoMin && (
                      <FilterChip
                        label={`ISO ≥ ${filters.isoMin}`}
                        onRemove={() => updateFilter("isoMin", "", true)}
                      />
                    )}
                    {filters.isoMax && (
                      <FilterChip
                        label={`ISO ≤ ${filters.isoMax}`}
                        onRemove={() => updateFilter("isoMax", "", true)}
                      />
                    )}
                    {filters.apertureMin && (
                      <FilterChip
                        label={t("apertureGte", { value: filters.apertureMin })}
                        onRemove={() => updateFilter("apertureMin", "", true)}
                      />
                    )}
                    {filters.apertureMax && (
                      <FilterChip
                        label={t("apertureLte", { value: filters.apertureMax })}
                        onRemove={() => updateFilter("apertureMax", "", true)}
                      />
                    )}
                    {filters.focalMin && (
                      <FilterChip
                        label={t("focalGte", { value: filters.focalMin })}
                        onRemove={() => updateFilter("focalMin", "", true)}
                      />
                    )}
                    {filters.focalMax && (
                      <FilterChip
                        label={t("focalLte", { value: filters.focalMax })}
                        onRemove={() => updateFilter("focalMax", "", true)}
                      />
                    )}
                    {(filters.shutterMin || filters.shutterMax) && (
                      <FilterChip
                        label={`${t("shutterSpeedLabel")}: ${filters.shutterMin || "0"}s-${filters.shutterMax || "∞"}s`}
                        onRemove={() => {
                          setFilters((prev) => {
                            const next = {
                              ...prev,
                              shutterMin: "",
                              shutterMax: "",
                            };
                            const hasAny = Object.values(next).some((v) => v);
                            queueMicrotask(() =>
                              onSearch(query.trim(), hasAny ? next : undefined)
                            );
                            return next;
                          });
                        }}
                      />
                    )}
                  </div>
                )}
                {hasActiveFilters && !filterBarTrailingContent && (
                  <button
                    className="min-h-8 rounded-[4px] px-2 text-[11px] text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
                    onClick={clearFilters}
                    type="button"
                  >
                    {t("clearSearchFilters")}
                  </button>
                )}
                {filterBarTrailingContent && (
                  <div className="ml-auto flex min-h-8 shrink-0 items-center">
                    {filterBarTrailingContent}
                  </div>
                )}
              </div>
            )}

            {/* Filter panel */}
            {!PRIVATE_BUILD.hideExifFilter && showFilters && (
              <div
                className="absolute top-full right-4 z-[70] mt-2 w-[min(900px,calc(100%-32px))] overflow-y-auto overscroll-contain rounded-[10px] border border-border bg-popover p-4 shadow-2xl ring-1 ring-foreground/5"
                data-overlay-kind="search-filter"
                data-surface="overlay"
                onKeyDown={handleFilterKeyDown}
                style={{ maxHeight: floatingPanelMaxHeight }}
              >
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h2 className="font-semibold text-[14px] text-foreground">
                      {t("exifFilterTitle")}
                    </h2>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("enterToSearch")}
                    </p>
                  </div>
                  <button
                    aria-label={t("close")}
                    className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                    onClick={() => setShowFilters(false)}
                    type="button"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <FilterBreadcrumb
                  filters={filters}
                  getFilterLabel={getFilterLabel}
                  onClearAll={clearFilters}
                  onRemoveFilter={(key) => updateFilter(key, "", true)}
                />
                <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                  {/* Date range */}
                  <div>
                    <label
                      className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
                      htmlFor="search-date-from"
                    >
                      {t("dateRangeLabel")}
                    </label>
                    <div className="space-y-1">
                      <input
                        className={cn(
                          filterInputClass,
                          drillOriginFilters.has("dateFrom") &&
                            "border-primary bg-primary/10 dark:bg-primary/20"
                        )}
                        id="search-date-from"
                        onChange={(e) => {
                          updateFilter("dateFrom", e.target.value);
                          setDrillOriginFilters((prev) => {
                            const next = new Set(prev);
                            next.delete("dateFrom");
                            return next;
                          });
                        }}
                        placeholder={t("dateFromPlaceholder")}
                        type="date"
                        value={filters.dateFrom || ""}
                      />
                      <input
                        className={cn(
                          filterInputClass,
                          drillOriginFilters.has("dateTo") &&
                            "border-primary bg-primary/10 dark:bg-primary/20"
                        )}
                        onChange={(e) => {
                          updateFilter("dateTo", e.target.value);
                          setDrillOriginFilters((prev) => {
                            const next = new Set(prev);
                            next.delete("dateTo");
                            return next;
                          });
                        }}
                        placeholder={t("dateToPlaceholder")}
                        type="date"
                        value={filters.dateTo || ""}
                      />
                    </div>
                  </div>

                  <div>
                    <label
                      className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
                      htmlFor="search-date-month"
                    >
                      {t("dateMonthLabel")}
                    </label>
                    <FilterDropdown
                      ariaLabel={t("dateMonthLabel")}
                      className={cn(
                        filterDropdownClass,
                        drillOriginFilters.has("dateMonth") &&
                          "border-primary bg-primary/10 dark:bg-primary/20"
                      )}
                      id="search-date-month"
                      onChange={(value) => {
                        updateFilter("dateMonth", value);
                        setDrillOriginFilters((previous) => {
                          const next = new Set(previous);
                          next.delete("dateMonth");
                          return next;
                        });
                      }}
                      options={[
                        { label: t("datePeriodicAny"), value: "" },
                        ...Array.from(
                          { length: 12 },
                          (_, index) => index + 1
                        ).map((month) => ({
                          label: t("dateMonthValue", { value: month }),
                          value: String(month),
                        })),
                      ]}
                      placeholder={t("datePeriodicAny")}
                      value={filters.dateMonth || ""}
                    />
                  </div>

                  <div>
                    <label
                      className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
                      htmlFor="search-date-hour"
                    >
                      {t("dateHourLabel")}
                    </label>
                    <FilterDropdown
                      ariaLabel={t("dateHourLabel")}
                      className={cn(
                        filterDropdownClass,
                        drillOriginFilters.has("dateHour") &&
                          "border-primary bg-primary/10 dark:bg-primary/20"
                      )}
                      id="search-date-hour"
                      onChange={(value) => {
                        updateFilter("dateHour", value);
                        setDrillOriginFilters((previous) => {
                          const next = new Set(previous);
                          next.delete("dateHour");
                          return next;
                        });
                      }}
                      options={[
                        { label: t("datePeriodicAny"), value: "" },
                        ...Array.from({ length: 24 }, (_, hour) => hour).map(
                          (hour) => ({
                            label: t("dateHourValue", {
                              next: String((hour + 1) % 24).padStart(2, "0"),
                              value: String(hour).padStart(2, "0"),
                            }),
                            value: String(hour),
                          })
                        ),
                      ]}
                      placeholder={t("datePeriodicAny")}
                      value={filters.dateHour || ""}
                    />
                  </div>

                  {/* Camera */}
                  <div>
                    <label
                      className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
                      htmlFor="search-camera-model"
                    >
                      {t("cameraModelLabel")}
                    </label>
                    <FilterDropdown
                      ariaLabel={t("cameraModelLabel")}
                      className={cn(
                        filterDropdownClass,
                        drillOriginFilters.has("cameraModel") &&
                          "border-primary bg-primary/10 dark:bg-primary/20"
                      )}
                      editable
                      id="search-camera-model"
                      onChange={(value) => {
                        updateFilter("cameraModel", value);
                        setDrillOriginFilters((prev) => {
                          const next = new Set(prev);
                          next.delete("cameraModel");
                          return next;
                        });
                      }}
                      options={cameraSuggestions.map((model) => ({
                        label: model,
                        value: model,
                      }))}
                      placeholder={t("cameraPlaceholder")}
                      value={filters.cameraModel || ""}
                    />
                  </div>

                  {/* Lens */}
                  <div>
                    <label
                      className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
                      htmlFor="search-lens-model"
                    >
                      {t("lensModelLabel")}
                    </label>
                    <FilterDropdown
                      ariaLabel={t("lensModelLabel")}
                      className={cn(
                        filterDropdownClass,
                        drillOriginFilters.has("lensModel") &&
                          "border-primary bg-primary/10 dark:bg-primary/20"
                      )}
                      editable
                      id="search-lens-model"
                      onChange={(value) => {
                        updateFilter("lensModel", value);
                        setDrillOriginFilters((prev) => {
                          const next = new Set(prev);
                          next.delete("lensModel");
                          return next;
                        });
                      }}
                      options={lensSuggestions.map((model) => ({
                        label: model,
                        value: model,
                      }))}
                      placeholder={t("lensModelPlaceholder")}
                      value={filters.lensModel || ""}
                    />
                  </div>

                  {/* Creator */}
                  <div>
                    <label
                      className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
                      htmlFor="search-creator"
                    >
                      {t("creatorLabel")}
                    </label>
                    <FilterDropdown
                      ariaLabel={t("creatorLabel")}
                      className={cn(
                        filterDropdownClass,
                        drillOriginFilters.has("creator") &&
                          "border-primary bg-primary/10 dark:bg-primary/20"
                      )}
                      editable
                      id="search-creator"
                      onChange={(value) => {
                        updateFilter("creator", value);
                        setDrillOriginFilters((previous) => {
                          const next = new Set(previous);
                          next.delete("creator");
                          return next;
                        });
                      }}
                      options={creatorSuggestions.map((creator) => ({
                        label: creator,
                        value: creator,
                      }))}
                      placeholder={t("creatorPlaceholder")}
                      value={filters.creator || ""}
                    />
                  </div>

                  {/* Advanced maker metadata */}
                  <div>
                    <label
                      className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
                      htmlFor="search-advanced-exif-field"
                    >
                      {t("advancedExifFilter")}
                    </label>
                    <div className="space-y-1">
                      <FilterDropdown
                        ariaLabel={t("advancedExifFilterField")}
                        className={filterDropdownClass}
                        id="search-advanced-exif-field"
                        onChange={(value) =>
                          updateFilter(
                            "advancedField",
                            value as AdvancedExifFilterField
                          )
                        }
                        options={[
                          {
                            label: t("advancedExifFilterField"),
                            value: "",
                          },
                          ...ADVANCED_EXIF_FILTERS.map((field) => ({
                            label: t(`advancedFilter_${field}`),
                            value: field,
                          })),
                        ]}
                        placeholder={t("advancedExifFilterField")}
                        value={filters.advancedField ?? ""}
                      />
                      <FilterDropdown
                        ariaLabel={t("advancedExifFilterValue")}
                        className={filterDropdownClass}
                        disabled={!filters.advancedField}
                        editable
                        onChange={(value) =>
                          updateFilter("advancedValue", value)
                        }
                        options={(filters.advancedField
                          ? (advancedCategories[filters.advancedField] ?? [])
                          : []
                        ).map((option) => ({ label: option, value: option }))}
                        placeholder={t("advancedExifFilterValue")}
                        value={filters.advancedValue ?? ""}
                      />
                    </div>
                  </div>

                  {/* ISO range */}
                  <div>
                    <label
                      className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
                      htmlFor="search-iso-min"
                    >
                      {t("isoRangeLabel")}
                    </label>
                    <div className="space-y-1">
                      <input
                        className={cn(
                          filterInputClass,
                          drillOriginFilters.has("isoMin") &&
                            "border-primary bg-primary/10 dark:bg-primary/20"
                        )}
                        id="search-iso-min"
                        onChange={(e) => {
                          updateFilter("isoMin", e.target.value);
                          setDrillOriginFilters((prev) => {
                            const next = new Set(prev);
                            next.delete("isoMin");
                            return next;
                          });
                        }}
                        placeholder={t("isoMinPlaceholder")}
                        type="number"
                        value={filters.isoMin || ""}
                      />
                      <input
                        className={cn(
                          filterInputClass,
                          drillOriginFilters.has("isoMax") &&
                            "border-primary bg-primary/10 dark:bg-primary/20"
                        )}
                        onChange={(e) => {
                          updateFilter("isoMax", e.target.value);
                          setDrillOriginFilters((prev) => {
                            const next = new Set(prev);
                            next.delete("isoMax");
                            return next;
                          });
                        }}
                        placeholder={t("isoMaxPlaceholder")}
                        type="number"
                        value={filters.isoMax || ""}
                      />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {(
                        ["100-400", "400-1600", "1600-6400", "6400+"] as const
                      ).map((preset) => (
                        <button
                          className="rounded-[3px] bg-secondary px-1.5 py-0.5 text-[10px] hover:bg-primary/10"
                          key={preset}
                          onClick={() => applyIsoPreset(preset)}
                          type="button"
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Aperture range */}
                  <div>
                    <label
                      className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
                      htmlFor="search-aperture-min"
                    >
                      {t("apertureLabel")}
                    </label>
                    <div className="space-y-1">
                      <input
                        className={cn(
                          filterInputClass,
                          drillOriginFilters.has("apertureMin") &&
                            "border-primary bg-primary/10 dark:bg-primary/20"
                        )}
                        id="search-aperture-min"
                        min="0.7"
                        onChange={(e) => {
                          updateFilter("apertureMin", e.target.value);
                          setDrillOriginFilters((prev) => {
                            const next = new Set(prev);
                            next.delete("apertureMin");
                            return next;
                          });
                        }}
                        placeholder={t("minExamplePlaceholder", {
                          value: "1.4",
                        })}
                        step="0.1"
                        type="number"
                        value={filters.apertureMin || ""}
                      />
                      <input
                        className={cn(
                          filterInputClass,
                          drillOriginFilters.has("apertureMax") &&
                            "border-primary bg-primary/10 dark:bg-primary/20"
                        )}
                        min="0.7"
                        onChange={(e) => {
                          updateFilter("apertureMax", e.target.value);
                          setDrillOriginFilters((prev) => {
                            const next = new Set(prev);
                            next.delete("apertureMax");
                            return next;
                          });
                        }}
                        placeholder={t("maxExamplePlaceholder", {
                          value: "5.6",
                        })}
                        step="0.1"
                        type="number"
                        value={filters.apertureMax || ""}
                      />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {(
                        ["f/1.4-2.8", "f/2.8-5.6", "f/5.6-11", "f/11+"] as const
                      ).map((preset) => (
                        <button
                          className="rounded-[3px] bg-secondary px-1.5 py-0.5 text-[10px] hover:bg-primary/10"
                          key={preset}
                          onClick={() => applyAperturePreset(preset)}
                          type="button"
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Focal length range */}
                  <div>
                    <label
                      className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
                      htmlFor="search-focal-min"
                    >
                      {t("focalLabel")}
                    </label>
                    <div className="space-y-1">
                      <input
                        className={cn(
                          filterInputClass,
                          drillOriginFilters.has("focalMin") &&
                            "border-primary bg-primary/10 dark:bg-primary/20"
                        )}
                        id="search-focal-min"
                        onChange={(e) => {
                          updateFilter("focalMin", e.target.value);
                          setDrillOriginFilters((prev) => {
                            const next = new Set(prev);
                            next.delete("focalMin");
                            return next;
                          });
                        }}
                        placeholder={t("minExamplePlaceholder", {
                          value: "24",
                        })}
                        type="number"
                        value={filters.focalMin || ""}
                      />
                      <input
                        className={cn(
                          filterInputClass,
                          drillOriginFilters.has("focalMax") &&
                            "border-primary bg-primary/10 dark:bg-primary/20"
                        )}
                        onChange={(e) => {
                          updateFilter("focalMax", e.target.value);
                          setDrillOriginFilters((prev) => {
                            const next = new Set(prev);
                            next.delete("focalMax");
                            return next;
                          });
                        }}
                        placeholder={t("maxExamplePlaceholder", {
                          value: "200",
                        })}
                        type="number"
                        value={filters.focalMax || ""}
                      />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {(
                        ["<35mm", "35-85mm", "85-200mm", ">200mm"] as const
                      ).map((preset) => (
                        <button
                          className="rounded-[3px] bg-secondary px-1.5 py-0.5 text-[10px] hover:bg-primary/10"
                          key={preset}
                          onClick={() => applyFocalPreset(preset)}
                          type="button"
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Shutter speed range */}
                  <div>
                    <label
                      className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
                      htmlFor="search-shutter-min"
                    >
                      {t("shutterSpeedLabel")}
                    </label>
                    <div className="flex gap-2">
                      <input
                        className={cn(
                          filterInputClass,
                          drillOriginFilters.has("shutterMin") &&
                            "border-primary bg-primary/10 dark:bg-primary/20"
                        )}
                        id="search-shutter-min"
                        onChange={(e) => {
                          updateFilter("shutterMin", e.target.value);
                          setDrillOriginFilters((prev) => {
                            const next = new Set(prev);
                            next.delete("shutterMin");
                            return next;
                          });
                        }}
                        placeholder={t("shutterSpeedMin")}
                        type="text"
                        value={filters.shutterMin || ""}
                      />
                      <input
                        className={cn(
                          filterInputClass,
                          drillOriginFilters.has("shutterMax") &&
                            "border-primary bg-primary/10 dark:bg-primary/20"
                        )}
                        onChange={(e) => {
                          updateFilter("shutterMax", e.target.value);
                          setDrillOriginFilters((prev) => {
                            const next = new Set(prev);
                            next.delete("shutterMax");
                            return next;
                          });
                        }}
                        placeholder={t("shutterSpeedMax")}
                        type="text"
                        value={filters.shutterMax || ""}
                      />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {(["1/1000+", "1/100-1/10", "1s+", "30s+"] as const).map(
                        (preset) => (
                          <button
                            className="rounded-[3px] bg-secondary px-1.5 py-0.5 text-[10px] hover:bg-primary/10"
                            key={preset}
                            onClick={() => applyShutterPreset(preset)}
                            type="button"
                          >
                            {preset}
                          </button>
                        )
                      )}
                    </div>
                  </div>
                </div>

                <FilterPresets
                  currentFilters={filters}
                  onLoadPreset={(loadedFilters) => {
                    setFilters(loadedFilters);
                  }}
                />
                <div className="mt-3 flex items-center justify-between border-border border-t pt-2">
                  <span className="text-[10px] text-muted-foreground/70">
                    {t("enterToSearch")}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      className="min-h-8 rounded-[4px] px-2 text-[11px] text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
                      onClick={() => {
                        clearFilters();
                        setShowFilters(false);
                      }}
                      type="button"
                    >
                      {t("reset")}
                    </button>
                    <button
                      className="min-h-8 rounded-[4px] bg-primary/10 px-2 font-medium text-[11px] text-primary hover:bg-primary/20"
                      onClick={() => {
                        onSearch(
                          query.trim(),
                          hasActiveFilters ? filters : undefined
                        );
                        setShowFilters(false);
                      }}
                      type="button"
                    >
                      {t("applyFilters")}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Search suggestions dropdown */}
          {showSuggestionPanel && (
            <div
              className="absolute top-full left-4 z-[60] mt-1 w-[min(960px,calc(100%-32px))] overflow-y-auto overscroll-contain rounded-[10px] border border-border bg-popover shadow-xl outline-none ring-1 ring-foreground/5"
              data-overlay-kind="search-suggestions"
              data-surface="overlay"
              id="search-suggestions-listbox"
              onBlur={(e) => {
                // 焦点离开建议列表且没有回到 input 时关闭
                const related = e.relatedTarget as Node | null;
                if (
                  related &&
                  (suggestionListRef.current?.contains(related) ||
                    related === inputRef.current)
                ) {
                  return;
                }
                setShowSuggestions(false);
                setSuggestionIndex(-1);
              }}
              onKeyDown={handleSuggestionKeyDown}
              ref={(node) => {
                (
                  dropdownRef as React.MutableRefObject<HTMLDivElement | null>
                ).current = node;
                (
                  suggestionListRef as React.MutableRefObject<HTMLDivElement | null>
                ).current = node;
              }}
              role="listbox"
              style={{ maxHeight: Math.min(440, floatingPanelMaxHeight) }}
              tabIndex={0}
            >
              {query.trim() ? (
                <>
                  <div className="flex items-center justify-between px-3 py-1.5">
                    <span className="font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                      {t("searchSuggestions")}
                    </span>
                  </div>
                  {suggestions.map((s, i) => (
                    <button
                      aria-selected={i === suggestionIndex}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
                        i === suggestionIndex
                          ? "bg-foreground/8 text-foreground"
                          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                      }`}
                      data-suggestion-index={i}
                      id={`search-suggestion-${i}`}
                      key={`${s.type}-${s.text}`}
                      onClick={() => handleSuggestionClick(s)}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setSuggestionIndex(i)}
                      role="option"
                      tabIndex={-1}
                      type="button"
                    >
                      {s.type === "dictionary" ? (
                        <>
                          <Search className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
                          <span className="truncate">{s.text}</span>
                          {s.category && (
                            <span className="ml-auto flex-shrink-0 rounded-[3px] bg-primary/10 px-1 text-[10px] text-primary/70">
                              {s.category}
                            </span>
                          )}
                        </>
                      ) : s.type === "tag" ? (
                        <>
                          <span
                            className="h-2 w-2 flex-shrink-0 rounded-full"
                            style={{ background: s.color }}
                          />
                          <span className="truncate">{s.text}</span>
                          <span className="ml-auto flex-shrink-0 rounded-[3px] bg-green-500/10 px-1 text-[10px] text-green-500">
                            标签
                          </span>
                        </>
                      ) : (
                        <>
                          <Clock className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
                          <span className="truncate">{s.text}</span>
                        </>
                      )}
                    </button>
                  ))}
                </>
              ) : (
                <>
                  {/*
                    自用版（用户口径："去掉这个提示"）：搜索框为空时那条
                    「今天 / 本周 / 本月 / 今年 / 去年」快捷筛选，属于"搜索提示"，
                    与下面的「试试这样搜索」引导**同类** —— 一起由 hideSearchHints 关掉 ✓。
                    （功能本身没删：直接在搜索框里打"今天"这类词，语义搜索照样会解析时间范围 ✓）
                  */}
                  {!PRIVATE_BUILD.hideSearchHints && (
                  <div className="flex flex-wrap items-center gap-1.5 border-border border-b px-3 py-2">
                    <Clock className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" />
                    {timePresets.map((preset) => (
                      <button
                        className="rounded-[4px] border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
                        key={preset.label}
                        onClick={() => {
                          const range = preset.getRange();
                          const nextFilters: ExifFilters = {
                            ...filters,
                            dateFrom: range.dateFrom,
                            dateTo: range.dateTo,
                          };
                          setFilters(nextFilters);
                          setShowSuggestions(false);
                          queueMicrotask(() => onSearch("", nextFilters));
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        type="button"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  )}
                  {/* 自用版：去掉「试试这样搜索」引导区（见 private-build.ts 的 hideSearchHints） */}
                  {!PRIVATE_BUILD.hideSearchHints && (
                    <>
                  <div className="px-3 pt-2.5 pb-1.5">
                    <div className="font-medium text-[12px] text-foreground">
                      {t("searchStarterTitle")}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground/70">
                      {t("searchStarterDescription")}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 px-3 pb-2.5">
                    {searchExamples.map((example, i) => (
                      <button
                        aria-selected={
                          !examplesDisabled && i === suggestionIndex
                        }
                        className={cn(
                          "flex min-w-0 items-center gap-2 rounded-[6px] border border-border px-2.5 py-2 text-left text-[12px] transition-colors",
                          examplesDisabled
                            ? "cursor-not-allowed text-muted-foreground/50"
                            : i === suggestionIndex
                              ? "border-primary/30 bg-primary/10 text-primary"
                              : "text-muted-foreground hover:border-primary/20 hover:bg-primary/5 hover:text-foreground"
                        )}
                        data-suggestion-index={examplesDisabled ? undefined : i}
                        disabled={examplesDisabled}
                        id={
                          examplesDisabled
                            ? undefined
                            : `search-suggestion-${i}`
                        }
                        key={example.text}
                        onClick={() => handleSuggestionClick(example)}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => {
                          if (!examplesDisabled) {
                            setSuggestionIndex(i);
                          }
                        }}
                        role="option"
                        tabIndex={-1}
                        type="button"
                      >
                        <Search className="h-3.5 w-3.5 flex-shrink-0" />
                        <span className="truncate">{example.text}</span>
                      </button>
                    ))}
                  </div>
                  {examplesDisabled && (
                    <div className="mx-3 mb-2 rounded-[5px] bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                      {t("searchStarterAiUnavailable")}
                    </div>
                  )}
                  <div className="border-border border-t px-3 py-2 text-[10px] text-muted-foreground/70">
                    {t("searchStarterWildcardHint")}
                  </div>
                    </>
                  )}
                  {recentSuggestions.length > 0 && (
                    <>
                      <div className="flex items-center justify-between border-border border-t px-3 py-1.5">
                        <span className="font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                          {t("recentSearches")}
                        </span>
                        <button
                          className="text-[10px] text-muted-foreground/70 hover:text-foreground"
                          onClick={clearHistory}
                          tabIndex={-1}
                          type="button"
                        >
                          {t("clearAll")}
                        </button>
                      </div>
                      {recentSuggestions.map((s, historyIndex) => {
                        const i =
                          (examplesDisabled ? 0 : searchExamples.length) +
                          historyIndex;
                        return (
                          <SuggestionButton
                            index={i}
                            isActive={i === suggestionIndex}
                            key={`${s.type}-${s.text}`}
                            onClick={() => handleSuggestionClick(s)}
                            onMouseEnter={() => setSuggestionIndex(i)}
                            suggestion={s}
                          />
                        );
                      })}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </search>
      );
    }
  ),
  (prevProps, nextProps) => {
    if (prevProps.aiStatus !== nextProps.aiStatus) {
      return false;
    }
    if (
      (prevProps.activeTagIds ?? []).join(",") !==
      (nextProps.activeTagIds ?? []).join(",")
    ) {
      return false;
    }
    if (prevProps.colorHex !== nextProps.colorHex) {
      return false;
    }
    if (prevProps.imageSearchActive !== nextProps.imageSearchActive) {
      return false;
    }
    if (
      prevProps.imageSearchReference?.imagePath !==
        nextProps.imageSearchReference?.imagePath ||
      prevProps.imageSearchReference?.previewDataUrl !==
        nextProps.imageSearchReference?.previewDataUrl
    ) {
      return false;
    }
    if (prevProps.onTagRemove !== nextProps.onTagRemove) {
      return false;
    }
    if (prevProps.onTagClear !== nextProps.onTagClear) {
      return false;
    }
    if (prevProps.onTagSelect !== nextProps.onTagSelect) {
      return false;
    }
    if (prevProps.query !== nextProps.query) {
      return false;
    }
    if (prevProps.resetVersion !== nextProps.resetVersion) {
      return false;
    }
    if (prevProps.filters !== nextProps.filters) {
      return false;
    }
    if (prevProps.drillDownFilters !== nextProps.drillDownFilters) {
      return false;
    }
    if (
      prevProps.filterBarLeadingContent !== nextProps.filterBarLeadingContent
    ) {
      return false;
    }
    if (
      prevProps.filterBarTrailingContent !== nextProps.filterBarTrailingContent
    ) {
      return false;
    }
    if (prevProps.resultCount !== nextProps.resultCount) {
      return false;
    }
    if (prevProps.searchMode !== nextProps.searchMode) {
      return false;
    }
    if (prevProps.searchTime !== nextProps.searchTime) {
      return false;
    }
    if (prevProps.leadingContent !== nextProps.leadingContent) {
      return false;
    }
    if (prevProps.trailingContent !== nextProps.trailingContent) {
      return false;
    }
    return true;
  }
);

function SuggestionButton({
  suggestion,
  index,
  isActive,
  onClick,
  onMouseEnter,
}: {
  suggestion: SearchSuggestion;
  index: number;
  isActive: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  return (
    <button
      aria-selected={isActive}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors",
        isActive
          ? "bg-foreground/8 text-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
      )}
      data-suggestion-index={index}
      id={`search-suggestion-${index}`}
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onMouseEnter}
      role="option"
      tabIndex={-1}
      type="button"
    >
      <Clock className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
      <span className="truncate">{suggestion.text}</span>
    </button>
  );
}

function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  const { t } = useTranslation();

  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-[4px] bg-primary/10 px-2 py-0.5 font-medium text-[10px] text-primary">
      <span className="min-w-0 flex-1 break-all">{label}</span>
      <button
        aria-label={t("removeSearchFilter", { label })}
        className="-mr-1 ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-primary/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onRemove}
        type="button"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
