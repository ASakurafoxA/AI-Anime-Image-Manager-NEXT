/**
 * Perceptual hash (pHash) — the shared "is this the same image?" fingerprint.
 *
 * 从 `indexer.ts` 原样搬出来，**算法一字未改**：库里 77,296 张图的 phash 都是
 * 用它算的（`phash-v1`），改动算法会让已存指纹全部失效。
 *
 * 用途（三处共用）：
 *   - 以图搜图：外部图片算指纹 → 与库内指纹比 → 判断「这张图我存过吗」
 *   - 查重：库内两两比 → 找出重复簇
 *   - 人物识别前置：先合并「同一幅画的多张差分」，避免干扰角色分组
 *
 * 调参提示：汉明距离阈值由 `duplicate-sensitivity.ts` 的三档决定
 * （低=4 / 中=8 / 高=12）。
 */
import sharp from "sharp";

/** Stored phash algorithm version. Must match `photos.phash` values in the DB. */
export const PHASH_VERSION = "phash-v1";

/** Side length the image is squashed to before the DCT. */
export const PHASH_SIZE = 32;

/** Bits kept from the low-frequency block (8x8 minus the DC term). */
export const PHASH_BITS = 63;

export function dct1D(input: Float64Array): Float64Array {
  const N = input.length;
  const output = new Float64Array(N);
  const piOver2N = Math.PI / (2 * N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += input[n] * Math.cos((2 * n + 1) * k * piOver2N);
    }
    output[k] = sum;
  }
  return output;
}

export function dct2D(matrix: Float64Array[], size: number): Float64Array[] {
  // DCT on rows
  const rowTransformed: Float64Array[] = [];
  for (let i = 0; i < size; i++) {
    rowTransformed.push(dct1D(matrix[i]));
  }
  // DCT on columns
  const result: Float64Array[] = Array.from(
    { length: size },
    () => new Float64Array(size)
  );
  for (let j = 0; j < size; j++) {
    const col = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      col[i] = rowTransformed[i][j];
    }
    const colDct = dct1D(col);
    for (let i = 0; i < size; i++) {
      result[i][j] = colDct[i];
    }
  }
  return result;
}

/**
 * Resize → 32×32 grayscale → 2D DCT → top-left 8×8 low-freq → median threshold
 * → 64-bit hex. More robust than aHash against scaling, compression, and
 * brightness changes.
 *
 * @param input file path or image buffer
 * @returns 16-char lowercase hex, or null when the image cannot be decoded
 */
export async function computePHash(
  input: string | Buffer
): Promise<string | null> {
  try {
    const SIZE = PHASH_SIZE;
    const { data } = await sharp(input)
      .rotate()
      .resize(SIZE, SIZE, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8Array(data);

    // Build 32×32 float matrix
    const matrix: Float64Array[] = [];
    for (let i = 0; i < SIZE; i++) {
      const row = new Float64Array(SIZE);
      for (let j = 0; j < SIZE; j++) {
        row[j] = pixels[i * SIZE + j];
      }
      matrix.push(row);
    }

    // 2D DCT
    const dct = dct2D(matrix, SIZE);

    // Extract top-left 8×8 (lowest frequency coefficients, excluding DC at [0][0])
    const lowFreq: number[] = [];
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        if (i === 0 && j === 0) {
          continue; // skip DC component
        }
        lowFreq.push(dct[i][j]);
      }
    }

    // Median threshold
    const sorted = [...lowFreq].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // 64-bit hash (63 values from 8×8 minus DC = 63, pad to 64)
    let hash = 0n;
    for (let i = 0; i < lowFreq.length; i++) {
      if (lowFreq[i] > median) {
        hash += 2n ** BigInt(i);
      }
    }

    return hash.toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}

/**
 * Human-readable "how alike" for a given Hamming distance (0 = identical bits).
 * 仅用于展示：0 位差 → 100%，位差越大越接近 0。
 */
export function phashSimilarity(distance: number): number {
  if (!Number.isFinite(distance) || distance < 0) {
    return 0;
  }
  return Math.max(0, 1 - distance / 64);
}
