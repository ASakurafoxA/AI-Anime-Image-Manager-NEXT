/**
 * 角色标签的共享查询助手（NEXT 版新增）。
 *
 * 抽出来的原因：`character-suggest.ts`（种子投票）和 `character-cluster.ts`（无监督聚类）
 * 都要知道"哪些标签算角色标签"，两处各写一份迟早会不一致。
 * `collectDescendantTagIds` 的既有实现保留在 character-suggest.ts 里不动（有单测钉着），
 * 这里只提供更简单的 id 列表入口。
 */
import { getDatabase } from "@/db";
import { tags } from "@/db/schema";

/** 「角色」这一顶层标签的名字（库里 id=2）。 */
export const CHARACTER_ROOT_TAG_NAME = "角色";

export interface CharacterTagRow {
  id: number;
  name: string;
  parentId: number | null;
}

/** 读出全量标签行（内容很少，一次性读入足够）。 */
export function loadTagRows(): CharacterTagRow[] {
  const db = getDatabase();
  return db
    .select({ id: tags.id, name: tags.name, parentId: tags.parentId })
    .from(tags)
    .all();
}

/**
 * 从标签行里算出「角色」顶层标签的全部后代 id。
 *
 * 用迭代遍历而不是递归 SQL（与既有实现同策略：标签树只有几千个节点，
 * 一次读入再在内存里展开，比反复查库快得多）。
 */
export function characterTagIdsFromRows(
  rows: readonly CharacterTagRow[]
): number[] {
  const root = rows.find(
    (row) => row.parentId === null && row.name === CHARACTER_ROOT_TAG_NAME
  );
  if (!root) {
    return [];
  }
  const childrenOf = new Map<number, number[]>();
  for (const row of rows) {
    if (row.parentId === null) {
      continue;
    }
    const list = childrenOf.get(row.parentId);
    if (list) {
      list.push(row.id);
    } else {
      childrenOf.set(row.parentId, [row.id]);
    }
  }
  const ids: number[] = [];
  const stack = [...(childrenOf.get(root.id) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    ids.push(current);
    for (const child of childrenOf.get(current) ?? []) {
      stack.push(child);
    }
  }
  return ids;
}