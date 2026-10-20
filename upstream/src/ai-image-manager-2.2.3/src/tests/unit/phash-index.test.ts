import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { hammingDistance } from "@/services/bk-tree";
import {
  buildGroupsFromEntries,
  chunkPlan,
  queryFromEntries,
} from "@/services/phash-match";
import { computePHash, phashSimilarity } from "@/services/phash";

describe("chunkPlan", () => {
  it("produces threshold+1 nibble-aligned chunks covering all 64 bits", () => {
    for (const threshold of [2, 4, 8, 12]) {
      const plan = chunkPlan(threshold);
      expect(plan).toHaveLength(threshold + 1);
      expect(plan[0][0]).toBe(0);
      expect(plan[plan.length - 1][1]).toBe(16);
      // 连续、不重叠、不越界
      for (let i = 1; i < plan.length; i++) {
        expect(plan[i][0]).toBe(plan[i - 1][1]);
        expect(plan[i][1]).toBeGreaterThan(plan[i][0]);
      }
    }
  });
});

/** Smooth gradient — a stand-in for photographic content. */
async function gradientPng(size = 64): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 3;
      raw[o] = Math.round((x / (size - 1)) * 255);
      raw[o + 1] = Math.round((y / (size - 1)) * 255);
      raw[o + 2] = 128;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();
}

/** Hard checkerboard — maximally different low-frequency structure. */
async function checkerPng(size = 64): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 3;
      const on = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 255 : 0;
      raw[o] = on;
      raw[o + 1] = on;
      raw[o + 2] = on;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();
}

/**
 * Large colour blocks plus a circle — structurally much closer to a real
 * illustration than a smooth ramp. 实测：这种结构在不同分辨率/JPEG 压缩下
 * 指纹距离为 0，而纯渐变会飘到 6~12（见 scripts/measure-phash-robustness.mjs）。
 */
async function illustrationPng(size = 128): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 3);
  const cx = size * 0.35;
  const cy = size * 0.4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 3;
      const inCircle = (x - cx) ** 2 + (y - cy) ** 2 < (size * 0.22) ** 2;
      const band = Math.floor((y / size) * 4);
      const v = inCircle ? 40 : band % 2 === 0 ? 220 : 90;
      raw[o] = v;
      raw[o + 1] = v;
      raw[o + 2] = v;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();
}

describe("computePHash", () => {
  it("is deterministic for the same input", async () => {
    const png = await gradientPng();
    const a = await computePHash(png);
    const b = await computePHash(png);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
  });

  it("keeps the same fingerprint when the only difference is resolution", async () => {
    // 这正是用户的真实场景：同一张内容、分辨率不一样 -> 必须识别为同一张
    const png = await illustrationPng(128);
    const base = await computePHash(png);
    expect(base).not.toBeNull();
    for (const size of [48, 64, 96, 256, 400]) {
      const resized = await sharp(png).resize(size, size).png().toBuffer();
      const hash = await computePHash(resized);
      expect(hammingDistance(base as string, hash as string)).toBeLessThanOrEqual(4);
    }
  });

  it("survives JPEG re-encoding", async () => {
    const png = await illustrationPng(128);
    const base = (await computePHash(png)) as string;
    const jpeg = await sharp(png).jpeg({ quality: 70 }).toBuffer();
    const hash = await computePHash(jpeg);
    expect(hammingDistance(base, hash as string)).toBeLessThanOrEqual(4);
  });

  it("separates visually different content", async () => {
    const base = await computePHash(await gradientPng());
    const other = await computePHash(await checkerPng());
    expect(base).not.toBeNull();
    expect(other).not.toBeNull();
    expect(hammingDistance(base as string, other as string)).toBeGreaterThan(12);
  });

  it("returns null for undecodable input", async () => {
    expect(await computePHash(Buffer.from("definitely not an image"))).toBeNull();
  });
});

describe("phashSimilarity", () => {
  it("maps distance 0 to 100% and grows monotonically downward", () => {
    expect(phashSimilarity(0)).toBe(1);
    expect(phashSimilarity(8)).toBeCloseTo(0.875, 6);
    expect(phashSimilarity(64)).toBe(0);
    expect(phashSimilarity(-1)).toBe(0);
  });
});

describe("queryFromEntries", () => {
  const entries = [
    { photoId: 10, phash: "0000000000000000" },
    { photoId: 11, phash: "0000000000000001" },
    { photoId: 12, phash: "0000000000000003" },
    { photoId: 13, phash: "ffffffffffffffff" },
  ];

  it("finds exact and near matches, sorted by distance", () => {
    const hits = queryFromEntries(entries, "0000000000000000", 4);
    expect(hits.map((h) => h.photoId)).toEqual([10, 11, 12]);
    expect(hits.map((h) => h.distance)).toEqual([0, 1, 2]);
  });

  it("respects the distance threshold", () => {
    expect(queryFromEntries(entries, "0000000000000000", 0)).toHaveLength(1);
    expect(queryFromEntries(entries, "0000000000000000", 1)).toHaveLength(2);
  });

  it("respects the limit and stays deterministic on ties", () => {
    const hits = queryFromEntries(entries, "0000000000000000", 4, 2);
    expect(hits.map((h) => h.photoId)).toEqual([10, 11]);
  });

  it("returns nothing when the library is empty", () => {
    expect(queryFromEntries([], "0000000000000000", 4)).toEqual([]);
  });
});

describe("buildGroupsFromEntries", () => {
  it("chains transitively and drops groups below minSize", () => {
    const entries = [
      { photoId: 1, phash: "0000000000000000" },
      { photoId: 2, phash: "0000000000000003" }, // 2 bits from 1
      { photoId: 3, phash: "0000000000000007" }, // 1 bit from 2, 3 from 1
      { photoId: 4, phash: "ffffffffffffffff" }, // far from everything
      { photoId: 5, phash: "fffffffffffffffe" }, // 1 bit from 4
    ];
    const groups = buildGroupsFromEntries(entries, 4, 2);
    expect(groups).toHaveLength(2);
    // 最大的簇在前
    expect(groups[0]).toEqual([1, 2, 3]);
    expect(groups[1]).toEqual([4, 5]);
  });

  it("respects minSize", () => {
    const entries = [
      { photoId: 1, phash: "0000000000000000" },
      { photoId: 2, phash: "ffffffffffffffff" },
    ];
    expect(buildGroupsFromEntries(entries, 4, 2)).toEqual([]);
  });

  it("returns nothing for an empty library", () => {
    expect(buildGroupsFromEntries([], 4)).toEqual([]);
  });

  it("does not merge pairs above the threshold", () => {
    const entries = [
      { photoId: 1, phash: "0000000000000000" },
      { photoId: 2, phash: "00000000000000ff" }, // 8 bits apart
    ];
    expect(buildGroupsFromEntries(entries, 4, 2)).toEqual([]);
    expect(buildGroupsFromEntries(entries, 8, 2)).toEqual([[1, 2]]);
  });

  it("still groups pairs that differ in every 4-bit segment (regression)", () => {
    // 距离只有 4，但四段各差 1 位 —— 任何"必须有一段完全相同"的剪枝都会漏掉它
    const entries = [
      { photoId: 1, phash: "0000000000000000" },
      { photoId: 2, phash: "0001000100010001" },
    ];
    expect(hammingDistance(entries[0].phash, entries[1].phash)).toBe(4);
    expect(buildGroupsFromEntries(entries, 4, 2)).toEqual([[1, 2]]);
  });

  it("groups a large chain that spans many segments", () => {
    // 12 张图，每相邻两张差 2 位，且分散在不同段
    const entries = Array.from({ length: 12 }, (_, i) => ({
      photoId: i + 1,
      phash: (BigInt(i) * BigInt(0x0001000100010001))
        .toString(16)
        .padStart(16, "0"),
    }));
    const groups = buildGroupsFromEntries(entries, 4, 2);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(12);
  });
});
