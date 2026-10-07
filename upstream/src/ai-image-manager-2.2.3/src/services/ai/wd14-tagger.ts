/**
 * WD14 动漫打标服务（自用新增）。
 *
 * 职责三件事：
 *  1. **词表导入**：把 `selected_tags.csv` 的标签导入 `tags` 表，
 *     并挂在「角色」/「通用」两个父标签下
 *  2. **批量打标**：遍历照片（**用 512px 缩略图**，不读 200 GB 原图），
 *     调 `wd14-tagger-client` 推理，把标签写进 `photo_tags`（`origin='auto'`）
 *  3. **可恢复**：进度游标存在 `app_settings`，中断后从上次位置继续
 *
 * ⚠️ 关键安全约束：**绝不能覆盖手动标签**。
 * 写入前先删该照片的自动标签（`user_confirmed = 0`），
 * 手动/已确认标签（`user_confirmed = 1`）一律不动 —— 与上游 `tag-suggester` 同一策略。
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
import {
  categorizeWd14Tag,
  WD14_TAG_CATEGORIES,
} from "./wd14-tag-categories";
import {
  initWd14Tagger,
  isWd14ModelAvailable,
  tagPhotoBatch,
  type Wd14PhotoResult,
} from "./wd14-tagger-client";

const log = createLogger("wd14-tagger");

/** 进度游标：已处理到的最大 photo id（可恢复）。 */
const CURSOR_KEY = "wd14.tagger.cursor";
/** 词表导入标记。 */
const VOCAB_KEY = "wd14.tagger.vocabVersion";
/** 是否已经跑过一次"全库重扫"。用于避免每次点按钮都从 0 重新扫。 */
const FULL_RUN_KEY = "wd14.tagger.fullRunDone";
const VOCAB_VERSION = "wd-vit-tagger-v3:10861:cat-v2-zh";
/** 每批照片数。 */
const BATCH_SIZE = 8;

/** 父标签名：挂父标签是为了侧边栏能折叠，而不是把上万个标签平铺。 */
const PARENT_CHARACTER = "角色";
const PARENT_GENERAL = "通用";

export interface Wd14TaggingProgress {
  done: number;
  total: number;
  tagged: number;
  failed: number;
}

export interface Wd14TaggingResult {
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

let running = false;
let cancelRequested = false;

export function isWd14TaggingRunning(): boolean {
  return running;
}

export function cancelWd14Tagging(): void {
  cancelRequested = true;
}

function vocabPath(modelsDir: string): string {
  return path.join(
    modelsDir,
    "SmilingWolf",
    "wd-vit-tagger-v3",
    "selected_tags.csv"
  );
}

/** 中文名映射表（`english,中文` 两列）。与模型放在同一目录，缺失时自动退回纯英文。 */
function zhNamesPath(modelsDir: string): string {
  return path.join(
    modelsDir,
    "SmilingWolf",
    "wd-vit-tagger-v3",
    "zh_names.csv"
  );
}

/**
 * 读取「英文 → 中文」映射。
 *
 * 文件首行带 UTF-8 BOM，必须先剥掉，否则 `1girl` 这类第一行标签会匹配不上。
 */
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
 * 显示名规范是 `中文 (english)`（括号前有一个空格）；角色标签没有中文，
 * 名字里虽可能含括号（如 `suzuran_(arknights)`），但括号前没有空格，不会被误解析。
 */
export function baseNameOf(storedName: string): string {
  const matched = /^(.+?) \(([^()]+)\)$/.exec(storedName);
  return matched ? matched[2] : storedName;
}

/** 生成落库的显示名：有中文就用 `中文 (english)`，否则保持英文。 */
function displayNameFor(english: string, zh: Map<string, string>): string {
  const chinese = zh.get(english);
  return chinese ? `${chinese} (${english})` : english;
}

/**
 * 把 WD14 词表导入 `tags` 表。
 *
 * category=9（rating 分级）按用户选择**跳过**。
 * 已存在的同名标签直接复用（不重复建）。
 */
export function importWd14Vocabulary(modelsDir: string): {
  character: number;
  general: number;
  skipped: number;
  inserted: number;
  reparented: number;
  renamed: number;
} {
  const db = getDatabase();
  const csv = vocabPath(modelsDir);
  if (!fs.existsSync(csv)) {
    throw new Error(`缺少 WD14 标签词表: ${csv}`);
  }

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

  const parentCharacter = ensureTag(PARENT_CHARACTER, null);
  const parentGeneral = ensureTag(PARENT_GENERAL, null);

  // 通用标签按类型建二级目录（类型划分见 wd14-tag-categories.ts）。
  // 侧边栏只展开「角色」，「通用」整体折叠到这些类型节点，长尾靠标签搜索。
  const typeParentByCategory = new Map<string, number>();
  let parentOther = parentGeneral;
  for (const cat of WD14_TAG_CATEGORIES) {
    if (cat.id === "character" || cat.id === "rating") {
      continue;
    }
    const id = ensureTag(cat.label, parentGeneral);
    if (cat.id === "other") {
      parentOther = id;
    } else {
      typeParentByCategory.set(cat.id, id);
    }
  }

  const lines = fs
    .readFileSync(csv, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const header = lines[0].split(",");
  const iName = header.indexOf("name");
  const iCategory = header.indexOf("category");
  if (iName < 0 || iCategory < 0) {
    throw new Error("selected_tags.csv 缺少 name / category 列");
  }

  // 一次读出已有标签（id + 父标签），避免逐条查询（上万条会非常慢）。
  // 除了跳过重复插入，还要把**已经导入过的**标签重新挂到正确的类型目录下
  // —— 否则从旧结构升级时二级目录会一直是空的。
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
        // 按**英文基础名**索引：库里可能已经是「中文 (english)」形式
        baseNameOf(row.name),
        { id: row.id, parentId: row.parentId, name: row.name },
      ])
  );

  let character = 0;
  let general = 0;
  let skipped = 0;
  let reparented = 0;
  let renamed = 0;
  const toInsert: { name: string; parentId: number }[] = [];
  const toReparent: { id: number; parentId: number }[] = [];
  const toRename: { id: number; name: string }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const name = parts[iName];
    if (!name) {
      continue;
    }
    const category = Number.parseInt(parts[iCategory], 10);
    if (category === 9) {
      skipped++;
      continue;
    }
    const isCharacter = category === 4;
    if (isCharacter) {
      character++;
    } else {
      if (!PRIVATE_BUILD.tagGeneralTags) {
        skipped++;
        continue;
      }
      general++;
    }

    const targetParent = isCharacter
      ? parentCharacter
      : (typeParentByCategory.get(categorizeWd14Tag(name, category)) ??
        parentOther);
    // 角色标签没有中文来源（保持英文，可之后右键手动改）；
    // 通用标签有映射时落库为「中文 (english)」，中英文都能搜到。
    const targetName = isCharacter ? name : displayNameFor(name, zhNames);

    const found = existing.get(name);
    if (found) {
      if (found.parentId !== targetParent) {
        toReparent.push({ id: found.id, parentId: targetParent });
        reparented++;
      }
      if (found.name !== targetName) {
        toRename.push({ id: found.id, name: targetName });
        renamed++;
      }
      continue;
    }
    existing.set(name, { id: -1, parentId: targetParent, name: targetName });
    toInsert.push({ name: targetName, parentId: targetParent });
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

  setSetting(VOCAB_KEY, VOCAB_VERSION);
  invalidateTagSearch();
  log.info(
    {
      character,
      general,
      skipped,
      inserted: toInsert.length,
      reparented,
      renamed,
    },
    "WD14 词表已导入"
  );
  return {
    character,
    general,
    skipped,
    inserted: toInsert.length,
    reparented,
    renamed,
  };
}

export function isWd14VocabularyImported(): boolean {
  return getSetting(VOCAB_KEY) === VOCAB_VERSION;
}

/** 是否已经跑完过一次全库重扫（决定下次点按钮是否重置游标）。 */
export function isFullWd14RunDone(): boolean {
  return getSetting(FULL_RUN_KEY) === "1";
}

/** 确认词表已导入；必要时执行导入。 */
export function ensureWd14Vocabulary(modelsDir: string): void {
  if (!isWd14VocabularyImported()) {
    importWd14Vocabulary(modelsDir);
  }
}

/** tag 名 → id 映射（打标主循环复用，避免逐条查库）。 */
function loadTagIdMap(): Map<string, number> {
  const db = getDatabase();
  const rows = db.select({ id: tags.id, name: tags.name }).from(tags).all();
  // 库里的名字可能是「中文 (english)」，而 worker 返回的是英文名，
  // 所以按**英文基础名**索引；纯英文名（角色标签、手动标签）原样作为键。
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
 * 策略（与上游 tag-suggester 一致，保证手动标签不被覆盖）：
 *   1. 先删这批照片的**自动**标签（`user_confirmed = 0`）
 *   2. 再插入本次结果（`origin='auto'`、`userConfirmed=false`）
 */
function persistResults(
  results: Wd14PhotoResult[],
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

/** 处理一批照片：推理 + 落库。缩略图优先（WD14 只需 448px，缩略图是 512px）。 */
async function processBatch(
  rows: PhotoRow[],
  tagIds: Map<string, number>
): Promise<{ written: number }> {
  const requests = rows
    .map((row) => {
      const source = row.thumbnailPath || row.path;
      return source ? { id: row.id, path: source } : null;
    })
    .filter((item): item is { id: number; path: string } => item !== null);

  if (requests.length === 0) {
    return { written: 0 };
  }

  const results = await tagPhotoBatch(requests, {
    includeEmbedding: PRIVATE_BUILD.storeWd14Embeddings,
  });

  // 自用：把 768 维动漫特征写入 LanceDB。
  // 它与标签是**同一次推理的两个输出**，所以这一步不增加任何推理成本；
  // 入库失败只影响「以图搜图」的质量，绝不能让打标失败。
  if (PRIVATE_BUILD.storeWd14Embeddings) {
    const entries = results
      .filter(
        (result) =>
          !result.error &&
          Array.isArray(result.embedding) &&
          result.embedding.length > 0
      )
      .map((result) => ({
        photoId: result.id,
        vector: result.embedding as number[],
      }));
    if (entries.length > 0) {
      try {
        const { isVectorDBInitialized, upsertWd14Vectors } = await import(
          "@/services/ai/vector-db"
        );
        if (!isVectorDBInitialized()) {
          // ⚠️ 不要静默跳过：否则"特征一条都没写进去"会完全无声无息
          log.warn(
            { photos: entries.length },
            "向量库未就绪，本轮 WD14 特征未入库（下次打标会自动重试）"
          );
        } else {
          await upsertWd14Vectors(entries);
          log.info({ photos: entries.length }, "WD14 特征已写入向量库");
        }
      } catch (error) {
        log.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "WD14 特征入库失败（标签不受影响）"
        );
      }
    }
  }

  const { written, skippedTags } = persistResults(results, tagIds);
  if (skippedTags > 0) {
    log.warn({ skippedTags }, "标签名不在 tags 表中，已跳过");
  }
  return { written };
}

/**
 * 跑一轮 WD14 打标。
 *
 * @param modelsDir `<dataPath>/models`
 * @param options.photoIds    只打这些照片；不传则按游标增量推进全库
 * @param options.resetCursor 从头开始（全库重跑）
 * @param options.maxPhotos   最多处理多少张（用于小范围试点）
 */
export async function runWd14Tagging(
  modelsDir: string,
  options: {
    useGpu?: boolean;
    onProgress?: (progress: Wd14TaggingProgress) => void;
    photoIds?: number[];
    resetCursor?: boolean;
    maxPhotos?: number;
  } = {}
): Promise<Wd14TaggingResult> {
  if (running) {
    throw new Error("WD14 打标已在进行中");
  }
  if (!PRIVATE_BUILD.useWd14Tagger) {
    throw new Error("WD14 tagger 已在 private-build.ts 中关闭");
  }
  if (!isWd14ModelAvailable(modelsDir)) {
    throw new Error("WD14 模型文件缺失，无法打标");
  }

  running = true;
  cancelRequested = false;
  try {
    ensureWd14Vocabulary(modelsDir);
    // 自用修复：调用方没显式传 useGpu 时，读应用里的「GPU 加速」设置。
    // 之前是 Boolean(options.useGpu)，而调用方基本不传该参数 → 恒为 false → 一直在跑 CPU。
    // 读取该设置的既有写法见 face-detector.ts 的 getSetting("gpu.enabled") === "true"。
    const useGpu = options.useGpu ?? (getSetting("gpu.enabled") === "true");
    log.info({ useGpu, explicit: options.useGpu !== undefined }, "WD14 推理设备");
    await initWd14Tagger(modelsDir, useGpu);
    const tagIds = loadTagIdMap();

    let done = 0;
    let tagged = 0;
    let failed = 0;
    let total: number;

    if (options.photoIds && options.photoIds.length > 0) {
      const ids = [...new Set(options.photoIds)];
      const limited = options.maxPhotos
        ? ids.slice(0, options.maxPhotos)
        : ids;
      total = limited.length;
      for (let i = 0; i < limited.length; i += BATCH_SIZE) {
        if (cancelRequested) {
          break;
        }
        const chunk = limited.slice(i, i + BATCH_SIZE);
        const rows = loadPhotosByIds(chunk);
        const { written } = await processBatch(rows, tagIds);
        done += chunk.length;
        tagged += written;
        failed += chunk.length - written;
        options.onProgress?.({ done, total, tagged, failed });
      }
    } else {
      if (options.resetCursor && !isFullWd14RunDone()) {
        // 只在**第一次**全库重扫时把游标归零。
        // 之后即便中途关掉应用再点一次，也会从上次的游标继续，而不是从头再来
        //（全库 CPU 跑一遍约 4 小时，重头开始代价太大）。
        setSetting(CURSOR_KEY, "0");
      }
      let cursor = readCursor();
      total = countRemaining(cursor);
      if (options.maxPhotos) {
        total = Math.min(total, options.maxPhotos);
      }
      for (;;) {
        if (cancelRequested) {
          break;
        }
        if (options.maxPhotos && done >= options.maxPhotos) {
          break;
        }
        const rows = loadPhotosAfterCursor(cursor, BATCH_SIZE);
        if (rows.length === 0) {
          break;
        }
        const { written } = await processBatch(rows, tagIds);
        cursor = rows[rows.length - 1].id;
        setSetting(CURSOR_KEY, String(cursor));
        done += rows.length;
        tagged += written;
        failed += rows.length - written;
        options.onProgress?.({ done, total, tagged, failed });
      }
    }

    invalidateTagSearch();
    if (!cancelRequested) {
      // 标记"已完成一次全库重扫"：下次点按钮只做增量，避免重复扫全库。
      // 需要再强制全库重扫时，清掉 app_settings 里的 wd14.tagger.fullRunDone 即可。
      setSetting(FULL_RUN_KEY, "1");
    }
    log.info({ done, tagged, failed }, "WD14 打标结束");
    return { total, tagged, failed, cancelled: cancelRequested };
  } finally {
    running = false;
    cancelRequested = false;
  }
}

/** 供 UI / 诊断：当前状态快照。 */
export function getWd14TaggingStatus(): {
  imported: boolean;
  cursor: number;
  remaining: number;
} {
  const cursor = readCursor();
  return {
    imported: isWd14VocabularyImported(),
    cursor,
    remaining: countRemaining(cursor),
  };
}
