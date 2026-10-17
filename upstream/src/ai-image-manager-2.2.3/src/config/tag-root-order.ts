/**
 * 一级标签（"主类"）的固定显示顺序（自用）。
 *
 * 桌面侧边栏（`components/sidebar-trees.tsx` 的 `buildTagTree`）与
 * 局域网网页端（`services/lan-api.ts` 的 `listLanTags`）都读这一份，
 * 保证两端顺序一致 —— 目前的要求是**「角色」置顶**，其后是「通用」，
 * 其余主类保持各自原有的相对顺序。
 *
 * 注意：这里比对的是标签的**原始名**（`tag.name`），不是界面显示名。
 */
export const TAG_ROOT_ORDER: readonly string[] = ["角色", "通用"];

/** 主类在固定顺序里的排位；不在名单里的排到名单之后。 */
export function tagRootRank(name: string): number {
  const index = TAG_ROOT_ORDER.indexOf(name);
  return index === -1 ? TAG_ROOT_ORDER.length : index;
}
