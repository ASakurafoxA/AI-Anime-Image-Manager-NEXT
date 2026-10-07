import fs from "node:fs";
import fsp from "node:fs/promises";
import nodeOs from "node:os";
import path from "node:path";
import { os } from "@orpc/server";
import { eq, sql } from "drizzle-orm";
import { app, BrowserWindow } from "electron";
import { z } from "zod";
import { getDatabase } from "@/db";
import { duplicateCleanupPlans, duplicateReviewGroups } from "@/db/schema";
import {
  getDuplicateSensitivityConfig,
  parseDuplicateSensitivity,
} from "@/services/duplicate-sensitivity";
import {
  clearPermanentPassword as clearPermanentPasswordValue,
  clearTempPassword as clearTempPasswordValue,
  generatePermanentPassword as generatePermanentPasswordValue,
  generateTempPassword as generateTempPasswordValue,
  getLanConfig as getLanConfigValue,
  MAX_LAN_PORT,
  MIN_LAN_PORT,
  MIN_PASSWORD_LENGTH,
  setLanEnabled as setLanEnabledValue,
  setLanPort as setLanPortValue,
  setPermanentPassword as setPermanentPasswordValue,
  setRandomLanPort as setRandomLanPortValue,
  setTempPassword as setTempPasswordValue,
  setTempPasswordHours as setTempPasswordHoursValue,
  TEMP_PASSWORD_HOUR_OPTIONS,
} from "@/services/lan-access";
import { notifySequencesChanged } from "@/services/photo-sequences";
import { registry } from "@/services/registry";
import { refreshSequenceSuggestions } from "@/services/sequence-suggestions";
import {
  getAllSettings,
  getSetting,
  setSetting,
} from "@/services/settings-manager";
import { parseAccentColor } from "@/types/accent-color";
import {
  APP_PREFERENCE_DEFAULTS,
  APP_PREFERENCE_KEYS,
  type AppPreferences,
  parseBooleanPreference,
  parseCloseBehavior,
} from "@/types/app-preferences";
import { normalizeSequenceDetectionSettings } from "@/types/sequence-detection-settings";
import {
  getDataPath,
  isDefaultDataPath,
  setCustomDataPath,
} from "@/utils/data-path";
import {
  DATA_PATH_SUBDIRECTORIES,
  inspectDataPathDestination,
} from "@/utils/data-path-destination";

const diagLog = (msg: string) => {
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "migrate.log"),
      `${new Date().toISOString()} ${msg}\n`,
      { flag: "a" }
    );
  } catch {
    /* best-effort */
  }
};

type MigrateProgress =
  | { phase: "start"; total: number }
  | { phase: "stopping-services" }
  | { phase: "copying"; dir: string; index: number; total: number }
  | { phase: "copied"; dir: string; index: number; total: number }
  | {
      phase: "skipped";
      dir: string;
      index: number;
      total: number;
      reason: string;
    }
  | {
      phase: "failed";
      dir: string;
      index: number;
      total: number;
      error: string;
    }
  | { phase: "done"; copied: number; errors: string[] };

const sendMigrateProgress = (payload: MigrateProgress) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("data-path-migrate-progress", payload);
  }
};

export const getAppSetting = os
  .input(z.object({ key: z.string() }))
  .handler(({ input }) => {
    const value = getSetting(input.key);
    if (value === null) {
      return null;
    }
    return { key: input.key, value };
  });

export const getDuplicateSettings = os.handler(() => {
  const preset = parseDuplicateSensitivity(
    getSetting("duplicates.sensitivity")
  );
  return {
    ...getDuplicateSensitivityConfig(preset),
    revision: getSetting("duplicates.settingsRevision") ?? "0",
  };
});

export const updateDuplicateSettings = os
  .input(
    z.object({
      expectedRevision: z.string().optional(),
      preset: z.enum(["strict", "standard", "loose"]),
    })
  )
  .handler(({ input }) => {
    const currentRevision = getSetting("duplicates.settingsRevision") ?? "0";
    if (input.expectedRevision && input.expectedRevision !== currentRevision) {
      throw new Error("Duplicate detection settings are stale; refresh first");
    }
    const parsedRevision = Number.parseInt(currentRevision, 10);
    const nextRevision = String(
      Number.isSafeInteger(parsedRevision) && parsedRevision >= 0
        ? parsedRevision + 1
        : 1
    );
    setSetting("duplicates.sensitivity", input.preset);
    setSetting("duplicates.settingsRevision", nextRevision);
    const db = getDatabase();
    db.transaction(() => {
      db.update(duplicateCleanupPlans)
        .set({ status: "STALE", updatedAt: Date.now() })
        .where(eq(duplicateCleanupPlans.status, "READY"))
        .run();
      db.update(duplicateReviewGroups)
        .set({
          complete: false,
          needsReview: true,
          reviewRevision: sql`${duplicateReviewGroups.reviewRevision} + 1`,
          updatedAt: Date.now(),
        })
        .where(eq(duplicateReviewGroups.ignoreState, "ACTIVE"))
        .run();
    });
    return {
      ...getDuplicateSensitivityConfig(input.preset),
      revision: nextRevision,
    };
  });

export const setAppSetting = os
  .input(z.object({ key: z.string(), value: z.string() }))
  .handler(({ input }) => {
    if (input.key === "sequence.detection.settings") {
      const normalized = normalizeSequenceDetectionSettings(
        JSON.parse(input.value)
      );
      getDatabase().transaction(() => {
        setSetting(input.key, JSON.stringify(normalized));
        refreshSequenceSuggestions();
      });
      notifySequencesChanged(undefined, "settings");
    } else {
      setSetting(input.key, input.value);
    }
    return { ok: true };
  });

export const getAllAppSettings = os
  .input(z.object({ prefix: z.string().optional() }))
  .handler(({ input }) => {
    const settings = getAllSettings(input.prefix);
    return { settings };
  });

export const getAppPreferences = os.handler(
  (): AppPreferences => ({
    accentColor: parseAccentColor(getSetting(APP_PREFERENCE_KEYS.accentColor)),
    closeBehavior: parseCloseBehavior(
      getSetting(APP_PREFERENCE_KEYS.closeBehavior)
    ),
    reduceMotion: parseBooleanPreference(
      getSetting(APP_PREFERENCE_KEYS.reduceMotion),
      APP_PREFERENCE_DEFAULTS.reduceMotion
    ),
    rememberBounds: parseBooleanPreference(
      getSetting(APP_PREFERENCE_KEYS.rememberBounds),
      APP_PREFERENCE_DEFAULTS.rememberBounds
    ),
    updateAutoUpdate: parseBooleanPreference(
      getSetting(APP_PREFERENCE_KEYS.updateAutoUpdate),
      APP_PREFERENCE_DEFAULTS.updateAutoUpdate
    ),
    updateReminder: parseBooleanPreference(
      getSetting(APP_PREFERENCE_KEYS.updateReminder),
      APP_PREFERENCE_DEFAULTS.updateReminder
    ),
  })
);

export const setAppPreference = os
  .input(
    z.object({
      key: z.enum([
        APP_PREFERENCE_KEYS.accentColor,
        APP_PREFERENCE_KEYS.closeBehavior,
        APP_PREFERENCE_KEYS.reduceMotion,
        APP_PREFERENCE_KEYS.rememberBounds,
        APP_PREFERENCE_KEYS.updateAutoUpdate,
        APP_PREFERENCE_KEYS.updateReminder,
      ]),
      value: z.string(),
    })
  )
  .handler(async ({ input }) => {
    if (input.key === APP_PREFERENCE_KEYS.accentColor) {
      setSetting(input.key, parseAccentColor(input.value));
    } else if (input.key === APP_PREFERENCE_KEYS.closeBehavior) {
      setSetting(input.key, parseCloseBehavior(input.value));
    } else if (input.key === APP_PREFERENCE_KEYS.reduceMotion) {
      setSetting(
        input.key,
        String(
          parseBooleanPreference(
            input.value,
            APP_PREFERENCE_DEFAULTS.reduceMotion
          )
        )
      );
    } else if (input.key === APP_PREFERENCE_KEYS.rememberBounds) {
      setSetting(
        input.key,
        String(
          parseBooleanPreference(
            input.value,
            APP_PREFERENCE_DEFAULTS.rememberBounds
          )
        )
      );
    } else if (input.key === APP_PREFERENCE_KEYS.updateAutoUpdate) {
      setSetting(
        input.key,
        String(
          parseBooleanPreference(
            input.value,
            APP_PREFERENCE_DEFAULTS.updateAutoUpdate
          )
        )
      );
    } else {
      setSetting(
        input.key,
        String(
          parseBooleanPreference(
            input.value,
            APP_PREFERENCE_DEFAULTS.updateReminder
          )
        )
      );
    }
    if (input.key === APP_PREFERENCE_KEYS.updateAutoUpdate) {
      const { setAutoUpdateEnabled } = await import(
        "@/services/update-manager"
      );
      setAutoUpdateEnabled(
        parseBooleanPreference(
          input.value,
          APP_PREFERENCE_DEFAULTS.updateAutoUpdate
        )
      );
    } else if (input.key === APP_PREFERENCE_KEYS.updateReminder) {
      const { setReminderEnabled } = await import("@/services/update-manager");
      setReminderEnabled(
        parseBooleanPreference(
          input.value,
          APP_PREFERENCE_DEFAULTS.updateReminder
        )
      );
    }
    return { ok: true };
  });

export const getDataPathInfo = os.handler(() => {
  return {
    path: getDataPath(),
    isDefault: isDefaultDataPath(),
  };
});

export const setDataPath = os
  .input(z.object({ newPath: z.string().min(1) }))
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Data-path migration preserves validation, progress, rollback, and restart ordering.
  .handler(async ({ input }) => {
    diagLog("setDataPath: START");
    const oldPath = getDataPath();
    const { newPath } = input;
    diagLog(`setDataPath: old=${oldPath} new=${newPath}`);

    // Validate new path
    if (!fs.existsSync(newPath)) {
      try {
        diagLog("setDataPath: mkdir newPath");
        fs.mkdirSync(newPath, { recursive: true });
      } catch {
        return { ok: false, error: "无法创建目录" };
      }
    }

    // Check writable
    try {
      fs.accessSync(newPath, fs.constants.W_OK);
    } catch {
      return { ok: false, error: "目录不可写" };
    }

    // Same path
    if (path.resolve(oldPath) === path.resolve(newPath)) {
      return { ok: true, copied: 0 };
    }

    // An existing library must be connected in place instead of treated as a
    // migration target. Other managed subdirectories are still rejected so
    // unrelated data is never merged or overwritten.
    const destination = inspectDataPathDestination(newPath);
    if (destination.kind === "conflict") {
      const dir = destination.conflictingDirectory;
      diagLog(
        `setDataPath: ABORT — dst subdir exists without database: ${dir}`
      );
      return {
        ok: false,
        error: `目标目录下已有 ${dir} 子目录，但未发现有效的图库数据库。请选择已有图库的根目录，或选择一个空目录`,
      };
    }
    const usesExistingLibrary = destination.kind === "existing-library";
    const subDirs = DATA_PATH_SUBDIRECTORIES;
    diagLog(
      usesExistingLibrary
        ? `setDataPath: existing library detected at ${destination.databasePath}`
        : "setDataPath: empty migration destination detected"
    );

    sendMigrateProgress({
      phase: "start",
      total: usesExistingLibrary ? 0 : subDirs.length,
    });

    // Gracefully close all services to release file locks (DB, vector DB, etc.)
    diagLog("setDataPath: calling registry.stop()");
    sendMigrateProgress({ phase: "stopping-services" });
    try {
      await registry.stop();
      diagLog("setDataPath: registry.stop() OK");
    } catch (err) {
      diagLog(
        `setDataPath: registry.stop() FAILED: ${(err as Error)?.message}`
      );
      console.error(
        "[Settings] Failed to stop services before migration:",
        (err as Error)?.message
      );
      return { ok: false, error: "无法关闭后台服务，请重试" };
    }

    // Migrate data subdirectories from old to new (don't delete old data).
    // IMPORTANT: must be async — fs.cpSync blocks the Electron main process
    // event loop, and Windows kills the app as "Not Responding" when copying
    // hundreds of MB (e.g. the ~300 MB models directory).
    let copied = 0;
    const errors: string[] = [];
    const copiedDirs = new Set<string>();
    const destinationDirs = new Set<string>();
    let canCleanupOldPath = false;
    for (let i = 0; !usesExistingLibrary && i < subDirs.length; i++) {
      const dir = subDirs[i];
      const index = i + 1;
      const total = subDirs.length;
      const src = path.join(oldPath, dir);
      const dst = path.join(newPath, dir);
      let srcExists = false;
      try {
        srcExists = fs.existsSync(src);
      } catch {
        srcExists = false;
      }
      if (!srcExists) {
        diagLog(`setDataPath: skip ${dir} (src missing)`);
        sendMigrateProgress({
          phase: "skipped",
          dir,
          index,
          total,
          reason: "源目录不存在",
        });
        continue;
      }
      try {
        diagLog(`setDataPath: copying ${dir}…`);
        // Rollback may remove only destination directories that were absent
        // immediately before this copy. Never delete a pre-existing user
        // directory if a copy races with another process.
        if (!fs.existsSync(dst)) {
          destinationDirs.add(dst);
        }
        sendMigrateProgress({ phase: "copying", dir, index, total });
        await fsp.cp(src, dst, {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
        copied++;
        copiedDirs.add(dir);
        diagLog(`setDataPath: copy ${dir} OK`);
        sendMigrateProgress({ phase: "copied", dir, index, total });
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        diagLog(`setDataPath: copy ${dir} FAILED: ${msg}`);
        console.error(`[Settings] Failed to copy ${dir}:`, msg);
        errors.push(`${dir}: ${msg}`);
        sendMigrateProgress({
          phase: "failed",
          dir,
          index,
          total,
          error: msg,
        });
      }
    }

    if (errors.length > 0) {
      const rollbackErrors: string[] = [];
      for (const dst of destinationDirs) {
        try {
          await fsp.rm(dst, { recursive: true, force: true });
        } catch (err) {
          rollbackErrors.push(
            `${path.basename(dst)}: ${(err as Error)?.message ?? String(err)}`
          );
        }
      }
      errors.push(...rollbackErrors.map((error) => `rollback: ${error}`));
      sendMigrateProgress({ phase: "done", copied, errors });
      // Try to bring services back up on the OLD path so the app stays usable.
      try {
        await registry.start();
      } catch (err) {
        diagLog(
          `setDataPath: rollback registry.start() FAILED: ${(err as Error)?.message}`
        );
      }
      return {
        ok: false,
        error: `文件迁移失败：${errors.join("; ")}`,
      };
    }

    diagLog("setDataPath: calling setCustomDataPath");
    setCustomDataPath(newPath);
    diagLog("setDataPath: DONE");
    console.log(
      `[Settings] Data path changed: ${oldPath} → ${newPath} (${usesExistingLibrary ? "connected existing library" : `copied ${copied} dirs`})`
    );

    // Clean up the old directory's subdirs to avoid disk bloat across repeated
    // migrations (each migration would otherwise leave a ~420MB orphan copy).
    // SAFETY: we only ever delete the four well-known subdirs we just copied,
    // and only if their copy succeeded — never the parent oldPath itself, never
    // any other files the user may have placed there.
    let cleaned = 0;
    const cleanupErrors: string[] = [];
    if (canCleanupOldPath) {
      for (const dir of subDirs) {
        const oldSub = path.join(oldPath, dir);
        let exists = false;
        try {
          exists = fs.existsSync(oldSub);
        } catch {
          exists = false;
        }
        if (!exists) {
          continue;
        }
        try {
          diagLog(`setDataPath: cleanup removing old ${oldSub}`);
          await fsp.rm(oldSub, { recursive: true, force: true });
          cleaned++;
          diagLog(`setDataPath: cleanup ${dir} OK`);
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          diagLog(`setDataPath: cleanup ${dir} FAILED: ${msg}`);
          cleanupErrors.push(`${dir}: ${msg}`);
        }
      }
      if (cleaned > 0) {
        console.log(
          `[Settings] Removed ${cleaned} old subdir(s) under ${oldPath}`
        );
      }
    } else {
      diagLog(
        "setDataPath: skip cleanup (errors during copy — preserving old data)"
      );
    }

    // Restart services in-place against the NEW path. This avoids relying on
    // app.relaunch() (broken in `npm run dev` because forge tears down the
    // Vite dev server when the main process exits, so the relaunched process
    // loads a dead URL → white screen). The renderer will reload() on receipt
    // of the "done" event and reconnect via a fresh oRPC port.
    diagLog("setDataPath: calling registry.start()");
    try {
      await registry.start();
      diagLog("setDataPath: registry.start() OK");
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      diagLog(`setDataPath: registry.start() FAILED: ${msg}`);
      console.error("[Settings] Failed to restart services:", msg);
      setCustomDataPath(oldPath);
      try {
        await registry.start();
      } catch (rollbackErr) {
        diagLog(
          `setDataPath: old-path restart FAILED: ${(rollbackErr as Error)?.message ?? rollbackErr}`
        );
      }
      sendMigrateProgress({
        phase: "done",
        copied,
        errors: [...errors, `服务重启失败：${msg}`],
      });
      return {
        ok: false,
        error: usesExistingLibrary
          ? `无法打开已有图库：${msg}。已恢复原数据目录`
          : `数据已迁移到新路径，但服务重启失败：${msg}。请手动重启应用。`,
      };
    }

    canCleanupOldPath = true;
    let cleanedAfterStart = 0;
    const cleanupErrorsAfterStart: string[] = [];
    for (const dir of copiedDirs) {
      try {
        await fsp.rm(path.join(oldPath, dir), { recursive: true, force: true });
        cleanedAfterStart++;
      } catch (err) {
        cleanupErrorsAfterStart.push(
          `${dir}: ${(err as Error)?.message ?? String(err)}`
        );
      }
    }

    sendMigrateProgress({ phase: "done", copied, errors });
    return {
      ok: true,
      adopted: usesExistingLibrary,
      copied,
      cleaned: cleanedAfterStart,
      errors: errors.length > 0 ? errors : undefined,
      cleanupErrors:
        cleanupErrorsAfterStart.length > 0
          ? cleanupErrorsAfterStart
          : undefined,
    };
  });

export const getMirrorSettings = os.handler(() => {
  const mirror = getSetting("ai.mirror") || "auto";
  const customUrl = getSetting("ai.mirror.customUrl") || "";
  return { mirror, customUrl };
});

export const setMirrorSettings = os
  .input(
    z.object({
      mirror: z.string(),
      customUrl: z.string().optional(),
    })
  )
  .handler(({ input }) => {
    setSetting("ai.mirror", input.mirror);
    if (input.customUrl) {
      setSetting("ai.mirror.customUrl", input.customUrl);
    }
    return { ok: true };
  });

export const checkMirrorHealth = os.handler(async () => {
  const { checkAllMirrors } = await import("@/services/ai/mirror-health");
  const results = await checkAllMirrors();
  return { results };
});

const VIRTUAL_GPU_RE =
  /virtual|mumu|oray|remote\s*display|basic\s*display|hyper-?v|vmware|virtualbox|citrix|parsec|indirect\s*display/i;

export const getGpuSettings = os.handler(() => {
  const enabled = getSetting("gpu.enabled") === "true";
  const promptShown = getSetting("gpu.promptShown") === "true";
  let detected: Record<string, unknown> | null = null;
  const raw = getSetting("gpu.detected");
  if (raw) {
    try {
      detected = JSON.parse(raw);
      // Reject stale cache that captured a virtual display adapter
      // (e.g. OrayIddDriver, MuMu, Hyper-V) instead of the real GPU.
      if (
        detected &&
        typeof detected.gpuName === "string" &&
        VIRTUAL_GPU_RE.test(detected.gpuName)
      ) {
        detected = null;
      }
    } catch {
      /* ignore malformed */
    }
  }
  return { enabled, detected, promptShown };
});

export const setGpuSettings = os
  .input(
    z.object({
      enabled: z.boolean(),
    })
  )
  .handler(({ input }) => {
    setSetting("gpu.enabled", String(input.enabled));
    return { ok: true };
  });

export const checkGpuCapability = os.handler(async () => {
  const { probeGpuCapability, cacheDetectionResult, findModelsDir } =
    await import("@/services/gpu-detector");
  const modelsDir = findModelsDir();
  const result = await probeGpuCapability(modelsDir);
  cacheDetectionResult(result);
  return result;
});

export const markGpuPromptShown = os.handler(async () => {
  const { markPromptShown } = await import("@/services/gpu-detector");
  markPromptShown();
  return { ok: true };
});

export const getOpenAtLogin = os.handler(() => {
  return { openAtLogin: app.getLoginItemSettings().openAtLogin };
});

export const setOpenAtLogin = os
  .input(z.object({ openAtLogin: z.boolean() }))
  .handler(({ input }) => {
    app.setLoginItemSettings({ openAtLogin: input.openAtLogin });
    return { ok: true };
  });

/* ── 局域网访问（自用新增） ─────────────────────────────────
 *
 * 这一组接口**只给本机渲染层用**。局域网侧（手机网页 / 只读 API）永远拿不到
 * 这里的信息 —— 端口、口令、开关一律不通过 HTTP 暴露，见「局域网功能实施计划.md」§5。
 *
 * 口令**只存哈希**，所以这里没有任何"读回口令"的接口：
 *  · 生成类接口把明文放在**返回值里**（设置页当场显示一次，随后只存在于组件内存）
 *  · 自定义输入的口令由用户自己输入，服务端同样不会回传
 */

/** 口令长度校验（真正确认还在服务层，这里只是把错误提前到 IPC 边界）。*/
const lanPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `口令至少需要 ${MIN_PASSWORD_LENGTH} 位`);

const lanPortSchema = z.number().int().min(MIN_LAN_PORT).max(MAX_LAN_PORT);

const lanTempHoursSchema = z
  .number()
  .int()
  .refine(
    (value) => (TEMP_PASSWORD_HOUR_OPTIONS as readonly number[]).includes(value),
    { message: "不支持的临时口令有效时长" }
  );

/** 本机在局域网里的 IPv4 地址，供设置页拼出"用手机访问这个地址"。*/
function listLocalIpv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(nodeOs.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

function lanSettingsView() {
  return {
    ...getLanConfigValue(),
    localAddresses: listLocalIpv4Addresses(),
  };
}

/**
 * 局域网配置改完之后：让监听器与设置对齐，再把**真实**的监听状态一起返回。
 *
 * 这里用动态 import 是有意的 —— `http-server` 会拉进 sharp/thumbnailer，
 * 没必要让只用到其它设置项的地方也跟着加载它。
 */
async function lanSettingsViewAfterChange() {
  const { getLanListenerStatus, syncLanListener } = await import(
    "@/services/http-server"
  );
  await syncLanListener();
  return {
    ...getLanConfigValue(),
    listener: getLanListenerStatus(),
    localAddresses: listLocalIpv4Addresses(),
  };
}

export const getLanSettings = os.handler(async () => {
  const { getLanListenerStatus } = await import("@/services/http-server");
  return { ...lanSettingsView(), listener: getLanListenerStatus() };
});

/** 重新尝试绑定局域网端口（端口曾被占用、现在空出来了时用）。*/
export const retryLanListener = os.handler(() => lanSettingsViewAfterChange());

export const setLanEnabled = os
  .input(z.object({ enabled: z.boolean() }))
  .handler(async ({ input }) => {
    setLanEnabledValue(input.enabled);
    return await lanSettingsViewAfterChange();
  });

export const setLanPort = os
  .input(z.object({ port: lanPortSchema }))
  .handler(async ({ input }) => {
    setLanPortValue(input.port);
    return await lanSettingsViewAfterChange();
  });

/** 换一个随机端口（默认端口就是随机生成的，撞端口时点这个）。*/
export const pickRandomLanPort = os.handler(async () => {
  setRandomLanPortValue();
  return await lanSettingsViewAfterChange();
});

export const setLanPermanentPassword = os
  .input(z.object({ password: lanPasswordSchema }))
  .handler(async ({ input }) => {
    setPermanentPasswordValue(input.password);
    return await lanSettingsViewAfterChange();
  });

/** 生成随机永久口令；`password` 只在这一个返回值里出现。*/
export const generateLanPermanentPassword = os.handler(async () => ({
  ...(await lanSettingsViewAfterChange()),
  password: generatePermanentPasswordValue(),
}));

export const clearLanPermanentPassword = os.handler(async () => {
  clearPermanentPasswordValue();
  return await lanSettingsViewAfterChange();
});

export const setLanTempPassword = os
  .input(z.object({ password: lanPasswordSchema, hours: lanTempHoursSchema }))
  .handler(async ({ input }) => {
    setTempPasswordValue(input.password, input.hours);
    return await lanSettingsViewAfterChange();
  });

/** 生成随机临时口令；`password` 只在这一个返回值里出现。*/
export const generateLanTempPassword = os
  .input(z.object({ hours: lanTempHoursSchema }))
  .handler(async ({ input }) => {
    const { password, expiresAt } = generateTempPasswordValue(input.hours);
    return { ...(await lanSettingsViewAfterChange()), expiresAt, password };
  });

export const clearLanTempPassword = os.handler(async () => {
  clearTempPasswordValue();
  return await lanSettingsViewAfterChange();
});

export const setLanTempPasswordHours = os
  .input(z.object({ hours: lanTempHoursSchema }))
  .handler(async ({ input }) => {
    setTempPasswordHoursValue(input.hours);
    return await lanSettingsViewAfterChange();
  });
