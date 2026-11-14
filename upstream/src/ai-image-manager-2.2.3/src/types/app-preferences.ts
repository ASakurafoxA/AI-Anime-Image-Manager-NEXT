import {
  ACCENT_COLOR_KEY,
  type AccentColor,
  DEFAULT_ACCENT_COLOR,
} from "@/types/accent-color";

export type CloseBehavior = "tray" | "quit" | "ask";

export interface AppPreferences {
  accentColor: AccentColor;
  closeBehavior: CloseBehavior;
  /** 文件夹树进软件时默认展开主文件夹（2026-11-14 · 会话#12） */
  folderTreeExpanded: boolean;
  reduceMotion: boolean;
  rememberBounds: boolean;
  updateAutoUpdate: boolean;
  updateReminder: boolean;
}

export const APP_PREFERENCE_DEFAULTS: AppPreferences = {
  accentColor: DEFAULT_ACCENT_COLOR,
  closeBehavior: "tray",
  folderTreeExpanded: true,
  reduceMotion: false,
  rememberBounds: false,
  updateAutoUpdate: true,
  updateReminder: true,
};

export const APP_PREFERENCE_KEYS = {
  accentColor: ACCENT_COLOR_KEY,
  closeBehavior: "window.closeBehavior",
  folderTreeExpanded: "ui.folderTreeExpanded",
  reduceMotion: "ui.reduceMotion",
  rememberBounds: "window.rememberBounds",
  updateAutoUpdate: "update.autoUpdate",
  updateReminder: "update.reminder",
} as const;

export function parseBooleanPreference(
  value: string | null | undefined,
  fallback: boolean
): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
}

export function parseCloseBehavior(
  value: string | null | undefined
): CloseBehavior {
  return value === "quit" || value === "ask" || value === "tray"
    ? value
    : APP_PREFERENCE_DEFAULTS.closeBehavior;
}
