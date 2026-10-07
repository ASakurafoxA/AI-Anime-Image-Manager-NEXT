import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IMAGE_SIZE,
  preprocessImage,
} from "../../../scripts/pixai-preprocess.mjs";

/**
 * PixAI 预处理的**结构性**断言。
 *
 * 为什么要有这个测试：预处理错一点点，模型**不会报错**，只是输出变成垃圾
 * （交接文档 §2.3 明确警告过"照 preprocessor_config.json 写会做错"）。
 * 与官方 Python 输出的逐元素比对在 `scripts/pixai-selftest.mjs`（需要 1.9 GB 模型），
 * 而这里用**合成图**把可判定的性质钉死，跑得快、不依赖模型：
 *   · 张量形状/长度、数值域 [-1,1]
 *   · **通道序必须是 RGB**（做反了会得到灰发→红发这种诡异结果）
 *   · 补边必须是 **-1**（= 黑边 0 经过 (x-0.5)/0.5；补成 0 就说明归一化顺序错了）
 *   · 缩放几何按官方 `rescale_pad`：长边贴到 1008、`int()` 截断、余数补在右/下
 *   · 带 alpha 的图必须**白底合成**
 */

const PIXELS = IMAGE_SIZE * IMAGE_SIZE;
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pixai-preprocess-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function writeImage(
  name: string,
  width: number,
  height: number,
  create: { r: number; g: number; b: number; alpha?: number }
): Promise<string> {
  const file = path.join(tmpDir, name);
  await sharp({
    create: {
      background: {
        alpha: create.alpha ?? 1,
        b: create.b,
        g: create.g,
        r: create.r,
      },
      channels: create.alpha === undefined ? 3 : 4,
      height,
      width,
    },
  })
    .png()
    .toFile(file);
  return file;
}

function planeValue(
  data: Float32Array,
  plane: 0 | 1 | 2,
  x: number,
  y: number
): number {
  return data[plane * PIXELS + y * IMAGE_SIZE + x];
}

describe("PixAI 预处理（官方 rescale_pad 的结构性断言）", () => {
  it("输出形状/数值域正确，且补边严格等于 -1（黑边 + (x-0.5)/0.5）", async () => {
    // 32x64 竖图 → 缩放到 504x1008（长边贴满），左右各补 252
    const file = await writeImage("portrait.png", 32, 64, {
      b: 0,
      g: 0,
      r: 255,
    });
    const data = await preprocessImage(file);

    expect(data.length).toBe(3 * PIXELS);
    expect(data).toBeInstanceOf(Float32Array);

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of data) {
      if (value < min) {
        min = value;
      }
      if (value > max) {
        max = value;
      }
    }
    expect(min).toBeGreaterThanOrEqual(-1.0000001);
    expect(max).toBeLessThanOrEqual(1.0000001);

    // 左上角必定落在补边区域（左边补 252px）
    expect(planeValue(data, 0, 0, 0)).toBe(-1);
    expect(planeValue(data, 1, 0, 0)).toBe(-1);
    expect(planeValue(data, 2, 0, 0)).toBe(-1);

    // 正中一定在图像区域，且是纯红 → R=+1、G=B=-1
    const centerX = Math.floor(IMAGE_SIZE / 2);
    const centerY = Math.floor(IMAGE_SIZE / 2);
    expect(planeValue(data, 0, centerX, centerY)).toBeCloseTo(1, 5);
    expect(planeValue(data, 1, centerX, centerY)).toBeCloseTo(-1, 5);
    expect(planeValue(data, 2, centerX, centerY)).toBeCloseTo(-1, 5);
  });

  it("通道序是 RGB（写反了会把红蓝互换 —— 正是「灰发变红发」那类错误的来源）", async () => {
    const file = await writeImage("blue.png", 64, 64, { b: 255, g: 0, r: 0 });
    const data = await preprocessImage(file);
    const x = Math.floor(IMAGE_SIZE / 2);
    const y = Math.floor(IMAGE_SIZE / 2);
    // 纯蓝图：B 平面 +1，R 平面 -1
    expect(planeValue(data, 0, x, y)).toBeCloseTo(-1, 5);
    expect(planeValue(data, 2, x, y)).toBeCloseTo(1, 5);
  });

  it("正方形图不做缩放也不补边（官方 rescale_pad 的短路分支）", async () => {
    const file = await writeImage("square.png", IMAGE_SIZE, IMAGE_SIZE, {
      b: 128,
      g: 128,
      r: 128,
    });
    const data = await preprocessImage(file);
    // 中灰 128/127.5-1 ≈ 0.0039，四角都不该是 -1
    const corner = planeValue(data, 0, 0, 0);
    expect(corner).toBeGreaterThan(-1);
    expect(corner).toBeCloseTo(128 / 127.5 - 1, 4);
  });

  it("带 alpha 的图按白底合成（透明区域变成 +1 而不是保留黑色）", async () => {
    // 完全透明的图 → 白底合成后应全白 → 图像区域约 +1
    const file = await writeImage("alpha.png", 64, 64, {
      alpha: 0,
      b: 0,
      g: 0,
      r: 0,
    });
    const data = await preprocessImage(file);
    const x = Math.floor(IMAGE_SIZE / 2);
    const y = Math.floor(IMAGE_SIZE / 2);
    expect(planeValue(data, 0, x, y)).toBeCloseTo(1, 3);
    expect(planeValue(data, 1, x, y)).toBeCloseTo(1, 3);
    expect(planeValue(data, 2, x, y)).toBeCloseTo(1, 3);
  });

  it("极端长宽比：缩放后长边贴满 1008，且补边余数落在右/下（与官方一致）", async () => {
    // 1008 宽、1 高 → new_w = 1008，new_h = floor(1 * (1008/1008)) = 1
    const file = await writeImage("strip.png", 1008, 1, {
      b: 0,
      g: 255,
      r: 0,
    });
    const data = await preprocessImage(file);
    // top = floor((1008-1)/2) = 503 → y=503 是图像行，y=0 是补边
    expect(planeValue(data, 1, 0, 503)).toBeCloseTo(1, 4);
    expect(planeValue(data, 1, 0, 0)).toBe(-1);
    expect(planeValue(data, 1, 0, IMAGE_SIZE - 1)).toBe(-1);
  });
});
