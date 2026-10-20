import { describe, expect, it } from "vitest";
import {
  buildMutualKnnGroups,
  type KnnEntry,
} from "@/services/character-cluster";

/** 用紧凑写法造近邻表：{ 1: [[2, 0.9], [3, 0.9]] } */
function knnOf(
  input: Record<number, Array<[number, number]>>
): Map<number, KnnEntry[]> {
  const map = new Map<number, KnnEntry[]>();
  for (const [key, list] of Object.entries(input)) {
    map.set(
      Number(key),
      list.map(([id, similarity]) => ({ id, similarity }))
    );
  }
  return map;
}

function normalize(groups: number[][]): string[] {
  return groups
    .map((group) => [...group].sort((a, b) => a - b).join(","))
    .sort();
}

describe("buildMutualKnnGroups", () => {
  it("把两个互不相干的簇分开（互近邻成组）", () => {
    const knn = knnOf({
      1: [
        [2, 0.95],
        [3, 0.95],
      ],
      2: [
        [1, 0.95],
        [3, 0.95],
      ],
      3: [
        [1, 0.95],
        [2, 0.95],
      ],
      4: [
        [5, 0.95],
        [6, 0.95],
      ],
      5: [
        [4, 0.95],
        [6, 0.95],
      ],
      6: [
        [4, 0.95],
        [5, 0.95],
      ],
    });

    const groups = buildMutualKnnGroups(knn, { minGroupSize: 3 });
    expect(normalize(groups)).toEqual(["1,2,3", "4,5,6"]);
  });

  it("单向相似不连边（防止把单方面像的图误并进来）", () => {
    // 1 觉得 2 很像，但 2 的邻居里没有 1 → 1 不该并进 {2,3}
    const knn = knnOf({
      1: [[2, 0.99]],
      2: [
        [3, 0.99],
        [1, 0.2], // 低于阈值：不算"互相像"
      ],
      3: [[2, 0.99]],
    });

    const groups = buildMutualKnnGroups(knn, { minGroupSize: 2 });
    expect(normalize(groups)).toEqual(["2,3"]);
  });

  it("丢掉小于最小规模的组", () => {
    const knn = knnOf({
      1: [[2, 0.95]],
      2: [[1, 0.95]],
      3: [
        [4, 0.95],
        [5, 0.95],
      ],
      4: [
        [3, 0.95],
        [5, 0.95],
      ],
      5: [
        [3, 0.95],
        [4, 0.95],
      ],
    });

    const groups = buildMutualKnnGroups(knn, { minGroupSize: 3 });
    expect(normalize(groups)).toEqual(["3,4,5"]);
  });

  it("太大且内部松散的组会提高阈值递归细分", () => {
    // 6 张图两两都「像」（0.91），但其实是两个角色：组内 0.95、跨组 0.91
    const strong = 0.95;
    const weak = 0.91;
    const knn = knnOf({
      1: [
        [2, strong],
        [3, strong],
        [4, weak],
        [5, weak],
        [6, weak],
      ],
      2: [
        [1, strong],
        [3, strong],
        [4, weak],
        [5, weak],
        [6, weak],
      ],
      3: [
        [1, strong],
        [2, strong],
        [4, weak],
        [5, weak],
        [6, weak],
      ],
      4: [
        [5, strong],
        [6, strong],
        [1, weak],
        [2, weak],
        [3, weak],
      ],
      5: [
        [4, strong],
        [6, strong],
        [1, weak],
        [2, weak],
        [3, weak],
      ],
      6: [
        [4, strong],
        [5, strong],
        [1, weak],
        [2, weak],
        [3, weak],
      ],
    });

    const groups = buildMutualKnnGroups(knn, {
      similarityThreshold: 0.9,
      minGroupSize: 2,
      maxGroupSize: 4,
    });
    expect(normalize(groups)).toEqual(["1,2,3", "4,5,6"]);
  });

  it("低于阈值的边被忽略", () => {
    const knn = knnOf({
      1: [[2, 0.7]],
      2: [[1, 0.7]],
      3: [[4, 0.7]],
      4: [[3, 0.7]],
    });

    const groups = buildMutualKnnGroups(knn, {
      similarityThreshold: 0.9,
      minGroupSize: 2,
    });
    expect(groups).toEqual([]);
  });

  it("空输入返回空", () => {
    expect(buildMutualKnnGroups(new Map(), { minGroupSize: 2 })).toEqual([]);
  });
});