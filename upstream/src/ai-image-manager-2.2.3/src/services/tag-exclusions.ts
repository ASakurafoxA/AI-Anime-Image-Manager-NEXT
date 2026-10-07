/**
 * 标签黑名单（自用新增）。
 *
 * 用途：把不关心的标签（例如某个不喜欢的类型目录、或某些成人向子标签）
 * 从标签树里移出去，集中放到侧边栏底部的独立区域。
 *
 * 与「文件夹黑名单」同一套思路：
 *  - 存进 `app_settings` 的通用键值表 → **不需要数据库迁移**
 *  - **只影响显示，不删数据**：`photo_tags` 一行不动，标签仍可被搜索到
 */
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { tags } from "@/db/schema";
import { getSetting, setSetting } from "@/services/settings-manager";

/** `app_settings` 里的键。存 JSON 数组（标签 id）。 */
export const HIDDEN_TAGS_KEY = "tags.hiddenIds";

export interface HiddenTagInfo {
  id: number;
  name: string;
  parentId: number | null;
}

function parseIds(raw: string | null): number[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

/** 读取黑名单里的标签 id（去重、升序，便于比较）。 */
export function getHiddenTagIds(): number[] {
  return [...new Set(parseIds(getSetting(HIDDEN_TAGS_KEY)))].sort(
    (a, b) => a - b
  );
}

export function setHiddenTagIds(ids: number[]): void {
  const next = [...new Set(ids)].filter(
    (value) => Number.isInteger(value) && value > 0
  );
  setSetting(HIDDEN_TAGS_KEY, JSON.stringify(next.sort((a, b) => a - b)));
}

/**
 * 黑名单详情（给侧边栏底部区域渲染用）。
 *
 * 已失效的 id（标签被删除）会被**自动清理**，避免黑名单里留下点不动的条目。
 */
export function getHiddenTagsState(): HiddenTagInfo[] {
  const ids = getHiddenTagIds();
  if (ids.length === 0) {
    return [];
  }
  const db = getDatabase();
  const rows = db
    .select({ id: tags.id, name: tags.name, parentId: tags.parentId })
    .from(tags)
    .all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result: HiddenTagInfo[] = [];
  const alive: number[] = [];
  for (const id of ids) {
    const found = byId.get(id);
    if (found) {
      result.push(found);
      alive.push(id);
    }
  }
  if (alive.length !== ids.length) {
    setHiddenTagIds(alive);
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** 按 id 加入 / 移出黑名单。 */
export function setTagHiddenById(tagId: number, hidden: boolean): void {
  const current = new Set(getHiddenTagIds());
  if (hidden) {
    current.add(tagId);
  } else {
    current.delete(tagId);
  }
  setHiddenTagIds([...current]);
}

/**
 * 由黑名单 id 展开成"需要从标签树隐藏的全部 id"（含各自的子孙）。
 *
 * 与文件夹黑名单同理：隐藏一个类型目录时，它下面的标签也应一起消失，
 * 否则目录空了、子标签还挂在那儿。
 */
export function expandHiddenTagIds(
  allTags: { id: number; parentId: number | null }[]
): Set<number> {
  const hiddenRoots = new Set(getHiddenTagIds());
  if (hiddenRoots.size === 0) {
    return hiddenRoots;
  }
  const childrenByParent = new Map<number, number[]>();
  for (const tag of allTags) {
    if (tag.parentId === null) {
      continue;
    }
    const list = childrenByParent.get(tag.parentId);
    if (list) {
      list.push(tag.id);
    } else {
      childrenByParent.set(tag.parentId, [tag.id]);
    }
  }
  const result = new Set(hiddenRoots);
  const queue = [...hiddenRoots];
  while (queue.length > 0) {
    const current = queue.pop() as number;
    for (const child of childrenByParent.get(current) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}

/** 供主进程查询：某个标签是否（直接）在黑名单里。 */
export function isTagHidden(tagId: number): boolean {
  const db = getDatabase();
  const exists = db.select({ id: tags.id }).from(tags).where(eq(tags.id, tagId)).get();
  return Boolean(exists) && getHiddenTagIds().includes(tagId);
}
