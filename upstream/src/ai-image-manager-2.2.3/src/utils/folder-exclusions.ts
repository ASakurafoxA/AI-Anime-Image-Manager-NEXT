import { getFolderSubtreeIds } from "@/services/folder-hierarchy";

/**
 * 自用精简版：文件夹黑名单（视图级过滤）
 *
 * 设计要点：
 *  - **只过滤视图，绝不取消索引**。照片、缩略图、向量、人脸、phash 全部保留，
 *    照片依然可以被搜索到（搜索链路不做过滤，这是刻意的）。
 *  - 黑名单以**绝对路径**存储而非文件夹 id：文件夹 id 会随着
 *    "从索引移除 → 重新导入" 而变化，用路径可以避免黑名单静默失效。
 *  - 命中黑名单的文件夹及其**整棵子树**都会被排除；但用户主动点进
 *    黑名单文件夹本身时正常显示（见 isFolderInsideExclusion）。
 */
export interface FolderPathItem {
  id: number;
  parentId: number | null;
  path: string;
}

/**
 * Windows 路径归一化：统一分隔符、去尾部斜杠、转小写。
 * NTFS 大小写不敏感，因此比较前统一小写。
 */
export function normalizeFolderPath(folderPath: string): string {
  return folderPath.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** 把存储的路径解析成**当前实际存在**的文件夹 id（已被移除的路径静默忽略）。 */
export function resolveFolderIdsByPath(
  folders: FolderPathItem[],
  paths: string[]
): number[] {
  if (paths.length === 0) {
    return [];
  }
  const wanted = new Set(paths.map(normalizeFolderPath));
  return folders
    .filter((folder) => wanted.has(normalizeFolderPath(folder.path)))
    .map((folder) => folder.id);
}

/**
 * 展开成"需要从聚合视图里排除"的完整文件夹 id 集合
 * （每个黑名单文件夹 = 它自己 + 它的全部子孙）。
 */
export function expandExcludedFolderIds(
  folders: FolderPathItem[],
  paths: string[]
): number[] {
  const excluded = new Set<number>();
  for (const rootId of resolveFolderIdsByPath(folders, paths)) {
    for (const folderId of getFolderSubtreeIds(folders, rootId)) {
      excluded.add(folderId);
    }
  }
  return [...excluded];
}

/** 当前选中的文件夹是否落在某个黑名单文件夹的子树内（是则应当放行）。 */
export function isFolderInsideExclusion(
  folders: FolderPathItem[],
  folderId: number,
  paths: string[]
): boolean {
  return expandExcludedFolderIds(folders, paths).includes(folderId);
}
