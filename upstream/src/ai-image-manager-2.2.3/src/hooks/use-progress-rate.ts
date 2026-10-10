import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * 自用（需求 7）：给"特征提取 / 打标"这类按张数推进的阶段算**处理速度**与**预估剩余时间**。
 *
 * 为什么放在前端算：进度接口只给 `processed / total`，没有时间戳。组件本身每 500ms
 * 轮询一次，天然就是一组采样点，取最近一段时间的**增量**算速度即可，比在后端加状态更简单，
 * 也不受"暂停后继续"之类情况影响（阶段一变就重新采样）。
 */

/** 采样窗口：只用最近这段时间的增量，避免整段平均掩盖"越跑越慢 / 越跑越快"。 */
export const PROGRESS_RATE_WINDOW_MS = 20_000;
/** 至少要两个样本才谈得上速度。 */
export const PROGRESS_RATE_MIN_SAMPLES = 2;
/** 这么久没有新增进度就认为卡住/暂停 → 显示"估算中"，而不是一个巨大的剩余时间。 */
export const PROGRESS_RATE_STALE_MS = 15_000;
/** 速度刷新的心跳（用于"卡住了"能及时反映出来）。 */
const PROGRESS_RATE_TICK_MS = 2000;

export interface ProgressSample {
  at: number;
  processed: number;
}

export interface ProgressRateInput {
  isActive?: boolean;
  phase: string;
  processed: number;
  total: number;
}

/** 纯函数：给一组采样点算速度与剩余时间（便于单测，不依赖 React）。 */
export function computeProgressRate(
  samples: readonly ProgressSample[],
  total: number,
  now: number
): { perSecond: number | null; remainingSeconds: number | null } {
  if (!(total > 0)) {
    return { perSecond: null, remainingSeconds: null };
  }

  const usable = samples.filter(
    (sample) => now - sample.at <= PROGRESS_RATE_WINDOW_MS
  );
  if (usable.length < PROGRESS_RATE_MIN_SAMPLES) {
    return { perSecond: null, remainingSeconds: null };
  }

  const first = usable[0];
  const last = usable[usable.length - 1];
  const elapsedMs = last.at - first.at;
  const advanced = last.processed - first.processed;
  if (elapsedMs <= 0 || advanced <= 0) {
    return { perSecond: null, remainingSeconds: null };
  }
  // 最近一段时间没有新进度：不要给"还剩 3 小时"这种吓人的估算。
  if (now - last.at > PROGRESS_RATE_STALE_MS) {
    return { perSecond: null, remainingSeconds: null };
  }

  const perSecond = (advanced / elapsedMs) * 1000;
  const remaining = Math.max(0, total - last.processed);
  return {
    perSecond,
    remainingSeconds: perSecond > 0 ? remaining / perSecond : null,
  };
}

/** "2.3 张/秒"（低于 10 保留一位小数，避免数字乱跳太长）。 */
export function formatProgressSpeed(t: TFunction, perSecond: number): string {
  const value = perSecond >= 10 ? Math.round(perSecond).toString() : perSecond.toFixed(1);
  return t("aiProgressSpeed", { value });
}

/** "剩余约 1 分 20 秒"：不到 1 分钟只给秒，超过 1 小时给小时+分。 */
export function formatProgressRemaining(
  t: TFunction,
  remainingSeconds: number
): string {
  const total = Math.max(0, Math.round(remainingSeconds));
  if (total < 60) {
    return t("aiProgressEta", { time: t("aiProgressTimeSeconds", { seconds: total }) });
  }
  if (total < 3600) {
    return t("aiProgressEta", {
      time: t("aiProgressTimeMinutes", {
        minutes: Math.floor(total / 60),
        seconds: total % 60,
      }),
    });
  }
  return t("aiProgressEta", {
    time: t("aiProgressTimeHours", {
      hours: Math.floor(total / 3600),
      minutes: Math.round((total % 3600) / 60),
    }),
  });
}

/**
 * 采样 + 返回可显示的文本。`input` 传 `null` 表示"当前阶段不需要速度/预估"
 * （例如加载模型、已完成、空闲），此时会清空采样。
 */
export function useProgressRate(input: ProgressRateInput | null): {
  pending: boolean;
  remainingText: string | null;
  speedText: string | null;
} {
  const { t } = useTranslation();
  const samplesRef = useRef<ProgressSample[]>([]);
  const phaseRef = useRef<string | null>(null);
  const [rate, setRate] = useState<{
    perSecond: number | null;
    remainingSeconds: number | null;
  }>({ perSecond: null, remainingSeconds: null });

  const phase = input?.phase ?? null;
  const processed = input?.processed ?? null;
  const total = input?.total ?? 0;
  const isActive = input?.isActive ?? false;

  // 收采样点：阶段变了或不在跑 → 重新开始，避免把上一段的速度算进来。
  useEffect(() => {
    if (phase === null || !isActive) {
      if (samplesRef.current.length > 0) {
        samplesRef.current = [];
      }
      phaseRef.current = phase;
      setRate({ perSecond: null, remainingSeconds: null });
      return;
    }
    if (phaseRef.current !== phase) {
      phaseRef.current = phase;
      samplesRef.current = [];
    }
    const now = Date.now();
    const samples = samplesRef.current;
    const previous = samples[samples.length - 1];
    if (processed !== null && (!previous || previous.processed !== processed)) {
      samples.push({ at: now, processed });
    }
    while (
      samples.length > PROGRESS_RATE_MIN_SAMPLES &&
      now - samples[0].at > PROGRESS_RATE_WINDOW_MS
    ) {
      samples.shift();
    }
    setRate(computeProgressRate(samples, total, now));
  }, [isActive, phase, processed, total]);

  // 心跳：卡住时能及时把估算收回去（显示"估算中"）。
  useEffect(() => {
    if (!isActive || phase === null) {
      return;
    }
    const timer = setInterval(() => {
      setRate(computeProgressRate(samplesRef.current, total, Date.now()));
    }, PROGRESS_RATE_TICK_MS);
    return () => clearInterval(timer);
  }, [isActive, phase, total]);

  return {
    speedText: rate.perSecond === null ? null : formatProgressSpeed(t, rate.perSecond),
    remainingText:
      rate.remainingSeconds === null
        ? null
        : formatProgressRemaining(t, rate.remainingSeconds),
    pending: isActive && rate.perSecond === null,
  };
}
