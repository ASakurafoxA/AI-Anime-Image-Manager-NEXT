/**
 * 自用（多卡·第 10 轮）：**吞吐速率计**（滑动窗口，而不是累计平均）。
 *
 * 为什么不用"累计张数 ÷ 总耗时"：那个数字会越跑越"钝" ——
 * 跑到一半时拖动占用限制、或某张卡变慢，界面上的速度几乎不动，
 * 看不出变化。这里用**最近一个时间窗**内的增量来算，能真实反映"此刻多快"。
 *
 * 用法（每个卡/每个 worker 一个实例）：
 *   const rate = createRateMeter(4000);
 *   rate.add(20);            // 完成 20 张
 *   rate.perSecond();        // → 张/秒（样本不足时返回 0）
 *   rate.reset();
 */
export interface RateMeter {
  /** 记录完成了多少张。 */
  add: (count: number) => void;
  /** 清空（例如重新开始一个任务）。 */
  reset: () => void;
  /** 当前速度（张/秒）；窗口内样本不足或没有进展时返回 0。 */
  perSecond: () => number;
  /** 窗口内的总张数（诊断用）。 */
  windowTotal: () => number;
}

/**
 * @param windowMs 统计窗口（默认 4 秒：短到能看出变化，长到不会一跳一跳）
 */
export function createRateMeter(windowMs = 4000): RateMeter {
  let samples: Array<{ at: number; count: number }> = [];

  function prune(now: number) {
    const cutoff = now - windowMs;
    // 保留一个"窗口起点之前"的样本，这样窗口内增量才完整
    let keepFrom = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].at >= cutoff) {
        keepFrom = Math.max(0, i - 1);
        break;
      }
      keepFrom = i;
    }
    if (keepFrom > 0) {
      samples = samples.slice(keepFrom);
    }
  }

  return {
    add(count: number) {
      if (!Number.isFinite(count) || count <= 0) {
        return;
      }
      const now = Date.now();
      samples.push({ at: now, count });
      prune(now);
    },
    reset() {
      samples = [];
    },
    perSecond() {
      if (samples.length === 0) {
        return 0;
      }
      const now = Date.now();
      prune(now);
      const first = samples[0];
      const spanMs = now - first.at;
      if (spanMs < 1000) {
        // 样本跨度太短，算出来会虚高 → 先不给数字
        return 0;
      }
      const total = samples.reduce((sum, item) => sum + item.count, 0);
      return (total * 1000) / spanMs;
    },
    windowTotal() {
      return samples.reduce((sum, item) => sum + item.count, 0);
    },
  };
}
