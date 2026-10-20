/**
 * 自用（2026-10-18 · 会话#9）：**清除「还没命名」的角色检测结果**。
 *
 * 用户的规则（原话）：
 *   「要一个清空人物数据，但不要用原来的代码，你重新写一个，作用是**清除未命名的结果**，
 *     要二次确认，**已经命名的不能被删**」
 *
 * 所以这里刻意**不复用** `character-group-store.ts` 里原有的清理函数，
 * 而是独立实现一份最小、可读、可单测的逻辑：
 *   · 只处理 `<图库>/character-groups.json`（聚类结果缓存）；
 *   · 只删 `namedTagId == null` 的分组（检测出来、还没起名的）；
 *   · `namedTagId` 有值的分组 = 已经命名过 → **保留**；
 *   · `manualRoles`（「我创建的角色」= 用户已命名的角色）→ **原样保留**；
 *   · 照片、标签、图片文件、向量库、手动创建的角色 —— **一个都不碰**。
 *
 * 注意：这里也**不碰** `photo_tags`。也就是说，「识别漏标签」写进去的 AI 建议标签
 * 不会因为这次清理而消失（那些标签图片本来就带着，是否需要撤回是另一件事）。
 */
import fs from "node:fs";
import path from "node:path";
import { getDataPath } from "@/utils/data-path";
import { createLogger } from "@/utils/logger";

const log = createLogger("character-result-cleanup");

const FILE_NAME = "character-groups.json";

export interface ClearUnnamedCharacterResult {
  /** 角色结果文件是否存在（不存在 = 本来就没有结果） */
  fileExisted: boolean;
  /** 删掉了多少个"未命名"的分组 */
  removedGroups: number;
  /** 这些分组里一共涉及多少张图（仅用于告知用户，照片本身不删） */
  removedPhotoRefs: number;
  /** 保留了多少个"已命名"的分组 */
  keptGroups: number;
  /** 保留了多少个「我创建的角色」 */
  keptManualRoles: number;
}

interface RawGroup {
  namedTagId?: unknown;
  photoIds?: unknown;
}

interface RawStore {
  groups?: unknown;
  manualRoles?: unknown;
  [key: string]: unknown;
}

function storeFile(): string {
  return path.join(getDataPath(), FILE_NAME);
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** 是否是「还没命名」的分组（没有 namedTagId，或它是 null）。 */
function isUnnamed(group: RawGroup | null | undefined): boolean {
  if (!group || typeof group !== "object") {
    return false;
  }
  return group.namedTagId === null || group.namedTagId === undefined;
}

/**
 * 执行清理。**幂等**：没有可删的就什么都不写，文件保持原样。
 *
 * @throws 文件存在但不是合法 JSON / 不是对象时抛错（界面会提示原因），
 *         绝不静默删除用户的数据。
 */
export function clearUnnamedCharacterResults(): ClearUnnamedCharacterResult {
  const file = storeFile();
  if (!fs.existsSync(file)) {
    return {
      fileExisted: false,
      removedGroups: 0,
      removedPhotoRefs: 0,
      keptGroups: 0,
      keptManualRoles: 0,
    };
  }

  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as RawStore | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `角色结果文件格式不对（${FILE_NAME}），为避免误删，本次没有做任何修改`
    );
  }

  const groups = Array.isArray(raw.groups) ? (raw.groups as RawGroup[]) : [];
  const kept: RawGroup[] = [];
  let removedGroups = 0;
  let removedPhotoRefs = 0;
  for (const group of groups) {
    if (isUnnamed(group)) {
      removedGroups += 1;
      removedPhotoRefs += countArray(group.photoIds);
    } else {
      kept.push(group);
    }
  }

  const keptManualRoles = countArray(raw.manualRoles);
  const result: ClearUnnamedCharacterResult = {
    fileExisted: true,
    removedGroups,
    removedPhotoRefs,
    keptGroups: kept.length,
    keptManualRoles,
  };

  if (removedGroups === 0) {
    return result; // 没东西可删 → 不动文件
  }

  const next: RawStore = { ...raw, groups: kept };
  try {
    fs.writeFileSync(file, JSON.stringify(next), "utf-8");
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "写回角色结果失败"
    );
    throw new Error(
      `清除失败：结果文件写不进去（${error instanceof Error ? error.message : String(error)}）`
    );
  }

  log.info(result, "已清除未命名的角色分组");
  return result;
}
