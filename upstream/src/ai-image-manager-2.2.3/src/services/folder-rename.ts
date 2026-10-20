/**
 * 「在软件里重命名文件夹」的纯逻辑（NEXT 版新增）。
 *
 * 用户口径：
 *   "加个重命名文件夹的功能，软件里重命名就同步系统文件夹状态，
 *    如果是系统里先改的没过图库就不管他了，当新的检测入库就好。"
 *
 * 为什么要单独放一个纯函数文件：**路径前缀替换**是这个功能的核心，
 * 一旦写错就会把图库里成片的路径改坏 ✗ —— 所以它必须能被独立单测 ✓。
 */
import path from "node:path";

/**
 * 把 `p` 前缀部分的 `oldPrefix` 换成 `newPrefix`；**不匹配则返回 null**。
 *
 * 注意：必须按"目录边界"匹配 —— 只比较 `startsWith` 会把
 * `/图库/12` 误伤到 `/图库/123` 里去 ✗，所以补上路径分隔符再比 ✓。
 * 相等的情况单独处理（文件夹自己）✓。
 */
export function replacePathPrefix(
  p: string,
  oldPrefix: string,
  newPrefix: string
): string | null {
  if (p === oldPrefix) {
    return newPrefix;
  }
  const boundary = oldPrefix.endsWith(path.sep)
    ? oldPrefix
    : `${oldPrefix}${path.sep}`;
  if (p.startsWith(boundary)) {
    return `${newPrefix}${p.slice(oldPrefix.length)}`;
  }
  return null;
}

/** Windows 不允许的保留名（CON、PRN、COM1…）。 */
const WINDOWS_RESERVED_NAME =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 校验"新文件夹名"。返回**错误说明**（给用户看的中文），合法则返回 null。
 *
 * 这里必须拦住的几类（否则 `fs.rename` 要么报错、要么产生用户看不懂的后果）：
 *   · 空名、`.`、`..`     —— 会把文件夹移到父目录/更上层 ✗
 *   · 含 `\ / : * ? " < > |` —— 非法路径字符 ✗
 *   · 结尾是点或空格      —— Windows 会静默去掉，导致磁盘名与图库记录对不上 ✗
 *   · Windows 保留名      —— 系统直接拒绝 ✗
 */
export function validateFolderName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "名字不能为空";
  }
  if (trimmed.length > 200) {
    return "名字太长了";
  }
  if (trimmed === "." || trimmed === "..") {
    return "这个名字不能用";
  }
  if (/[\\/:*?"<>|]/.test(trimmed)) {
    return '名字里不能有 \\ / : * ? " < > | 这些字符';
  }
  /*
   * 结尾不能是点：Windows 会把它静默去掉（"名字." 存成 "名字"），
   * 于是磁盘上的名字与图库记录对不上 ✗。
   * 结尾空格不用管 —— 上面已经 `trim()` 过了，压根到不了这里 ✓。
   */
  if (trimmed.endsWith(".")) {
    return "名字结尾不能是点（Windows 不允许）";
  }
  if (WINDOWS_RESERVED_NAME.test(trimmed)) {
    return "这个名字是系统保留名，换一个吧";
  }
  return null;
}
