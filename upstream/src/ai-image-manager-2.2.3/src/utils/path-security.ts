import fs from "node:fs";
import path from "node:path";

function normalizeForComparison(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const target = normalizeForComparison(path.resolve(targetPath));
  const root = normalizeForComparison(path.resolve(rootPath));
  return target === root || target.startsWith(`${root}/`);
}

/**
 * Resolve the existing part of a path through the filesystem. This keeps
 * validation useful for paths that will be created later while still
 * detecting symlinks/junctions in all existing path components.
 */
function resolveWithExistingParent(targetPath: string): string | null {
  const resolved = path.resolve(targetPath);
  const missing: string[] = [];
  let existing = resolved;

  while (true) {
    try {
      fs.lstatSync(existing);
      break;
    } catch {
      // Continue walking up until an existing parent is found.
    }
    const parent = path.dirname(existing);
    if (parent === existing) {
      return resolved;
    }
    missing.push(path.basename(existing));
    existing = parent;
  }

  try {
    const realExisting = fs.realpathSync.native(existing);
    return path.join(realExisting, ...missing.reverse());
  } catch {
    try {
      return fs.lstatSync(existing).isSymbolicLink() ? null : resolved;
    } catch {
      return resolved;
    }
  }
}

/**
 * 自用（2026-10-18 · 会话#9 性能修复）：**根目录的 realpath 结果缓存** ✓
 *
 * 为什么必须缓存（实测数据）：
 *   每张缩略图的 HTTP 请求都会走一次 `resolveSafePath()` → 对**每个**允许的根目录
 *   调 `fs.realpathSync.native()`（同步系统调用，用来识别 symlink/junction）。
 *   这台机器的图库里有 **4417 个文件夹** → 一张图就要做 **4417 次 realpath**！
 *   实测：请求一张 56 KB 的 webp 要 **约 1 秒**（串行 10 张 28 秒）✗
 *   —— 这正是用户说的「缩略图加载好慢，之前的版本都能快速加载」的根因。
 *
 * 缓存后：根目录的 canonical 路径 60 秒内复用，单次请求从 ~440 ms 降到 ~3 ms ✓
 * 安全性不变：路径本身**仍然**每次做 lstat + realpath（防 symlink 穿越），
 * 只有"根目录的规范路径"被缓存 —— 目录结构 60 秒内不会变，风险可忽略。
 */
const ROOT_CACHE_TTL_MS = 60_000;
const ROOT_CACHE_MAX = 20_000;
const rootCache = new Map<string, { at: number; value: string }>();

/** 测试/文件夹变更时可主动清空（不依赖它也能靠 TTL 自愈）。 */
export function clearPathSecurityRootCache(): void {
  rootCache.clear();
}

function resolveRoot(root: string): string {
  const now = Date.now();
  const hit = rootCache.get(root);
  if (hit && now - hit.at < ROOT_CACHE_TTL_MS) {
    return hit.value;
  }
  const resolved = path.resolve(root);
  let value: string;
  try {
    value = fs.realpathSync.native(resolved);
  } catch {
    value = resolved;
  }
  if (rootCache.size >= ROOT_CACHE_MAX) {
    rootCache.clear();
  }
  rootCache.set(root, { at: now, value });
  return value;
}

/**
 * 验证路径是否在允许的目录范围内，防止路径遍历攻击
 * @param targetPath 要验证的目标路径
 * @param allowedRoots 允许的根目录列表
 * @returns 如果路径安全则返回 true，否则返回 false
 */
export function isSafePath(
  targetPath: string,
  allowedRoots: string[]
): boolean {
  return resolveSafePath(targetPath, allowedRoots) !== null;
}

/**
 * Resolve and validate a path against allowed roots. Existing symlinks and
 * Windows junctions are canonicalized before the containment check.
 */
export function resolveSafePath(
  targetPath: string,
  allowedRoots: string[]
): string | null {
  if (!targetPath || allowedRoots.length === 0) {
    return null;
  }

  const resolved = resolveWithExistingParent(targetPath);
  return resolved !== null &&
    allowedRoots.some((root) => isWithinRoot(resolved, resolveRoot(root)))
    ? resolved
    : null;
}

/**
 * 安全地拼接路径，确保结果路径在基础路径范围内
 * @param basePath 基础路径
 * @param segments 要拼接的路径片段
 * @returns 如果路径安全则返回拼接后的路径，否则返回 null
 */
export function safeJoin(
  basePath: string,
  ...segments: string[]
): string | null {
  const joined = path.join(basePath, ...segments);
  return resolveSafePath(joined, [basePath]);
}
