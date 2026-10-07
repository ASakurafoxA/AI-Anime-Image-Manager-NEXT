import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { folders } from "@/db/schema";
import { getSetting, setSetting } from "@/services/settings-manager";
import {
  expandExcludedFolderIds,
  type FolderPathItem,
  normalizeFolderPath,
} from "@/utils/folder-exclusions";

/**
 * 自用精简版：文件夹黑名单的存取层。
 *
 * 参照上游既有的 `services/face-scan-scope.ts` 写法：把一组文件夹路径以 JSON
 * 存进 app_settings 的通用键值表，因此**不需要数据库迁移**。
 */
const HIDDEN_FOLDERS_KEY = "folders.hiddenPaths";

/** 读取全部已索引文件夹的层级 + 路径信息。 */
export function getAllFolderPathItems(): FolderPathItem[] {
  return getDatabase()
    .select({ id: folders.id, parentId: folders.parentId, path: folders.path })
    .from(folders)
    .all();
}

/** 读取黑名单（绝对路径列表）。 */
export function getHiddenFolderPaths(): string[] {
  const raw = getSetting(HIDDEN_FOLDERS_KEY);
  if (!raw) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter(
          (item): item is string => typeof item === "string" && item.length > 0
        )
      : [];
  } catch {
    return [];
  }
}

/** 覆盖写入黑名单，返回去重后的结果。 */
export function setHiddenFolderPaths(paths: string[]): string[] {
  const unique = [...new Set(paths.filter((p) => p && p.trim().length > 0))];
  setSetting(HIDDEN_FOLDERS_KEY, JSON.stringify(unique));
  return unique;
}

/**
 * 需要从聚合视图（「全部照片」/父文件夹/标签/收藏/未分组）里排除的文件夹 id 集合。
 */
export function resolveExcludedFolderIds(
  rows: FolderPathItem[] = getAllFolderPathItems()
): number[] {
  return expandExcludedFolderIds(rows, getHiddenFolderPaths());
}

/**
 * 供界面使用的完整状态：黑名单路径 + 当前已解析到的文件夹 id，
 * 便于左侧树给黑名单文件夹打标记。
 */
export function getHiddenFoldersState(): {
  paths: string[];
  resolvedFolderIds: number[];
} {
  const rows = getAllFolderPathItems();
  const paths = getHiddenFolderPaths();
  return {
    resolvedFolderIds: expandExcludedFolderIds(rows, paths),
    paths,
  };
}

/**
 * 把某个文件夹加入 / 移出黑名单。
 *
 * 由**主进程**按 id 反查路径后再落库：渲染层只传 id，路径的归一化与大小写
 * 处理都留在这一侧，避免把 Windows 路径语义泄漏到界面代码里。
 */
export function setFolderHiddenById(
  folderId: number,
  hidden: boolean
): { paths: string[]; resolvedFolderIds: number[] } {
  const folder = getDatabase()
    .select({ path: folders.path })
    .from(folders)
    .where(eq(folders.id, folderId))
    .get();
  if (!folder) {
    return getHiddenFoldersState();
  }

  const normalized = normalizeFolderPath(folder.path);
  const current = getHiddenFolderPaths();
  const remaining = current.filter(
    (stored) => normalizeFolderPath(stored) !== normalized
  );
  setHiddenFolderPaths(hidden ? [...remaining, folder.path] : remaining);
  return getHiddenFoldersState();
}
