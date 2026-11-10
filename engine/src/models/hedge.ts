import { ewmaCovariance, ewmaVariance, type EwmaOptions } from "./vol.ts";

/** ρ_max: the most of an exposure the policy will ever hedge (operator setting). */
export const MAX_HEDGE_RATIO = 0.6;
/** η, the square-root impact prefactor (operator setting, not a fitted value). */
export const IMPACT_ETA = 0.7;

/**
 * h* = Cov(r_S, r_F) / Var(r_F): the hedge units per unit of exposure that minimise the hedged variance.
 * Ref: Ederington (1979). Null when Var(r_F) ≤ 0 or an input is non-finite.
 */
export function minimumVarianceHedgeRatio(covariance: number, hedgeVariance: number): number | null {
  if (!Number.isFinite(covariance) || !Number.isFinite(hedgeVariance) || hedgeVariance <= 0) return null;
  return covariance / hedgeVariance;
}

/**
 * h* = Cov(r_S, r_F) / Var(r_F) with both moments from RiskMetrics EWMA (λ = 0.94).
 * Ref: Ederington (1979); RiskMetrics (1996). Null when either moment is unavailable or Var(r_F) = 0.
 */
export function ewmaHedgeRatio(
  exposureReturns: readonly number[],
  hedgeReturns: readonly number[],
  options: EwmaOptions = {},
): number | null {
  const covariance = ewmaCovariance(exposureReturns, hedgeReturns, options);
  const variance = ewmaVariance(hedgeReturns, options);
  if (covariance === null || variance === null) return null;
  return minimumVarianceHedgeRatio(covariance, variance);
}

export type HedgeTargetInput = {
  /** I in [0, 1], the vector's noisy-OR intensity. */
  intensity: number;
  /** h*, hedge units per unit of exposure. */
  hedgeRatio: number;
  /** E, signed book USD delta: positive for a long book. */
  exposureUsd: number;
  /** H, signed USD notional of the hedge already on. */
  currentHedgeUsd: number;
  minOrderUsd: number;
  /** k_b, the band width in hedge-volatility units (operator setting). */
  bandMultiplier: number;
  /** σ_h, the hedge instrument's volatility over the rebalance interval, as a fraction. */
  hedgeVolatility: number;
  maxHedgeRatio?: number;
};

export type HedgeTarget = { targetUsd: number; tradeUsd: number; bandUsd: number; shouldTrade: boolean };

/**
 * H* = −I · h* · ρ_max · E (ρ_max = 0.6); trade q = H* − H only when |q| ≥ max(minOrder, k_b · σ_h · |E|).
 * No-trade band after Whalley & Wilmott (1997). Null for non-finite data, I outside [0, 1] or σ_h < 0;
 * throws RangeError for ρ_max outside [0, 1] or a negative minOrder or k_b.
 */
export function hedgeTarget(input: HedgeTargetInput): HedgeTarget | null {
  const maxHedgeRatio = input.maxHedgeRatio ?? MAX_HEDGE_RATIO;
  if (!(maxHedgeRatio >= 0 && maxHedgeRatio <= 1)) throw new RangeError(`maxHedgeRatio must be in [0, 1], got ${maxHedgeRatio}`);
  if (!(input.minOrderUsd >= 0) || !Number.isFinite(input.minOrderUsd)) {
    throw new RangeError(`minOrderUsd must be zero or more, got ${input.minOrderUsd}`);
  }
  if (!(input.bandMultiplier >= 0) || !Number.isFinite(input.bandMultiplier)) {
    throw new RangeError(`bandMultiplier must be zero or more, got ${input.bandMultiplier}`);
  }
  const { intensity, hedgeRatio, exposureUsd, currentHedgeUsd, hedgeVolatility } = input;
  if (![intensity, hedgeRatio, exposureUsd, currentHedgeUsd, hedgeVolatility].every(Number.isFinite)) return null;
  if (intensity < 0 || intensity > 1 || hedgeVolatility < 0) return null;
  const targetUsd = -intensity * hedgeRatio * maxHedgeRatio * exposureUsd;
  const tradeUsd = targetUsd - currentHedgeUsd;
  const bandUsd = Math.max(input.minOrderUsd, input.bandMultiplier * hedgeVolatility * Math.abs(exposureUsd));
  return { targetUsd, tradeUsd, bandUsd, shouldTrade: Math.abs(tradeUsd) >= bandUsd };
}

/** Q, V_daily and depth share one unit (USD notional or contracts); spreads and costs are in bps of mid. */
export type ImpactMarket = {
  spreadBps: number;
  /** σ_daily as a fraction (0.02 = 2%). */
  dailyVolatility: number;
  dailyVolume: number;
  eta?: number;
};

/**
 * cost_bps ≈ ½·spread_bps + η·σ_daily·√(Q / V_daily)·10⁴ (square-root impact, η = 0.7).
 * Ref: Almgren, Thum, Hauptmann & Li (2005); Tóth et al. (2011). Null for Q < 0, V_daily ≤ 0, a negative
 * spread or σ, or non-finite input; throws RangeError for η < 0.
 */
export function executionCostBps(quantity: number, market: ImpactMarket): number | null {
  const eta = resolveEta(market.eta);
  if (!isUsableMarket(market) || !Number.isFinite(quantity) || quantity < 0) return null;
  return market.spreadBps / 2 + eta * market.dailyVolatility * Math.sqrt(quantity / market.dailyVolume) * 1e4;
}

export type QuantityCap = { quantity: number; limitedBy: "slippage" | "depth" };

/**
 * Largest Q with cost_bps ≤ maxSlippageBps and Q ≤ depth within 1% of mid, where the cost bound inverts
 * {@link executionCostBps}: Q = V_daily · ((maxSlippageBps − ½·spread_bps) / (η·σ_daily·10⁴))².
 * Ref: Almgren et al. (2005); Tóth et al. (2011). Null for invalid market data or negative depth.
 */
export function maxQuantityWithinCost(
  market: ImpactMarket & { maxSlippageBps: number; depthWithinOnePercent: number },
): QuantityCap | null {
  const eta = resolveEta(market.eta);
  if (!(market.maxSlippageBps >= 0) || !Number.isFinite(market.maxSlippageBps)) {
    throw new RangeError(`maxSlippageBps must be zero or more, got ${market.maxSlippageBps}`);
  }
  const depth = market.depthWithinOnePercent;
  if (!isUsableMarket(market) || !Number.isFinite(depth) || depth < 0) return null;
  const impactBudgetBps = market.maxSlippageBps - market.spreadBps / 2;
  if (impactBudgetBps < 0) return { quantity: 0, limitedBy: "slippage" };
  const impactPerRootShare = eta * market.dailyVolatility * 1e4;
  // With no impact term the cost never grows with size, so only the book can bind.
  const costCap =
    impactPerRootShare === 0 ? Number.POSITIVE_INFINITY : market.dailyVolume * (impactBudgetBps / impactPerRootShare) ** 2;
  return depth <= costCap ? { quantity: depth, limitedBy: "depth" } : { quantity: costCap, limitedBy: "slippage" };
}

function resolveEta(eta: number | undefined): number {
  const value = eta ?? IMPACT_ETA;
  if (!(value >= 0) || !Number.isFinite(value)) throw new RangeError(`eta must be zero or more, got ${value}`);
  return value;
}

function isUsableMarket(market: ImpactMarket): boolean {
  return (
    Number.isFinite(market.spreadBps) &&
    market.spreadBps >= 0 &&
    Number.isFinite(market.dailyVolatility) &&
    market.dailyVolatility >= 0 &&
    Number.isFinite(market.dailyVolume) &&
    market.dailyVolume > 0
  );
}
