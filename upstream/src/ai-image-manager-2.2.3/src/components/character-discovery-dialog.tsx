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
  /** 组里有多少张多人图（≥2 人）；由服务端算好（2026-11-14 会话#12） */
  multiPhotoCount?: number;
  /** 组里最多几个人 = 一次最多能命名几个角色 */
  maxPersonCount?: number;
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
type GroupPhoto = LightboxPhoto & {
  /** 这张图里有几个人（服务端算好；≥2 时缩略图右上角标数字） */
  personCount?: number;
};

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
  /**
   * 多人图命名（2026-11-14 · 会话#12，按用户口径重做）：
   *   · 用户原话：「多人图的话支持在列表里多选名字，而不是这样一列下来，
   *     因为本身打标也不能具体到角色」→ 名字当**可多选的 chips**：
   *     一个输入框 + 一个「添加」，加完变成 chip（可删）。
   *   · 「只选一个名字就按单人图处理」（抱枕图：一张图多张脸但同一个人）
   *     → 提交时 targets 只有 1 个，服务端就写全部照片。
   *   · 每个 chip 可能是**手输的新名字**，也可能是从建议里点的**已有标签**
   *     （后者带 `tagId`，服务端直接用它、不新建同名标签）。
   */
  const [extraNames, setExtraNames] = useState<
    Record<number, Array<{ name: string; tagId?: number }>>
  >({});
  const [extraDraft, setExtraDraft] = useState<Record<number, string>>({});
  /** 附加名字输入框的**标签检索建议**（与主输入框同一套接口） */
  const [extraSuggestions, setExtraSuggestions] = useState<
    Record<number, TagSuggestion[]>
  >({});
  const [extraSuggestionTotals, setExtraSuggestionTotals] = useState<
    Record<number, number>
  >({});
  const extraSearchTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>(
    {}
  );
  const [multiOff, setMultiOff] = useState<Record<number, boolean>>({});
  const [picked, setPicked] = useState<Record<number, TagSuggestion | null>>({});
  /** 每个输入框的检索**命中总数**（> matches.length 时提示"还有 N 个"）。 */
  const [suggestionTotals, setSuggestionTotals] = useState<
    Record<number, number>
  >({});
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
    /** 这次**实际会写入**的张数（有勾选就是勾选数，没勾选才是整组） */
    count: number;
    /** 整组张数，用来在"只勾了部分"时把话说清楚 */
    groupSize: number;
    index: number;
    /** 全部要写入的名字（第一个是主名字） */
    names: string[];
    /** 其中"会新建角色"的个数（手输的新名字才算） */
    createsCount: number;
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
            limit: 50,
          })) as { matches: TagSuggestion[]; total?: number };
          setSuggestions((prev) => ({
            ...prev,
            [index]: result?.matches ?? [],
          }));
          setSuggestionTotals((prev) => ({
            ...prev,
            [index]: result?.total ?? result?.matches?.length ?? 0,
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

  /**
   * 自用（2026-11-08 · 会话#11 用户口径）：
   * 「≤5 张就不用再展开了，直接在小图上操作就可以了」
   *
   * 于是 ≤5 张的组：进弹窗就把**真实照片**拉回来（每组 ≤5 张，很轻），
   * 让那一排小图带勾选圈。为什么不直接给预览缩略图加圈：预览只有路径、没有 photo.id；
   * 而且服务端给预览时是「代表图排第一」的**另一种顺序**（`previewIds`），
   * 拿下标猜 id 会**勾错图** ✗ —— 所以宁可多一次按组拉取，也要拿到真实 id ✓
   * 用 `loadingSmallRef` 防重复请求；拉失败了就维持"点小图看大图"的老样子，不影响列表。
   * ⚠️ 结果是**一次性合并回填**：列表最多 200 组，逐组 setState 会触发上百次重渲染（界面会卡一下）。
   */
  const loadingSmallRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!(open && groups)) {
      return;
    }
    const pending = groups.filter(
      (group) =>
        group.size > 0 &&
        group.size <= 5 &&
        !groupPhotos[group.representativeId] &&
        !loadingSmallRef.current.has(group.representativeId)
    );
    if (pending.length === 0) {
      return;
    }
    for (const group of pending) {
      loadingSmallRef.current.add(group.representativeId);
    }
    void (async () => {
      const loaded: Array<[number, GroupPhoto[]]> = [];
      await Promise.all(
        pending.map(async (group) => {
          try {
            const result = (await faceActions.getCharacterGroupPhotos(
              group.photoIds
            )) as { photos?: GroupPhoto[] };
            loaded.push([group.representativeId, result?.photos ?? []]);
          } catch {
            // 拉失败 → 退化成不可勾选（仍可点开大图）；删掉记录，下次再试
            loadingSmallRef.current.delete(group.representativeId);
          }
        })
      );
      if (loaded.length === 0) {
        return;
      }
      setGroupPhotos((prev) => {
        const next = { ...prev };
        for (const [key, photos] of loaded) {
          next[key] = photos;
        }
        return next;
      });
    })();
  }, [open, groups, groupPhotos]);

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

  /**
   * 自用（2026-10-23 · 会话#10）：**点缩影也能看大图**。
   * 用户反馈：少于 5 张的组没有「展开」按钮，于是没有看大图的入口。
   * 这里点缩略图 → 先按需拉整组照片（缓存）→ 打开大图，并停在被点的那张。
   */
  async function openLightboxAt(
    index: number,
    group: CharacterGroupView,
    thumbIndex: number
  ) {
    const key = group.representativeId;
    let photos = groupPhotos[key];
    if (!photos || photos.length === 0) {
      setLoadingGroup(key);
      try {
        const result = (await faceActions.getCharacterGroupPhotos(
          group.photoIds
        )) as { photos?: GroupPhoto[] };
        photos = result?.photos ?? [];
        setGroupPhotos((prev) => ({ ...prev, [key]: photos as GroupPhoto[] }));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return;
      } finally {
        setLoadingGroup(null);
      }
    }
    if (photos && photos.length > 0) {
      setLightbox({
        index: Math.min(thumbIndex, photos.length - 1),
        photos,
      });
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
   * 一键全选（2026-11-08 · 会话#11 用户口径）：
   * 「一两百张里只有几张不对，却要把其他需要的全部点一遍，太麻烦」
   * → 先全选、再把不对的那几张点掉就行。
   * ⚠️ 不要做成"全选/全不选"切换：这里的**空集 = 整组**（不勾选就是整组打标），
   * 「全不选」会变成"反而给整组打标"，是反的、会误操作 ✗ —— 取消用「清空勾选」。
   */
  function selectAll(key: number, list: GroupPhoto[]) {
    setSelection((prev) => ({
      ...prev,
      [key]: new Set(list.map((photo) => photo.id)),
    }));
  }

  /**
   * 反选（2026-11-14 · 会话#12 用户口径：「展开的这部分需要有多选」+ 与「多人图只有一个名字」
   * 对话框统一按钮位置/样式）。
   * 语义：已勾的取消、没勾的勾上；反选后若一个都没有 → 变回「整组」（空集 = 整组）。
   */
  function invertSelection(key: number, list: GroupPhoto[]) {
    setSelection((prev) => {
      const current = prev[key] ?? new Set<number>();
      return {
        ...prev,
        [key]: new Set(
          list.map((photo) => photo.id).filter((id) => !current.has(id))
        ),
      };
    });
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

  /**
   * 这一组最多能命名几个角色：
   *   · 有 ≥2 人的图 → 组内最大人数（服务端算好，最多 6）；
   *   · 全是单人 → 1（不显示多名字界面）。
   */
  function maxPeopleOf(group: CharacterGroupView): number {
    if ((group.multiPhotoCount ?? 0) === 0) {
      return 1;
    }
    return Math.min(6, Math.max(2, group.maxPersonCount ?? 2));
  }

  /** 多名字是否生效：有人数≥2 的图 **且** 用户没手动关掉 */
  function isMultiEnabled(index: number, group: CharacterGroupView): boolean {
    return maxPeopleOf(group) > 1 && multiOff[index] !== true;
  }

  /** 附加名字输入：边打字边检索已有标签（与主输入框同一套 `searchCharacterTags`） */
  function updateExtraDraft(index: number, value: string) {
    setExtraDraft((prev) => ({ ...prev, [index]: value }));
    const timer = extraSearchTimers.current[index];
    if (timer) {
      clearTimeout(timer);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setExtraSuggestions((prev) => ({ ...prev, [index]: [] }));
      return;
    }
    extraSearchTimers.current[index] = setTimeout(() => {
      void (async () => {
        try {
          const result = (await faceActions.searchCharacterTags({
            query: trimmed,
            limit: 50,
          })) as { matches: TagSuggestion[]; total?: number };
          setExtraSuggestions((prev) => ({
            ...prev,
            [index]: result?.matches ?? [],
          }));
          setExtraSuggestionTotals((prev) => ({
            ...prev,
            [index]: result?.total ?? result?.matches?.length ?? 0,
          }));
        } catch {
          /* 检索失败不影响手输新名字 */
        }
      })();
    }, 250);
  }

  /** 往 chips 里加一个名字（去重、不许空、不超过"组内最大人数 − 1"） */
  function pushExtra(
    index: number,
    group: CharacterGroupView,
    entry: { name: string; tagId?: number }
  ) {
    const limit = Math.max(0, maxPeopleOf(group) - 1);
    setExtraNames((prev) => {
      const current = prev[index] ?? [];
      if (current.length >= limit) {
        return prev;
      }
      const key = entry.name.toLowerCase();
      const duplicated = current.some(
        (item) =>
          item.name.toLowerCase() === key ||
          (entry.tagId != null && item.tagId === entry.tagId)
      );
      if (duplicated) {
        return prev;
      }
      return { ...prev, [index]: [...current, entry] };
    });
    setExtraDraft((prev) => ({ ...prev, [index]: "" }));
    setExtraSuggestions((prev) => ({ ...prev, [index]: [] }));
  }

  /** 手输的名字 → 交给服务端按名字新建标签 */
  function addExtraName(index: number, group: CharacterGroupView) {
    const raw = (extraDraft[index] ?? "").trim();
    if (!raw) {
      return;
    }
    pushExtra(index, group, { name: raw });
  }

  /** 点建议 → 用**已有标签**（带 tagId，避免新建同名标签） */
  function pickExtraSuggestion(
    index: number,
    group: CharacterGroupView,
    suggestion: TagSuggestion
  ) {
    pushExtra(index, group, { name: suggestion.name, tagId: suggestion.id });
  }

  function removeExtraName(index: number, chip: number) {
    setExtraNames((prev) => {
      const current = prev[index] ?? [];
      return { ...prev, [index]: current.filter((_, position) => position !== chip) };
    });
  }

  /** 点「命名」：导入已有标签要先二次确认；手动新建直接执行。 */
  function requestName(index: number) {
    const group = groups?.[index];
    const choice = picked[index] ?? null;
    if (!group) {
      return;
    }
    if (choice) {
      /*
       * 2026-11-14（会话#12）：多选名字后确认框要**把全部名字说清楚**，
       * 并且区分"只是用已有标签"还是"其中还有手输的新名字（会新建角色）"。
       */
      const extras = isMultiEnabled(index, group) ? (extraNames[index] ?? []) : [];
      setConfirmImport({
        count: targetPhotoIds(index, group).length,
        createsCount: extras.filter((item) => item.tagId == null).length,
        groupSize: group.size,
        index,
        names: [choice.name, ...extras.map((item) => item.name)],
        suggestion: choice,
      });
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
    /*
     * 多人图命名（2026-11-14 · 会话#12）：第一个名字用于全部照片，
     * 第 2 个起只写"人数 ≥2"的图（服务端分流）。
     * ⚠️ 用户口径：**只选一个名字就按单人图处理**（抱枕图等一张图多张脸但同一角色）
     *    —— 此时 extras 为空，targets 只有 1 个，服务端会写全部照片 ✓
     */
    const extras =
      group && isMultiEnabled(index, group) ? (extraNames[index] ?? []) : [];
    const targets = [
      ...(choice ? [{ tagId: choice.id }] : typed ? [{ name: typed }] : []),
      // 已有标签带 tagId；手输的走 name（服务端按名字新建）
      ...extras.map((item) =>
        item.tagId != null ? { tagId: item.tagId } : { name: item.name }
      ),
    ];
    if (targets.length === 0) {
      return;
    }
    setNamingIndex(index);
    try {
      const result = (await faceActions.nameCharacterGroup({
        targets,
        // 有勾选就只命名勾选的；没勾选是整组（用户口径：未选中维持原样）
        photoIds: targetPhotoIds(index, group),
        confidence: group.meanSimilarity,
        groupIndex: index,
      })) as {
        applied: number;
        attempted: number;
        tagId: number;
        tagName: string;
        /** 每个名字各自的写入情况（多人图命名时长度 > 1） */
        tags?: Array<{
          tagId: number;
          tagName: string;
          applied: number;
          attempted: number;
        }>;
        multiCount?: number;
        /** 整组是否全部命名完（false = 还有照片留在列表里） */
        namedAll?: boolean;
        remaining?: number;
      };
      if ((result.tags?.length ?? 0) > 1) {
        // 多个名字：一句话报总数（逐名字的明细太啰嗦）
        toast.success(
          t("characterDiscoveryMultiNamed", {
            count: result.tags?.length ?? 0,
            applied: result.applied,
          })
        );
        setExtraNames((prev) => ({ ...prev, [index]: [] }));
      } else {
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
      }
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
      /*
       * 自用（2026-11-11 用户报「19 张里只命名了 1 张，剩 18 张同角色，但整组也一起消失了」）：
       * 以前**无条件**把整组从列表里删掉 → 剩下没命名的同角色照片再也不会出现 ✗
       * 现在：整组都命名完 → 移除；只命名了一部分 → 组留着，只把已命名的那几张摘掉 ✓
       */
      if (result.namedAll === false) {
        const namedIds = new Set(targetPhotoIds(index, group));
        setGroups((prev) => {
          if (!prev) {
            return prev;
          }
          const next = prev.map((item, i) => {
            if (i !== index) {
              return item;
            }
            const rest = item.photoIds.filter((id) => !namedIds.has(id));
            const nextRepresentative = rest[0] ?? item.representativeId;
            return {
              ...item,
              photoIds: rest,
              size: rest.length,
              representativeId: nextRepresentative,
            };
          });
          // 张数归 0 且没命名过的组不再保留（否则会留一条 "0 张" 的空组）
          return next.filter(
            (item) => item.size > 0 || item.namedTagId != null
          );
        });
        /*
         * ⚠️ 2026-11-14（会话#12，用户报「命名完成之后缩略图会炸开，全部显示出来」·偶发）：
         * 组的张数变少（≤5）后，左侧那排小图会走"整组就这几张"的分支，
         * 而 `groupPhotos` 缓存里**还是命名前那几十张** → 一次全渲染出来 ✗
         * 所以这里把已命名的从缓存里也摘掉（缓存按代表图 id 存，键可能已经变，两个键都处理）。
         */
        setGroupPhotos((prev) => {
          const keys = [group.representativeId];
          const next = { ...prev };
          let changed = false;
          for (const key of keys) {
            const list = next[key];
            if (!list || list.length === 0) {
              continue;
            }
            const rest = list.filter((photo) => !namedIds.has(photo.id));
            if (rest.length !== list.length) {
              next[key] = rest;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        // 这组已经改过内容，勾选状态作废
        setSelection((prev) => {
          const next = { ...prev };
          delete next[group.representativeId];
          return next;
        });
      } else {
        // 用户口径：整组命名完的组**从"发现"列表里消失**（不再显示）
        setGroups((prev) =>
          prev ? prev.filter((_, i) => i !== index) : prev
        );
      }
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
              /**
               * ≤5 张的组：这一排小图就是整组，所以要有勾选圈（见上面的 auto-load effect）。
               * >5 张的组仍用预览缩略图，勾选去展开区里做。
               *
               * ⚠️ 2026-11-14（会话#12）：必须按**当前** `group.photoIds` 过滤 ——
               * 命名后组变小、而 `groupPhotos` 缓存可能还是命名前那几十张，
               * 不滤就会"整组缩略图全炸开"（用户实测·偶发）。
               */
              const currentIds = new Set(group.photoIds);
              const inlinePhotos =
                group.size <= 5
                  ? photos
                      .filter((photo) => currentIds.has(photo.id))
                      .slice(0, 5)
                  : [];
              /**
               * 2026-11-14（会话#12，用户反馈「怪怪的，改成返回十张，这样缩略图显示就能对齐了，
               * 单角色一排，多角色两排」）：
               * 统一 **5 列**：单人组一排 5 张、多人组两排 10 张 —— 列宽一致、组与组之间才对得齐。
               */
              const previewLimit = (group.multiPhotoCount ?? 0) > 0 ? 10 : 5;
              const previewRows = previewLimit > 5;
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
                    <div className="flex shrink-0 items-start gap-1">
                      <div
                        className={
                          previewRows
                            ? "grid grid-cols-5 items-center gap-1"
                            : "flex items-center gap-1"
                        }
                      >
                      {/* ≤5 张：整组就在这一排里 → 小图直接能勾选（不用先展开） */}
                      {group.size <= 5 && inlinePhotos.length > 0
                        ? inlinePhotos.map((photo, inlineIndex) => {
                            const picked = chosen.has(photo.id);
                            return (
                              <div className="relative" key={photo.id}>
                                <button
                                  aria-label={t(
                                    "characterDiscoveryToggleSelect"
                                  )}
                                  aria-pressed={picked}
                                  className={`absolute top-0.5 left-0.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors ${
                                    picked
                                      ? "border-primary bg-primary text-white"
                                      : "border-white/80 bg-black/35 hover:bg-black/60"
                                  }`}
                                  onClick={() => toggleSelect(groupKey, photo.id)}
                                  type="button"
                                >
                                  {picked && <Check className="h-3 w-3" />}
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
                                    photo.thumbnailPath || photo.path
                                  )}
                                />
                              </div>
                            );
                          })
                        : group.thumbnails
                            .slice(0, previewLimit)
                            .map((thumb, thumbIndex) => (
                            <LazyThumb
                              className="h-12 w-12 cursor-zoom-in rounded-[4px]"
                              key={thumb}
                              onClick={() =>
                                void openLightboxAt(index, group, thumbIndex)
                              }
                              src={toLocalMediaUrl(thumb)}
                            />
                          ))}
                      </div>
                      {/* 展开/收起：看整组图 + 勾选部分图（用户要求）
                          2026-11-08 · 会话#11：**>5 张才展开**（≤5 张全部缩略图已经列出来了，
                          按用户口径"直接在 5 张小图上勾选"就够，不需要再展开一层）✓ */}
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
                        {(group.multiPhotoCount ?? 0) > 0 && (
                          <div className="mt-1 rounded-[4px] border border-dashed border-border bg-secondary/40 p-1.5">
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-[11px] text-muted-foreground">
                                {t("characterDiscoveryMultiHint", {
                                  count: group.multiPhotoCount ?? 0,
                                  max: maxPeopleOf(group),
                                })}
                              </span>
                              <button
                                className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                                onClick={() =>
                                  setMultiOff((prev) => ({
                                    ...prev,
                                    [index]: isMultiEnabled(index, group),
                                  }))
                                }
                                type="button"
                              >
                                {isMultiEnabled(index, group)
                                  ? t("characterDiscoveryMultiOnlyOne")
                                  : t("characterDiscoveryMultiAgain")}
                              </button>
                            </div>
                            {isMultiEnabled(index, group) && (
                              <>
                                {(extraNames[index] ?? []).length > 0 && (
                                  <div className="mt-1 flex flex-wrap gap-1">
                                    {(extraNames[index] ?? []).map((item, chip) => (
                                      <span
                                        className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-foreground"
                                        key={`${item.name}-${chip}`}
                                      >
                                        {item.name}
                                        <button
                                          aria-label={t("characterDiscoveryRemoveName")}
                                          className="text-muted-foreground transition-colors hover:text-destructive"
                                          onClick={() => removeExtraName(index, chip)}
                                          type="button"
                                        >
                                          ×
                                        </button>
                                      </span>
                                    ))}
                                  </div>
                                )}
                                {(extraNames[index] ?? []).length <
                                  Math.max(0, maxPeopleOf(group) - 1) && (
                                  <div className="mt-1 flex items-center gap-1">
                                    <input
                                      className="min-w-0 flex-1 rounded-[4px] border border-border bg-secondary px-2 py-1 text-[12px] text-foreground outline-none focus:border-foreground/40"
                                      onChange={(event) =>
                                        updateExtraDraft(index, event.target.value)
                                      }
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter") {
                                          event.preventDefault();
                                          addExtraName(index, group);
                                        }
                                      }}
                                      placeholder={t("characterDiscoveryExtraNamePlaceholder")}
                                      value={extraDraft[index] ?? ""}
                                    />
                                    <button
                                      className="shrink-0 rounded-[4px] border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                                      onClick={() => addExtraName(index, group)}
                                      type="button"
                                    >
                                      {t("characterDiscoveryAddName")}
                                    </button>
                                  </div>
                                )}
                                {/* 附加名字也支持检索已有标签（用户反馈：这个框不能检索） */}
                                {(extraSuggestions[index] ?? []).length > 0 && (
                                  <div className="mt-1 flex flex-col gap-0.5 rounded-[4px] border border-border bg-secondary/60 p-1">
                                    <span className="px-1 text-[10px] text-muted-foreground">
                                      {t("characterDiscoverySuggestHint")}
                                    </span>
                                    <div className="max-h-32 overflow-y-auto">
                                      {(extraSuggestions[index] ?? []).map((suggestion) => (
                                        <button
                                          className="block w-full rounded-[3px] px-1 py-0.5 text-left text-[12px] text-foreground transition-colors hover:bg-foreground/10"
                                          key={suggestion.id}
                                          onClick={() =>
                                            pickExtraSuggestion(index, group, suggestion)
                                          }
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
                                    {(extraSuggestionTotals[index] ?? 0) >
                                      (extraSuggestions[index] ?? []).length && (
                                      <span className="px-1 text-[10px] text-muted-foreground">
                                        {t("characterDiscoverySuggestMore", {
                                          shown: (extraSuggestions[index] ?? []).length,
                                          total: extraSuggestionTotals[index] ?? 0,
                                        })}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
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
                            <div className="max-h-56 overflow-y-auto">
                            {list.map((suggestion) => (
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
                            {(suggestionTotals[index] ?? 0) > list.length && (
                              <span className="px-1 text-[10px] text-muted-foreground">
                                {t("characterDiscoverySuggestMore", {
                                  shown: list.length,
                                  total: suggestionTotals[index] ?? 0,
                                })}
                              </span>
                            )}
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
                        : t("characterDiscoveryNameApply")}
                  </button>
                  </div>

                  {/* 展开区：整组图 + 左上角勾选圈（点圈勾选、点图看大图） */}
                  {expanded && (
                    <div className="border-border border-t pt-2">
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        {/* 说明文字保留（用户口径：图二的描述需要保留） */}
                        <span>{t("characterDiscoverySelectHint")}</span>
                        <span className="ml-auto text-foreground">
                          {t("characterSingleNamedSelected", {
                            count: chosen.size,
                            total: photos.length,
                          })}
                        </span>
                        {/* 三个按钮固定在右侧、样式与「多人图只认出一个名字」一致 */}
                        <button
                          className="rounded-[3px] border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                          onClick={() => selectAll(groupKey, photos)}
                          type="button"
                        >
                          {t("characterSingleNamedSelectAll")}
                        </button>
                        <button
                          className="rounded-[3px] border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                          onClick={() => invertSelection(groupKey, photos)}
                          type="button"
                        >
                          {t("characterSingleNamedInvert")}
                        </button>
                        <button
                          className="rounded-[3px] border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                          onClick={() => clearSelection(groupKey)}
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
                                {/* 右上角：这张图有几个人（≥2 才显示，用户口径） */}
                                {(photo.personCount ?? 0) >= 2 && (
                                  <span
                                    aria-label={t("characterDiscoveryPersonCountHint", {
                                      count: photo.personCount ?? 0,
                                    })}
                                    className="absolute top-1 right-1 z-10 rounded-full bg-black/65 px-1.5 py-[1px] text-[10px] font-semibold leading-none text-white shadow-sm"
                                    title={t("characterDiscoveryPersonCountHint", {
                                      count: photo.personCount ?? 0,
                                    })}
                                  >
                                    {photo.personCount}
                                  </span>
                                )}
                                {/* 点图片 = 看大图 */}
                                <LazyThumb
                                  className={`h-[76px] w-full cursor-zoom-in rounded-[4px] ${
                                    isPicked ? "ring-2 ring-primary" : ""
                                  }`}
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
            description={(() => {
              const partial = confirmImport.count < confirmImport.groupSize;
              const multi = confirmImport.names.length > 1;
              const createdNote =
                confirmImport.createsCount > 0
                  ? t("manualImportCreatesRoles", {
                      count: confirmImport.createsCount,
                    })
                  : t("manualImportNoNewRoles");
              const key = multi
                ? partial
                  ? "manualImportBodyMultiPartial"
                  : "manualImportBodyMulti"
                : partial
                  ? "manualImportBodyPartial"
                  : "manualImportBody";
              return t(key, {
                count: confirmImport.count,
                createdNote,
                groupSize: confirmImport.groupSize,
                name: confirmImport.suggestion.name,
                names: confirmImport.names.join("、"),
                root: confirmImport.suggestion.rootName || "—",
              });
            })()}
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