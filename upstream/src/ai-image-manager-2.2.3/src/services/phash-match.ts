/**
 * pHash 匹配的纯逻辑（无数据库依赖，可被脚本与单测直接调用）。
 *
 * 与 `phash-index.ts` 的分工：
 *   - 本模块：给定一组指纹，怎么比对、怎么聚类（纯函数）
 *   - phash-index.ts：从数据库加载指纹 + 缓存索引 + 面向功能的封装
 *
 * 为什么这样拆：全库规模验证需要一个不依赖 Electron/DB 单例的入口，
 * 而单测也应该只依赖纯函数。
 */
import { hammingDistance } from "@/services/bk-tree";

export interface PhashEntry {
  photoId: number;
  phash: string;
}

export interface PhashMatch {
  distance: number;
  photoId: number;
}

/** 排序：距离小的在前，同距离按 photoId 保证结果稳定可复现。 */
export function byDistanceThenId(a: PhashMatch, b: PhashMatch): number {
  return a.distance - b.distance || a.photoId - b.photoId;
}

/**
 * 把 16 个 nibble 切成 threshold+1 段（全部按 nibble 对齐）。
 *
 * 依据鸽巢原理：两条指纹若总距离 <= threshold，则这 threshold+1 段里
 * **至少有一段完全相同**（否则每段都至少差 1 位，总距离就超过 threshold）。
 * 因此用「段号+段值」做桶，候选对一定落在同一个桶里，**不会漏**。
 *
 * ⚠️ 踩过的坑：不能只切成固定的 4 段。两条指纹若在每一段各差 1 位，
 * 总距离只有 4，却可能一段都不相同 —— 那样就会漏掉真重复。
 *
 * 实测（本机、77,296 张）：分桶做全库聚类约 12 秒；换成 BK 树逐条查询会
 * 退化到 20 分钟以上（库里重复极多，阈值查询会遍历大量分支）。
 * BK 树仍适合「以图搜图」那种单点查询（毫秒级）。
 */
export function chunkPlan(threshold: number): Array<[number, number]> {
  const chunks = Math.max(1, Math.floor(threshold) + 1);
  const total = 16; // 16 个 nibble = 64 位
  const plan: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < chunks; i++) {
    const remainingChunks = chunks - i;
    const remainingNibbles = total - start;
    const size = Math.max(1, Math.floor(remainingNibbles / remainingChunks));
    plan.push([start, Math.min(total, start + size)]);
    start += size;
  }
  return plan.filter(([from, to]) => from < to && to <= total);
}

/**
 * 在一组指纹里找出与目标指纹距离 <= threshold 的条目。
 * @param limit 最多返回几条（0 = 不限）
 */
export function queryFromEntries(
  entries: readonly PhashEntry[],
  phash: string,
  threshold: number,
  limit = 0
): PhashMatch[] {
  const matches: PhashMatch[] = [];
  for (const entry of entries) {
    if (entry.phash === phash) {
      matches.push({ photoId: entry.photoId, distance: 0 });
      continue;
    }
    const distance = hammingDistance(entry.phash, phash);
    if (distance <= threshold) {
      matches.push({ photoId: entry.photoId, distance });
    }
  }
  matches.sort(byDistanceThenId);
  return limit > 0 ? matches.slice(0, limit) : matches;
}

/**
 * 找出所有距离 <= threshold 的配对（查重下游要的是 pair，而不是簇）。
 *
 * 与 `buildGroupsFromEntries` 用同一套分桶。同一对可能出现在多个桶里
 * （共享多段），这里用 Set 去重；并且**必须受 `maxPairs` 上限保护** ——
 * 高阈值时候选数量会爆炸（这正是原实现改用 max(阈值,16) 后永远跑不完的原因）。
 *
 * @param maxPairs 上限（0 = 不限）。达到上限即停止并返回已找到的部分。
 */
export function collectPairsFromEntries(
  entries: readonly PhashEntry[],
  threshold: number,
  maxPairs = 0
): Array<{ distance: number; photoAId: number; photoBId: number }> {
  const n = entries.length;
  if (n === 0) {
    return [];
  }
  const plan = chunkPlan(threshold);
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const phash = entries[i].phash;
    for (let c = 0; c < plan.length; c++) {
      const [from, to] = plan[c];
      const key = `${c}:${phash.slice(from, to)}`;
      const list = buckets.get(key);
      if (list) {
        list.push(i);
      } else {
        buckets.set(key, [i]);
      }
    }
  }

  const out: Array<{ distance: number; photoAId: number; photoBId: number }> =
    [];
  const seen = new Set<number>();
  for (const list of buckets.values()) {
    if (list.length < 2) {
      continue;
    }
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a];
        const j = list[b];
        const pairKey = i * n + j;
        if (seen.has(pairKey)) {
          continue;
        }
        const distance = hammingDistance(entries[i].phash, entries[j].phash);
        if (distance > threshold) {
          continue;
        }
        seen.add(pairKey);
        const idA = entries[i].photoId;
        const idB = entries[j].photoId;
        out.push({
          distance,
          photoAId: Math.min(idA, idB),
          photoBId: Math.max(idA, idB),
        });
        if (maxPairs > 0 && out.length >= maxPairs) {
          return out;
        }
      }
    }
  }
  return out;
}

/**
 * 把互相在阈值内的图并成簇（连通分量 = 单连接聚类），与现有查重语义一致。
 * @returns 只返回成员数 >= minSize 的簇，按簇大小降序
 */
export function buildGroupsFromEntries(
  entries: readonly PhashEntry[],
  threshold: number,
  minSize = 2
): number[][] {
  const n = entries.length;
  if (n === 0) {
    return [];
  }
  const plan = chunkPlan(threshold);

  const buckets = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const phash = entries[i].phash;
    for (let c = 0; c < plan.length; c++) {
      const [from, to] = plan[c];
      const key = `${c}:${phash.slice(from, to)}`;
      const list = buckets.get(key);
      if (list) {
        list.push(i);
      } else {
        buckets.set(key, [i]);
      }
    }
  }

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    parent[i] = i;
  }
  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) {
      root = parent[root];
    }
    let current = a;
    while (parent[current] !== root) {
      const next = parent[current];
      parent[current] = root;
      current = next;
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

  // ⚠️ 不要用全局 Set 去重「候选对」：阈值 8/12 时候选对数量会超过 V8 的
  // Set 上限（约 1600 万）并直接抛 RangeError。而 union 是幂等的，
  // 重复计算距离只是浪费一点时间，不会出错。
  for (const list of buckets.values()) {
    if (list.length < 2) {
      continue;
    }
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a];
        const j = list[b];
        if (hammingDistance(entries[i].phash, entries[j].phash) <= threshold) {
          union(i, j);
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) {
      list.push(entries[i].photoId);
    } else {
      groups.set(root, [entries[i].photoId]);
    }
  }
  return [...groups.values()]
    .filter((members) => members.length >= minSize)
    .map((members) => members.sort((a, b) => a - b))
    .sort((a, b) => b.length - a.length || a[0] - b[0]);
}
