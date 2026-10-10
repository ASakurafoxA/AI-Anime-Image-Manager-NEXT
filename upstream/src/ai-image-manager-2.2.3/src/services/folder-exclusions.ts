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

/**
 * 「已从索引移除」的文件夹路径。
 *
 * ⚠️ 这和上面的**黑名单不是一回事**，别混：
 *   · 黑名单（hidden）= **视图级过滤**：记录和照片都还在，仍然能被搜索到
 *   · 移除（removed）= 真的把文件夹记录和照片从库里删掉（`deleteFolder`）
 *
 * 为什么移除还要单独记一份路径：
 *   本版有「开机增量补扫」（`scheduleStartupCatchUpScan`，见 private-build.ts），
 *   启动 25 秒后会重扫每个树根，而扫描过程会**自动把"含图片的子目录"重新建成
 *   文件夹记录**（`scanFolder` 里的 auto-discover）。于是用户明明移除过的文件夹，
 *   下次开软件又冒回来了 —— 实测用户反馈的正是这个问题。
 *
 * 处理办法：
 *   · `deleteFolder` 时把路径记进来
 *   · 扫描时跳过这些路径及其整棵子树
 *   · 用户**主动重新导入**某个路径时，忘掉它自己与它的祖先（等于"接回来"），
 *     但它下面**之前被单独移除过**的子目录仍然保持移除
 */
const REMOVED_FOLDERS_KEY = "folders.removedPaths";

/** 读取「已移除」的文件夹路径列表。 */
export function getRemovedFolderPaths(): string[] {
  const raw = getSetting(REMOVED_FOLDERS_KEY);
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

/** 覆盖写入「已移除」列表，返回去重后的结果。 */
export function setRemovedFolderPaths(paths: string[]): string[] {
  const unique = [...new Set(paths.filter((p) => p && p.trim().length > 0))];
  setSetting(REMOVED_FOLDERS_KEY, JSON.stringify(unique));
  return unique;
}

/** 记下一个被移除的文件夹路径。 */
export function addRemovedFolderPath(folderPath: string): string[] {
  return setRemovedFolderPaths([...getRemovedFolderPaths(), folderPath]);
}

/**
 * 这个路径是否处于「已移除」状态（它自己被移除，或它在某个被移除的目录下面）。
 *
 * @param removed 可选：调用方预先读好的列表 —— 扫描时逐目录调用，
 *                每次去查数据库会成为瓶颈，所以外面读一次传进来。
 */
export function isPathRemoved(
  folderPath: string,
  removed: string[] = getRemovedFolderPaths()
): boolean {
  if (removed.length === 0) {
    return false;
  }
  const target = normalizeFolderPath(folderPath);
  return removed.some((item) => {
    const base = normalizeFolderPath(item);
    return target === base || target.startsWith(`${base}\\`);
  });
}

/**
 * 忘掉某个路径的「已移除」记录 —— 用户主动重新导入它时调用。
 *
 * 只忘掉**它自己和它的祖先**（导入 `A\B` 时，`A` 必须能被扫描，否则 `B` 进不来）；
 * 它**下面**之前被单独移除过的子目录保持移除 —— 那是用户另外的意图。
 */
export function forgetRemovedPath(folderPath: string): string[] {
  const target = normalizeFolderPath(folderPath);
  const remaining = getRemovedFolderPaths().filter((item) => {
    const base = normalizeFolderPath(item);
    return !(base === target || target.startsWith(`${base}\\`));
  });
  return setRemovedFolderPaths(remaining);
}


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
