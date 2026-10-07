import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  FILTER_DROPDOWN_CLASS_NAME,
  FilterDropdown,
} from "@/components/filter-dropdown";
import { SettingRow } from "@/components/settings/setting-row";
import {
  SettingsPageShell,
  SettingsSection,
} from "@/components/settings/settings-page-shell";
import { Button } from "@/components/ui/button";
import { SmoothInput } from "@/components/ui/smooth-input";
import { Switch } from "@/components/ui/switch";
import { PRIVATE_BUILD } from "@/config/private-build";
import { ipc } from "@/ipc/manager";

/**
 * 局域网访问设置（自用新增）。
 *
 * 设计约束（见工作区根目录「局域网功能实施计划.md」）：
 *  · 口令**只存哈希**，所以这里**没有任何"查看已设口令"的入口**。
 *    随机生成的口令只在生成的那一刻显示一次（存在本组件的 state 里，
 *    离开页面即消失）；自定义口令由用户自己输入，服务端同样不回传。
 *  · 页面里显示的访问地址**只在本机渲染层出现**，局域网侧没有任何设置接口。
 */
interface LanSettingsView {
  enabled: boolean;
  hasPermanentPassword: boolean;
  listeningOnLan: boolean;
  /** 局域网监听器的**真实**状态（端口被占用时这里会带错误）。*/
  listener: {
    active: boolean;
    error: { code: string; message: string } | null;
    port: number | null;
  };
  localAddresses: string[];
  port: number;
  tempPasswordActive: boolean;
  tempPasswordExpiresAt: number | null;
  tempPasswordHours: number;
  tempPasswordSet: boolean;
}

const TEMP_HOUR_OPTIONS = [1, 3, 6, 12, 24] as const;
const MIN_PASSWORD_LENGTH = 6;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const PASSWORD_INPUT_CLASS = `${FILTER_DROPDOWN_CLASS_NAME} w-full max-w-[320px]`;

function formatRemaining(
  ms: number,
  hourLabel: string,
  minuteLabel: string
): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0
    ? `${hours} ${hourLabel} ${minutes} ${minuteLabel}`
    : `${minutes} ${minuteLabel}`;
}

/** 随机口令的"只看一次"提示框。 */
function OneTimePasswordNotice({
  label,
  onDismiss,
  password,
}: {
  label: string;
  onDismiss: () => void;
  password: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 rounded-[6px] border border-amber-500/40 bg-amber-500/10 p-3">
      <div className="text-[11px] text-amber-700 dark:text-amber-300">
        {t("lanPasswordShowOnce")}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="rounded-[4px] bg-card px-2 py-1 font-mono text-[13px] text-foreground">
          {password}
        </code>
        <Button
          onClick={() => {
            navigator.clipboard
              .writeText(password)
              .then(() => toast.success(t("copied")))
              .catch(() => toast.error(t("copyFailed")));
          }}
          size="sm"
          variant="outline"
        >
          {label}
        </Button>
        <Button onClick={onDismiss} size="sm" variant="ghost">
          {t("clear")}
        </Button>
      </div>
    </div>
  );
}

function LanSettingsPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<LanSettingsView | null>(null);
  const [portInput, setPortInput] = useState("");
  const [permanentInput, setPermanentInput] = useState("");
  const [tempInput, setTempInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [revealedPermanent, setRevealedPermanent] = useState<string | null>(
    null
  );
  const [revealedTemp, setRevealedTemp] = useState<string | null>(null);

  const applyView = useCallback((view: LanSettingsView) => {
    setSettings(view);
  }, []);

  const applyViewWithPort = useCallback((view: LanSettingsView) => {
    setSettings(view);
    setPortInput(String(view.port));
  }, []);

  useEffect(() => {
    let cancelled = false;
    ipc.client.settings
      .getLanSettings({})
      .then((view) => {
        if (!cancelled) {
          applyViewWithPort(view as LanSettingsView);
        }
      })
      .catch((error: unknown) => {
        // 坑 #5：不静默吞错 —— 控制台留痕 + 界面明确报错
        console.error("[LAN] 读取局域网设置失败", error);
        if (!cancelled) {
          toast.error(t("lanSettingsLoadFailed"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyViewWithPort, t]);

  // 临时口令的剩余有效期需要每秒刷新。
  useEffect(() => {
    if (!settings?.tempPasswordActive) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [settings?.tempPasswordActive]);

  async function run(
    action: () => Promise<LanSettingsView>
  ): Promise<LanSettingsView | null> {
    setBusy(true);
    try {
      return await action();
    } catch (error) {
      console.error("[LAN] 保存局域网设置失败", error);
      const detail =
        error instanceof Error && error.message ? `：${error.message}` : "";
      toast.error(`${t("saveFailed")}${detail}`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  // 地址用**监听器实际绑定的端口**（可能与输入框里正在编辑的值不同）。
  const effectivePort = settings?.listener.port ?? settings?.port ?? null;
  const urls =
    effectivePort === null
      ? []
      : (settings?.localAddresses.map(
          (address) => `http://${address}:${effectivePort}/`
        ) ?? []);
  const primaryUrl = urls[0] ?? null;

  const listenerError = settings?.listener.error ?? null;
  const listenerDescription = settings?.listener.active
    ? t("lanListenerActive")
    : listenerError
      ? listenerError.code === "EADDRINUSE"
        ? t("lanPortBusy")
        : listenerError.message
      : t("lanListenerInactive");

  const remainingMs =
    settings?.tempPasswordActive && settings.tempPasswordExpiresAt
      ? Math.max(0, settings.tempPasswordExpiresAt - now)
      : 0;

  const tempStatus = !settings?.tempPasswordSet
    ? t("lanTempStatusUnset")
    : settings.tempPasswordActive
      ? `${t("lanTempStatusActive")} · ${t("lanTempRemaining")} ${formatRemaining(remainingMs, t("lanHourShort"), t("lanMinuteShort"))}`
      : t("lanTempStatusExpired");

  if (!PRIVATE_BUILD.enableLanAccess) {
    return (
      <SettingsPageShell
        description={t("settingsLanDescription")}
        title={t("settingsLan")}
      >
        <SettingsSection>
          <p className="text-[12px] text-muted-foreground">
            {t("lanDisabledInBuild")}
          </p>
        </SettingsSection>
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell
      description={t("settingsLanDescription")}
      title={t("settingsLan")}
    >
      <SettingsSection>
        <SettingRow
          description={t("lanWarningBody")}
          title={t("lanWarningTitle")}
          tone="warning"
        />
        <SettingRow
          action={
            <Switch
              ariaLabel={t("lanEnable")}
              checked={settings?.enabled ?? false}
              disabled={busy || settings === null}
              onCheckedChange={(checked) => {
                void run(async () => {
                  const view = await ipc.client.settings.setLanEnabled({
                    enabled: checked,
                  });
                  applyView(view as LanSettingsView);
                  return view as LanSettingsView;
                });
              }}
            />
          }
          description={t("lanEnableHint")}
          title={t("lanEnable")}
        />
        {settings?.enabled && !settings.hasPermanentPassword ? (
          <SettingRow
            title={t("lanNotListening")}
            tone="warning"
          />
        ) : null}
      </SettingsSection>

      <SettingsSection
        description={t("lanAccessAddressHint")}
        title={t("lanAccessAddress")}
      >
        <SettingRow
          action={
            <div className="flex flex-wrap items-center gap-2">
              <SmoothInput
                aria-label={t("lanPort")}
                className={`${FILTER_DROPDOWN_CLASS_NAME} w-[96px]`}
                inputMode="numeric"
                onChange={(event) => setPortInput(event.target.value)}
                value={portInput}
              />
              <Button
                disabled={busy || settings === null}
                onClick={() => {
                  const port = Number.parseInt(portInput, 10);
                  if (
                    !Number.isFinite(port) ||
                    port < MIN_PORT ||
                    port > MAX_PORT
                  ) {
                    toast.error(t("lanPortInvalid"));
                    return;
                  }
                  void run(async () => {
                    const view = await ipc.client.settings.setLanPort({ port });
                    applyViewWithPort(view as LanSettingsView);
                    return view as LanSettingsView;
                  });
                }}
                size="sm"
              >
                {t("save")}
              </Button>
              <Button
                disabled={busy || settings === null}
                onClick={() => {
                  void run(async () => {
                    const view = await ipc.client.settings.pickRandomLanPort({});
                    applyViewWithPort(view as LanSettingsView);
                    return view as LanSettingsView;
                  });
                }}
                size="sm"
                variant="outline"
              >
                {t("lanPickRandomPort")}
              </Button>
            </div>
          }
          description={t("lanPortHint")}
          title={t("lanPort")}
        />
        <SettingRow
          action={
            <Button
              disabled={busy || !settings?.enabled || !settings?.hasPermanentPassword}
              onClick={() => {
                void run(async () => {
                  const view = await ipc.client.settings.retryLanListener({});
                  applyView(view as LanSettingsView);
                  return view as LanSettingsView;
                });
              }}
              size="sm"
              variant="outline"
            >
              {t("lanRetryListener")}
            </Button>
          }
          description={listenerDescription}
          title={t("lanListenerStatus")}
          tone={
            settings && !settings.listener.active && settings.enabled
              ? "warning"
              : "default"
          }
        />
        <SettingRow
          action={
            <Button
              disabled={!primaryUrl}
              onClick={() => {
                if (primaryUrl) {
                  void copyText(primaryUrl);
                }
              }}
              size="sm"
              variant="outline"
            >
              {t("lanCopyAddress")}
            </Button>
          }
          description={urls.length > 0 ? undefined : t("lanNoAddress")}
          title={
            <span className="font-mono">
              {primaryUrl ?? t("lanNoAddress")}
            </span>
          }
        >
          {urls.length > 1 ? (
            <div className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
              {urls.slice(1).map((url) => (
                <div key={url}>{url}</div>
              ))}
            </div>
          ) : undefined}
        </SettingRow>
        <p className="pt-1 text-[11px] text-muted-foreground/70">
          {t("lanRestartHint")}
        </p>
      </SettingsSection>

      <SettingsSection
        description={t("lanPermanentPasswordHint")}
        title={t("lanPermanentPassword")}
      >
        <SettingRow
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={busy || permanentInput.trim().length === 0}
                onClick={() => {
                  if (permanentInput.trim().length < MIN_PASSWORD_LENGTH) {
                    toast.error(t("lanPasswordTooShort"));
                    return;
                  }
                  void run(async () => {
                    const view =
                      await ipc.client.settings.setLanPermanentPassword({
                        password: permanentInput,
                      });
                    applyView(view as LanSettingsView);
                    setPermanentInput("");
                    setRevealedPermanent(null);
                    toast.success(t("lanPasswordSet"));
                    return view as LanSettingsView;
                  });
                }}
                size="sm"
              >
                {t("lanSavePassword")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  void run(async () => {
                    const result =
                      await ipc.client.settings.generateLanPermanentPassword(
                        {}
                      );
                    applyView(result as LanSettingsView);
                    setRevealedPermanent(result.password);
                    setPermanentInput("");
                    return result as LanSettingsView;
                  });
                }}
                size="sm"
                variant="outline"
              >
                {t("lanGenerateRandom")}
              </Button>
              <Button
                disabled={busy || !settings?.hasPermanentPassword}
                onClick={() => {
                  void run(async () => {
                    const view =
                      await ipc.client.settings.clearLanPermanentPassword({});
                    applyView(view as LanSettingsView);
                    setRevealedPermanent(null);
                    return view as LanSettingsView;
                  });
                }}
                size="sm"
                variant="destructive"
              >
                {t("lanClearPassword")}
              </Button>
            </div>
          }
          title={
            settings?.hasPermanentPassword
              ? t("lanPasswordSet")
              : t("lanPasswordUnset")
          }
        >
          <SmoothInput
            aria-label={t("lanPermanentPassword")}
            className={PASSWORD_INPUT_CLASS}
            onChange={(event) => setPermanentInput(event.target.value)}
            placeholder={t("lanPasswordPlaceholder")}
            value={permanentInput}
          />
          {revealedPermanent ? (
            <OneTimePasswordNotice
              label={t("copied")}
              onDismiss={() => setRevealedPermanent(null)}
              password={revealedPermanent}
            />
          ) : null}
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        description={t("lanTempPasswordHint")}
        title={t("lanTempPassword")}
      >
        <SettingRow
          action={
            <FilterDropdown
              ariaLabel={t("lanTempDuration")}
              className="w-full min-w-0 max-w-[160px]"
              onChange={(value) => {
                const hours = Number.parseInt(value, 10);
                void run(async () => {
                  const view =
                    await ipc.client.settings.setLanTempPasswordHours({
                      hours,
                    });
                  applyView(view as LanSettingsView);
                  return view as LanSettingsView;
                });
              }}
              options={TEMP_HOUR_OPTIONS.map((hours) => ({
                label: `${hours} ${t("lanHourShort")}`,
                value: String(hours),
              }))}
              placeholder={t("lanTempDuration")}
              value={String(settings?.tempPasswordHours ?? 24)}
            />
          }
          title={t("lanTempDuration")}
        />
        <SettingRow
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={busy || tempInput.trim().length === 0}
                onClick={() => {
                  if (tempInput.trim().length < MIN_PASSWORD_LENGTH) {
                    toast.error(t("lanPasswordTooShort"));
                    return;
                  }
                  void run(async () => {
                    const view = await ipc.client.settings.setLanTempPassword({
                      hours: settings?.tempPasswordHours ?? 24,
                      password: tempInput,
                    });
                    applyView(view as LanSettingsView);
                    setTempInput("");
                    setRevealedTemp(null);
                    return view as LanSettingsView;
                  });
                }}
                size="sm"
              >
                {t("lanSavePassword")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  void run(async () => {
                    const result =
                      await ipc.client.settings.generateLanTempPassword({
                        hours: settings?.tempPasswordHours ?? 24,
                      });
                    applyView(result as LanSettingsView);
                    setRevealedTemp(result.password);
                    setTempInput("");
                    return result as LanSettingsView;
                  });
                }}
                size="sm"
                variant="outline"
              >
                {t("lanGenerateRandom")}
              </Button>
              <Button
                disabled={busy || !settings?.tempPasswordSet}
                onClick={() => {
                  void run(async () => {
                    const view =
                      await ipc.client.settings.clearLanTempPassword({});
                    applyView(view as LanSettingsView);
                    setRevealedTemp(null);
                    return view as LanSettingsView;
                  });
                }}
                size="sm"
                variant="destructive"
              >
                {t("lanClearPassword")}
              </Button>
            </div>
          }
          title={tempStatus}
        >
          <SmoothInput
            aria-label={t("lanTempPassword")}
            className={PASSWORD_INPUT_CLASS}
            onChange={(event) => setTempInput(event.target.value)}
            placeholder={t("lanPasswordPlaceholder")}
            value={tempInput}
          />
          {revealedTemp ? (
            <OneTimePasswordNotice
              label={t("copied")}
              onDismiss={() => setRevealedTemp(null)}
              password={revealedTemp}
            />
          ) : null}
        </SettingRow>
      </SettingsSection>
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/lan")({
  component: LanSettingsPage,
});
