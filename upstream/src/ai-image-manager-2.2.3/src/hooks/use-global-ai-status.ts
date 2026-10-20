import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";

// ── Types ──────────────────────────────────────────────────────────

export interface GlobalAiProgress {
  canCancel: boolean;
  /**
   * 自用（2026-10）：任务被**暂停**（当前只有打标会暂停）。
   * 暂停时 isRunning 为 false，界面必须靠这个字段决定"进度条还要不要显示"
   * —— 否则按了暂停整条顶栏就消失，用户再也找不到进度和继续入口。
   */
  isPaused?: boolean;
  /**
   * 自用（2026-10-20 · 会话#10）：**被暂停的是哪个任务**。
   *
   * 为什么不能只看 `phase`：暂停后 `phase` 只是个"类任务"标签，而「继续」
   * 必须调对接口 —— 打标要 `batchGenerateTags`（从断点续跑），建向量要
   * `resumeAiIndexing`。早先按 `phase === "embedding"` 猜，暂停打标时被猜成
   * "建向量"，点继续调用的是 resumeAiIndexing → 打标根本没动
   *（用户实测："点继续也不会继续"）。
   */
  pausedKind?: "embedding" | "tagging" | null;
  /**
   * 自用（2026-10-18 · 会话#9）：任务**还在启动**（识别进程正在各自加载模型）。
   * 界面靠它把进度条切成"走马灯"，而不是定在 0% 上看着像卡住。
   */
  isStarting?: boolean;
  /** Whether any background AI task is currently active. */
  isRunning: boolean;
  /**
   * 自用（问题 4）：当前任务的**原始张数**，供界面算"处理速度 / 预估剩余时间"。
   * 只有 AI 特征提取与打标这两个按张数推进的阶段有值，其它阶段为 null。
   */
  processed: number | null;
  total: number | null;
  /** 0–100 aggregate progress percentage. */
  percent: number;
  /** Which kind of task is currently active. */
  phase:
    | "idle"
    | "scanning"
    | "loading-model"
    | "embedding"
    | "tagging"
    /** 自用（会话#9）：人物页「获取全库角色特征」（CCIP 全库重算，几小时级）。 */
    | "character-features"
    | "import-queue";
  /** Human-readable status line for the UI. */
  statusText: string;
}

const IDLE_GLOBAL_AI_PROGRESS: GlobalAiProgress = {
  canCancel: false,
  isRunning: false,
  percent: 0,
  phase: "idle",
  processed: null,
  statusText: "",
  total: null,
};

const GlobalAiStatusContext = createContext<GlobalAiProgress>(
  IDLE_GLOBAL_AI_PROGRESS
);

interface ScanPayload {
  channel: "scan-progress";
  phase: "scanning" | "indexing" | "complete";
  scanned: number;
  total: number;
}

interface AiProgressPayload {
  channel: "ai-progress";
  downloadPercent?: number;
  /** 自用（2026-10）：暂停标记（暂停建向量/打标时由主进程主动推送）。 */
  isPaused?: boolean;
  phase:
    | "idle"
    | "loading"
    | "embedding"
    | "tagging"
    /** 自用（需求 1）：打标被暂停（游标保留，继续即续跑） */
    | "tagging-paused"
    | "complete"
    | "error"
    | "tag-error"
    | "repairing";
  processed: number;
  total: number;
}

/**
 * 自用（2026-10-18 · 会话#9）：CCIP「获取全库角色特征」的进度。
 *
 * 与上面几条不同，它**不是** postMessage 推送，而是主进程里的一份内存计数
 * （`getCcipBuildProgress()`），所以只能由渲染进程按秒轮询。
 */
interface CharacterFeatureProgressPayload {
  done: number;
  embedded: number;
  etaSeconds: number | null;
  failed: number;
  photosPerSecond: number | null;
  running: boolean;
  /** 还在启动识别进程（每个进程各自加载一次模型）。 */
  starting?: boolean;
  total: number;
  /** 这次跑的显卡名字（顶栏写明，一眼看出走没走对路）。 */
  device?: string | null;
  /** 实际开了几个识别进程。 */
  workers?: number;
  workersReady?: number;
  workersTotal?: number;
}

interface QueueTask {
  error?: string;
  failed?: number;
  folderPath: string;
  id: number;
  newPhotoCount?: number;
  photoCount?: number;
  position: number;
  skipped?: number;
  status: "queued" | "scanning" | "embedding" | "done" | "failed" | "cancelled";
}

interface QueueStatusPayload {
  channel: "import-queue-status";
  current: QueueTask | null;
  history: QueueTask[];
  pending: QueueTask[];
}

// ── Helpers ────────────────────────────────────────────────────────

function clampPct(n: number, d: number): number {
  if (d <= 0) {
    return 0;
  }
  return Math.round(Math.min(1, n / d) * 100);
}

function getFolderDisplayName(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, "/").split("/");
  return parts.at(-1) || fullPath;
}

interface QueueHistoryState {
  completedBatchRef: {
    current: {
      folders: number;
      photos: number;
      indexed: number;
      skipped: number;
      failed: number;
    };
  };
  prevQueueDoneIdsRef: { current: Set<number> };
  seenTerminalTaskIdsRef: { current: Set<number> };
}

function processQueueTask(
  task: QueueTask,
  state: QueueHistoryState,
  onFailure: (task: QueueTask) => void
): void {
  if (state.seenTerminalTaskIdsRef.current.has(task.id)) {
    return;
  }
  state.seenTerminalTaskIdsRef.current.add(task.id);
  if (task.status === "done") {
    state.completedBatchRef.current.folders++;
    state.completedBatchRef.current.photos += task.newPhotoCount ?? 0;
    state.completedBatchRef.current.indexed +=
      task.photoCount ?? task.newPhotoCount ?? 0;
    state.completedBatchRef.current.skipped += Math.max(
      0,
      (task.skipped ?? 0) - (task.failed ?? 0)
    );
    state.completedBatchRef.current.failed += task.failed ?? 0;
  } else if (task.status === "failed") {
    onFailure(task);
  }
}

function processQueueHistory(
  history: QueueTask[],
  state: QueueHistoryState,
  onFailure: (task: QueueTask) => void
): boolean {
  if (history.length === 0) {
    return false;
  }
  for (const task of history) {
    processQueueTask(task, state, onFailure);
  }
  const doneIds = new Set(
    history.filter((task) => task.status === "done").map((task) => task.id)
  );
  const hasNewDoneTask = [...doneIds].some(
    (id) => !state.prevQueueDoneIdsRef.current.has(id)
  );
  state.prevQueueDoneIdsRef.current = doneIds;
  return hasNewDoneTask;
}

interface ProgressSnapshot {
  aiPercent: number;
  aiPhase: AiProgressPayload["phase"];
  /** 自用（2026-10）：当前是否处于"已暂停"。 */
  aiIsPaused: boolean;
  /** 自用（问题 4）：原始张数，用于算速度/预估。 */
  aiProcessed: number | null;
  aiText: string;
  aiTotal: number | null;
  /** 自用（会话#9）：角色特征（CCIP）全库构建 —— 是否在跑 / 张数 / 文案 */
  ccipPercent: number;
  ccipProcessed: number | null;
  ccipStarting: boolean;
  ccipText: string;
  ccipTotal: number | null;
  /** 自用（2026-10-17）：角色识别的原始张数，供顶栏算速度 / 预估剩余时间 ✓ */
  hasAi: boolean;
  hasCcip: boolean;
  hasQueue: boolean;
  hasScan: boolean;
  isScanning: boolean;
  queueCurrent: QueueTask | null;
  queuePending: number;
  queueText: string;
  scanPercent: number;
  scanText: string;
}

function getScanSnapshot(scan: ScanPayload | null) {
  const scanActive =
    scan !== null && scan.phase !== "complete" && scan.total > 0;
  const scanPct = scan ? clampPct(scan.scanned, scan.total) : 0;
  let scanText = "";
  if (scan) {
    scanText =
      scan.phase === "indexing"
        ? `导入并生成缩略图 ${scan.scanned}/${scan.total}`
        : `扫描文件中... ${scan.scanned}/${scan.total}`;
  }
  return {
    hasScan: scanActive,
    isScanning: scan?.phase === "scanning" || scan?.phase === "indexing",
    scanPercent: scanPct,
    scanText,
  };
}

function getAiSnapshot(ai: AiProgressPayload | null) {
  const aiActive =
    ai !== null &&
    ai.phase !== "idle" &&
    ai.phase !== "complete" &&
    ai.phase !== "error";
  let aiPct = 0;
  let aiText = "";
  if (ai) {
    if (ai.phase === "loading" || ai.phase === "repairing") {
      aiPct = ai.downloadPercent ?? 0;
      aiText =
        ai.phase === "repairing"
          ? "正在修复向量数据库..."
          : `正在初始化 AI 模型... ${aiPct}%`;
    } else if (ai.phase === "embedding") {
      aiPct = clampPct(ai.processed, ai.total);
      aiText = `AI 特征提取 ${ai.processed}/${ai.total}`;
    } else if (ai.phase === "tagging" || ai.phase === "tagging-paused") {
      aiPct = clampPct(ai.processed, ai.total);
      // 自用（方案 A · 问题 6）：累计口径 + 本次还需，避免看起来像从头重跑
      aiText = `AI 标签生成 ${ai.processed}/${ai.total}（还需 ${Math.max(0, ai.total - ai.processed)}）`;
    }
  }
  return {
    hasAi: aiActive,
    aiIsPaused: ai?.isPaused === true,
    aiPhase: ai?.phase ?? "idle",
    aiPercent: aiPct,
    // 自用（问题 4）：把原始张数一并带出去（特征提取/打标才有意义）
    aiProcessed: ai?.processed ?? null,
    aiText,
    aiTotal: ai?.total ?? null,
  };
}
/**
 * 自用（2026-10-18 · 会话#9）：角色特征（CCIP）全库构建的快照。
 *
 * 用户口径：「没有进度条我也不知道它识别特征到什么程度、有没有出问题」
 * —— 所以这里除了百分比，还要把 **已处理/总数/已写入/失败** 都摆到顶栏上，
 * 失败数不为 0 时直接把「失败 N 张」写进文案，肉眼就能看出是不是出了问题 ✓。
 */
function getCcipSnapshot(ccip: CharacterFeatureProgressPayload | null) {
  const running = ccip?.running === true;
  const total = ccip?.total ?? 0;
  const done = ccip?.done ?? 0;
  const failed = ccip?.failed ?? 0;
  /*
   * 自用（2026-10-18 · 会话#9）：**启动阶段**要单独说清楚。
   * 每个识别进程都要各自加载一次模型，4 个进程并行加载要十几秒；
   * 这段时间如果只显示"0/65003、0 张/秒"，用户会以为卡死 ✗
   * → 显示「正在启动识别进程 2/4…」，并且用走马灯（不显示百分比）。
   */
  const starting =
    running && total > 0 && (ccip?.starting === true || done === 0);
  const device = ccip?.device ? ` · 显卡：${ccip.device}` : "";
  const workers = ccip?.workers ? ` · ${ccip.workers} 进程` : "";
  let text = "";
  if (starting) {
    const ready = ccip?.workersReady ?? 0;
    const totalWorkers = ccip?.workersTotal ?? 0;
    text =
      totalWorkers > 0
        ? `角色特征提取：正在启动识别进程 ${ready}/${totalWorkers}（每个进程要加载一次模型）${device}`
        : "角色特征提取：正在统计待处理照片...";
  } else if (running) {
    text =
      total > 0
        ? `角色特征提取 ${done}/${total}（还需 ${Math.max(0, total - done)}）${device}${workers}`
        : "角色特征提取：正在统计待处理照片...";
    if (failed > 0) {
      text += ` · 失败 ${failed} 张`;
    }
  }
  return {
    hasCcip: running,
    ccipPercent: total > 0 ? clampPct(done, total) : 0,
    ccipProcessed: running && !starting ? done : null,
    ccipStarting: starting,
    ccipText: text,
    ccipTotal: running && !starting && total > 0 ? total : null,
  };
}

function getQueueSnapshot(
  queue: QueueStatusPayload | null,
  queueRunning: boolean
) {
  const current = queue?.current ?? null;
  const pending = queue?.pending.length ?? 0;
  const hasQueue = queueRunning && (current !== null || pending > 0);
  let queueText = "";
  if (current) {
    const name = getFolderDisplayName(current.folderPath);
    const suffix = pending > 0 ? ` (还有 ${pending} 个排队)` : "";
    queueText = `正在导入: ${name}${suffix}`;
  } else if (pending > 0) {
    queueText = `${pending} 个文件夹等待导入`;
  }
  return { hasQueue, queueCurrent: current, queuePending: pending, queueText };
}

function buildSnapshot(
  scan: ScanPayload | null,
  ai: AiProgressPayload | null,
  ccip: CharacterFeatureProgressPayload | null,
  queue: QueueStatusPayload | null,
  queueRunning: boolean
): ProgressSnapshot {
  const scanSnap = getScanSnapshot(scan);
  const aiSnap = getAiSnapshot(ai);
  const ccipSnap = getCcipSnapshot(ccip);
  const queueSnap = getQueueSnapshot(queue, queueRunning);

  return {
    hasScan: scanSnap.hasScan,
    isScanning: scanSnap.isScanning,
    scanPercent: scanSnap.scanPercent,
    scanText: scanSnap.scanText,
    hasAi: aiSnap.hasAi,
    aiPhase: aiSnap.aiPhase,
    aiIsPaused: aiSnap.aiIsPaused,
    aiPercent: aiSnap.aiPercent,
    aiProcessed: aiSnap.aiProcessed,
    aiText: aiSnap.aiText,
    aiTotal: aiSnap.aiTotal,
    hasCcip: ccipSnap.hasCcip,
    ccipPercent: ccipSnap.ccipPercent,
    ccipProcessed: ccipSnap.ccipProcessed,
    ccipStarting: ccipSnap.ccipStarting,
    ccipText: ccipSnap.ccipText,
    ccipTotal: ccipSnap.ccipTotal,
    hasQueue: queueSnap.hasQueue,
    queueCurrent: queueSnap.queueCurrent,
    queuePending: queueSnap.queuePending,
    queueText: queueSnap.queueText,
  };
}

/**
 * Resolution order (highest priority first):
 *   1. Queue running (import + AI) — the user's explicit action
 *   3. CCIP character-feature build (hours-long, must never be a black box)
 *   4. SigLIP model loading / embedding / tagging
 *   5. File scan / indexing
 *   6. Idle
 */
/**
 * 自用（问题 4）：`deriveStatus` 只管"阶段 / 百分比 / 文案"，
 * 原始张数（processed/total）由下面的 hook 统一补上，所以这里不用重复填。
 */
type DerivedGlobalAiProgress = Omit<GlobalAiProgress, "processed" | "total">;

function deriveStatus(snap: ProgressSnapshot): DerivedGlobalAiProgress {
  // Queue currently processing a folder (covers scan+embed phases)
  if (snap.hasQueue && snap.queueCurrent) {
    return {
      canCancel: snap.queueCurrent.status === "scanning",
      isRunning: true,
      percent: snap.scanPercent > 0 ? snap.scanPercent : snap.aiPercent,
      statusText: snap.queueText,
      phase: "import-queue",
    };
  }

  if (snap.hasQueue && snap.queuePending > 0) {
    return {
      canCancel: false,
      isRunning: true,
      percent: 0,
      statusText: snap.queueText,
      phase: "import-queue",
    };
  }

  /*
   * 自用（2026-10-18 · 会话#9）：CCIP 全库「获取角色特征」。
   *
   * 这一步动辄几小时，用户原话：「没有进度条我也不知道他识别特征到什么程度，
   * 有没有出问题」→ 所以它的优先级放在角色识别之后、建向量/打标之前：
   * 导入、角色识别这类"用户正在盯着点"的短任务先占顶栏，剩下的长时间占顶栏 ✓。
   */
  if (snap.hasCcip) {
    return {
      canCancel: false,
      isRunning: true,
      isStarting: snap.ccipStarting,
      percent: snap.ccipPercent,
      statusText: snap.ccipText,
      phase: "character-features",
    };
  }

  /*
   * 自用（2026-10）：**先判断"已暂停"**，再判断各运行阶段。
   * 暂停时 isRunning=false（不算在跑），但 isPaused=true —— 顶栏靠它继续显示，
   * 用户也才有地方点「继续」。
   *
   * 2026-10-20（会话#10）：**被暂停的是谁要单独带上**（`pausedKind`）。
   * 之前这里用 `phase === "tagging" ? "tagging" : "embedding"` 猜，
   * 而暂停打标时相位是 `tagging-paused` → 猜成 embedding →
   * 顶栏同时冒出"暂停/已暂停/继续"三个键、点「继续」调的又是建向量的接口，
   * 打标根本没动（用户实测："点继续也不会继续"）。
   */
  if (snap.hasAi && snap.aiIsPaused) {
    const taggingPaused =
      snap.aiPhase === "tagging" || snap.aiPhase === "tagging-paused";
    return {
      canCancel: false,
      isPaused: true,
      pausedKind: taggingPaused ? "tagging" : "embedding",
      isRunning: false,
      percent: snap.aiPercent,
      statusText: `${
        snap.aiText || (taggingPaused ? "AI 标签生成" : "AI 特征提取")
      } · 已暂停`,
      phase: taggingPaused ? "tagging" : "embedding",
    };
  }

  if (snap.hasAi && snap.aiPhase === "loading") {
    return {
      canCancel: false,
      isRunning: true,
      percent: snap.aiPercent,
      statusText: snap.aiText,
      phase: "loading-model",
    };
  }

  if (snap.hasAi && snap.aiPhase === "embedding") {
    return {
      canCancel: false,
      isRunning: true,
      percent: snap.aiPercent,
      statusText: snap.aiText,
      phase: "embedding",
    };
  }

  /*
   * 自用（2026-10）：暂停打标时相位是 `tagging-paused`（见 ipc/photos/handlers/ai.ts），
   * 以前这里没有这个分支 → 会被当成 idle → isRunning=false → 顶栏整条消失。
   * 现在显式处理：不算"运行中"，但标记为"已暂停"，让进度条继续显示。
   */
  if (snap.hasAi && snap.aiPhase === "tagging-paused") {
    return {
      canCancel: false,
      isPaused: true,
      pausedKind: "tagging",
      isRunning: false,
      percent: snap.aiPercent,
      statusText: `${snap.aiText || "AI 标签生成"} · 已暂停`,
      phase: "tagging",
    };
  }

  if (snap.hasAi && snap.aiPhase === "tagging") {
    return {
      canCancel: false,
      isRunning: true,
      percent: snap.aiPercent,
      statusText: snap.aiText,
      phase: "tagging",
    };
  }

  if (snap.hasAi && snap.aiPhase === "repairing") {
    return {
      canCancel: false,
      isRunning: true,
      percent: snap.aiPercent,
      statusText: snap.aiText,
      phase: "loading-model",
    };
  }

  if (snap.hasScan) {
    return {
      canCancel: false,
      isRunning: true,
      percent: snap.scanPercent,
      statusText: snap.scanText,
      phase: "scanning",
    };
  }

  return {
    canCancel: false,
    isRunning: false,
    percent: 0,
    statusText: "",
    phase: "idle",
  };
}

// ── Hook ───────────────────────────────────────────────────────────

function useGlobalAiStatusState(): GlobalAiProgress {
  const { t } = useTranslation();
  const [scan, setScan] = useState<ScanPayload | null>(null);
  const [ai, setAi] = useState<AiProgressPayload | null>(null);
  /** 自用（会话#9）：CCIP 全库角色特征构建的进度（轮询拿到的快照）。 */
  const [ccip, setCcip] = useState<CharacterFeatureProgressPayload | null>(
    null
  );
  const [queue, setQueue] = useState<QueueStatusPayload | null>(null);
  const [queueRunning, setQueueRunning] = useState(false);

  const lastAiPhaseRef = useRef<AiProgressPayload["phase"]>("idle");
  const prevQueueDoneIdsRef = useRef<Set<number>>(new Set());
  const seenTerminalTaskIdsRef = useRef<Set<number>>(new Set());
  const completedBatchRef = useRef({
    folders: 0,
    photos: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
  });

  // ── Queue completion → auto-refresh UI caches ─────────────────

  const handleQueueStatus = useCallback(
    (payload: QueueStatusPayload) => {
      setQueue(payload);
      const hasActive = payload.current !== null || payload.pending.length > 0;
      setQueueRunning(hasActive);

      const hasNewDoneTask = processQueueHistory(
        payload.history,
        {
          completedBatchRef,
          prevQueueDoneIdsRef,
          seenTerminalTaskIdsRef,
        },
        (task) => {
          toast.error(
            t("toastImportFailed", {
              folder: getFolderDisplayName(task.folderPath),
              error: task.error ?? "",
            })
          );
        }
      );
      if (hasNewDoneTask) {
        queryClient.invalidateQueries({ queryKey: ["folders"] });
        queryClient.invalidateQueries({
          queryKey: ["photos"],
          refetchType: "active",
        });
      }

      if (!hasActive && completedBatchRef.current.folders > 0) {
        const summary = completedBatchRef.current;
        if (summary.skipped + summary.failed > 0) {
          toast.warning(t("toastImportBatchIncomplete", summary), {
            description: t("toastImportSkippedReason"),
            duration: 12_000,
          });
        } else {
          toast.success(t("toastImportBatchComplete", summary));
        }
        completedBatchRef.current = {
          folders: 0,
          photos: 0,
          indexed: 0,
          skipped: 0,
          failed: 0,
        };
      }
    },
    [t]
  );
  const handleScanMsg = useCallback((payload: ScanPayload) => {
    setScan(payload);
    if (payload.phase === "complete") {
      setTimeout(() => {
        setScan((prev) => (prev?.phase === "complete" ? null : prev));
      }, 3000);
    }
  }, []);

  // ── postMessage listener ─────────────────────────────────────

  const handleMessage = useCallback(
    (e: MessageEvent) => {
      const ch = e.data?.channel as string | undefined;
      if (!ch) {
        return;
      }

      switch (ch) {
        case "scan-progress":
          handleScanMsg(e.data as ScanPayload);
          break;
        case "ai-progress":
          lastAiPhaseRef.current = (e.data as AiProgressPayload).phase;
          setAi(e.data as AiProgressPayload);
          break;
        case "ai-embedding-done":
          if (lastAiPhaseRef.current === "error") {
            toast.error(t("toastAiIndexFailed"));
          } else if (lastAiPhaseRef.current === "tag-error") {
            toast.error(t("aiTagsFailed"));
          } else if (lastAiPhaseRef.current !== "idle") {
            toast.success(t("toastAiIndexReady"));
          }
          lastAiPhaseRef.current = "idle";
          setAi(null);
          queryClient.invalidateQueries({ queryKey: ["aiStatus"] });
          queryClient.invalidateQueries({ queryKey: ["dashboard", "stats"] });
          break;
          break;
        case "import-queue-status":
          handleQueueStatus(e.data as QueueStatusPayload);
          break;
        default:
          break;
      }
    },
    [handleQueueStatus, handleScanMsg, t]
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // ── Initial state sync ──────────────────────────────────────────
  // If the user reloads while tasks are running, poll IPC once to
  // catch up. PostMessage listeners handle subsequent updates.

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const [aiStatus, queueStatus] = await Promise.all([
          ipc.client.photos.getAiProgress({}).catch(() => null),
          ipc.client.photos.getImportQueueStatus({}).catch(() => null),
        ]);
        if (cancelled) {
          return;
        }
        applyInitAi(aiStatus);
        applyInitQueue(queueStatus);
      } catch {
        /* best-effort */
      }
    }

    function applyInitAi(raw: unknown) {
      if (!raw) {
        return;
      }
      const p = raw as AiProgressPayload & { isActive: boolean };
      if (p.isActive || p.phase === "loading" || p.phase === "embedding") {
        setAi({
          channel: "ai-progress" as const,
          phase: p.phase,
          processed: p.processed,
          total: p.total,
          downloadPercent: p.downloadPercent,
        });
      }
    }

    function applyInitQueue(raw: unknown) {
      if (!raw) {
        return;
      }
      const q = raw as QueueStatusPayload;
      setQueue(q);
      setQueueRunning(q.current !== null || q.pending.length > 0);
      prevQueueDoneIdsRef.current = new Set(
        q.history.filter((t) => t.status === "done").map((t) => t.id)
      );
      seenTerminalTaskIdsRef.current = new Set(
        q.history.map((task) => task.id)
      );
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * 自用（2026-10-18 · 会话#9）：CCIP 全库「获取角色特征」的进度轮询。
   *
   * 为什么只能轮询：这份进度是主进程里的内存计数（getCcipBuildProgress），
   * 没有 postMessage 通道；1 秒一次的开销可以忽略，而任务本身要跑几小时。
   * 空闲时降到 2 秒 —— 既能及时"发现有人开始跑"，也不至于一直白转。
   */
  const ccipRunningRef = useRef(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const raw = (await ipc.client.photos.getCharacterFeatureProgress(
          {}
        )) as CharacterFeatureProgressPayload;
        if (stopped) {
          return;
        }
        const running = raw?.running === true;
        ccipRunningRef.current = running;
        // 没在跑就置空，顶栏最迟 2 秒后自己收起来（不留一条僵尸进度）
        setCcip(running ? raw : null);
      } catch {
        /* 轮询失败不打扰用户（主进程忙的时候会偶发） */
      } finally {
        if (!stopped) {
          timer = setTimeout(
            () => void tick(),
            ccipRunningRef.current ? 1000 : 2000
          );
        }
      }
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  // ── Derive unified status ──────────────────────────────────────

  const snap = buildSnapshot(scan, ai, ccip, queue, queueRunning);
  const derived = deriveStatus(snap);
  /*
   * 自用（问题 4 / 2026-10-17）：把"按张数推进"的阶段的原始张数挂上去，
   * 供界面算 速度 / 预估剩余时间 ✓。
   *
   * ⚠️ 2026-10-18（会话#9）：SFace 人脸链路已整体剔除，`face-detection` 这一档不再存在 ✓
   * 现在只有 embedding / tagging（建向量、打标）+ character-features（CCIP 全库构建）。
   */
  const countableSource =
    derived.phase === "embedding" || derived.phase === "tagging"
      ? "ai"
      : derived.phase === "character-features"
        ? "ccip"
        : null;
  const processed =
    countableSource === "ai"
      ? snap.aiProcessed
      : countableSource === "ccip"
        ? snap.ccipProcessed
        : null;
  const total =
    countableSource === "ai"
      ? snap.aiTotal
      : countableSource === "ccip"
        ? snap.ccipTotal
        : null;
  return { ...derived, processed, total };
}

export function GlobalAiStatusProvider({ children }: { children: ReactNode }) {
  const status = useGlobalAiStatusState();
  return createElement(
    GlobalAiStatusContext.Provider,
    { value: status },
    children
  );
}

export function useGlobalAiStatus(): GlobalAiProgress {
  return useContext(GlobalAiStatusContext);
}
