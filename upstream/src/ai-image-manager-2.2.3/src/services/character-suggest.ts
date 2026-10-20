/**
 * 人物识别：找出「未命名的同角色」。
 *
 * 用户的需求原话：「查找图库里未命名的同角色」「识别没有 tag 的角色然后命名」。
 *
 * 为什么不用现成的人脸识别：实测 SFace 对动漫角色成对 F1 只有 **0.152**
 * （12 个角色被分成 6 组、最大一组塞了 134 张脸 = 把不同角色混在一起），
 * 调阈值救不了。而**整图特征**（发饰/服装/配色）显著更好：
 * 前 10 张同角色率 Chinese-CLIP 54%、CCIP 76%。
 *
 * 本模块的思路（种子 + 投票，实测模拟 98.6% 精度 / 覆盖约一半）：
 *   1. 把**已经打过角色标签**的图当"种子"（这些标签实测 100% 准确）；
 *   2. 每个角色算一个特征中心（质心）；
 *   3. 对**没有角色标签**的图，找到最接近的角色中心；
 *   4. 相似度达标、且明显优于第二名的，才作为建议。
 *
 * 结果不直接当作既定事实：由调用方以「AI 建议标签」（userConfirmed = false）
 * 落库，走现有的标签确认流程。
 *
 * 纯逻辑放在本文件上半部分，可单测；数据库/向量访问在下半部分。
 */

import { inArray, isNull } from "drizzle-orm";
import path from "node:path";
import { getDatabase } from "@/db";
import { photoTags, photos, tags } from "@/db/schema";
import { getTagSearchRevision } from "@/services/tag-search-revision";
import { getDataPath } from "@/utils/data-path";
import {
  getCcipVectors,
  getPhotoVectors,
  searchByCcipVector,
  searchByPhotoVector,
} from "@/services/ai/vector-db";
import {
  resolveCharacterFeatureStatus,
  type CharacterFeatureStatus,
} from "@/services/ccip-model";

/**
 * 角色识别的特征源解析（自用 2026-10）。
 *
 * 用户口径：**默认首选 CCIP**；开关开着但模型没放 → 角色识别**不可用**并明确提示；
 * 用户**手动关掉开关**才算"已知晓"，这时回退到现有 CLIP 特征。
 * 判断逻辑统一放在 `ccip-model.ts`，这里只负责按结论选读写入口。
 */
export async function resolveCharacterFeatureAccess(): Promise<{
  status: CharacterFeatureStatus;
  loadVectors: (photoIds: number[]) => Promise<Map<number, number[]>>;
  search: (
    vector: number[] | Float64Array,
    limit: number
  ) => Promise<Array<{ photoId: number; similarity: number }> | null>;
}> {
  const modelsDir = path.join(getDataPath(), "models");
  const status = await resolveCharacterFeatureStatus(modelsDir);
  if (status.source === "unavailable") {
    throw new Error(describeCharacterFeatureUnavailable(status));
  }
  const useCcip = status.source === "ccip";
  return {
    status,
    loadVectors: useCcip ? getCcipVectors : getPhotoVectors,
    // 统一签名：CCIP 检索只接受 number[]，这里做一次转换，调用方不必关心。
    search: (vector, limit) =>
      useCcip
        ? searchByCcipVector(Array.from(vector), limit)
        : searchByPhotoVector(vector, limit),
  };
}

/** 角色识别暂时不可用时的**可执行**提示（服务层与界面共用同一句话）。 */
export function describeCharacterFeatureUnavailable(
  status: CharacterFeatureStatus
): string {
  if (status.reason === "model-missing") {
    return (
      "角色识别需要 CCIP 模型，但没找到模型文件。" +
      "请把模型放到「图库\\models\\ccip\\model_feat.onnx」；" +
      "或者在「设置 → 应用行为」里关掉「角色识别优先使用 CCIP 模型」，改用现有特征。"
    );
  }
  if (status.reason === "vectors-missing") {
    return (
      "CCIP 模型已就位，但还没有生成角色特征（全库需要先算一次）。" +
      "请在「角色识别」页点「获取全库角色特征」。"
    );
  }
  if (status.reason === "vector-db-not-ready") {
    return "向量库还没准备好，稍后再试。";
  }
  return "角色识别当前不可用。";
}

export interface SeedPhoto {
  photoId: number;
  tagId: number;
  tagName: string;
}

export interface VectorEntry {
  photoId: number;
  vector: ArrayLike<number>;
}

export interface CharacterCentroid {
  centroid: Float64Array;
  seedCount: number;
  tagId: number;
  tagName: string;
}

export interface CharacterProposal {
  maxSimilarity: number;
  minSimilarity: number;
  meanSimilarity: number;
  photoIds: number[];
  seedCount: number;
  tagId: number;
  tagName: string;
}

export interface SuggestOptions {
  /** 相似度下限（余弦）。实测同角色不同作品的中位是 0.873，所以默认取得更高以保证精度。 */
  minSimilarity?: number;
  /** 与第二名的差距下限，用来排除「两个角色都像」的模糊情况。 */
  minMargin?: number;
  /** 一个角色至少要这么多张已命名图片，才算得出可靠的中心。 */
  minSeedCount?: number;
  /** 建议里至少要这么多张图才值得给用户看。 */
  minPhotos?: number;
  /** 每个角色最多建议多少张，防止一个大角色淹没界面。 */
  maxPhotosPerCharacter?: number;
}

const DEFAULTS = {
  minSimilarity: 0.95,
  minMargin: 0.01,
  minSeedCount: 3,
  minPhotos: 2,
  maxPhotosPerCharacter: 500,
} as const;

function normalize(vector: ArrayLike<number>): Float64Array {
  const out = new Float64Array(vector.length);
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const v = Number(vector[i]);
    out[i] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i++) {
    out[i] /= norm;
  }
  return out;
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * 按角色标签聚合种子图，算出每个角色的特征中心（归一化均值）。
 * 已命名图片少于 `minSeedCount` 的角色会被跳过。
 */
export function buildCharacterCentroids(
  seeds: readonly SeedPhoto[],
  vectors: ReadonlyMap<number, ArrayLike<number>>,
  options: SuggestOptions = {}
): CharacterCentroid[] {
  const minSeedCount = options.minSeedCount ?? DEFAULTS.minSeedCount;
  const buckets = new Map<
    number,
    { dims: number; sum: Float64Array; count: number; tagName: string }
  >();

  for (const seed of seeds) {
    const vector = vectors.get(seed.photoId);
    if (!vector || vector.length === 0) {
      continue;
    }
    let bucket = buckets.get(seed.tagId);
    if (!bucket) {
      bucket = {
        dims: vector.length,
        sum: new Float64Array(vector.length),
        count: 0,
        tagName: seed.tagName,
      };
      buckets.set(seed.tagId, bucket);
    }
    if (bucket.dims !== vector.length) {
      continue; // 维度不一致（模型换过）→ 跳过，避免算出无意义的中心
    }
    for (let i = 0; i < vector.length; i++) {
      bucket.sum[i] += Number(vector[i]);
    }
    bucket.count++;
  }

  const centroids: CharacterCentroid[] = [];
  for (const [tagId, bucket] of buckets) {
    if (bucket.count < minSeedCount) {
      continue;
    }
    const mean = new Float64Array(bucket.dims);
    for (let i = 0; i < bucket.dims; i++) {
      mean[i] = bucket.sum[i] / bucket.count;
    }
    centroids.push({
      tagId,
      tagName: bucket.tagName,
      seedCount: bucket.count,
      centroid: normalize(mean),
    });
  }
  return centroids;
}

export interface TagCandidateHits {
  hits: Array<{ photoId: number; similarity: number }>;
  seedCount: number;
  tagId: number;
  tagName: string;
}

/**
 * 合并「每个角色各自找到的候选」，产出最终建议。
 *
 * 因为候选是靠向量索引按角色逐个检索来的（不是全库两两比），
 * 这里要做三件事：
 *   1. 一张图只归给最像的那个角色；
 *   2. 若两个角色都像（差距小于 minMargin）就不下结论，交给用户；
 *   3. 相似度低于 minSimilarity 的直接丢弃。
 */
export function mergeCandidateHits(
  perTag: readonly TagCandidateHits[],
  options: SuggestOptions = {}
): CharacterProposal[] {
  const minSimilarity = options.minSimilarity ?? DEFAULTS.minSimilarity;
  const minMargin = options.minMargin ?? DEFAULTS.minMargin;
  const minPhotos = options.minPhotos ?? DEFAULTS.minPhotos;
  const maxPhotos = options.maxPhotosPerCharacter ?? DEFAULTS.maxPhotosPerCharacter;

  const tagInfo = new Map<number, { tagName: string; seedCount: number }>();
  for (const entry of perTag) {
    tagInfo.set(entry.tagId, {
      tagName: entry.tagName,
      seedCount: entry.seedCount,
    });
  }

  // photoId → 该图在候选里出现过的最好成绩与次好成绩（来自不同角色）
  const best = new Map<
    number,
    { secondScore: number; secondTagId: number; score: number; tagId: number }
  >();

  for (const entry of perTag) {
    for (const hit of entry.hits) {
      if (hit.similarity < minSimilarity) {
        continue;
      }
      const current = best.get(hit.photoId);
      if (!current) {
        best.set(hit.photoId, {
          tagId: entry.tagId,
          score: hit.similarity,
          secondTagId: -1,
          secondScore: -1,
        });
        continue;
      }
      if (entry.tagId === current.tagId) {
        if (hit.similarity > current.score) {
          current.score = hit.similarity;
        }
        continue;
      }
      if (hit.similarity > current.score) {
        best.set(hit.photoId, {
          tagId: entry.tagId,
          score: hit.similarity,
          secondTagId: current.tagId,
          secondScore: current.score,
        });
      } else if (entry.tagId !== current.secondTagId && hit.similarity > current.secondScore) {
        current.secondScore = hit.similarity;
        current.secondTagId = entry.tagId;
      }
    }
  }

  const grouped = new Map<number, { photoIds: number[]; sims: number[] }>();
  for (const [photoId, info] of best) {
    // 两个角色都像 → 不猜
    if (info.secondScore > -1 && info.score - info.secondScore < minMargin) {
      continue;
    }
    let bucket = grouped.get(info.tagId);
    if (!bucket) {
      bucket = { photoIds: [], sims: [] };
      grouped.set(info.tagId, bucket);
    }
    if (bucket.photoIds.length >= maxPhotos) {
      continue;
    }
    bucket.photoIds.push(photoId);
    bucket.sims.push(info.score);
  }

  const proposals: CharacterProposal[] = [];
  for (const [tagId, bucket] of grouped) {
    if (bucket.photoIds.length < minPhotos) {
      continue;
    }
    const info = tagInfo.get(tagId);
    if (!info) {
      continue;
    }
    const sorted = [...bucket.photoIds].sort((a, b) => a - b);
    proposals.push({
      tagId,
      tagName: info.tagName,
      seedCount: info.seedCount,
      photoIds: sorted,
      meanSimilarity: bucket.sims.reduce((s, v) => s + v, 0) / bucket.sims.length,
      minSimilarity: Math.min(...bucket.sims),
      maxSimilarity: Math.max(...bucket.sims),
    });
  }

  return proposals.sort(
    (a, b) =>
      b.photoIds.length - a.photoIds.length || a.tagName.localeCompare(b.tagName)
  );
}

// ── 数据库 / 向量访问（下半部分）────────────────────────────────────────

/** 「角色」这一顶层标签的名字（库里 id=2，含 8,308 个子标签）。 */
const CHARACTER_ROOT_TAG_NAME = "角色";

/*
 * 自用（2026-10-18 · 会话#9 用户反馈「这个分析有点久」）：
 *   ① **进度**：分析分"加载种子向量 → 逐个角色检索"两段，界面要能显示走到哪了 ✓
 *   ② **缓存**：种子向量 → 角色特征中心这一步最贵（要把几万张已命名图的 768 维读出来）；
 *      标签没变时没必要重算 → 按"标签版本号 + 5 分钟 TTL"缓存 ✓
 */
let suggestProgress: {
  done: number;
  elapsedMs: number;
  phase: "seeds" | "search";
  startedAt: number;
  total: number;
} | null = null;

export interface CharacterSuggestProgress {
  done: number;
  elapsedMs: number;
  phase: "idle" | "seeds" | "search";
  running: boolean;
  total: number;
}

export function getCharacterSuggestProgress(): CharacterSuggestProgress {
  if (!suggestProgress) {
    return { running: false, done: 0, total: 0, phase: "idle", elapsedMs: 0 };
  }
  return {
    running: true,
    done: suggestProgress.done,
    total: suggestProgress.total,
    phase: suggestProgress.phase,
    elapsedMs: Date.now() - suggestProgress.startedAt,
  };
}

/** 特征中心缓存（标签没变、且 5 分钟内 → 直接复用） */
const CENTROID_CACHE_TTL_MS = 5 * 60_000;
let centroidCache: {
  at: number;
  revision: number;
  centroids: CharacterCentroid[];
  seedPhotos: number;
} | null = null;
const MAX_CHARACTERS_PER_RUN = 300;
const PER_CHARACTER_LIMIT = 300;
const VECTOR_CHUNK = 2_000;

export interface CharacterAnalysisResult {
  /** 实际写入的建议标签条数（dryRun 时为 0） */
  applied: number;
  candidateCount: number;
  characterCount: number;
  proposals: CharacterProposal[];
  /** 参与计算中心的已命名图片数（有向量的） */
  seedPhotos: number;
  /** 被跳过的角色数（超出单次上限） */
  skippedCharacters: number;
  /** 图库里没有角色标签的图片数 */
  unnamedPhotos: number;
}

export interface AnalyzeCharacterOptions extends SuggestOptions {
  /** true = 只算不写（用于预览） */
  dryRun?: boolean;
}

/** 从标签表里找出「角色」顶层标签的全部后代（用 JS 遍历，避免递归 SQL）。 */
export function collectDescendantTagIds(
  rows: ReadonlyArray<{ id: number; name: string; parentId: number | null }>
): { ids: number[]; nameById: Map<number, string>; rootId: number | null } {
  const root = rows.find(
    (row) => row.parentId === null && row.name === CHARACTER_ROOT_TAG_NAME
  );
  const nameById = new Map<number, string>();
  for (const row of rows) {
    nameById.set(row.id, row.name);
  }
  if (!root) {
    return { ids: [], nameById, rootId: null };
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
  return { ids, nameById, rootId: root.id };
}

/**
 * 找出「未命名的同角色」并（可选）写入 AI 建议标签。
 *
 * 写入的是**建议**：`origin = "auto"`、`userConfirmed = false`、把相似度作为
 * confidence，冲突时什么都不做 —— 手动/已确认的标签绝不会被覆盖
 * （与 tag-suggester / WD14 / PixAI 同一策略）。
 */
export async function analyzeUnnamedCharacters(
  options: AnalyzeCharacterOptions = {}
): Promise<CharacterAnalysisResult> {
  // 先定特征源：首选 CCIP；缺失则按用户口径抛错（不静默回退）。
  const { loadVectors, search } = await resolveCharacterFeatureAccess();
  const db = getDatabase();
  const allTags = db
    .select({ id: tags.id, name: tags.name, parentId: tags.parentId })
    .from(tags)
    .all();
  const {
    ids: characterTagIds,
    nameById,
    rootId,
  } = collectDescendantTagIds(allTags);

  const empty: CharacterAnalysisResult = {
    applied: 0,
    candidateCount: 0,
    characterCount: 0,
    proposals: [],
    seedPhotos: 0,
    skippedCharacters: 0,
    unnamedPhotos: 0,
  };
  if (!(rootId && characterTagIds.length > 0)) {
    return empty;
  }

  // 已打角色标签的图 = 种子；其余 = 未命名
  const seedRows: Array<{ photoId: number; tagId: number }> = [];
  const TAG_CHUNK = 500;
  for (let i = 0; i < characterTagIds.length; i += TAG_CHUNK) {
    const slice = characterTagIds.slice(i, i + TAG_CHUNK);
    const rows = db
      .select({ photoId: photoTags.photoId, tagId: photoTags.tagId })
      .from(photoTags)
      .where(inArray(photoTags.tagId, slice))
      .all();
    for (const row of rows) {
      // photo_tags 的 photo_id / tag_id 在 schema 里都可空，两个都要判
      if (row.photoId != null && row.tagId != null) {
        seedRows.push({ photoId: row.photoId, tagId: row.tagId });
      }
    }
  }

  const namedIds = new Set(seedRows.map((row) => row.photoId));
  const allPhotoIds = db
    .select({ id: photos.id })
    .from(photos)
    .where(isNull(photos.deletedAt))
    .all()
    .map((row) => row.id);
  const unnamedIds = new Set(allPhotoIds.filter((id) => !namedIds.has(id)));

  /*
   * 种子图的向量 → 每个角色的特征中心（特征源按开关：CCIP 优先 / CLIP 回退）
   *
   * 自用（2026-10-18 · 会话#9）：这一步最贵（要把几万张已命名图的 768 维都读出来），
   * 而**标签没变时结果完全一样** → 按"标签版本号 + 5 分钟"缓存，第二次打开直接秒出 ✓
   */
  const revision = (() => {
    try {
      return getTagSearchRevision();
    } catch {
      return -1;
    }
  })();
  const cacheHit =
    centroidCache &&
    centroidCache.revision === revision &&
    Date.now() - centroidCache.at < CENTROID_CACHE_TTL_MS;

  let centroids: CharacterCentroid[];
  let seedPhotoCount: number;
  if (cacheHit && centroidCache) {
    centroids = centroidCache.centroids;
    seedPhotoCount = centroidCache.seedPhotos;
    console.log("[CharacterSuggest] 命中特征中心缓存，跳过种子向量读取");
  } else {
    const seedVectors = new Map<number, number[]>();
    const seedPhotoIds = [...namedIds];
    suggestProgress = {
      done: 0,
      elapsedMs: 0,
      phase: "seeds",
      startedAt: Date.now(),
      total: seedPhotoIds.length,
    };
    /*
     * 自用（2026-10-18 · 会话#9）：**分块并发读** —— 每块 2000 张 × 768 维，
     * 串行读 2 万张要十几秒；4 路并发能把这段压到几秒 ✓
     */
    const SEED_CONCURRENCY = 4;
    const chunks: number[][] = [];
    for (let i = 0; i < seedPhotoIds.length; i += VECTOR_CHUNK) {
      chunks.push(seedPhotoIds.slice(i, i + VECTOR_CHUNK));
    }
    for (let start = 0; start < chunks.length; start += SEED_CONCURRENCY) {
      const batch = chunks.slice(start, start + SEED_CONCURRENCY);
      const loaded = await Promise.all(batch.map((ids) => loadVectors(ids)));
      for (const vectors of loaded) {
        for (const [photoId, vector] of vectors) {
          seedVectors.set(photoId, vector);
        }
      }
      if (suggestProgress) {
        suggestProgress.done = Math.min(
          (start + batch.length) * VECTOR_CHUNK,
          seedPhotoIds.length
        );
      }
    }
    const seedPhotos: SeedPhoto[] = seedRows.map((row) => ({
      photoId: row.photoId,
      tagId: row.tagId,
      tagName: nameById.get(row.tagId) ?? String(row.tagId),
    }));
    centroids = buildCharacterCentroids(seedPhotos, seedVectors, options);
    seedPhotoCount = seedVectors.size;
    centroidCache = {
      at: Date.now(),
      revision,
      centroids,
      seedPhotos: seedPhotoCount,
    };
  }
  const ranked = [...centroids].sort((a, b) => b.seedCount - a.seedCount);
  const considered = ranked.slice(0, MAX_CHARACTERS_PER_RUN);

  // 按角色检索最像的图，只保留「未命名」的
  /*
   * 自用（2026-10-18 · 会话#9 用户反馈「点了半天才出列表」）：
   * 以前是**逐个角色串行**检索（最多 300 次向量查询）→ 实测要几十秒 ✗
   * 现在按 4 路并发检索，结果顺序不变（按 considered 的顺序收集）。
   */
  const SEARCH_CONCURRENCY = 8;
  const perTag: TagCandidateHits[] = [];
  let searchUnavailable = false;
  for (
    let start = 0;
    start < considered.length;
    start += SEARCH_CONCURRENCY
  ) {
    const batch = considered.slice(start, start + SEARCH_CONCURRENCY);
    const hitsPerCentroid = await Promise.all(
      batch.map((centroid) => search(centroid.centroid, PER_CHARACTER_LIMIT))
    );
    if (suggestProgress) {
      suggestProgress.phase = "search";
      suggestProgress.done = Math.min(
        start + batch.length,
        considered.length
      );
      suggestProgress.total = considered.length;
    }
    for (let i = 0; i < batch.length; i += 1) {
      const centroid = batch[i];
      const hits = hitsPerCentroid[i];
      if (!hits) {
        searchUnavailable = true;
        break; // 向量库不可用 → 不再继续白跑
      }
      perTag.push({
        tagId: centroid.tagId,
        tagName: centroid.tagName,
        seedCount: centroid.seedCount,
        hits: hits.filter((hit) => unnamedIds.has(hit.photoId)),
      });
    }
    if (searchUnavailable) {
      break;
    }
  }

  const proposals = mergeCandidateHits(perTag, options);
  const candidateCount = proposals.reduce(
    (sum, proposal) => sum + proposal.photoIds.length,
    0
  );

  let applied = 0;
  if (!options.dryRun && proposals.length > 0) {
    const rows = proposals.flatMap((proposal) =>
      proposal.photoIds.map((photoId) => ({
        photoId,
        tagId: proposal.tagId,
        confidence: Math.round(proposal.meanSimilarity * 10_000) / 10_000,
        isConfirmed: false,
        origin: "auto" as const,
        userConfirmed: false,
      }))
    );
    const INSERT_CHUNK = 200;
    db.transaction(() => {
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        db.insert(photoTags)
          .values(rows.slice(i, i + INSERT_CHUNK))
          .onConflictDoNothing()
          .run();
      }
    });
    applied = rows.length;
  }

  suggestProgress = null;
  return {
    applied,
    candidateCount,
    characterCount: proposals.length,
    proposals,
    seedPhotos: seedPhotoCount,
    skippedCharacters: ranked.length - considered.length,
    unnamedPhotos: unnamedIds.size,
  };
}

