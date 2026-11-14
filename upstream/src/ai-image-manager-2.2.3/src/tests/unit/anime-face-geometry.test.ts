/**
 * 动漫人脸检测的几何/解码单测（2026-11-14 · 会话#12）。
 *
 * 这些函数出错的表现很隐蔽（框偏几像素 → 裁图裁到头发/背景 → 特征全废），
 * 所以用**可推算的输入**钉死：letterbox 补边、坐标还原、NMS 去重、裁图放大。
 */
import { describe, expect, it } from "vitest";

import {
  boxIou,
  computeLetterbox,
  decodeFaceBoxes,
  expandFaceBox,
  nonMaxSuppression,
  topFaces,
  type FaceBox,
} from "@/services/anime-face/geometry";

function box(x1: number, y1: number, x2: number, y2: number, score = 0.9): FaceBox {
  return { x1, y1, x2, y2, score };
}

describe("computeLetterbox", () => {
  it("横图：按宽度铺满、上下补边", () => {
    const t = computeLetterbox(1920, 1080, 640);
    expect(t.scale).toBeCloseTo(640 / 1920, 6);
    expect(t.padX).toBe(0);
    expect(t.padY).toBe(Math.floor((640 - Math.round(1080 * (640 / 1920))) / 2));
  });

  it("竖图：按高度铺满、左右补边", () => {
    const t = computeLetterbox(800, 1600, 640);
    expect(t.scale).toBeCloseTo(640 / 1600, 6);
    expect(t.padY).toBe(0);
    expect(t.padX).toBeGreaterThan(0);
  });

  it("正方形：不补边", () => {
    const t = computeLetterbox(500, 500, 640);
    expect(t.scale).toBeCloseTo(1.28, 6);
    expect(t.padX).toBe(0);
    expect(t.padY).toBe(0);
  });

  it("尺寸非法要报错（而不是静默算出 NaN 框）", () => {
    expect(() => computeLetterbox(0, 100, 640)).toThrow();
    expect(() => computeLetterbox(100, 0, 640)).toThrow();
  });
});

describe("decodeFaceBoxes", () => {
  const transform = { scale: 0.5, padX: 0, padY: 0 };

  function encode(n: number, entries: Array<[number, number, number, number, number]>) {
    const data = new Float32Array(5 * n);
    entries.forEach(([cx, cy, w, h, score], index) => {
      data[index] = cx;
      data[n + index] = cy;
      data[2 * n + index] = w;
      data[3 * n + index] = h;
      data[4 * n + index] = score;
    });
    return data;
  }

  it("640 空间的框按 scale/pad 还原到原图坐标", () => {
    // scale 0.5：640 空间里 cx=160,cy=160,w=80,h=80 → 原图中心 (320,320)、边长 160
    const data = encode(2, [[160, 160, 80, 80, 0.9], [0, 0, 0, 0, 0]]);
    const boxes = decodeFaceBoxes(data, 2, 5, transform, 1920, 1080, 0.5);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ x1: 240, y1: 240, x2: 400, y2: 400 });
  });

  it("低于阈值的候选被丢掉", () => {
    const data = encode(2, [[160, 160, 80, 80, 0.2], [160, 160, 80, 80, 0.9]]);
    const boxes = decodeFaceBoxes(data, 2, 5, transform, 1000, 1000, 0.278);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].score).toBeCloseTo(0.9, 6);
  });

  it("超出画面的框被裁到画面内（不能出现负坐标）", () => {
    const data = encode(1, [[5, 5, 80, 80, 0.9]]);
    const boxes = decodeFaceBoxes(data, 1, 5, transform, 500, 500, 0.2);
    expect(boxes[0].x1).toBeGreaterThanOrEqual(0);
    expect(boxes[0].y1).toBeGreaterThanOrEqual(0);
  });

  it("过小的框（<4px）被丢掉（避免把噪点当脸）", () => {
    // scale 0.5 → 640 空间 1.5px 还原到原图只有 3px，低于 minSide=4
    const data = encode(1, [[100, 100, 1.5, 1.5, 0.99]]);
    const boxes = decodeFaceBoxes(data, 1, 5, transform, 1000, 1000, 0.2);
    expect(boxes).toHaveLength(0);
  });

  it("通道数不足要报错", () => {
    expect(() => decodeFaceBoxes(new Float32Array(8), 2, 4, transform, 100, 100, 0.2)).toThrow();
  });
});

describe("nonMaxSuppression", () => {
  it("同一个脸的两个重叠框只留分数高的", () => {
    const a = box(10, 10, 110, 110, 0.9);
    const b = box(12, 12, 112, 112, 0.8);
    const kept = nonMaxSuppression([b, a], 0.45);
    expect(kept).toHaveLength(1);
    expect(kept[0].score).toBeCloseTo(0.9, 6);
  });

  it("两个分开的脸都保留（两人图的关键）", () => {
    const left = box(10, 10, 110, 110, 0.9);
    const right = box(400, 10, 500, 110, 0.85);
    expect(nonMaxSuppression([left, right])).toHaveLength(2);
  });

  it("IoU 计算自洽", () => {
    const a = box(0, 0, 10, 10);
    expect(boxIou(a, a)).toBeCloseTo(1, 6);
    expect(boxIou(a, box(100, 100, 110, 110))).toBe(0);
  });
});

describe("expandFaceBox", () => {
  it("放大后中心不变、面积变大（默认 2.2 倍）", () => {
    const face = box(100, 100, 200, 200);
    const crop = expandFaceBox(face, 1000, 1000, 2.2);
    expect(crop.width).toBeGreaterThan(100);
    expect(crop.height).toBeGreaterThan(100);
    const centerX = crop.left + crop.width / 2;
    expect(Math.abs(centerX - 150)).toBeLessThan(3);
  });

  it("贴边时不会越界（张量裁切不允许负坐标）", () => {
    const face = box(0, 0, 40, 40);
    const crop = expandFaceBox(face, 500, 500);
    expect(crop.left).toBeGreaterThanOrEqual(0);
    expect(crop.top).toBeGreaterThanOrEqual(0);
    expect(crop.left + crop.width).toBeLessThanOrEqual(500);
    expect(crop.top + crop.height).toBeLessThanOrEqual(500);
  });
});

describe("topFaces", () => {
  it("按分数取前 k 个", () => {
    const boxes = [box(0, 0, 10, 10, 0.3), box(1, 1, 11, 11, 0.9), box(2, 2, 12, 12, 0.6)];
    expect(topFaces(boxes, 2).map((b) => b.score)).toEqual([0.9, 0.6]);
  });

  it("k 非法时至少保留 1 个", () => {
    expect(topFaces([box(0, 0, 10, 10, 0.5)], 0)).toHaveLength(1);
  });
});
