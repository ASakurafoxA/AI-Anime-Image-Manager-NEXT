/**
 * 无标签角色的聚类发现（NEXT 版新增）。
 *
 * 这是用户最初需求的后一半：**发现「没有角色标签」的（原创）角色**。
 *
 * 为什么需要单独一套逻辑：现有 `character-suggest.ts` 是「种子 + 投票」，
 * 必须**先有角色标签**才知道要找谁 —— 所以完全没标签的原创角色永远不会被发现。
 * 本模块改从**无标签的图本身**出发：把彼此很像的图聚成组，交给用户命名。
 *
 * 算法（沿用当年 CCIP 全量实验验证过的思路）：
 *   1. 对每张候选图用向量索引找 top-K 近邻（**逐张 ANN**：实测 4.2ms/张，
 *      全库约 5 分钟；而全量两两比对要 26 小时，不可行）；
 *   2. 只保留相似度 ≥ 阈值的边，并且要求**互近邻**（i 的邻居里有 j、j 的邻居里也有 i）
 *      —— 这一步是"防误连"的关键，能把"单方面像"的噪声边掐掉；
 *   3. 并查集求连通分量；
 *   4. 丢掉太小的组；太大的组**提高阈值递归细分**（当年实验表明大组里常混着多个角色）。
 *
 * 纯算法部分（`buildMutualKnnGroups`）不碰数据库，方便单测。
 */
import { inArray, isNull } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photoTags, photos } from "@/db/schema";
import {
  getCcipVectors,
  listCcipVectorIds,
  searchByCcipVector,
} from "@/services/ai/vector-db";
import { characterTagIdsFromRows, loadTagRows } from "./character-tags";

export interface KnnEntry {
  id: number;
  similarity: number;
}

export interface ClusterOptions {
  /**
   * 连边门槛（余弦相似度）。
   *
   * 实测（20 角色 / 160 张，CCIP 特征）：0.85 时组内纯度 0.889、75% 的组纯度 ≥0.9；
   * 0.80 时覆盖面更大但纯度降到 0.877。默认取 0.85 —— 宁可少而准。
   */
  similarityThreshold?: number;
  /** 每张图找多少个近邻（互近邻判定用）。默认 12（与当年实验一致）。 */
  neighbors?: number;
  /** 组内至少多少张才值得给用户看。默认 3。 */
  minGroupSize?: number;
  /** 超过多少张的组要递归细分（过大通常混了多个角色）。默认 60。 */
  maxGroupSize?: number;
  /** 只看这些照片（默认：库里所有「无角色标签且已有 CCIP 特征」的图）。 */
  photoIds?: number[];
  /** 试跑上限。 */
  limit?: number;
  /** 进度回调。 */
  onProgress?: (progress: ClusterProgress) => void;
  signal?: AbortSignal;
}

export interface ClusterProgress {
  phase: "collect" | "search" | "group";
  done: number;
  total: number;
}

/**
 * 聚类过程的实时进度（界面轮询用）。
 *
 * 全库聚类要逐张查近邻（实测 4.2ms/张 → 7.7 万张约 5 分钟），
 * 只给"正在分析"四个字等于黑箱，这里把"已处理/总数"暴露出来。
 */
let liveClusterProgress: {
  phase: string;
  done: number;
  total: number;
  startedAt: number;
} | null = null;

export interface ClusterProgressView {
  running: boolean;
  phase: string;
  done: number;
  total: number;
  photosPerSecond: number | null;
  etaSeconds: number | null;
}

export function getClusterProgress(): ClusterProgressView {
  if (!liveClusterProgress) {
    return {
      running: false,
      phase: "idle",
      done: 0,
      total: 0,
      photosPerSecond: null,
      etaSeconds: null,
    };
  }
  const elapsed = Math.max(0.001, (Date.now() - liveClusterProgress.startedAt) / 1000);
  const rate = liveClusterProgress.done / elapsed;
  const remaining = liveClusterProgress.total - liveClusterProgress.done;
  return {
    running: true,
    phase: liveClusterProgress.phase,
    done: liveClusterProgress.done,
    total: liveClusterProgress.total,
    photosPerSecond: rate > 0 ? Math.round(rate * 100) / 100 : null,
    etaSeconds: rate > 0 && remaining > 0 ? Math.round(remaining / rate) : 0,
  };
}

export interface CharacterGroup {
  photoIds: number[];
  size: number;
  /** 组内两两相似度的均值（抽样估算）。 */
  meanSimilarity: number;
  /** 最接近组中心的图（界面拿它当封面）。 */
  representativeId: number;
}

export interface ClusterResult {
  groups: CharacterGroup[];
  /** 参与聚类的候选图数 */
  candidates: number;
  /** 真正取到向量的图数 */
  embedded: number;
  cancelled: boolean;
  elapsedMs: number;
  threshold: number;
}

/** 默认参数（集中放这里，便于调参与测试）。 */
export const CLUSTER_DEFAULTS = {
  similarityThreshold: 0.85,
  neighbors: 12,
  minGroupSize: 3,
  maxGroupSize: 60,
} as const;

interface UnionFind {
  find: (a: number) => number;
  union: (a: number, b: number) => void;
}

function createUnionFind(size: number): UnionFind {
  const parent = Array.from({ length: size }, (_, i) => i);
  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]];
      root = parent[root];
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent[rb] = ra;
    }
  };
  return { find, union };
}

/**
 * 由「每张图的近邻表」推出分组（互近邻 + 连通分量 + 递归细分）。
 *
 * @param knn 每张图 → 它的近邻（相似度降序即可，顺序不影响结果）
 * @returns 组数组（已按组大小降序），每组是 photoId 数组
 */
export function buildMutualKnnGroups(
  knn: ReadonlyMap<number, readonly KnnEntry[]>,
  options: {
    similarityThreshold?: number;
    minGroupSize?: number;
    maxGroupSize?: number;
    /** 递归细分的最大深度（防御性上限）。 */
    maxDepth?: number;
  } = {}
): number[][] {
  const baseThreshold =
    options.similarityThreshold ?? CLUSTER_DEFAULTS.similarityThreshold;
  const minGroupSize = options.minGroupSize ?? CLUSTER_DEFAULTS.minGroupSize;
  const maxGroupSize = options.maxGroupSize ?? CLUSTER_DEFAULTS.maxGroupSize;
  const maxDepth = options.maxDepth ?? 6;

  const ids = [...knn.keys()];
  const indexOf = new Map<number, number>();
  ids.forEach((id, i) => indexOf.set(id, i));

  /** 在给定阈值下，求所有照片的连通分量。 */
  function componentsAt(
    threshold: number,
    restrictTo?: ReadonlySet<number>
  ): number[][] {
    const uf = createUnionFind(ids.length);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (restrictTo && !restrictTo.has(id)) {
        continue;
      }
      const own = knn.get(id) ?? [];
      // 自己在这个阈值下的邻居集合（O(K)）
      const ownSet = new Set<number>();
      for (const entry of own) {
        if (entry.similarity >= threshold) {
          ownSet.add(entry.id);
        }
      }
      for (const entry of own) {
        if (entry.similarity < threshold || !ownSet.has(entry.id)) {
          continue;
        }
        const j = indexOf.get(entry.id);
        if (j === undefined) {
          continue;
        }
        if (restrictTo && !restrictTo.has(entry.id)) {
          continue;
        }
        // 互近邻：对方的邻居里也要有我（同样满足阈值）
        const back = knn.get(entry.id) ?? [];
        let mutual = false;
        for (const b of back) {
          if (b.id === id && b.similarity >= threshold) {
            mutual = true;
            break;
          }
        }
        if (!mutual) {
          continue;
        }
        uf.union(i, j);
      }
    }

    const buckets = new Map<number, number[]>();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (restrictTo && !restrictTo.has(id)) {
        continue;
      }
      const root = uf.find(i);
      const list = buckets.get(root);
      if (list) {
        list.push(id);
      } else {
        buckets.set(root, [id]);
      }
    }
    return [...buckets.values()];
  }

  function split(
    members: readonly number[],
    threshold: number,
    depth: number
  ): number[][] {
    if (members.length <= maxGroupSize) {
      return members.length >= minGroupSize ? [[...members]] : [];
    }
    if (depth >= maxDepth || threshold >= 0.995) {
      return members.length >= minGroupSize ? [[...members]] : [];
    }
    const restrict = new Set(members);
    const next = Math.min(0.995, threshold + 0.02);
    const parts = componentsAt(next, restrict);
    // 没分动（还是一个整体）→ 继续抬高阈值
    if (parts.length <= 1) {
      return split(members, next, depth + 1);
    }
    const out: number[][] = [];
    for (const part of parts) {
      out.push(...split(part, next, depth + 1));
    }
    return out;
  }

  const initial = componentsAt(baseThreshold);
  const groups: number[][] = [];
  for (const component of initial) {
    groups.push(...split(component, baseThreshold, 0));
  }
  return groups.sort((a, b) => b.length - a.length);
}

/** 取「无角色标签、且已经有 CCIP 特征」的照片 id。 */
async function listUnnamedCandidates(
  explicitPhotoIds?: number[],
  limit?: number
): Promise<number[]> {
  const db = getDatabase();
  const characterIds = characterTagIdsFromRows(loadTagRows());
  if (characterIds.length === 0) {
    return [];
  }

  // 已打角色标签的图
  const named = new Set<number>();
  const TAG_CHUNK = 500;
  for (let i = 0; i < characterIds.length; i += TAG_CHUNK) {
    const slice = characterIds.slice(i, i + TAG_CHUNK);
    const rows = db
      .select({ photoId: photoTags.photoId })
      .from(photoTags)
      .where(inArray(photoTags.tagId, slice))
      .all();
    for (const row of rows) {
      if (row.photoId != null) {
        named.add(row.photoId);
      }
    }
  }

  // 有 CCIP 特征的图
  const withFeatures = new Set(await listCcipVectorIds());
  if (withFeatures.size === 0) {
    return [];
  }

  let candidates: number[];
  if (explicitPhotoIds && explicitPhotoIds.length > 0) {
    candidates = explicitPhotoIds.filter((id) => withFeatures.has(id));
  } else {
    // ⚠️ 不能写成 `IN (7.7 万个 id)` —— SQLite 的变量数有上限，会直接报错。
    // 这里查全库未删除的照片 id，再在内存里与特征集合求交集（7.7 万个整数，开销很小）。
    const allIds = db
      .select({ id: photos.id })
      .from(photos)
      .where(isNull(photos.deletedAt))
      .all()
      .map((row) => row.id);
    candidates = allIds.filter(
      (id) => withFeatures.has(id) && !named.has(id)
    );
  }

  candidates.sort((a, b) => a - b);
  if (limit && limit > 0 && candidates.length > limit) {
    return candidates.slice(0, limit);
  }
  return candidates;
}

/** 组内两两相似度均值（超过一定规模则抽样，避免 O(n²) 爆炸）。 */
function estimateMeanSimilarity(
  members: readonly number[],
  vectors: ReadonlyMap<number, number[]>
): number {
  const MAX_PAIRS = 4000;
  let total = 0;
  let count = 0;
  const n = members.length;
  for (let i = 0; i < n && count < MAX_PAIRS; i++) {
    for (let j = i + 1; j < n && count < MAX_PAIRS; j++) {
      const a = vectors.get(members[i]);
      const b = vectors.get(members[j]);
      if (!a || !b) {
        continue;
      }
      let dot = 0;
      const len = Math.min(a.length, b.length);
      for (let k = 0; k < len; k++) {
        dot += a[k] * b[k];
      }
      total += dot;
      count += 1;
    }
  }
  return count > 0 ? total / count : 0;
}

/**
 * 找出「无角色标签」的图里彼此像一个角色的组。
 *
 * @throws 当 CCIP 特征一条都没有时抛出（提示先生成特征）。
 */
export async function clusterCharacterCandidates(
  options: ClusterOptions = {}
): Promise<ClusterResult> {
  const startedAt = Date.now();
  const threshold =
    options.similarityThreshold ?? CLUSTER_DEFAULTS.similarityThreshold;
  const neighbors = options.neighbors ?? CLUSTER_DEFAULTS.neighbors;
  const minGroupSize = options.minGroupSize ?? CLUSTER_DEFAULTS.minGroupSize;
  const maxGroupSize = options.maxGroupSize ?? CLUSTER_DEFAULTS.maxGroupSize;

  // 实时进度（界面轮询）—— 全库要几分钟，不能是黑箱
  liveClusterProgress = {
    phase: "collect",
    done: 0,
    total: 0,
    startedAt: Date.now(),
  };
  const reportProgress = (progress: ClusterProgress): void => {
    if (liveClusterProgress) {
      liveClusterProgress.phase = progress.phase;
      liveClusterProgress.done = progress.done;
      liveClusterProgress.total = progress.total;
    }
    options.onProgress?.(progress);
  };
  const clearProgress = (): void => {
    liveClusterProgress = null;
  };

  reportProgress({ phase: "collect", done: 0, total: 0 });
  const candidates = await listUnnamedCandidates(options.photoIds, options.limit);

  if (candidates.length === 0) {
    clearProgress();
    return {
      groups: [],
      candidates: 0,
      embedded: 0,
      cancelled: false,
      elapsedMs: Date.now() - startedAt,
      threshold,
    };
  }

  // 逐张取向量（分批，控制内存峰值）并做 ANN
  const knn = new Map<number, KnnEntry[]>();
  const vectorsForStats = new Map<number, number[]>();
  const VECTOR_CHUNK = 2000;
  let done = 0;
  let cancelled = false;

  for (let i = 0; i < candidates.length; i += VECTOR_CHUNK) {
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }
    const slice = candidates.slice(i, i + VECTOR_CHUNK);
    const vectors = await getCcipVectors(slice);
    for (const [photoId, vector] of vectors) {
      vectorsForStats.set(photoId, vector);
    }
    for (const id of slice) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      const vector = vectors.get(id);
      if (!vector) {
        done += 1;
        continue;
      }
      const hits = await searchByCcipVector(vector, neighbors + 1);
      if (!hits) {
        // 向量库不可用 → 不再继续白跑
        cancelled = true;
        break;
      }
      knn.set(
        id,
        hits
          .filter((hit) => hit.photoId !== id && hit.similarity >= threshold)
          .slice(0, neighbors)
          .map((hit) => ({ id: hit.photoId, similarity: hit.similarity }))
      );
      done += 1;
      if (done % 200 === 0 || done === candidates.length) {
        reportProgress({
          phase: "search",
          done,
          total: candidates.length,
        });
      }
    }
  }

  reportProgress({ phase: "group", done: 0, total: 1 });
  const rawGroups = buildMutualKnnGroups(knn, {
    similarityThreshold: threshold,
    minGroupSize,
    maxGroupSize,
  });

  const groups: CharacterGroup[] = rawGroups
    .map((members) => {
      const sorted = [...members].sort((a, b) => a - b);
      const meanSimilarity = estimateMeanSimilarity(sorted, vectorsForStats);
      // 代表图：与其它成员平均相似度最高的一张（用已有向量算，规模可控）
      let representativeId = sorted[0];
      let bestAvg = -1;
      for (const id of sorted) {
        const a = vectorsForStats.get(id);
        if (!a) {
          continue;
        }
        let sum = 0;
        let n = 0;
        for (const other of sorted) {
          if (other === id) {
            continue;
          }
          const b = vectorsForStats.get(other);
          if (!b) {
            continue;
          }
          let dot = 0;
          const len = Math.min(a.length, b.length);
          for (let k = 0; k < len; k++) {
            dot += a[k] * b[k];
          }
          sum += dot;
          n += 1;
        }
        const avgSim = n > 0 ? sum / n : 0;
        if (avgSim > bestAvg) {
          bestAvg = avgSim;
          representativeId = id;
        }
      }
      return {
        photoIds: sorted,
        size: sorted.length,
        meanSimilarity,
        representativeId,
      };
    })
    .sort((a, b) => b.size - a.size || b.meanSimilarity - a.meanSimilarity);

  reportProgress({ phase: "group", done: 1, total: 1 });
  clearProgress();

  return {
    groups,
    candidates: candidates.length,
    embedded: knn.size,
    cancelled,
    elapsedMs: Date.now() - startedAt,
    threshold,
  };
}