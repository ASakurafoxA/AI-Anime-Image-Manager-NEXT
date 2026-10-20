import { describe, expect, it } from "vitest";
import {
  buildCharacterCentroids,
  collectDescendantTagIds,
  mergeCandidateHits,
  type SeedPhoto,
} from "@/services/character-suggest";

function v(...values: number[]): number[] {
  return values;
}

describe("collectDescendantTagIds", () => {
  const rows = [
    { id: 1, name: "通用", parentId: null },
    { id: 2, name: "角色", parentId: null },
    { id: 10, name: "白上吹雪", parentId: 2 },
    { id: 11, name: "甘城夏希", parentId: 2 },
    { id: 12, name: "某作品的子分类", parentId: 10 },
    { id: 20, name: "某画风", parentId: 1 },
  ];

  it("finds the whole subtree under 角色 and nothing else", () => {
    const { ids, rootId, nameById } = collectDescendantTagIds(rows);
    expect(rootId).toBe(2);
    expect(ids.sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect(nameById.get(12)).toBe("某作品的子分类");
  });

  it("returns nothing when the 角色 root tag is missing", () => {
    const { ids, rootId } = collectDescendantTagIds([
      { id: 1, name: "通用", parentId: null },
    ]);
    expect(rootId).toBeNull();
    expect(ids).toEqual([]);
  });
});

describe("buildCharacterCentroids", () => {
  const seeds: SeedPhoto[] = [
    { photoId: 1, tagId: 10, tagName: "A" },
    { photoId: 2, tagId: 10, tagName: "A" },
    { photoId: 3, tagId: 10, tagName: "A" },
    { photoId: 4, tagId: 11, tagName: "B" },
    { photoId: 5, tagId: 11, tagName: "B" },
  ];
  const vectors = new Map<number, number[]>([
    [1, v(1, 0)],
    [2, v(1, 0)],
    [3, v(1, 0)],
    [4, v(0, 1)],
    [5, v(0, 1)],
  ]);

  it("keeps only characters with enough seeds and normalizes the centroid", () => {
    const centroids = buildCharacterCentroids(seeds, vectors, { minSeedCount: 3 });
    expect(centroids).toHaveLength(1);
    expect(centroids[0].tagId).toBe(10);
    expect(centroids[0].seedCount).toBe(3);
    expect(Math.hypot(...centroids[0].centroid)).toBeCloseTo(1, 6);
    expect(centroids[0].centroid[0]).toBeCloseTo(1, 6);
  });

  it("skips seed photos without a vector", () => {
    const centroids = buildCharacterCentroids(
      [...seeds, { photoId: 99, tagId: 10, tagName: "A" }],
      vectors,
      { minSeedCount: 3 }
    );
    expect(centroids[0].seedCount).toBe(3);
  });
});

describe("mergeCandidateHits", () => {
  it("assigns each photo to its best-matching character", () => {
    const proposals = mergeCandidateHits(
      [
        {
          tagId: 10,
          tagName: "A",
          seedCount: 5,
          hits: [
            { photoId: 1, similarity: 0.99 },
            { photoId: 2, similarity: 0.96 },
          ],
        },
        {
          tagId: 11,
          tagName: "B",
          seedCount: 5,
          hits: [{ photoId: 2, similarity: 0.9 }],
        },
      ],
      { minSimilarity: 0.95 }
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].tagName).toBe("A");
    expect(proposals[0].photoIds).toEqual([1, 2]);
  });

  it("drops photos where two characters are equally close (ambiguous)", () => {
    const proposals = mergeCandidateHits(
      [
        { tagId: 10, tagName: "A", seedCount: 5, hits: [{ photoId: 1, similarity: 0.96 }] },
        { tagId: 11, tagName: "B", seedCount: 5, hits: [{ photoId: 1, similarity: 0.955 }] },
      ],
      { minSimilarity: 0.95, minMargin: 0.01 }
    );
    expect(proposals).toEqual([]);
  });

  it("drops hits below the similarity threshold", () => {
    const proposals = mergeCandidateHits(
      [
        { tagId: 10, tagName: "A", seedCount: 5, hits: [{ photoId: 1, similarity: 0.9 }] },
        { tagId: 10, tagName: "A", seedCount: 5, hits: [{ photoId: 2, similarity: 0.8 }] },
      ],
      { minSimilarity: 0.95, minPhotos: 1 }
    );
    expect(proposals).toEqual([]);
  });

  it("requires minPhotos members and sorts by size", () => {
    const proposals = mergeCandidateHits(
      [
        {
          tagId: 10,
          tagName: "A",
          seedCount: 5,
          hits: [{ photoId: 1, similarity: 0.99 }],
        },
        {
          tagId: 11,
          tagName: "B",
          seedCount: 5,
          hits: [
            { photoId: 2, similarity: 0.99 },
            { photoId: 3, similarity: 0.98 },
            { photoId: 4, similarity: 0.97 },
          ],
        },
      ],
      { minSimilarity: 0.95, minPhotos: 2 }
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].tagName).toBe("B");
    expect(proposals[0].minSimilarity).toBeCloseTo(0.97, 6);
    expect(proposals[0].maxSimilarity).toBeCloseTo(0.99, 6);
  });

  it("caps how many photos a single character can claim", () => {
    const proposals = mergeCandidateHits(
      [
        {
          tagId: 10,
          tagName: "A",
          seedCount: 5,
          hits: [
            { photoId: 1, similarity: 0.99 },
            { photoId: 2, similarity: 0.99 },
            { photoId: 3, similarity: 0.99 },
          ],
        },
      ],
      { minSimilarity: 0.95, minPhotos: 1, maxPhotosPerCharacter: 2 }
    );
    expect(proposals[0].photoIds).toHaveLength(2);
  });

  it("returns nothing without candidates", () => {
    expect(mergeCandidateHits([])).toEqual([]);
  });
});
