import { ipc } from "@/ipc/manager";

export const UI_REDUCE_MOTION_KEY = "ui.reduceMotion";
export const UI_REDUCE_MOTION_STORAGE_KEY = UI_REDUCE_MOTION_KEY;

export function parseReduceMotionValue(value: string | null | undefined) {
  return value === "true";
}

export function readCachedReduceMotion() {
  try {
    return parseReduceMotionValue(
      window.localStorage.getItem(UI_REDUCE_MOTION_STORAGE_KEY)
    );
  } catch {
    return false;
  }
}

export function cacheReduceMotion(value: boolean) {
  try {
    window.localStorage.setItem(UI_REDUCE_MOTION_STORAGE_KEY, String(value));
  } catch {
    // localStorage is best-effort; SQLite remains the source of persistence.
  }
}

export async function getReduceMotionPreference() {
  const result = await ipc.client.settings.getAppSetting({
    key: UI_REDUCE_MOTION_KEY,
  });
  const value = parseReduceMotionValue(
    result && typeof result === "object" && "value" in result
      ? (result as { value?: string | null }).value
      : undefined
  );
  cacheReduceMotion(value);
  return value;
}

export async function setReduceMotionPreference(value: boolean) {
  await ipc.client.settings.setAppPreference({
    key: UI_REDUCE_MOTION_KEY,
    value: String(value),
  });
  cacheReduceMotion(value);
}

/** The document attribute is the non-React source used before the first render. */
export function isReducedMotionEnabled() {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.reducedMotion === "true"
  );
}

/*
 * 2026-11-14（会话#12 · 用户实测「关了开关、重开还是展开」）：
 *
 * 原来只存 localStorage —— 而 dev 版每次启动开发服务器端口可能变（5173 → 5174 …），
 * **origin 一变 localStorage 就是另一个命名空间**，值等于丢了；打包版则是 file:// 又是第三份。
 * 所以改成**和「减少动效」一样**：SQLite 是唯一真相，localStorage 只做首帧缓存。
 */
export const FOLDER_TREE_EXPANDED_KEY = "ui.folderTreeExpanded";

export function parseFolderTreeExpandedValue(
  value: string | null | undefined
): boolean {
  // 没存过 → 默认展开（保持老行为）
  return value == null ? true : value === "true";
}

export function readCachedFolderTreeExpanded(): boolean {
  try {
    return parseFolderTreeExpandedValue(
      window.localStorage.getItem(FOLDER_TREE_EXPANDED_KEY)
    );
  } catch {
    return true;
  }
}

export function cacheFolderTreeExpanded(value: boolean) {
  try {
    window.localStorage.setItem(FOLDER_TREE_EXPANDED_KEY, String(value));
  } catch {
    // best-effort；SQLite 才是持久化来源
  }
}

export async function getFolderTreeExpandedPreference(): Promise<boolean> {
  try {
    const result = await ipc.client.settings.getAppSetting({
      key: FOLDER_TREE_EXPANDED_KEY,
    });
    const value = parseFolderTreeExpandedValue(
      result && typeof result === "object" && "value" in result
        ? (result as { value?: string | null }).value
        : undefined
    );
    cacheFolderTreeExpanded(value);
    return value;
  } catch {
    return readCachedFolderTreeExpanded();
  }
}

export async function setFolderTreeExpandedPreference(value: boolean) {
  await ipc.client.settings.setAppPreference({
    key: FOLDER_TREE_EXPANDED_KEY,
    value: String(value),
  });
  cacheFolderTreeExpanded(value);
}
