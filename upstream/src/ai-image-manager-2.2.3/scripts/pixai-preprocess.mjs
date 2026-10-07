/**
 * PixAI Tagger v1.0 预处理（官方 `rescale_pad` + `RescalePadProcessor` 的忠实实现）。
 *
 * 单独成模块的理由：预处理是**最容易静默做错**的一环（错一点点模型不报错、只是结果变成垃圾），
 * 所以它必须能被自检脚本独立调用、与官方 Python 输出逐元素比对。
 * 权威参考：`pixai-tagger-v1.0/tagger_pipeline.py`
 *   - `rescale_pad()`（第 1001 行起）：几何
 *   - `RescalePadProcessor.preprocess()`（第 1024 行起）：白底合成 → 0..1 → rescale_pad → (x-0.5)/0.5
 *
 * 官方几何（**逐字对应，不要"优化"**）：
 * ```python
 * r = min(size/h, size/w); new_h, new_w = int(h*r), int(w*r)   # 向下取整
 * left = (size-new_w)//2; right = (size-new_w) - left          # 余数给右边
 * top  = (size-new_h)//2; bottom = (size-new_h) - top          # 余数给下边
 * resize(bilinear) → pad(0，黑) → normalize(0.5,0.5) → NCHW float32
 * ```
 *
 * ⚠️ 与 WD14 的区别（照抄 WD14 必错）：尺寸 448→**1008**、布局 NHWC→**NCHW**、
 *    通道序 BGR→**RGB**、数值 0-255→**-1..1**、补边 白→**黑**、插值 bicubic→**bilinear**、
 *    顺序 "先补方再缩" → **"先等比缩放再补边"**。
 */

import sharp from "sharp";

/** 官方 `RescalePadProcessor(size=1008)`；ONNX 输入实测 `[1,3,1008,1008]` float32。 */
export const IMAGE_SIZE = 1008;

/** 缩放用 bilinear：sharp 的 `linear`（三角滤波）对应 torchvision 的 bilinear。 */
const RESIZE_KERNEL = "linear";

/**
 * 把一张图预处理成 ONNX 输入张量。
 *
 * @param {string} imagePath
 * @param {{ size?: number }} [options]
 * @returns {Promise<Float32Array>} 长度 3*size*size 的 NCHW、-1..1、RGB float32
 */
export async function preprocessImage(imagePath, options = {}) {
  const size = options.size ?? IMAGE_SIZE;

  const meta = await sharp(imagePath).metadata();
  const srcW = meta.width || 0;
  const srcH = meta.height || 0;
  if (!(srcW > 0 && srcH > 0)) {
    throw new Error(`读不出图片尺寸: ${imagePath}`);
  }

  const scale = Math.min(size / srcH, size / srcW);
  const newH = Math.floor(srcH * scale);
  const newW = Math.floor(srcW * scale);

  // 非 RGB（含 alpha）→ 白底合成 → RGB（对应官方 RGBA + 白 canvas 的 alpha_composite）
  const { data, info } = await sharp(imagePath)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(newW, newH, { fit: "fill", kernel: RESIZE_KERNEL })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 3 || info.width !== newW || info.height !== newH) {
    throw new Error(
      `缩放结果异常: ${info.width}x${info.height}x${info.channels}（期望 ${newW}x${newH}x3）`
    );
  }

  const pixels = size * size;
  const floats = new Float32Array(3 * pixels);
  // 先整体填 -1：黑边 0 经 (0/255-0.5)/0.5 正好是 -1
  floats.fill(-1);

  const left = Math.floor((size - newW) / 2);
  const top = Math.floor((size - newH) / 2);

  for (let y = 0; y < newH; y++) {
    const dstRow = (top + y) * size + left;
    const srcRow = y * newW * 3;
    for (let x = 0; x < newW; x++) {
      const dst = dstRow + x;
      const src = srcRow + x * 3;
      // NCHW：三个通道各占一个平面；RGB 顺序；v/127.5-1 等价于 (v/255-0.5)/0.5
      floats[dst] = data[src] / 127.5 - 1;
      floats[pixels + dst] = data[src + 1] / 127.5 - 1;
      floats[2 * pixels + dst] = data[src + 2] / 127.5 - 1;
    }
  }

  return floats;
}
