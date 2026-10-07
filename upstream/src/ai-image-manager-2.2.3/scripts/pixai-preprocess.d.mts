/**
 * `pixai-preprocess.mjs` 的类型声明。
 *
 * 该模块是纯 JS（worker 与自检脚本都用它，不能因为 TS 编译链而变成 .ts），
 * 所以这里补一份 `.d.mts` 给 TS 侧（单元测试）用 —— 顺便把 API 契约写清楚。
 */

/** 官方 `RescalePadProcessor(size=1008)`；ONNX 输入实测 `[1,3,1008,1008]` float32。 */
export declare const IMAGE_SIZE: number;

/** 缩放用 bilinear：sharp 的 `linear`（三角滤波）对应 torchvision 的 bilinear。 */
export declare const RESIZE_KERNEL: string;

/**
 * 把一张图预处理成 ONNX 输入张量。
 *
 * 严格按官方 `rescale_pad` 几何：等比缩放到能塞进 size → **黑边**补到 size×size →
 * `(x/255-0.5)/0.5` → **NCHW**、**RGB**、**-1..1**、float32。
 *
 * @returns 长度 `3*size*size` 的 Float32Array（NCHW 展平）
 */
export declare function preprocessImage(
  imagePath: string,
  options?: { size?: number }
): Promise<Float32Array>;
