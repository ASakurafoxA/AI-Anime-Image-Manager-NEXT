/**
 * PixAI Tagger v1.0 动漫打标服务（NEXT 版新增，WD14 版本的孪生兄弟）。
 *
 * 职责三件事（与 `wd14-tagger.ts` 完全对称，便于两版对照维护）：
 *  1. **词表导入**：把 `<modelsDir>/pixai-tagger-v1.0/config.json` 的 `tags`（30,877 个）
 *     导入 `tags` 表，按模型自带的六分类挂到六个顶级父标签下；
 *     `general` 内部再沿用现有的 13 细类目录
 *  2. **批量打标**：遍历照片（**默认用 512px 缩略图**，见 `processBatch` 里的说明），
 *     调 `pixai-tagger-client` 推理，把标签写进 `photo_tags`（`origin='auto'`）
 *  3. **可恢复**：进度游标存在 `app_settings`，中断后从上次位置继续
 *
 * ⚠️ 关键安全约束（与 WD14 / 上游 `tag-suggester` 同一策略）：
 *    **绝不能覆盖手动标签**。写入前先删该照片的自动标签（`user_confirmed = 0`），
 *    手动/已确认标签（`user_confirmed = 1`）一律不动。
 *
 * ⚠️ 与 WD14 版**故意不同**的 5 个地方（改动时不要"顺手对齐"回去）：
 *  1. 词表来自 JSON 而不是 CSV，且**必须断言** 30,877 / 六分类 count 之和（见 `loadPixaiVocabulary`）
 *  2. settings key 用 `pixai.tagger.*`，**不能**复用 `wd14.tagger.*`
 *     —— 否则两个模型的导入状态互相污染（切回 WD14 会显示"词表已导入"却一个标签都没有）
 *  3. `rating:*` 四个标签**照常入库**（WD14 是 category===9 直接丢弃）
 *  4. embedding 是 **1024 维**，写的是 `upsertPixaiVectors`（另一张表 `pixai_embeddings`）
 *  5. 六个顶级父标签，而不是 WD14 的两个
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { PRIVATE_BUILD } from "@/config/private-build";
import { getDatabase } from "@/db";
import { photos, photoTags, tags } from "@/db/schema";
import { getSetting, setSetting } from "@/services/settings-manager";
import { invalidateTagSearch } from "@/services/tag-search-revision";
import { createLogger } from "@/utils/logger";
import { shouldResetTaggingCursor } from "./tagging-cursor";
import {
  PIXAI_CATEGORY_ORDER,
  pixaiParentLabel,
  pixaiSubCategoryLabel,
  type PixaiCategoryName,
} from "./pixai-tag-categories";
import {
  abortPixaiTagger,
  initPixaiTagger,
  isPixaiModelAvailable,
  PIXAI_EMBEDDING_DIM,
  tagPhotoBatchPixai,
  type PixaiPhotoResult,
} from "./pixai-tagger-client";
import { categorizeWd14Tag, WD14_TAG_CATEGORIES } from "./wd14-tag-categories";
import { pixaiChineseName } from "./pixai-zh-names";

const log = createLogger("pixai-tagger");

/** 进度游标：已处理到的最大 photo id（可恢复）。**不能与 WD14 共用**。 */
const CURSOR_KEY = "pixai.tagger.cursor";
/** 词表导入标记。 */
const VOCAB_KEY = "pixai.tagger.vocabVersion";
/** 是否已经跑过一次"全库重扫"。用于避免每次点按钮都从 0 重新扫。 */
const FULL_RUN_KEY = "pixai.tagger.fullRunDone";
const VOCAB_VERSION = "pixai-tagger-v1.0:30877:cat-v1-zh";

/** 每批照片数。与 WD14 一致：批越大显存/内存峰值越高，8 是实测稳妥值。 */
const BATCH_SIZE = 8;

/** 词表文件名（相对 `<modelsDir>/pixai-tagger-v1.0/`）。 */
const CONFIG_FILE = "config.json";
/** 模型目录名。 */
const MODEL_DIR_NAME = "pixai-tagger-v1.0";
/** `tags` 数组的期望长度。断言用的硬数字，见 `loadPixaiVocabulary`。 */
const EXPECTED_TAG_COUNT = 30877;

/**
 * 四个 `rating:*` 标签的内置中文名。
 *
 * 为什么内置：`zh_names.csv` 是照 WD14 的通用标签整理的，**完全没有** rating 这一族
 * （WD14 本来就把 rating 丢掉了），实测这四个在里面一个都查不到。
 * 不补的话标签树里会出现 `rating:q` 这种英文裸名，而「分级」正是本版
 * 要白送给用户的筛选维度。
 */
const RATING_ZH: Record<string, string> = {
  "rating:g": "分级:全年龄",
  "rating:s": "分级:安全",
  "rating:q": "分级:存疑",
  "rating:e": "分级:露骨",
};

export interface PixaiTaggingProgress {
  done: number;
  total: number;
  tagged: number;
  failed: number;
}

export interface PixaiTaggingResult {
  total: number;
  tagged: number;
  failed: number;
  cancelled: boolean;
}

interface PhotoRow {
  id: number;
  thumbnailPath: string | null;
  path: string;
}

/** 从 config.json 解析出来的一个标签。 */
interface PixaiVocabEntry {
  name: string;
  category: PixaiCategoryName;
  categoryIndex: number;
}

/** 解析后的完整词表。 */
interface PixaiVocabulary {
  file: string;
  tags: PixaiVocabEntry[];
  /** 各分类的标签数（与 `tags_split` 声明的一致，已断言过）。 */
  counts: Record<PixaiCategoryName, number>;
}

let running = false;
let cancelRequested = false;

export function isPixaiTaggingRunning(): boolean {
  return running;
}

/** 请求停止本轮打标：批边界会退出循环，worker 也会中止当前批次。 */
export function cancelPixaiTagging(): void {
  cancelRequested = true;
  abortPixaiTagger();
}

function configPath(modelsDir: string): string {
  return path.join(modelsDir, MODEL_DIR_NAME, CONFIG_FILE);
}

/**
 * 中文名映射表（`english,中文` 两列，无表头），直接复用 WD14 的那一份。
 *
 * 实测本机这份文件 23,799 行、带 UTF-8 BOM（首行是 `1girl,1个女性`）。
 * ⚠️ BOM 必须先剥掉，否则第一行标签 `1girl` 匹配不上（WD14 版也是这么处理的）。
 * 它是照 WD14 的通用标签整理的，新模型多出来的标签大量没有中文 —— 覆盖率见
 * `importPixaiVocabulary` 里的统计。
 */
function zhNamesPath(modelsDir: string): string {
  return path.join(
    modelsDir,
    "SmilingWolf",
    "wd-vit-tagger-v3",
    "zh_names.csv"
  );
}

/** 读取「英文 → 中文」映射；文件缺失时返回空表（标签保持英文，不报错）。 */
function loadZhNames(modelsDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const file = zhNamesPath(modelsDir);
  if (!fs.existsSync(file)) {
    log.warn({ file }, "缺少中文名映射表，标签将保持英文");
    return map;
  }
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const index = line.indexOf(",");
    if (index <= 0) {
      continue;
    }
    const english = line.slice(0, index).trim();
    const chinese = line.slice(index + 1).trim();
    if (english && chinese) {
      map.set(english, chinese);
    }
  }
  return map;
}

/**
 * 从存进数据库的显示名里取回**英文基础名**。
 *
 * 显示名规范是 `中文 (english)`（括号前有一个空格）；角色/作品系列标签没有中文时
 * 就是纯英文名，名字里虽可能含括号（如 `spine_(medium)`），但括号前没有空格，
 * 不会被误解析。
 */
export function baseNameOf(storedName: string): string {
  const matched = /^(.+?) \(([^()]+)\)$/.exec(storedName);
  return matched ? matched[2] : storedName;
}

/**
 * 生成落库的显示名：有中文就用 `中文 (english)`，否则保持英文。
 *
 * 查找链（先命中先用）：
 *   1. `RATING_ZH` —— 分级 4 条短表
 *   2. `pixaiChineseName()` —— **分类专属**表：作品系列 / 元信息
 *      （`style` 画风刻意没有表：那些是画师账号名，翻译反而是错的）
 *   3. `zh_names.csv` —— 既有的通用/角色中文表
 *   4. 都没有 → 保留英文原名，**不硬造**
 */
function displayNameFor(
  english: string,
  category: PixaiCategoryName,
  zh: Map<string, string>
): string {
  const chinese =
    RATING_ZH[english] ??
    pixaiChineseName(english, category) ??
    zh.get(english);
  return chinese ? `${chinese} (${english})` : english;
}

/**
 * 解析 `config.json` 的词表，并**断言**它确实是 PixAI v1.0 的那一份。
 *
 * 为什么这里必须抛错而不是"尽力而为"：`tags` 的**下标就是模型输出向量下标**。
 * 一旦文件被换成别的版本（或少了几行），标签与下标会整体错位 ——
 * 结果是"看起来在正常工作，其实每张图的标签都是错的"，这比直接失败难查得多。
 * 所以下面三个数字对不上就一律 throw：
 *   1. `tags.length === 30877`
 *   2. `tags_split` 各类 count 之和 === `tags.length`
 *   3. `tags` 里每个名字都是非空字符串
 * 另外还要求 `tags_split` 覆盖 `PIXAI_CATEGORY_ORDER` 里的全部六个分类，
 * 且分类名都在本项目的 `PixaiCategoryName` 里（否则 `category` 类型是假的）。
 */
function loadPixaiVocabulary(modelsDir: string): PixaiVocabulary {
  const file = configPath(modelsDir);
  if (!fs.existsSync(file)) {
    throw new Error(`缺少 PixAI 标签词表: ${file}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `PixAI 词表解析失败（config.json 不是合法 JSON）: ${file} — ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`PixAI 词表格式异常（顶层不是对象）: ${file}`);
  }
  const record = raw as { tags?: unknown; tags_split?: unknown };

  // ── 1) tags：必须是 30,877 个非空字符串 ────────────────────────────
  if (!Array.isArray(record.tags)) {
    throw new Error(`PixAI 词表缺少 tags 数组: ${file}`);
  }
  const names = record.tags.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(
        `PixAI 词表第 ${index} 个标签不是非空字符串（type=${typeof item}）: ${file}`
      );
    }
    return item;
  });
  if (names.length !== EXPECTED_TAG_COUNT) {
    throw new Error(
      `PixAI 词表标签数不对：期望 ${EXPECTED_TAG_COUNT}，实际 ${names.length}（${file}）`
    );
  }

  // ── 2) tags_split：`[[分类名, 个数], …]`，count 之和必须等于 tags.length ──
  if (!Array.isArray(record.tags_split)) {
    throw new Error(`PixAI 词表缺少 tags_split 数组: ${file}`);
  }
  const splitNames: string[] = [];
  const splitCounts: number[] = [];
  for (const entry of record.tags_split) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "number" ||
      !Number.isInteger(entry[1]) ||
      entry[1] < 0
    ) {
      throw new Error(
        `PixAI 词表 tags_split 格式异常（期望 ["分类名", 个数]）：${JSON.stringify(
          entry
        )}（${file}）`
      );
    }
    splitNames.push(entry[0]);
    splitCounts.push(entry[1]);
  }
  const splitTotal = splitCounts.reduce((sum, n) => sum + n, 0);
  if (splitTotal !== names.length) {
    throw new Error(
      `PixAI 词表 tags_split 个数之和(${splitTotal}) 与 tags 长度(${names.length}) 不一致（${file}）`
    );
  }
  if (splitNames.length !== PIXAI_CATEGORY_ORDER.length) {
    throw new Error(
      `PixAI 词表分类数不对：期望 ${PIXAI_CATEGORY_ORDER.length}，实际 ${splitNames.length}（${file}）`
    );
  }
  for (const name of PIXAI_CATEGORY_ORDER) {
    if (!splitNames.includes(name)) {
      throw new Error(
        `PixAI 词表 tags_split 缺少分类 "${name}"（实际：${splitNames.join(
          ", "
        )}）（${file}）`
      );
    }
  }

  // ── 3) 按区间给每个标签定位 category / categoryIndex ─────────────────
  // categoryIndex = 落在 tags_split 里的第几个区间（从 0 起），与模型输出下标一一对应。
  const tags: PixaiVocabEntry[] = [];
  const counts = {} as Record<PixaiCategoryName, number>;
  let offset = 0;
  for (let i = 0; i < splitNames.length; i++) {
    const name = splitNames[i] as PixaiCategoryName;
    const count = splitCounts[i];
    counts[name] = count;
    for (let j = offset; j < offset + count; j++) {
      tags.push({ name: names[j], category: name, categoryIndex: i });
    }
    offset += count;
  }
  if (tags.length !== names.length) {
    throw new Error(
      `PixAI 词表区间展开后长度(${tags.length}) !== tags 长度(${names.length})（${file}）`
    );
  }

  log.info(
    { file, total: tags.length, counts, order: splitNames },
    "PixAI 词表已解析并通过断言"
  );
  return { file, tags, counts };
}

/** 取某个分类的父标签 id；理论上不会缺（`loadPixaiVocabulary` 已断言六个分类齐全）。 */
function requireParentId(
  parents: Map<PixaiCategoryName, number>,
  name: PixaiCategoryName
): number {
  const id = parents.get(name);
  if (id === undefined) {
    throw new Error(`内部错误：分类 "${name}" 的父标签未创建`);
  }
  return id;
}

/**
 * 把 PixAI 词表导入 `tags` 表。
 *
 * 结构（对齐 `PixAI集成实施计划.md` §1.1）：
 * ```
 * 通用 ─┬─ 元信息与画质 / 画风与媒介 / 人数与构图 / 头发 / … / 其他（现有 13 细类）
 * 角色                 ← character 8,308，直接挂顶级
 * 作品系列             ← copyright 2,460（WD14 没有的维度）
 * 画风                 ← style 4,917（WD14 没有的维度）
 * 元信息               ← meta 145
 * 分级                 ← rating 4（WD14 直接丢弃，本版照常入库）
 * ```
 *
 * 关于"旧标签名跟着旧模型一起被替换也无所谓"（用户明确表示）：
 * 所以这里不为"保留 WD14 的旧结构"做特殊处理，同名标签直接复用，
 * 但复用**仍然走** `toReparent` / `toRename` 那套（照 WD14 的 `ensureTag` 逻辑），
 * 避免重复插入，也保证从旧结构升级时二级目录不会空着。
 */
export function importPixaiVocabulary(modelsDir: string): {
  general: number;
  character: number;
  copyright: number;
  style: number;
  meta: number;
  rating: number;
  inserted: number;
  reparented: number;
  renamed: number;
  skipped: number;
  zhCovered: number;
} {
  const db = getDatabase();
  const vocab = loadPixaiVocabulary(modelsDir);

  const ensureTag = (name: string, parentId: number | null): number => {
    const existing = db.select().from(tags).where(eq(tags.name, name)).get();
    if (existing) {
      return existing.id;
    }
    const inserted = db
      .insert(tags)
      .values({ name, color: null, parentId })
      .returning({ id: tags.id })
      .get();
    return inserted?.id ?? 0;
  };

  // 六个顶级父标签。名字一律由 pixaiParentLabel() 提供 ——
  // 不要在这里写中文字面量，否则改标签名要改两个地方（分类表 + 本文件）。
  const parentIds = new Map<PixaiCategoryName, number>();
  const parentTagIds: number[] = [];
  for (const name of PIXAI_CATEGORY_ORDER) {
    const id = ensureTag(pixaiParentLabel(name), null);
    parentIds.set(name, id);
    parentTagIds.push(id);
  }
  const parentGeneral = requireParentId(parentIds, "general");

  // `general` 的内部二级目录：**沿用现有 13 细类**的 label，挂在「通用」之下。
  // 划分规则一个字都没改（仍是 `categorizeWd14Tag`），所以用户已习惯的浏览方式不变。
  const subParentIdByLabel = new Map<string, number>();
  for (const cat of WD14_TAG_CATEGORIES) {
    if (cat.id === "character" || cat.id === "rating") {
      continue;
    }
    const id = ensureTag(cat.label, parentGeneral);
    subParentIdByLabel.set(cat.label, id);
  }

  // 一次读出已有标签（id + 父标签），避免逐条查询（三万多条会非常慢）。
  // 按**英文基础名**索引：库里可能已经是「中文 (english)」形式。
  const zhNames = loadZhNames(modelsDir);
  const existing = new Map<
    string,
    { id: number; parentId: number | null; name: string }
  >(
    db
      .select({ id: tags.id, name: tags.name, parentId: tags.parentId })
      .from(tags)
      .all()
      .map((row) => [
        baseNameOf(row.name),
        { id: row.id, parentId: row.parentId, name: row.name },
      ])
  );

  /**
   * 已占用的显示名集合（落库快照）。
   *
   * 为什么需要这么一层防御：`tags.name` 上有 UNIQUE，而本函数要一次性
   * insert / rename 三万多行；只要有一行撞唯一索引，**整笔事务回滚**
   * —— 前面全部白干，而且用户只会看到一句含糊的失败。
   *
   * 实测风险其实很低：显示名规范是 `中文 (english)`，而"多个英文名共用一个中文名"
   * 的 325 组（`skirt` / `short_dress` 都叫"短裙"）因为带上了英文名而互不相同；
   * 唯一可能真的撞上的情况是"某个英文标签名恰好等于另一个标签的显示名"
   * （例如手工建过一个叫 `短裙 (skirt)` 的标签）。真撞上时退回英文原名。
   */
  const usedNames = new Set<string>(existing.keys());

  const counts: Record<PixaiCategoryName, number> = {
    general: 0,
    character: 0,
    copyright: 0,
    style: 0,
    meta: 0,
    rating: 0,
  };
  const zhCoveredBy: Record<string, number> = { total: 0, general: 0 };
  let skipped = 0;
  let reparented = 0;
  let renamed = 0;
  const toInsert: { name: string; parentId: number }[] = [];
  const toReparent: { id: number; parentId: number }[] = [];
  const toRename: { id: number; name: string }[] = [];

  for (const tag of vocab.tags) {
    // ⚠️ 这里**没有**"rating 跳过"的分支：PixAI 的四个 rating:* 要正常入库。
    counts[tag.category]++;

    // 六分类 → 父标签：只有 general 再往下分一层（现有 13 细类）。
    let targetParent = requireParentId(parentIds, tag.category);
    if (tag.category === "general") {
      const subLabel = pixaiSubCategoryLabel(tag.name, tag.category);
      const subId = subLabel
        ? subParentIdByLabel.get(subLabel)
        : undefined;
      if (subId !== undefined) {
        targetParent = subId;
      }
      // subId === undefined 时留在「通用」下（不丢标签）
    }

    const targetName = displayNameFor(tag.name, tag.category, zhNames);
    if (targetName !== tag.name) {
      zhCoveredBy.total++;
      if (tag.category === "general") {
        zhCoveredBy.general++;
      }
    }
    // 中文名被别人占了 → 退回英文原名（见 usedNames 的说明；正常情况下不会触发）
    const preferredName = usedNames.has(targetName) ? tag.name : targetName;

    const found = existing.get(tag.name);
    if (found) {
      if (found.parentId !== targetParent) {
        toReparent.push({ id: found.id, parentId: targetParent });
        reparented++;
      }
      if (found.name !== preferredName) {
        if (usedNames.has(preferredName)) {
          // 连英文名都被占了（同一英文名两条记录，理论上不会发生）→ 什么都不改
          skipped++;
        } else {
          usedNames.add(preferredName);
          toRename.push({ id: found.id, name: preferredName });
          renamed++;
        }
      }
      continue;
    }
    usedNames.add(preferredName);
    existing.set(tag.name, {
      id: -1,
      parentId: targetParent,
      name: preferredName,
    });
    toInsert.push({ name: preferredName, parentId: targetParent });
  }

  const CHUNK = 500;
  db.transaction(() => {
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      db.insert(tags)
        .values(toInsert.slice(i, i + CHUNK))
        .onConflictDoNothing()
        .run();
    }
    for (const item of toReparent) {
      db.update(tags)
        .set({ parentId: item.parentId })
        .where(eq(tags.id, item.id))
        .run();
    }
    // 中文化：把已有标签改名为「中文 (english)」；已经改好的不会重复进这个列表
    for (const item of toRename) {
      db.update(tags)
        .set({ name: item.name })
        .where(eq(tags.id, item.id))
        .run();
    }
  });

  // 覆盖率的**统计口径**（如实统计，不假装 100%）：
  //   分子 = displayNameFor() 真的取到了中文名的标签数
  //          （zh_names.csv 精确同名命中 ＋ 内置的 4 个 rating 映射）
  //   分母 = 词表总标签数 30,877。general 另外单独打一条 —— 缺口主要在那儿。
  //   实测本机这份数据（2026-10 于真实 config.json + zh_names.csv 上跑统计脚本）：
  //     zh_names.csv 23,799 行；整体 12,509/30,877 = 40.5%；
  //     general 12,468/15,043 = 82.9%（character/copyright/style 等新分类基本没中文）。
  //   ⚠️ 覆盖率下降是**必然**的：旧表是为 WD14 那 8,106 个通用标签准备的，
  //      新模型 general 有 15,043 个，多出来的 6,937 个里大部分没有对应中文。
  const generalCount = counts.general;
  const generalRate =
    generalCount > 0
      ? ((zhCoveredBy.general / generalCount) * 100).toFixed(1)
      : "0.0";
  const totalRate = ((zhCoveredBy.total / vocab.tags.length) * 100).toFixed(1);

  setSetting(VOCAB_KEY, VOCAB_VERSION);
  invalidateTagSearch();
  log.info(
    {
      ...counts,
      inserted: toInsert.length,
      reparented,
      renamed,
      skipped,
      zhCovered: zhCoveredBy.total,
    },
    "PixAI 词表已导入"
  );
  log.info(
    {
      zhCovered: zhCoveredBy.total,
      total: vocab.tags.length,
      totalRate: `${totalRate}%`,
      generalZhCovered: zhCoveredBy.general,
      generalCount,
      generalRate: `${generalRate}%`,
    },
    `PixAI 中文覆盖率：整体 ${zhCoveredBy.total}/${vocab.tags.length} (${totalRate}%)，` +
      `general ${zhCoveredBy.general}/${generalCount} (${generalRate}%)；` +
      `未命中的按英文原名显示（旧 zh_names.csv 只有 23,799 行，新模型 general 有 15,043 个）`
  );

  return {
    general: counts.general,
    character: counts.character,
    copyright: counts.copyright,
    style: counts.style,
    meta: counts.meta,
    rating: counts.rating,
    inserted: toInsert.length,
    reparented,
    renamed,
    skipped,
    zhCovered: zhCoveredBy.total,
  };
}

export function isPixaiVocabularyImported(): boolean {
  return getSetting(VOCAB_KEY) === VOCAB_VERSION;
}

/**
 * 自用（方案 A · 问题 6）：开始前就能算出的"累计基线"，供界面第一帧使用。
 * `done` = 库里已打标的张数，`total` = 全库张数。
 */
export function getPixaiTaggingBaseline(): { done: number; total: number } {
  const libraryTotal = countRemaining(0);
  return {
    done: Math.max(0, libraryTotal - countRemaining(readCursor())),
    total: libraryTotal,
  };
}

/** 是否已经跑完过一次全库重扫（决定下次点按钮是否重置游标）。 */
export function isFullPixaiRunDone(): boolean {
  return getSetting(FULL_RUN_KEY) === "1";
}

/**
 * 自用（需求 1）：**强制**下次从第 0 张开始全库重扫。
 *
 * 只有"换了模型、必须把旧标签全部重打"这类用户明确要求时才调用它 ——
 * 日常的"继续打标"靠游标自动续跑，不要清游标（清了就等于从头再来）。
 */
export function resetPixaiTaggingProgress(): void {
  setSetting(CURSOR_KEY, "0");
  setSetting(FULL_RUN_KEY, "0");
}

/** 确认词表已导入；必要时执行导入。 */
export function ensurePixaiVocabulary(modelsDir: string): void {
  if (!isPixaiVocabularyImported()) {
    importPixaiVocabulary(modelsDir);
  }
}

/** tag 名 → id 映射（打标主循环复用，避免逐条查库）。 */
function loadTagIdMap(): Map<string, number> {
  const db = getDatabase();
  const rows = db.select({ id: tags.id, name: tags.name }).from(tags).all();
  // 库里的名字可能是「中文 (english)」，而 worker 返回的是英文名，
  // 所以按**英文基础名**索引；纯英文名（角色/作品系列/手动标签）原样作为键。
  return new Map(rows.map((row) => [baseNameOf(row.name), row.id]));
}

function readCursor(): number {
  const value = Number.parseInt(String(getSetting(CURSOR_KEY) ?? "0"), 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function countRemaining(cursor: number): number {
  const row = getDatabase()
    .select({ n: sql<number>`count(*)` })
    .from(photos)
    .where(and(isNull(photos.deletedAt), gt(photos.id, cursor)))
    .get();
  return Number(row?.n ?? 0);
}

function loadPhotosAfterCursor(cursor: number, limit: number): PhotoRow[] {
  return getDatabase()
    .select({
      id: photos.id,
      thumbnailPath: photos.thumbnailPath,
      path: photos.path,
    })
    .from(photos)
    .where(and(isNull(photos.deletedAt), gt(photos.id, cursor)))
    .orderBy(photos.id)
    .limit(limit)
    .all();
}

function loadPhotosByIds(ids: number[]): PhotoRow[] {
  if (ids.length === 0) {
    return [];
  }
  return getDatabase()
    .select({
      id: photos.id,
      thumbnailPath: photos.thumbnailPath,
      path: photos.path,
    })
    .from(photos)
    .where(and(isNull(photos.deletedAt), inArray(photos.id, ids)))
    .orderBy(photos.id)
    .all();
}

/**
 * 写入一批打标结果。
 *
 * 策略（与上游 tag-suggester / WD14 版一致，保证手动标签不被覆盖）：
 *   1. 先删这批照片的**自动**标签（`user_confirmed = 0`）
 *   2. 再插入本次结果（`origin='auto'`、`userConfirmed=false`）
 * 插入与删除都按 400 行分块：SQLite 的变量上限（999）要求分块，
 * 而且 3 万标签命中后单张图可能几十行，不分块会直接超限。
 */
function persistResults(
  results: PixaiPhotoResult[],
  tagIds: Map<string, number>
): { written: number; skippedTags: number } {
  const db = getDatabase();
  const photoIds: number[] = [];
  const rows: {
    photoId: number;
    tagId: number;
    confidence: number;
    isConfirmed: boolean;
    origin: "auto";
    userConfirmed: boolean;
  }[] = [];
  let skippedTags = 0;

  for (const result of results) {
    if (result.error || !result.tags) {
      continue;
    }
    photoIds.push(result.id);
    for (const tag of result.tags) {
      const tagId = tagIds.get(tag.name);
      if (!tagId) {
        skippedTags++;
        continue;
      }
      rows.push({
        photoId: result.id,
        tagId,
        confidence: tag.score,
        isConfirmed: false,
        origin: "auto",
        userConfirmed: false,
      });
    }
  }

  if (photoIds.length === 0) {
    return { written: 0, skippedTags };
  }

  const CHUNK = 400;
  db.transaction(() => {
    for (let i = 0; i < photoIds.length; i += CHUNK) {
      db.delete(photoTags)
        .where(
          and(
            inArray(photoTags.photoId, photoIds.slice(i, i + CHUNK)),
            eq(photoTags.userConfirmed, false)
          )
        )
        .run();
    }
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      if (chunk.length > 0) {
        db.insert(photoTags).values(chunk).onConflictDoNothing().run();
      }
    }
  });

  return { written: photoIds.length, skippedTags };
}

/**
 * 处理一批照片：推理 + 特征入库 + 落库。
 *
 * 图片源用**缩略图**（与 WD14 版同一取舍）：
 *  · 项目缩略图是 512px（`thumbnailer.ts` 的 md），而 PixAI 要 1008px —— 是上采样，
 *    质量上确实吃亏；但原图动辄几十 MB，79,777 张全走原图会让 I/O 成为瓶颈，
 *    而 1008px 下 PixAI 单张已在 CPU 上约 6.5 秒，缩略图的 300–400 KB 读取几乎不占时间。
 *  · 想换成原图：把下面的 `row.thumbnailPath || row.path` 改成 `row.path || row.thumbnailPath`
 *    即可（这一处是唯一的入口）。
 */
async function processBatch(
  rows: PhotoRow[],
  tagIds: Map<string, number>
): Promise<{ written: number; failed: number; errorIds: number[] }> {
  const requests = rows
    .map((row) => {
      const source = row.thumbnailPath || row.path;
      return source ? { id: row.id, path: source } : null;
    })
    .filter((item): item is { id: number; path: string } => item !== null);

  if (requests.length === 0) {
    return { written: 0, failed: 0, errorIds: [] };
  }

  // 没拿到可用路径的照片也算失败：否则它们会"静默消失"在进度里
  const failedSize = rows.length - requests.length;
  const errorIds: number[] = [];
  if (failedSize > 0) {
    const requestedIds = new Set(requests.map((item) => item.id));
    const missing = rows
      .filter((row) => !requestedIds.has(row.id))
      .map((row) => row.id);
    log.warn(
      { photoIds: missing, count: missing.length },
      "照片既无缩略图也无原图路径，已跳过"
    );
    errorIds.push(...missing);
  }

  let results: PixaiPhotoResult[];
  try {
    results = await tagPhotoBatchPixai(requests, {
      includeEmbedding: PRIVATE_BUILD.storePixaiEmbeddings,
    });
  } catch (error) {
    // 不静默吞错：整批失败时把**照片 id 与错误**都打出来，计入 failed
    const message = error instanceof Error ? error.message : String(error);
    log.error(
      { photoIds: requests.map((item) => item.id), error: message },
      "PixAI 批次推理失败"
    );
    return {
      written: 0,
      failed: rows.length,
      errorIds: rows.map((row) => row.id),
    };
  }

  for (const result of results) {
    if (result.error) {
      errorIds.push(result.id);
      log.warn(
        { photoId: result.id, error: result.error },
        "PixAI 单张打标失败"
      );
    }
  }

  // 自用：把 1024 维动漫特征写入 LanceDB 的 `pixai_embeddings` 表。
  // 它与标签是**同一次推理的两个输出**，所以这一步不增加任何推理成本；
  // 入库失败只影响「以图搜图」的质量，绝不能让打标失败。
  // ⚠️ 这里写的是 `upsertPixaiVectors`（不是 WD14 的 768 维那张表）。
  if (PRIVATE_BUILD.storePixaiEmbeddings) {
    const entries = results
      .filter((result) => {
        if (result.error || !Array.isArray(result.embedding)) {
          return false;
        }
        // 维度对不上就不要写：写进去只会让以图搜图整体变噪声
        if (result.embedding.length !== PIXAI_EMBEDDING_DIM) {
          log.warn(
            {
              photoId: result.id,
              dim: result.embedding.length,
              expected: PIXAI_EMBEDDING_DIM,
            },
            "PixAI 特征维度异常，已丢弃该条"
          );
          return false;
        }
        return result.embedding.length > 0;
      })
      .map((result) => ({
        photoId: result.id,
        vector: result.embedding as number[],
      }));
    if (entries.length > 0) {
      try {
        const { isVectorDBInitialized, upsertPixaiVectors } = await import(
          "@/services/ai/vector-db"
        );
        if (!isVectorDBInitialized()) {
          // ⚠️ 不要静默跳过：否则"特征一条都没写进去"会完全无声无息
          log.warn(
            { photos: entries.length },
            "向量库未就绪，本轮 PixAI 特征未入库（下次打标会自动重试）"
          );
        } else {
          await upsertPixaiVectors(entries);
          log.info({ photos: entries.length }, "PixAI 特征已写入向量库");
        }
      } catch (error) {
        log.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "PixAI 特征入库失败（标签不受影响）"
        );
      }
    }
  }

  const { written, skippedTags } = persistResults(results, tagIds);
  if (skippedTags > 0) {
    log.warn({ skippedTags }, "标签名不在 tags 表中，已跳过");
  }

  // 走到这里 results 里至少有一条；若整批都没有成功结果，failed 会等于整批
  return {
    written,
    failed: Math.max(errorIds.length, failedSize),
    errorIds,
  };
}

/**
 * 跑一轮 PixAI 打标。
 *
 * @param modelsDir `<dataPath>/models`
 * @param options.photoIds    只打这些照片；不传则按游标增量推进全库
 * @param options.resetCursor **显式要求从头**（无条件清空游标 → 全库重跑）。
 *   界面上点"生成 AI 标签"传的是 false（断点续跑）；只有明确要重打才传 true
 *   （例：无头命令 `--run-pixai-tagging` 默认 true、`--tag-resume` 时 false）。
 * @param options.maxPhotos   最多处理多少张（用于小范围试点）
 */
export async function runPixaiTagging(
  modelsDir: string,
  options: {
    useGpu?: boolean;
    onProgress?: (progress: PixaiTaggingProgress) => void;
    photoIds?: number[];
    resetCursor?: boolean;
    maxPhotos?: number;
  } = {}
): Promise<PixaiTaggingResult> {
  if (running) {
    throw new Error("PixAI 打标已在进行中");
  }
  if (!PRIVATE_BUILD.usePixaiTagger) {
    throw new Error("PixAI tagger 已在 private-build.ts 中关闭");
  }
  if (!isPixaiModelAvailable(modelsDir)) {
    throw new Error("PixAI 模型文件缺失，无法打标");
  }

  running = true;
  cancelRequested = false;
  try {
    // 词表必须先导入：否则 loadTagIdMap() 是空的，打标会"成功但一个标签都写不进去"
    ensurePixaiVocabulary(modelsDir);
    // 自用：打标也跟随「设置 → GPU 加速 → 使用显卡」选中的那块卡。
    const { getDmlDeviceId, resolveWorkerDevices } = await import(
      "@/services/gpu-detector"
    );
    await initPixaiTagger(
      modelsDir,
      Boolean(options.useGpu),
      getDmlDeviceId(),
      resolveWorkerDevices()
    );    const tagIds = loadTagIdMap();

    let done = 0;
    let tagged = 0;
    let failed = 0;
    let total: number;
    /**
     * 整批 0 成功时记下批次首张的 id：用于最后提示"游标停在这里，重跑会重试这批"。
     * 显式标注类型，否则 TS 会把下面循环里的赋值"看不见"，收窄成 null。
     */
    let stalledAt: number | null = null as number | null;
    const batchSize = BATCH_SIZE;

    if (options.photoIds && options.photoIds.length > 0) {
      const ids = [...new Set(options.photoIds)];
      const limited = options.maxPhotos
        ? ids.slice(0, options.maxPhotos)
        : ids;
      total = limited.length;
      for (let i = 0; i < limited.length; i += batchSize) {
        if (cancelRequested) {
          break;
        }
        const chunk = limited.slice(i, i + batchSize);
        const rows = loadPhotosByIds(chunk);
        const batch = await processBatch(rows, tagIds);
        done += chunk.length;
        tagged += batch.written;
        failed += chunk.length - batch.written;
        options.onProgress?.({ done, total, tagged, failed });
      }
    } else {
      if (
        shouldResetTaggingCursor(options, {
          cursor: readCursor(),
          fullRunDone: isFullPixaiRunDone(),
        })
      ) {
        // 「从头全库重跑」的唯一入口：调用方显式传 `resetCursor: true`
        // （界面上点按钮走的是 false → 断点续跑；无头 --run-pixai-tagging 默认 true）。
        // 另有一个更彻底的 `resetPixaiTaggingProgress()`（连"跑完过一轮"的标记一起清），
        // 留给"换模型要把旧标签全部重打"的显式操作。
        setSetting(CURSOR_KEY, "0");
      }
      let cursor = readCursor();
      /*
       * 自用（方案 A · 问题 6）：进度用**累计口径**上报。
       *
       *   processed = 库里已完成 + 本次已完成，  total = 全库张数
       *
       * 为什么：原来 total 是"还剩多少张"、processed 是"本次处理了多少张"，
       * 界面就成了"0 / 剩余" —— 看着像从头重跑，其实已经在续跑。
       * 换成累计口径后，界面自然显示"已完成 X / 全库 Y"，一眼就知道是在继续，
       * 而速度/预估也仍然正确（剩余时间 = (total − processed) / 速度）。
       */
      const libraryTotal = countRemaining(0);
      done = Math.max(0, libraryTotal - countRemaining(cursor));
      total = libraryTotal;
      // 先报一次累计基线：否则界面第一帧会是"0 / 全库"那种误导数字
      options.onProgress?.({ done, failed, tagged, total });
      for (;;) {
        if (cancelRequested) {
          break;
        }
        if (options.maxPhotos && done >= options.maxPhotos) {
          break;
        }
        const rows = loadPhotosAfterCursor(cursor, batchSize);
        if (rows.length === 0) {
          break;
        }
        const batch = await processBatch(rows, tagIds);
        /*
         * 游标推进策略（与 WD14 版只有一处不同，故意的）：
         *  WD14 无论成败都推进（等于把失败的照片跳过，下一轮也不会重试）。
         *  PixAI 的整批失败通常意味着"模型/worker 出了系统性问题"，
         *  此时推进游标 = 永久跳过这 8 张。所以：
         *   · 有成功写入 → 正常推进（个别失败的照 WD14 语义算 failed，不重试）
         *   · 整批 0 成功 → **不推进**，并结束本轮（否则会死循环重试同一批）
         *  用户再点一次就会从这批重试，这正是断点续跑的意义。
         */
        if (batch.written === 0) {
          stalledAt = rows[0].id;
          failed += rows.length;
          options.onProgress?.({ done, total, tagged, failed });
          log.error(
            {
              photoIds: rows.map((row) => row.id),
              cursor,
            },
            "整批 0 成功，已停止本轮打标并保留游标（重跑会从这批继续）"
          );
          break;
        }
        cursor = rows[rows.length - 1].id;
        setSetting(CURSOR_KEY, String(cursor));
        done += rows.length;
        tagged += batch.written;
        failed += rows.length - batch.written;
        options.onProgress?.({ done, total, tagged, failed });
      }
    }

    invalidateTagSearch();
    if (!cancelRequested && stalledAt === null) {
      // 标记"已完成一次全库重扫"：下次点按钮只做增量，避免重复扫全库。
      // 需要再强制全库重扫时，清掉 app_settings 里的 pixai.tagger.fullRunDone 即可。
      setSetting(FULL_RUN_KEY, "1");
    }
    log.info(
      {
        done,
        total,
        tagged,
        failed,
        cancelled: cancelRequested,
        stalledAt,
      },
      cancelRequested
        ? "PixAI 打标已取消（游标保留，重跑继续）"
        : stalledAt !== null
          ? "PixAI 打标提前结束（整批失败，游标已保留）"
          : "PixAI 打标结束"
    );
    return { total, tagged, failed, cancelled: cancelRequested };
  } finally {
    running = false;
    cancelRequested = false;
  }
}

/** 供 UI / 诊断：当前状态快照。 */
export function getPixaiTaggingStatus(): {
  imported: boolean;
  cursor: number;
  remaining: number;
} {
  const cursor = readCursor();
  return {
    imported: isPixaiVocabularyImported(),
    cursor,
    remaining: countRemaining(cursor),
  };
}
