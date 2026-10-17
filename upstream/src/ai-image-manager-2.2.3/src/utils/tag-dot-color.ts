/**
 * 自用（问题 2）：标签小点 / 标签 chip 的颜色规则 —— **主进程与界面共用一份**。
 *
 * 背景：颜色是"这个标签属于哪个一级分类（主类）"的标识，所以同一个标签
 * 无论在标签树、顶部已选标签、缩略图角标里，颜色都必须一样。
 * 这套规则原本写在 `components/sidebar-trees.tsx`（React 组件文件）里，
 * 但缩略图角标的颜色要在**主进程**的列表查询里算出来（`ipc/photos/handlers/listing.ts`），
 * 主进程不能 import React 组件，所以抽到这个纯工具模块，两处共用。
 */

/** 主类默认色板（按一级标签 id 稳定取色）。 */
export const ROOT_TAG_DOT_COLORS = [
  "#f97316", // 橙
  "#22c55e", // 绿
  "#3b82f6", // 蓝
  "#a855f7", // 紫
  "#ec4899", // 粉
  "#14b8a6", // 青
  "#eab308", // 黄
  "#ef4444", // 红
];

/** 按主类 id 取的默认色。 */
export function defaultTagDotColor(rootTagId: number): string {
  const index = Math.abs(Math.trunc(rootTagId)) % ROOT_TAG_DOT_COLORS.length;
  return ROOT_TAG_DOT_COLORS[index];
}

export interface TagColorLookupEntry {
  color?: string | null;
  id: number;
  parentId?: number | null;
}

/**
 * 标签颜色：**自己的颜色 → 所属主类的颜色 → 按主类 id 的默认色**。
 *
 * @param tag  目标标签（至少要有 id；有 parentId 才能向上找主类）
 * @param byId 全量标签表（id → {id, color, parentId}），用于向上遍历
 */
export function resolveTagDotColor(
  tag: TagColorLookupEntry,
  byId: Map<number, TagColorLookupEntry>
): string {
  if (tag.color) {
    return tag.color;
  }
  let root = tag;
  const guard = new Set<number>([tag.id]);
  while (root.parentId !== null && root.parentId !== undefined) {
    const parent = byId.get(root.parentId);
    if (!parent || guard.has(parent.id)) {
      break;
    }
    guard.add(parent.id);
    root = parent;
  }
  return root.color || defaultTagDotColor(root.id);
}
