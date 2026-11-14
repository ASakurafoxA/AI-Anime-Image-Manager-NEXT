/**
 * 「一张图里有几个人」——多人图命名（2026-11 会话#12）用的公共判定。
 *
 * 用户口径（`开发须知.md` §五-15）：**只认人数标签**，而且
 *   · `1girl` / `1boy` 单独出现 = 1 人；
 *   · **`1girl` + `1boy` 必须算 2 人**（库里 10,940 张，按"有单人标签就是单人"会全漏）；
 *   · `2girls/3girls/…/6+girls`、`2boys/…` 按标签人数；
 *   · `multiple_girls` / `multiple_boys` / `multiple_others` 只知道"多个" → 按 2 算。
 *
 * 为什么要"取最大值"而不是"相加"：同一张图可能同时带 `2girls` 和 `multiple_girls`
 * （打标冗余），相加会算成 4 人 ✗ —— 所以按类别取最大。
 *
 * 纯函数部分（`resolvePersonCount`）不碰数据库，方便单测。
 *
 * ⚠️ **库里标签名是"中文 + 英文"合体**（`1个女性 (1girl)`、`初音未来 (hatsune_miku)`），
 *    不是纯英文 —— 所以查库时按**括号里的英文**匹配，不能直接 `name = '1girl'`（会 0 行）。
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photoTags, tags } from "@/db/schema";

/** 参与人数判定的全部标签名。 */
export const PERSON_COUNT_TAGS: readonly string[] = Object.freeze([
  "solo",
  "1girl",
  "1boy",
  "1other",
  "2girls",
  "3girls",
  "4girls",
  "5girls",
  "6+girls",
  "2boys",
  "3boys",
  "4boys",
  "5boys",
  "6+boys",
  "multiple_girls",
  "multiple_boys",
  "multiple_others",
]);

const EXPLICIT_PATTERN = /^(\d+)\+?(girls|boys|others)$/;
const MULTIPLE_BY_CATEGORY: Record<string, "girls" | "boys" | "others"> = {
  multiple_girls: "girls",
  multiple_boys: "boys",
  multiple_others: "others",
};

/**
 * 从一张图的标签名里算人数；算不出来（没有人数标签）返回 0。
 *
 * @example resolvePersonCount(["1girl","1boy"]) // 2
 * @example resolvePersonCount(["2girls","multiple_girls"]) // 2
 */
export function resolvePersonCount(names: Iterable<string>): number {
  const byCategory: Record<"girls" | "boys" | "others", number> = {
    girls: 0,
    boys: 0,
    others: 0,
  };

  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    const single = /^1(girl|boy|other)$/.exec(name);
    if (single) {
      const key = `${single[1]}s` as "girls" | "boys" | "others";
      // 1girl / 1boy 是"一个人"，但和 2girls 同时出现时以 2 为准 → 取最大
      byCategory[key] = Math.max(byCategory[key], 1);
      continue;
    }
    const explicit = EXPLICIT_PATTERN.exec(name);
    if (explicit) {
      const count = Number(explicit[1]);
      const key = explicit[2] as "girls" | "boys" | "others";
      if (Number.isFinite(count)) {
        byCategory[key] = Math.max(byCategory[key], count);
      }
      continue;
    }
    const multiple = MULTIPLE_BY_CATEGORY[name];
    if (multiple) {
      // "多个"只知道 ≥2，取 2（保守）
      byCategory[multiple] = Math.max(byCategory[multiple], 2);
    }
  }

  const total = byCategory.girls + byCategory.boys + byCategory.others;
  if (total > 0) {
    return total;
  }
  // 只有 solo：明确是一个人
  for (const raw of names) {
    if (raw.trim().toLowerCase() === "solo") {
      return 1;
    }
  }
  return 0;
}

/**
 * 找出人数标签的 id（按括号里的英文名匹配）。
 *
 * 只扫一次 `tags`（3 万行、毫秒级），不猜 LIKE 通配，避免把
 * `1girl` 误配到 `1girl_pov` 之类的标签上。
 */
export function loadPersonCountTagIds(): Map<string, number> {
  const db = getDatabase();
  const rows = db.select({ id: tags.id, name: tags.name }).from(tags).all();
  const byEnglish = new Map<string, number>();
  for (const row of rows) {
    const name = typeof row.name === "string" ? row.name : "";
    for (const english of PERSON_COUNT_TAGS) {
      if (name.endsWith(`(${english})`)) {
        byEnglish.set(english, row.id);
        break;
      }
    }
  }
  return byEnglish;
}

/**
 * 批量取照片的人数（一次查库，按 900 一组防 SQLite 变量上限）。
 *
 * 返回的 Map **包含全部入参 id**：没有人数标签的给 0（调用方据此按"未知"处理）。
 */
export function getPersonCountsByPhotoIds(
  photoIds: readonly number[]
): Map<number, number> {
  const result = new Map<number, number>();
  const unique = [...new Set(photoIds)];
  for (const id of unique) {
    result.set(id, 0);
  }
  if (unique.length === 0) {
    return result;
  }

  const tagIdByEnglish = loadPersonCountTagIds();
  if (tagIdByEnglish.size === 0) {
    return result;
  }
  const idToEnglish = new Map<number, string>(
    [...tagIdByEnglish].map(([english, id]) => [id, english])
  );
  const personTagIds = [...tagIdByEnglish.values()];

  const db = getDatabase();
  const CHUNK = 900;
  const namesByPhoto = new Map<number, Set<string>>();

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const rows = db
      .select({ photoId: photoTags.photoId, tagId: photoTags.tagId })
      .from(photoTags)
      .where(
        and(
          inArray(photoTags.photoId, chunk),
          inArray(photoTags.tagId, personTagIds)
        )
      )
      .all();
    for (const row of rows) {
      // schema 里 photo_id / tag_id 都允许 null（外键 ON DELETE set null）
      const photoId = row.photoId;
      const tagId = row.tagId;
      if (photoId == null || tagId == null) continue;
      const english = idToEnglish.get(tagId);
      if (!english) continue;
      if (!namesByPhoto.has(photoId)) {
        namesByPhoto.set(photoId, new Set());
      }
      namesByPhoto.get(photoId)?.add(english);
    }
  }

  for (const [photoId, names] of namesByPhoto) {
    result.set(photoId, resolvePersonCount(names));
  }
  return result;
}

export interface PersonSplit {
  /** 人数 ≥ 2 的照片：写明全部角色名 */
  multi: number[];
  /** 单人（含人数未知=0）的照片：只写第一个角色名 */
  single: number[];
  /** 人数未知（没有人数标签）的张数，便于界面提示"靠猜" */
  unknown: number;
  /** 这批照片里的最大人数（至少 1） */
  maxPersonCount: number;
}

/** 纯函数：把照片按"已知人数"分成多人 / 单人两堆（便于单测，不碰数据库）。 */
export function groupPhotoIdsByCounts(
  photoIds: readonly number[],
  counts: ReadonlyMap<number, number>
): PersonSplit {
  const multi: number[] = [];
  const single: number[] = [];
  let unknown = 0;
  let maxPersonCount = 1;
  for (const photoId of photoIds) {
    const count = counts.get(photoId) ?? 0;
    if (count === 0) {
      unknown += 1;
      single.push(photoId);
      continue;
    }
    maxPersonCount = Math.max(maxPersonCount, count);
    if (count >= 2) {
      multi.push(photoId);
    } else {
      single.push(photoId);
    }
  }
  return { multi, single, unknown, maxPersonCount };
}

/** 把照片按人数分成"多人 / 单人"两堆，保持原顺序。 */
export function splitPhotoIdsByPersonCount(
  photoIds: readonly number[]
): PersonSplit {
  return groupPhotoIdsByCounts(photoIds, getPersonCountsByPhotoIds(photoIds));
}

export type SinglePersonTag = "1girl" | "1boy" | "1other";

/**
 * 把一批"多人图"的人数标签改成单人（2026-11-14 · 会话#12）。
 *
 * 用户口径：**在界面上手动选男/女/其他**，选哪个就落哪个单人标签
 * （用户原话：「给界面三个选项就好了，男，女，其他，选择哪个，当前命名的角色就都是哪个，就是全局开关」）。
 * 不猜性别——猜错比不改更糟（见 `即时改动记录.md` `#2026-11-14-07` 的统计）。
 *
 * 只动 `userConfirmed = 0` 的 AI 建议标签，不碰用户确认过的。
 * 返回实际改过的照片数。
 */
export function forceSinglePersonTags(
  photoIds: readonly number[],
  target: SinglePersonTag
): number {
  const unique = [...new Set(photoIds)];
  if (unique.length === 0) {
    return 0;
  }
  const tagIdByEnglish = loadPersonCountTagIds();
  const targetId = tagIdByEnglish.get(target);
  if (targetId == null) {
    return 0;
  }
  const personTagIds = [...tagIdByEnglish.values()];

  const db = getDatabase();
  const CHUNK = 400;
  let changed = 0;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    db.transaction(() => {
      // 1) 删掉其它人数标签（只删"建议"级）
      const otherIds = personTagIds.filter((id) => id !== targetId);
      if (otherIds.length > 0) {
        db.delete(photoTags)
          .where(
            and(
              inArray(photoTags.photoId, chunk),
              inArray(photoTags.tagId, otherIds),
              eq(photoTags.userConfirmed, false)
            )
          )
          .run();
      }
      // 2) 补上目标单人标签（已有就不重复插）
      const existing = db
        .select({ photoId: photoTags.photoId })
        .from(photoTags)
        .where(
          and(
            inArray(photoTags.photoId, chunk),
            eq(photoTags.tagId, targetId)
          )
        )
        .all();
      const has = new Set(existing.map((row) => row.photoId));
      const missing = chunk.filter((photoId) => !has.has(photoId));
      const INSERT_CHUNK = 100;
      for (let j = 0; j < missing.length; j += INSERT_CHUNK) {
        db.insert(photoTags)
          .values(
            missing.slice(j, j + INSERT_CHUNK).map((photoId) => ({
              confidence: null,
              isConfirmed: false,
              origin: "auto" as const,
              photoId,
              tagId: targetId,
              userConfirmed: false,
            }))
          )
          .onConflictDoNothing()
          .run();
      }
      changed += chunk.length;
    });
  }
  return changed;
}
