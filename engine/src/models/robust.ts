import { clamp01 } from "../math.ts";

// 1/Φ⁻¹(0.75): scales the MAD so it estimates σ when the data are normal (Rousseeuw & Croux 1993).
export const MAD_SCALE = 1.4826;
export const MIN_ROBUST_SAMPLES = 20;

/** median(X): the middle order statistic, or the mean of the two middle ones when n is even. Null for empty or non-finite input. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0 || !values.every(Number.isFinite)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const lower = sorted[Math.ceil(sorted.length / 2) - 1];
  const upper = sorted[Math.floor(sorted.length / 2)];
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

/** MAD(X) = median(|X − median(X)|). Ref: Rousseeuw & Croux (1993). Null for empty or non-finite input. */
export function medianAbsoluteDeviation(values: readonly number[]): number | null {
  const center = median(values);
  if (center === null) return null;
  return median(values.map((value) => Math.abs(value - center)));
}

/**
 * z = (x − median(X)) / (1.4826 · MAD(X)) against a trailing window X that excludes x.
 * Ref: Rousseeuw & Croux (1993). Null when n < minSamples (20), MAD = 0, or any input is non-finite.
 */
export function robustZScore(value: number, history: readonly number[], minSamples = MIN_ROBUST_SAMPLES): number | null {
  if (!Number.isFinite(value) || history.length < minSamples) return null;
  const center = median(history);
  const mad = medianAbsoluteDeviation(history);
  // A history with no spread gives no scale: any change would read as infinitely unusual.
  if (center === null || mad === null || mad === 0) return null;
  return (value - center) / (MAD_SCALE * mad);
}

/**
 * s = clip((|z| − z_trig) / (z_full − z_trig), 0, 1): zero up to the trigger, one from full scale.
 * A missing or non-finite z has no strength. Throws RangeError unless 0 ≤ z_trig < z_full.
 */
export function robustStrength(z: number | null, zTrigger: number, zFull: number): number {
  if (!(zTrigger >= 0) || !(zFull > zTrigger) || !Number.isFinite(zFull)) {
    throw new RangeError(`robust strength needs 0 <= zTrigger < zFull, got ${zTrigger} and ${zFull}`);
  }
  if (z === null || !Number.isFinite(z)) return 0;
  return clamp01((Math.abs(z) - zTrigger) / (zFull - zTrigger));
}

export type CusumOptions = {
  /** μ₀, the in-control mean. */
  mean: number;
  /** σ of the in-control process; k and h scale with it. */
  sigma: number;
  /** k in units of σ (default 0.5): drift tolerated before evidence builds up. */
  slackSigmas?: number;
  /** h in units of σ (default 5): the alarm level. */
  thresholdSigmas?: number;
};

export type CusumAlarm = { index: number; side: "up" | "down" };

/** Final S⁺ and S⁻, and the first index where either crossed h. */
export type CusumResult = { upper: number; lower: number; firstAlarm: CusumAlarm | null };

/**
 * S⁺_t = max(0, S⁺_{t−1} + x_t − μ₀ − k), S⁻_t = max(0, S⁻_{t−1} − x_t + μ₀ − k); alarm when S > h (k = 0.5σ, h = 5σ).
 * Ref: Page (1954). Null when σ ≤ 0 or any input is non-finite; throws RangeError for k < 0 or h ≤ 0.
 */
export function cusum(values: readonly number[], options: CusumOptions): CusumResult | null {
  const slackSigmas = options.slackSigmas ?? 0.5;
  const thresholdSigmas = options.thresholdSigmas ?? 5;
  if (!(slackSigmas >= 0) || !Number.isFinite(slackSigmas) || !(thresholdSigmas > 0) || !Number.isFinite(thresholdSigmas)) {
    throw new RangeError(`CUSUM needs slack >= 0 and threshold > 0, got ${slackSigmas} and ${thresholdSigmas}`);
  }
  const { mean, sigma } = options;
  if (!Number.isFinite(mean) || !Number.isFinite(sigma) || sigma <= 0 || !values.every(Number.isFinite)) return null;
  const slack = slackSigmas * sigma;
  const threshold = thresholdSigmas * sigma;
  let upper = 0;
  let lower = 0;
  let firstAlarm: CusumAlarm | null = null;
  for (const [index, value] of values.entries()) {
    upper = Math.max(0, upper + value - mean - slack);
    lower = Math.max(0, lower - value + mean - slack);
    if (firstAlarm !== null) continue;
    if (upper > threshold) firstAlarm = { index, side: "up" };
    else if (lower > threshold) firstAlarm = { index, side: "down" };
  }
  return { upper, lower, firstAlarm };
}
