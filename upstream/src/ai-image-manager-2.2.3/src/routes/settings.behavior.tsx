import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FilterDropdown } from "@/components/filter-dropdown";
import { PRIVATE_BUILD } from "@/config/private-build";
import { SettingRow } from "@/components/settings/setting-row";
import {
  SettingsPageShell,
  SettingsSection,
} from "@/components/settings/settings-page-shell";
import { Switch } from "@/components/ui/switch";
import { ipc } from "@/ipc/manager";
import {
  createOptimisticSaveQueue,
  type OptimisticSaveQueue,
} from "@/utils/optimistic-save-queue";

const SIDEBAR_COLLAPSED_KEY = "sidebar_collapsed";
const CLOSE_BEHAVIOR_OPTIONS = ["tray", "quit", "ask"] as const;
type CloseBehavior = (typeof CLOSE_BEHAVIOR_OPTIONS)[number];
const CLOSE_BEHAVIOR_LABEL_KEYS: Record<CloseBehavior, string> = {
  ask: "settingsCloseBehaviorAsk",
  quit: "settingsCloseBehaviorQuit",
  tray: "settingsCloseBehaviorTray",
};

function getSettingValue(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const value = (result as { value?: unknown }).value;
  return typeof value === "string" ? value : undefined;
}

function getBooleanSetting(result: unknown, fallback: boolean): boolean {
  const value = getSettingValue(result);
  return value === undefined ? fallback : value === "true";
}

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

/*
 * 自用（2026-10-16）：开机补扫的开关。
 * 键名与主进程 `services/import-queue.ts` 里读的完全一致 ✓（同一个 app_settings 表）。
 *
 * 用户口径（2026-10-16）：数字不给选（"图库只增不减"，挑阈值没意义）✓，
 * 但**要两个开关**：
 *   ① 开机自动补扫新图片（默认关）
 *   ② 只检查有没有变化（默认开 = 先做只读预检；关 = 每次都全量扫）✓
 * 阈值固定 30000 张（见 import-queue.ts 的 LARGE_RESCAN_THRESHOLD）✓。
 */
const STARTUP_SCAN_KEY = "imports.startupCatchUpScan";
const STARTUP_SCAN_PRECHECK_KEY = "imports.startupScanPrecheck";

/*
 * 自用（2026-10）：角色识别的特征源开关。
 *
 * 键名与主进程 `services/ccip-model.ts` 里读的完全一致 ✓（同一个 app_settings 表）。
 * 用户口径：**默认开**（首选 CCIP）；开着但没放 CCIP 模型 → 角色识别停用并提示；
 * 手动关掉 = 已知晓 → 回退现有特征（CLIP）。
 */
const CHARACTER_PREFER_CCIP_KEY = "ai.characterRecognitionUseCcip";

/**
 * 自用（2026-10-18 修正，用户口径「速度好慢」）：**角色识别每张卡开几个进程** ✓
 *
 * 为什么需要这个开关：角色识别（CCIP 算特征）的真实瓶颈是**每张图的解码 + 缩放**
 * （单进程内串行），所以"加进程"比"加显卡"有效。用生产 worker 复测同一张卡：
 *
 * | 每卡进程数 | 吞吐 | 相对 1 个 |
 * |---|---|---|
 * | 1 | 15.73 张/秒 | 100% |
 * | 2 | 23.77 | 151% |
 * | **4** | **34.66** | **220%** ← 拐点 |
 * | 6 / 8 | 33.2 / 34.2 | ≈211 / 217% |
 *
 * → 默认 **4**（4 之后不再变快，只是多占内存）✓
 * 主进程 `services/ai/ccip-embedder.ts` 读的就是这个键（**只有这一个键**，不留第二份）✓
 * 建向量（CLIP）是显卡瓶颈，不跟这个开关。
 */
/* ⚠️ 键名里的 "face" 是历史遗留（2026-10-18：SFace 已剔除）——**值不能改**，
   否则用户已经存过的设置会丢；界面文案与语义早就改成"角色识别"了 ✓ */
const CHARACTER_WORKERS_PER_CARD_KEY = "ai.faceWorkersPerCard";

const CHARACTER_WORKERS_OPTIONS = [1, 2, 3, 4, 6] as const;
const CHARACTER_WORKERS_DEFAULT = 4;

/** 数值型应用设置（存成字符串；乐观保存 + 回滚）✓。 */
function useNumberChoiceAppSetting(
  key: string,
  fallback: number,
  saveFailedMessage: string
) {
  const [value, setValue] = useState(fallback);
  const queueRef = useRef<OptimisticSaveQueue<number> | null>(null);

  if (!queueRef.current) {
    queueRef.current = createOptimisticSaveQueue({
      initialValue: fallback,
      onRollback: (next) => setValue(next),
      onSaveError: () => toast.error(saveFailedMessage),
      persist: (next) =>
        ipc.client.settings.setAppSetting({ key, value: String(next) }),
    });
  }

  useEffect(() => {
    ipc.client.settings
      .getAppSetting({ key })
      .then((result) => {
        const raw = (result as { value?: string } | undefined)?.value;
        const parsed = Number.parseInt(String(raw ?? ""), 10);
        if (!Number.isFinite(parsed)) {
          return;
        }
        if (queueRef.current?.hydrate(parsed)) {
          setValue(parsed);
        }
      })
      .catch(() => undefined);
  }, [key]);

  const update = useCallback((next: number) => {
    setValue(next);
    queueRef.current?.enqueue(next);
  }, []);

  return [value, update] as const;
}

/** 布尔型应用设置（乐观保存 + 回滚）✓。 */
function useBooleanAppSetting(
  key: string,
  fallback: boolean,
  saveFailedMessage: string
) {
  const [value, setValue] = useState(fallback);
  const queueRef = useRef<OptimisticSaveQueue<boolean> | null>(null);

  if (!queueRef.current) {
    queueRef.current = createOptimisticSaveQueue({
      initialValue: fallback,
      onRollback: (next) => setValue(next),
      onSaveError: () => toast.error(saveFailedMessage),
      persist: (next) =>
        ipc.client.settings.setAppSetting({ key, value: String(next) }),
    });
  }

  useEffect(() => {
    ipc.client.settings
      .getAppSetting({ key })
      .then((result) => {
        const next = getBooleanSetting(result, fallback);
        if (queueRef.current?.hydrate(next)) {
          setValue(next);
        }
      })
      .catch(() => undefined);
  }, [key, fallback]);

  const update = useCallback((next: boolean) => {
    setValue(next);
    queueRef.current?.enqueue(next);
  }, []);

  return [value, update] as const;
}

function BehaviorSettingsPage() {
  const { t } = useTranslation();
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>("tray");
  const [rememberBounds, setRememberBounds] = useState(false);
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] =
    useState(readSidebarCollapsed);
  const [syncCullFavorites, setSyncCullFavorites] = useState(true);
  /*
   * 自用（2026-10-16）：开机补扫两个开关 ✓
   *   ① 开机自动补扫新图片（默认关）
   *   ② 只检查有没有变化（默认开；关 = 每次都全量扫）
   */
  const [startupScanEnabled, setStartupScanEnabled] = useBooleanAppSetting(
    STARTUP_SCAN_KEY,
    PRIVATE_BUILD.startupCatchUpScan,
    t("saveFailed")
  );
  const [startupScanPrecheck, setStartupScanPrecheck] = useBooleanAppSetting(
    STARTUP_SCAN_PRECHECK_KEY,
    true,
    t("saveFailed")
  );
  /*
   * 自用（2026-10）：角色识别优先 CCIP ✓（**默认开** —— 用户明确要求）。
   */
  const [characterPreferCcip, setCharacterPreferCcip] = useBooleanAppSetting(
    CHARACTER_PREFER_CCIP_KEY,
    true,
    t("saveFailed")
  );
  /*
   * 自用（2026-10-17）：人物识别每卡 worker 数（默认 6，实测比 3 快 +32%）✓
   */
  const [faceWorkersPerCard, setFaceWorkersPerCard] = useNumberChoiceAppSetting(
    CHARACTER_WORKERS_PER_CARD_KEY,
    CHARACTER_WORKERS_DEFAULT,
    t("saveFailed")
  );
  const closeBehaviorQueueRef =
    useRef<OptimisticSaveQueue<CloseBehavior> | null>(null);
  const rememberBoundsQueueRef = useRef<OptimisticSaveQueue<boolean> | null>(
    null
  );
  const openAtLoginQueueRef = useRef<OptimisticSaveQueue<boolean> | null>(null);
  const syncCullFavoritesQueueRef = useRef<OptimisticSaveQueue<boolean> | null>(
    null
  );

  if (!closeBehaviorQueueRef.current) {
    closeBehaviorQueueRef.current = createOptimisticSaveQueue({
      initialValue: "tray" as CloseBehavior,
      onRollback: (value) => setCloseBehavior(value),
      onSaveError: () => toast.error(t("saveFailed")),
      persist: (value) =>
        ipc.client.settings.setAppPreference({
          key: "window.closeBehavior",
          value,
        }),
    });
  }

  if (!rememberBoundsQueueRef.current) {
    rememberBoundsQueueRef.current = createOptimisticSaveQueue({
      initialValue: false,
      onRollback: (value) => setRememberBounds(value),
      onSaveError: () => toast.error(t("saveFailed")),
      persist: (value) =>
        ipc.client.settings.setAppPreference({
          key: "window.rememberBounds",
          value: String(value),
        }),
    });
  }

  if (!openAtLoginQueueRef.current) {
    openAtLoginQueueRef.current = createOptimisticSaveQueue({
      initialValue: false,
      onRollback: (value) => setOpenAtLogin(value),
      onSaveError: () => toast.error(t("saveFailed")),
      persist: (value) =>
        ipc.client.settings.setOpenAtLogin({ openAtLogin: value }),
    });
  }

  if (!syncCullFavoritesQueueRef.current) {
    syncCullFavoritesQueueRef.current = createOptimisticSaveQueue({
      initialValue: true,
      onRollback: (value) => setSyncCullFavorites(value),
      onSaveError: () => toast.error(t("saveFailed")),
      persist: (value) =>
        ipc.client.settings.setAppSetting({
          key: "cull.syncKeptWithFavorites",
          value: String(value),
        }),
    });
  }

  const hydrateCloseBehavior = useCallback((value: CloseBehavior) => {
    if (!closeBehaviorQueueRef.current?.hydrate(value)) {
      return;
    }
    setCloseBehavior(value);
  }, []);

  const hydrateRememberBounds = useCallback((value: boolean) => {
    if (!rememberBoundsQueueRef.current?.hydrate(value)) {
      return;
    }
    setRememberBounds(value);
  }, []);

  const hydrateOpenAtLogin = useCallback((value: boolean) => {
    if (!openAtLoginQueueRef.current?.hydrate(value)) {
      return;
    }
    setOpenAtLogin(value);
  }, []);

  const hydrateSyncCullFavorites = useCallback((value: boolean) => {
    if (!syncCullFavoritesQueueRef.current?.hydrate(value)) {
      return;
    }
    setSyncCullFavorites(value);
  }, []);

  useEffect(() => {
    ipc.client.settings
      .getAppPreferences({})
      .then((preferences) => {
        hydrateCloseBehavior(preferences.closeBehavior);
        hydrateRememberBounds(preferences.rememberBounds);
      })
      .catch(() => {
        hydrateCloseBehavior("tray");
        hydrateRememberBounds(false);
      });

    ipc.client.settings
      .getOpenAtLogin({})
      .then((result) => {
        const value =
          (result as { openAtLogin?: boolean }).openAtLogin ?? false;
        hydrateOpenAtLogin(value);
      })
      .catch(() => hydrateOpenAtLogin(false));

    ipc.client.settings
      .getAppSetting({ key: "cull.syncKeptWithFavorites" })
      .then((result) => {
        const value = getBooleanSetting(result, true);
        hydrateSyncCullFavorites(value);
      })
      .catch(() => hydrateSyncCullFavorites(true));
  }, [
    hydrateCloseBehavior,
    hydrateOpenAtLogin,
    hydrateRememberBounds,
    hydrateSyncCullFavorites,
  ]);

  function onCloseBehaviorChange(value: CloseBehavior) {
    setCloseBehavior(value);
    closeBehaviorQueueRef.current?.enqueue(value);
  }

  function onRememberBoundsChange(checked: boolean) {
    setRememberBounds(checked);
    rememberBoundsQueueRef.current?.enqueue(checked);
  }

  function onOpenAtLoginChange(checked: boolean) {
    setOpenAtLogin(checked);
    openAtLoginQueueRef.current?.enqueue(checked);
  }

  function onSidebarCollapsedChange(checked: boolean) {
    const previous = sidebarCollapsed;
    setSidebarCollapsed(checked);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(checked));
    } catch {
      setSidebarCollapsed(previous);
      toast.error(t("saveFailed"));
    }
  }

  function onSyncCullFavoritesChange(checked: boolean) {
    setSyncCullFavorites(checked);
    syncCullFavoritesQueueRef.current?.enqueue(checked);
  }

  return (
    <SettingsPageShell
      description={t("settingsBehaviorDescription")}
      title={t("settingsBehavior")}
    >
      <SettingsSection>
        <SettingRow
          action={
            <FilterDropdown
              ariaLabel={t("settingsCloseBehavior")}
              className="w-full min-w-0 max-w-[220px]"
              onChange={(value) =>
                onCloseBehaviorChange(value as CloseBehavior)
              }
              options={CLOSE_BEHAVIOR_OPTIONS.map((value) => ({
                label: t(CLOSE_BEHAVIOR_LABEL_KEYS[value]),
                value,
              }))}
              placeholder={t("settingsCloseBehavior")}
              value={closeBehavior}
            />
          }
          description={t("settingsCloseBehaviorHint")}
          title={t("settingsCloseBehavior")}
        />
        <SettingRow
          action={
            <Switch
              ariaLabel={t("settingsRememberWindowBounds")}
              checked={rememberBounds}
              onCheckedChange={onRememberBoundsChange}
            />
          }
          description={t("settingsRememberWindowBoundsHint")}
          title={t("settingsRememberWindowBounds")}
        />
        <SettingRow
          action={
            <Switch
              ariaLabel={t("openAtLogin")}
              checked={openAtLogin}
              onCheckedChange={onOpenAtLoginChange}
            />
          }
          description={t("openAtLoginHint")}
          title={t("openAtLogin")}
        />
        <SettingRow
          action={
            <Switch
              ariaLabel={t("sidebarDefaultCollapsed")}
              checked={sidebarCollapsed}
              onCheckedChange={onSidebarCollapsedChange}
            />
          }
          description={t("sidebarDefaultCollapsedHint")}
          title={t("sidebarDefaultCollapsed")}
        />
        {/* 自用版：「选片」功能已隐藏，这个选项也一并隐藏
            （见 private-build.ts 的 hideCull） */}
        {!PRIVATE_BUILD.hideCull && (
          <SettingRow
            action={
              <Switch
                ariaLabel={t("cullSyncFavorites")}
                checked={syncCullFavorites}
                onCheckedChange={onSyncCullFavoritesChange}
              />
            }
            description={t("cullSyncFavoritesHint")}
            title={t("cullSyncFavorites")}
          />
        )}
      </SettingsSection>

      {/*
        自用（2026-10-16）：开机补扫。
        用户口径：数字不给选 ✓，但要**两个开关**（补扫总开关 + 是否只检查时间）✓；
        标题样式与页面顶部「应用行为」**保持一致** ✓（titleVariant="page"）；
        **两个开关各自一个框** ✓（用户要求：放一个框里太丑 ✗ → 分两张卡片 ✓）。
      */}
      <SettingsSection
        description={t("settingsStartupScanDescription")}
        title={t("settingsStartupScanGroup")}
        titleVariant="page"
      >
        <SettingRow
          action={
            <Switch
              ariaLabel={t("settingsStartupCatchUpScan")}
              checked={startupScanEnabled}
              onCheckedChange={setStartupScanEnabled}
            />
          }
          description={t("settingsStartupCatchUpScanHint")}
          title={t("settingsStartupCatchUpScan")}
        />
      </SettingsSection>

      {/*
        第二个开关：**单独一张卡片** ✓，只有开了上面的总开关才出现 ✓，
        出现时带一点入场动画 ✓（淡入 + 轻微下滑，见 global.css 的
        `.animate-setting-row-enter`；系统开启"减少动态效果"时自动不播 ✓）。
      */}
      {startupScanEnabled && (
        <SettingsSection className="animate-setting-row-enter">
          <SettingRow
            action={
              <Switch
                ariaLabel={t("settingsStartupScanPrecheck")}
                checked={startupScanPrecheck}
                onCheckedChange={setStartupScanPrecheck}
              />
            }
            // 自用（2026-10-16，用户要求 ✓）：说明**只写当前状态那一句**
            // （开 = 只检查时间；关 = 每次都全量扫）✓
            description={t(
              startupScanPrecheck
                ? "settingsStartupScanPrecheckHintOn"
                : "settingsStartupScanPrecheckHintOff"
            )}
            title={t("settingsStartupScanPrecheck")}
          />
        </SettingsSection>
      )}

      {/*
        自用（2026-10）：角色识别 —— 特征源开关 ✓
        用户口径：默认开（首选 CCIP）；开着但没放模型 → 角色识别停用并提示；
        手动关掉 = 已知晓 → 回退现有特征（CLIP）✓。
      */}
      <SettingsSection
        description={t("settingsCharacterRecognitionDescription")}
        title={t("settingsCharacterRecognitionGroup")}
        titleVariant="page"
      >
        <SettingRow
          action={
            <Switch
              ariaLabel={t("settingsCharacterPreferCcip")}
              checked={characterPreferCcip}
              onCheckedChange={setCharacterPreferCcip}
            />
          }
          description={t("settingsCharacterPreferCcipHint")}
          title={t("settingsCharacterPreferCcip")}
        />
      </SettingsSection>

      {/*
        自用（2026-10-17，用户口径）：**每卡 worker 数是"二级选项"** ——
        和上面「开机补扫 → 只检查有没有变化」同一个样式：**只有开了 CCIP 才显示** ✓
        （关掉 CCIP = 回退 CLIP 特征，加 worker 对它没作用，所以藏起来，别让人白调 ✗）
        内容：人物识别是 CPU 瓶颈，加 worker 有效；建向量/CCIP 固定，不跟这个开关 ✓
      */}
      {characterPreferCcip && (
        <SettingsSection className="animate-setting-row-enter">
          <SettingRow
            action={
              <FilterDropdown
                ariaLabel={t("settingsCharacterWorkersPerCard")}
                className="w-[76px] max-w-full"
                onChange={(nextValue) =>
                  setFaceWorkersPerCard(Number.parseInt(nextValue, 10))
                }
                options={CHARACTER_WORKERS_OPTIONS.map((count) => ({
                  label: String(count),
                  value: String(count),
                }))}
                placeholder={t("settingsCharacterWorkersPerCard")}
                showSelectedCheck
                value={String(faceWorkersPerCard)}
              />
            }
            description={t("settingsCharacterWorkersPerCardHint")}
            title={t("settingsCharacterWorkersPerCard")}
          />
        </SettingsSection>
      )}
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/behavior")({
  component: BehaviorSettingsPage,
});
