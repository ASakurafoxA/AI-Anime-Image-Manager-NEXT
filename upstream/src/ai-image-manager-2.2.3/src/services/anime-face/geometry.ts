/**
 * 动漫人脸检测器的纯几何/解码逻辑（2026-11-14 · 会话#12 新增，方案 C 阶段 1）。
 *
 * 为什么单独抽出来：letterbox、框还原、NMS 这三件事**最容易写错且最难在真机上发现**
 * （框偏几像素看不出来，但裁出来的图就歪了）。抽成纯函数后可以离线单测，
 * worker 里只负责读图/推理/发消息。
 *
 * 模型规格（`deepghs/anime_face_detection` v1.4_n / v1.4_s，YOLOv8 导出）：
 *   · 输入 `images` `[1,3,S,S]` float32，RGB、0–1、**letterbox 补灰边 114**；
 *   · 输出 `output0` `[1, 4+nc, N]`（nc=1 → `[1,5,N]`），每列 = cx,cy,w,h,score；
 *   · 官方阈值：v1.4_n 0.278 / v1.4_s 0.307。
 */

export interface LetterboxTransform {
  /** 640 空间 → 原图的缩放比 */
  scale: number;
  /** 左侧补边像素（640 空间） */
  padX: number;
  /** 顶部补边像素（640 空间） */
  padY: number;
}

export interface FaceBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

/** 计算 letterbox 的缩放与补边（与 Ultralytics 的居中补边一致）。 */
export function computeLetterbox(
  width: number,
  height: number,
  inputSize: number
): LetterboxTransform {
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`图片尺寸无效: ${width}x${height}`);
  }
  const scale = Math.min(inputSize / width, inputSize / height);
  const newW = Math.max(1, Math.round(width * scale));
  const newH = Math.max(1, Math.round(height * scale));
  return {
    scale,
    padX: Math.floor((inputSize - newW) / 2),
    padY: Math.floor((inputSize - newH) / 2),
  };
}

/**
 * 把模型输出解码成原图坐标的人脸框（已过滤低分与小框，**未做 NMS**）。
 *
 * @param data  `output0` 的扁平数组，布局 `[4+nc, N]` 列优先
 * @param n     N（候选数，如 8400）
 * @param rows  通道数（nc=1 时为 5）
 */
export function decodeFaceBoxes(
  data: ArrayLike<number>,
  n: number,
  rows: number,
  transform: LetterboxTransform,
  imageWidth: number,
  imageHeight: number,
  confidence: number,
  minSide = 4
): FaceBox[] {
  if (rows < 5) {
    throw new Error(`输出通道数异常: ${rows}（至少要有 4 个框参数 + 1 个分数）`);
  }
  const boxes: FaceBox[] = [];
  for (let i = 0; i < n; i += 1) {
    const score = data[4 * n + i];
    if (!Number.isFinite(score) || score < confidence) {
      continue;
    }
    const cx = data[i];
    const cy = data[n + i];
    const w = data[2 * n + i];
    const h = data[3 * n + i];
    if (!(w > 0) || !(h > 0)) {
      continue;
    }
    // 640 空间 → 原图
    const x1 = (cx - w / 2 - transform.padX) / transform.scale;
    const y1 = (cy - h / 2 - transform.padY) / transform.scale;
    const x2 = (cx + w / 2 - transform.padX) / transform.scale;
    const y2 = (cy + h / 2 - transform.padY) / transform.scale;
    const clampedX1 = Math.max(0, x1);
    const clampedY1 = Math.max(0, y1);
    const clampedX2 = Math.min(imageWidth, x2);
    const clampedY2 = Math.min(imageHeight, y2);
    if (clampedX2 - clampedX1 < minSide || clampedY2 - clampedY1 < minSide) {
      continue;
    }
    boxes.push({
      x1: clampedX1,
      y1: clampedY1,
      x2: clampedX2,
      y2: clampedY2,
      score,
    });
  }
  return boxes;
}

export function boxIou(a: FaceBox, b: FaceBox): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

/** 按分数从高到低做 NMS。 */
export function nonMaxSuppression(boxes: FaceBox[], iouThreshold = 0.45): FaceBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: FaceBox[] = [];
  for (const box of sorted) {
    if (kept.every((other) => boxIou(other, box) < iouThreshold)) {
      kept.push(box);
    }
  }
  return kept;
}

/**
 * 以脸框为中心放大，得到"近似人物上半身"的裁图区域（方案 C 实际喂给 CCIP 的就是它）。
 *
 * 实测（`#2026-11-14-04`）：放大 2.2× 时裁图特征的 1-NN 正确率 96.7%，
 * 比整图的区分度还高，所以默认 2.2。
 */
export function expandFaceBox(
  box: FaceBox,
  imageWidth: number,
  imageHeight: number,
  factor = 2.2
): { left: number; top: number; width: number; height: number } {
  const cx = (box.x1 + box.x2) / 2;
  const cy = (box.y1 + box.y2) / 2;
  const halfW = ((box.x2 - box.x1) * factor) / 2;
  const halfH = ((box.y2 - box.y1) * factor) / 2;
  const left = Math.max(0, Math.round(cx - halfW));
  // 头顶少留、往下多留（脖子/肩膀/服装是认角色的关键）
  const top = Math.max(0, Math.round(cy - halfH * 1.25));
  const width = Math.max(16, Math.min(imageWidth - left, Math.round(halfW * 2)));
  const height = Math.max(16, Math.min(imageHeight - top, Math.round(halfH * 2.5)));
  return { left, top, width, height };
}

/** 取分数最高的前 k 张脸（人脸数一般 1~6）。 */
export function topFaces(boxes: FaceBox[], k = 6): FaceBox[] {
  return [...boxes].sort((a, b) => b.score - a.score).slice(0, Math.max(1, k));
}
