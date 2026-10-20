/**
 * 角色分组结果的落盘存储（NEXT 版新增）。
 *
 * 为什么需要：聚类一次全库要几分钟，而用户不可能一口气把 60 组全命名完
 * —— 中途关掉对话框、关掉软件都是常态。所以分组结果要**存下来**，
 * 下次打开直接显示（并把已命名的组标成"已命名"），而不是让用户重跑一遍。
 *
 * 存放位置：`<图库>/character-groups.json`（跟随图库走，不随软件版本走）。
 * 大小：几十组 × 每组几十上百个 id → 通常几十 KB，可直接整份读写。
 */
import fs from "node:fs";
import path from "node:path";
import { getDataPath } from "@/utils/data-path";
import { createLogger } from "@/utils/logger";

const log = createLogger("character-group-store");

export interface StoredCharacterGroup {
  photoIds: number[];
  size: number;
  meanSimilarity: number;
  representativeId: number;
  thumbnails: string[];
  /** 已经命名过的组记住用了哪个标签，界面显示"已命名"，且不会重复提示命名。 */
  namedTagId: number | null;
  namedTagName: string | null;
}

/**
 * 「手动创建的角色」（NEXT 版新增）。
 *
 * 用户口径（2026-10）：
 *   · **选已有标签**导入 → 只等于"批量打标签"，**不进**人物识别页面 ✗；
 *   · **手动新建标签** → 这个角色要**出现在人物识别页面** ✓（同时它本来就在
 *     标签树的「角色」分类下）—— 这样用户一眼就能区分"哪些是新角色"。
 *
 * 所以这里只记录**真正手动新建**的角色，供人物识别页面展示与改名。
 */
export interface ManualCharacterRole {
  tagId: number;
  tagName: string;
  /** 代表图（人物识别卡片封面） */
  representativePhotoId: number;
  thumbnailPath: string | null;
  photoCount: number;
  createdAt: number;
}

export interface StoredCharacterGroups {
  createdAt: number;
  threshold: number;
  candidates: number;
  groups: StoredCharacterGroup[];
  /** 手动创建的角色列表（缺省为空，老文件没有这个字段也能读）。 */
  manualRoles: ManualCharacterRole[];
}

const FILE_NAME = "character-groups.json";

function storeFile(): string {
  return path.join(getDataPath(), FILE_NAME);
}

/** 读取上次的分组结果（没有或损坏都返回 null，调用方回退到"需要重新分析"）。 */
export function readCharacterGroups(): StoredCharacterGroups | null {
  try {
    const file = storeFile();
    if (!fs.existsSync(file)) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as StoredCharacterGroups;
    if (!Array.isArray(raw?.groups)) {
      return null;
    }
    // 容错：老文件缺字段时补齐默认值
    return {
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
      threshold: typeof raw.threshold === "number" ? raw.threshold : 0.85,
      candidates: typeof raw.candidates === "number" ? raw.candidates : 0,
      manualRoles: Array.isArray(raw.manualRoles)
        ? raw.manualRoles
            .filter(
              (role) =>
                role && typeof role.tagId === "number" && role.tagId > 0
            )
            .map((role) => ({
              tagId: role.tagId,
              tagName: typeof role.tagName === "string" ? role.tagName : "",
              representativePhotoId:
                typeof role.representativePhotoId === "number"
                  ? role.representativePhotoId
                  : 0,
              thumbnailPath:
                typeof role.thumbnailPath === "string" ? role.thumbnailPath : null,
              photoCount:
                typeof role.photoCount === "number" ? role.photoCount : 0,
              createdAt:
                typeof role.createdAt === "number" ? role.createdAt : 0,
            }))
        : [],
      groups: raw.groups.map((group) => ({
        photoIds: Array.isArray(group.photoIds) ? group.photoIds : [],
        size: typeof group.size === "number" ? group.size : group.photoIds?.length ?? 0,
        meanSimilarity:
          typeof group.meanSimilarity === "number" ? group.meanSimilarity : 0,
        representativeId:
          typeof group.representativeId === "number"
            ? group.representativeId
            : (group.photoIds?.[0] ?? 0),
        thumbnails: Array.isArray(group.thumbnails) ? group.thumbnails : [],
        namedTagId:
          typeof group.namedTagId === "number" ? group.namedTagId : null,
        namedTagName:
          typeof group.namedTagName === "string" && group.namedTagName.length > 0
            ? group.namedTagName
            : null,
      })),
    };
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "读取角色分组缓存失败（当作没有缓存）"
    );
    return null;
  }
}

/** 覆盖写入分组结果。 */
export function writeCharacterGroups(data: StoredCharacterGroups): void {
  try {
    fs.writeFileSync(storeFile(), JSON.stringify(data), "utf-8");
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "写入角色分组缓存失败（不影响本次结果展示）"
    );
  }
}

/**
 * 记下"某一组已经命名过了"。
 *
 * 优先按 `groupIndex` 定位；没有索引时退回按代表图匹配（防止界面顺序变化后标错）。
 */
export function markGroupNamed(
  groupIndex: number | null,
  representativeId: number | null,
  tagId: number,
  tagName: string
): void {
  const data = readCharacterGroups();
  if (!data) {
    return;
  }
  let target: StoredCharacterGroup | undefined;
  if (
    groupIndex !== null &&
    groupIndex >= 0 &&
    groupIndex < data.groups.length
  ) {
    target = data.groups[groupIndex];
  } else if (representativeId !== null) {
    target = data.groups.find(
      (group) => group.representativeId === representativeId
    );
  }
  if (!target) {
    return;
  }
  target.namedTagId = tagId;
  target.namedTagName = tagName;
  writeCharacterGroups(data);
}

/** 清掉缓存（重新分析时覆盖，或用户想重来时用）。 */
export function clearCharacterGroups(): void {
  try {
    const file = storeFile();
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
    }
  } catch {
    /* 清不掉也不影响 */
  }
}

/**
 * 只清掉「**还没命名**的检测结果」✓（用户口径 2026-10-17）
 *
 * 用户原话：「删除检测出来的未命名结果，**已经完成命名的就不动**」。
 * 所以这里**不能**用 `clearCharacterGroups()`（那是整份删掉，连 `manualRoles`
 * 和已命名的分组一起没了 ✗），而是：
 *   · 保留 `namedTagId !== null` 的分组（已经命名过的组，属历史记录）；
 *   · **保留 `manualRoles`**（「我创建的角色」= 用户已经命名的角色）✓；
 *   · 只删 `namedTagId === null` 的分组（检测出来、还没起名的那些）✓。
 *
 * @returns 实际删掉了多少组
 */
export function removeUnnamedGroups(): number {
  const data = readCharacterGroups();
  if (!data) {
    return 0;
  }
  const kept = data.groups.filter((group) => group.namedTagId !== null);
  const removed = data.groups.length - kept.length;
  if (removed > 0) {
    writeCharacterGroups({ ...data, groups: kept });
  }
  return removed;
}

/** 读/改/写一圈（文件不存在时按空壳创建，保证"只创建了角色"也能存下）。 */
function withStore(mutate: (data: StoredCharacterGroups) => void): void {
  const existing = readCharacterGroups();
  const data: StoredCharacterGroups = existing ?? {
    createdAt: Date.now(),
    threshold: 0.85,
    candidates: 0,
    groups: [],
    manualRoles: [],
  };
  mutate(data);
  writeCharacterGroups(data);
}

/** 列出"手动创建的角色"（人物识别页面用）。 */
export function listManualRoles(): ManualCharacterRole[] {
  return readCharacterGroups()?.manualRoles ?? [];
}

/** 记下一个手动新建的角色（同一个标签重复创建时覆盖，保持最新）。 */
export function addManualRole(role: ManualCharacterRole): void {
  withStore((data) => {
    const others = data.manualRoles.filter((item) => item.tagId !== role.tagId);
    data.manualRoles = [...others, role];
  });
}

/** 标签改名后同步（人物识别页面显示的正是这个名字）。 */
export function renameManualRole(tagId: number, tagName: string): void {
  withStore((data) => {
    data.manualRoles = data.manualRoles.map((role) =>
      role.tagId === tagId ? { ...role, tagName } : role
    );
  });
}

/**
 * 自用（2026-10-18 · 会话#9 用户要求）：**把某张图设为这个角色的图集封面** ✓
 *
 * 只改 `manualRoles` 里那条记录的 `representativePhotoId` / `thumbnailPath`
 * （人物页卡片的封面就吃这两个字段），**不碰标签、不碰照片本身** ✓
 */
export function setManualRoleCover(
  tagId: number,
  representativePhotoId: number,
  thumbnailPath: string | null
): boolean {
  let touched = false;
  withStore((data) => {
    data.manualRoles = data.manualRoles.map((role) => {
      if (role.tagId !== tagId) {
        return role;
      }
      touched = true;
      return { ...role, representativePhotoId, thumbnailPath };
    });
  });
  return touched;
}

/** 标签被删掉时同步移除（避免人物识别页面显示一个已经不存在的角色）。 */
export function removeManualRole(tagId: number): void {
  withStore((data) => {
    data.manualRoles = data.manualRoles.filter((role) => role.tagId !== tagId);
  });
}

/** 批量剔除已经不存在的标签（读取时自愈，防止显示幽灵角色）。 */
export function pruneManualRoles(existingTagIds: ReadonlySet<number>): void {
  withStore((data) => {
    data.manualRoles = data.manualRoles.filter((role) =>
      existingTagIds.has(role.tagId)
    );
  });
}