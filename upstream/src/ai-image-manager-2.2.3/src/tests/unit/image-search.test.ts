import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const computePHash = vi.fn();
const queryPhashIndex = vi.fn();
const aiSearchByImage = vi.fn();

vi.mock("@/services/phash", () => ({
  computePHash: (...args: unknown[]) => computePHash(...args),
}));
vi.mock("@/services/phash-index", () => ({
  queryPhashIndex: (...args: unknown[]) => queryPhashIndex(...args),
}));
vi.mock("@/services/ai", () => ({
  searchByImage: (...args: unknown[]) => aiSearchByImage(...args),
}));

import {
  EXACT_COPY_PHASH_THRESHOLD,
  searchByImageWithPhash,
} from "@/services/image-search";

let tmpFile: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpFile = path.join(os.tmpdir(), `image-search-${crypto.randomUUID()}.png`);
  fs.writeFileSync(tmpFile, Buffer.from("not-a-real-image"));
  computePHash.mockResolvedValue("0123456789abcdef");
  queryPhashIndex.mockReturnValue([]);
  aiSearchByImage.mockResolvedValue([]);
});

afterEach(() => {
  fs.rmSync(tmpFile, { force: true });
});

describe("searchByImageWithPhash", () => {
  it("asks the pHash index with the strict threshold", async () => {
    await searchByImageWithPhash(tmpFile, 20);
    expect(queryPhashIndex).toHaveBeenCalledWith(
      "0123456789abcdef",
      EXACT_COPY_PHASH_THRESHOLD
    );
    expect(EXACT_COPY_PHASH_THRESHOLD).toBe(4);
  });

  it("指纹命中时不再跑语义检索（这是「搜图好慢」的根因：原来两条都跑）", async () => {
    queryPhashIndex.mockReturnValue([
      { photoId: 7, distance: 0 },
      { photoId: 9, distance: 3 },
    ]);
    aiSearchByImage.mockResolvedValue([
      { photoId: 9, similarity: 0.98 },
      { photoId: 11, similarity: 0.9 },
    ]);

    const hits = await searchByImageWithPhash(tmpFile, 20);

    // 只返回指纹命中的（秒答）；语义那条**根本不该被调用** ✓
    expect(hits.map((h) => h.photoId)).toEqual([7, 9]);
    expect(aiSearchByImage).not.toHaveBeenCalled();
    expect(hits[0]).toMatchObject({
      isExactCopy: true,
      phashDistance: 0,
      similarity: 1,
    });
    expect(hits[1]).toMatchObject({ isExactCopy: true, phashDistance: 3 });
  });

  it("指纹没命中时才走语义，并保持原样返回", async () => {
    queryPhashIndex.mockReturnValue([]);
    aiSearchByImage.mockResolvedValue([
      { photoId: 9, similarity: 0.98 },
      { photoId: 11, similarity: 0.9 },
    ]);

    const hits = await searchByImageWithPhash(tmpFile, 20);

    expect(hits.map((h) => h.photoId)).toEqual([9, 11]);
    expect(hits[0]).toMatchObject({
      isExactCopy: false,
      phashDistance: null,
      similarity: 0.98,
    });
  });

  it("still answers with exact copies when the AI search fails", async () => {
    queryPhashIndex.mockReturnValue([{ photoId: 1, distance: 0 }]);
    aiSearchByImage.mockRejectedValue(new Error("model not ready"));

    const hits = await searchByImageWithPhash(tmpFile, 20);
    expect(hits).toHaveLength(1);
    expect(hits[0].photoId).toBe(1);
  });

  it("propagates the AI failure when there are no exact copies either", async () => {
    aiSearchByImage.mockRejectedValue(new Error("model not ready"));
    await expect(searchByImageWithPhash(tmpFile, 20)).rejects.toThrow(
      "model not ready"
    );
  });

  it("falls back to AI only when the image cannot be hashed", async () => {
    computePHash.mockResolvedValue(null);
    aiSearchByImage.mockResolvedValue([{ photoId: 3, similarity: 0.8 }]);

    const hits = await searchByImageWithPhash(tmpFile, 20);
    expect(queryPhashIndex).not.toHaveBeenCalled();
    expect(hits.map((h) => h.photoId)).toEqual([3]);
  });

  it("falls back to AI only when the pHash index throws", async () => {
    queryPhashIndex.mockImplementation(() => {
      throw new Error("index unavailable");
    });
    aiSearchByImage.mockResolvedValue([{ photoId: 4, similarity: 0.7 }]);

    const hits = await searchByImageWithPhash(tmpFile, 20);
    expect(hits.map((h) => h.photoId)).toEqual([4]);
  });
});
