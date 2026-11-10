// Decay factor RiskMetrics sets for daily data (J.P. Morgan/Reuters, RiskMetrics Technical Document, 1996).
export const RISKMETRICS_LAMBDA = 0.94;
export const EWMA_SEED_COUNT = 10;

export type EwmaOptions = { lambda?: number; seedCount?: number };

/** r_t = P_t / P_{t−1} − 1. Empty for fewer than two prices; null when any price is non-finite or not positive. */
export function simpleReturns(prices: readonly number[]): number[] | null {
  if (!prices.every((price) => Number.isFinite(price) && price > 0)) return null;
  return consecutive(prices).map(([before, after]) => after / before - 1);
}

/** s² = Σ(x − x̄)² / (n − 1). Null for n < 2 or any non-finite value. */
export function sampleVariance(values: readonly number[]): number | null {
  return sampleCovariance(values, values);
}

/** s_xy = Σ(x − x̄)(y − ȳ) / (n − 1). Null when the lengths differ, n < 2, or any value is non-finite. */
export function sampleCovariance(a: readonly number[], b: readonly number[]): number | null {
  const pairs = finitePairs(a, b);
  const first = pairs?.[0];
  if (!pairs || !first || pairs.length < 2) return null;
  // Shifting by the first pair keeps a constant series at exactly zero and limits cancellation error.
  const [x0, y0] = first;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  for (const [x, y] of pairs) {
    sumX += x - x0;
    sumY += y - y0;
    sumXY += (x - x0) * (y - y0);
  }
  return (sumXY - (sumX * sumY) / pairs.length) / (pairs.length - 1);
}

/**
 * σ²_t = λ·σ²_{t−1} + (1 − λ)·r²_{t−1}, λ = 0.94, seeded with the sample variance of the first 10 returns.
 * Ref: J.P. Morgan/Reuters, RiskMetrics Technical Document (1996). Null when n < seedCount or any return is non-finite.
 */
export function ewmaVariance(returns: readonly number[], options: EwmaOptions = {}): number | null {
  return ewmaCovariance(returns, returns, options);
}

/** σ_t = √σ²_t with σ²_t from {@link ewmaVariance}. Ref: RiskMetrics (1996). */
export function ewmaVolatility(returns: readonly number[], options: EwmaOptions = {}): number | null {
  const variance = ewmaVariance(returns, options);
  return variance === null ? null : Math.sqrt(variance);
}

/**
 * c_t = λ·c_{t−1} + (1 − λ)·a_{t−1}·b_{t−1}, seeded with the sample covariance of the first 10 pairs.
 * Ref: RiskMetrics (1996). Null when the series differ in length, n < seedCount, or any value is non-finite.
 */
export function ewmaCovariance(a: readonly number[], b: readonly number[], options: EwmaOptions = {}): number | null {
  const { lambda, seedCount } = resolveEwmaOptions(options);
  const pairs = finitePairs(a, b);
  if (pairs === null || pairs.length < seedCount) return null;
  const seed = sampleCovariance(a.slice(0, seedCount), b.slice(0, seedCount));
  if (seed === null) return null;
  // RiskMetrics treats returns as zero-mean once seeded, so updates use raw cross-products.
  return pairs.slice(seedCount).reduce((covariance, [x, y]) => lambda * covariance + (1 - lambda) * x * y, seed);
}

function resolveEwmaOptions(options: EwmaOptions): { lambda: number; seedCount: number } {
  const lambda = options.lambda ?? RISKMETRICS_LAMBDA;
  const seedCount = options.seedCount ?? EWMA_SEED_COUNT;
  if (!(lambda > 0 && lambda < 1)) throw new RangeError(`EWMA lambda must be in (0, 1), got ${lambda}`);
  // The seed is a sample variance, whose n − 1 denominator needs at least two points.
  if (!Number.isInteger(seedCount) || seedCount < 2) {
    throw new RangeError(`EWMA seedCount must be an integer of at least 2, got ${seedCount}`);
  }
  return { lambda, seedCount };
}

function finitePairs(a: readonly number[], b: readonly number[]): [number, number][] | null {
  if (a.length !== b.length) return null;
  const pairs: [number, number][] = [];
  for (const [index, x] of a.entries()) {
    const y = b[index];
    if (y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    pairs.push([x, y]);
  }
  return pairs;
}

function consecutive(values: readonly number[]): [number, number][] {
  const pairs: [number, number][] = [];
  let previous: number | undefined;
  for (const value of values) {
    if (previous !== undefined) pairs.push([previous, value]);
    previous = value;
  }
  return pairs;
}
