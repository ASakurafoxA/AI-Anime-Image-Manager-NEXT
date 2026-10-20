import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ipc } from "@/ipc/manager";

interface PendingStartupScan {
  folderPath: string;
  photoCount: number;
}

function normalizePending(payload: unknown): PendingStartupScan[] | null {
  const list = (payload as { pendingStartupScans?: unknown })?.pendingStartupScans;
  if (!Array.isArray(list)) {
    return null;
  }
  return list
    .filter(
      (item): item is { folderPath: string; photoCount: number } =>
        typeof (item as { folderPath?: unknown })?.folderPath === "string"
    )
    .map((item) => ({
      folderPath: item.folderPath,
      photoCount: Number(item.photoCount ?? 0),
    }));
}

/**
 * 自用（2026-10-16）：开机补扫的「大图库先问我一句」提示条 ✓。
 *
 * 为什么需要它：开机补扫会**把整个树根重新走一遍**（本机 E:\图 24,723 张），
 * 以前是**自动就扫** ✗ —— 界面被占住、连「取消」都点不了，只能强杀 ✗。
 * 现在大图库不自动扫，而是在这里问一句 ✓（开关与阈值见「设置 → 应用行为」）。
 *
 * 数据来源：主进程 `import-queue.ts` 的 `pendingStartupScans`，
 * 既通过 `import-queue-status` 事件推过来，也会在挂载时主动拉一次 ✓。
 */
export function StartupScanPrompt() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingStartupScan[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const apply = (payload: unknown) => {
      const next = normalizePending(payload);
      if (next && !cancelled) {
        setPending(next);
      }
    };

    ipc.client.photos
      .getImportQueueStatus({})
      .then((status) => apply(status))
      .catch(() => undefined);

    /*
     * 自用（2026-10-16，**修"日志有、界面不显示"**）：频道名在 `channel` 字段里 ✗→✓。
     * preload 发过来的是 `{ channel: "import-queue-status", ...状态 }`（见 preload.ts），
     * 和 `use-global-ai-status.ts` 的判法一致 ✓；我一开始误判成 `type` ✗，
     * 结果消息接不住、提示条永远不出现 ✓（用户实测发现的 ✓）。
     */
    const onMessage = (event: MessageEvent) => {
      if (event.data?.channel === "import-queue-status") {
        apply(event.data);
      }
    };
    window.addEventListener("message", onMessage);

    /*
     * 兜底轮询：开机补扫是启动约 25 秒后才判断的，万一那条事件没收到
     * （渲染层晚挂载 / 事件丢失），这里每 10 秒主动拉一次，**只拉前 3 分钟** ✓，
     * 之后完全靠事件，不长期占用 ✓。
     */
    let polls = 0;
    const pollTimer = window.setInterval(() => {
      polls += 1;
      if (polls > 18) {
        window.clearInterval(pollTimer);
        return;
      }
      ipc.client.photos
        .getImportQueueStatus({})
        .then((status) => apply(status))
        .catch(() => undefined);
    }, 10_000);

    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  const start = useCallback(() => {
    setBusy(true);
    ipc.client.photos
      .confirmStartupScans({})
      .then(() => setPending([]))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, []);

  const skip = useCallback(() => {
    setBusy(true);
    ipc.client.photos
      .dismissStartupScans({})
      .then(() => setPending([]))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, []);

  if (pending.length === 0) {
    return null;
  }

  const first = pending[0];
  const extra = pending.length - 1;

  /*
   * 自用（2026-10-16，按用户反馈改样式 ✓）：
   *   ① 底色改**浅黄**（user：原来的不显眼 ✗）—— 用项目里警示色的现成写法
   *      `bg-amber-500/15` + `text-amber-700 dark:text-amber-300`（见 setting-row.tsx ✓），
   *      深浅两套主题下都能看清字 ✓；
   *   ② 两个按钮**上下居中**（左侧文字两行、右侧按钮组用 items-center 对齐 ✓）；
   *   ③ 按钮换成项目现成的 `Button` 组件 ✓（和设置页那些按钮同一套样式：
   *      「开始扫描」= 主色实心、「先跳过」= 描边 ✓）。
   *
   * 另外保留原来的说明：那个数字是「已入库总数」，不是新增数 ✓（用户曾误解过）。
   */
  return (
    <div className="border-amber-500/30 border-b bg-amber-500/15 px-4 py-1.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-[11px] text-amber-800 dark:text-amber-200">
            {t("startupScanPromptTitle", { count: pending.length })}
          </div>
          <div className="mt-0.5 text-[10px] text-amber-700/90 leading-relaxed dark:text-amber-300/80">
            <span>
              {t("startupScanPromptBody", {
                path: first.folderPath,
                photos: first.photoCount,
              })}
            </span>
            {extra > 0 ? (
              <span>{` ${t("startupScanPromptMore", { count: extra })}`}</span>
            ) : null}
            <span>{` ${t("startupScanPromptCost")}`}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button disabled={busy} onClick={start} size="sm" type="button">
            {t("startupScanPromptStart")}
          </Button>
          <Button
            disabled={busy}
            onClick={skip}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("startupScanPromptSkip")}
          </Button>
        </div>
      </div>
    </div>
  );
}
