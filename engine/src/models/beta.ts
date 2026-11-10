import { sampleCovariance, sampleVariance } from "./vol.ts";

/** One past event window: the change in YES odds (probability units) and the asset's simple return over it. */
export type EventWindow = { oddsChange: number; assetReturn: number };

/** The operator-approved β₀ and its weight κ in pseudo-observations. */
export type BetaPrior = { beta: number; weight: number };

export type EventBeta = { beta: number; sampleBeta: number | null; observations: number };

/**
 * β̂ = Cov(Δp, r) / Var(Δp) over past event windows (OLS slope of r = α + β·Δp + ε), shrunk to the prior:
 * β̃ = (n·β̂ + κ·β₀) / (n + κ); β̃ = β₀ when n < 2 or Δp never moved. Ref: MacKinlay (1997).
 * Null when a window holds a non-finite value; throws RangeError for a non-finite β₀ or κ < 0.
 */
export function eventBeta(windows: readonly EventWindow[], prior: BetaPrior): EventBeta | null {
  if (!Number.isFinite(prior.beta) || !(prior.weight >= 0) || !Number.isFinite(prior.weight)) {
    throw new RangeError(`beta prior needs a finite beta and weight >= 0, got ${prior.beta} and ${prior.weight}`);
  }
  if (!windows.every((window) => Number.isFinite(window.oddsChange) && Number.isFinite(window.assetReturn))) {
    return null;
  }
  const observations = windows.length;
  const oddsChanges = windows.map((window) => window.oddsChange);
  const oddsVariance = sampleVariance(oddsChanges);
  const covariance = sampleCovariance(
    oddsChanges,
    windows.map((window) => window.assetReturn),
  );
  // Without spread in Δp the slope is undefined, so the windows carry no evidence against the prior.
  if (oddsVariance === null || covariance === null || oddsVariance === 0) {
    return { beta: prior.beta, sampleBeta: null, observations };
  }
  const sampleBeta = covariance / oddsVariance;
  const beta = (observations * sampleBeta + prior.weight * prior.beta) / (observations + prior.weight);
  return { beta, sampleBeta, observations };
}

/** Book USD delta E_a in one asset and its shrunk event beta β̃_a. */
export type AssetExposure = { asset: string; exposureUsd: number; beta: number };

export type ScenarioPnl = { totalUsd: number; byAsset: { asset: string; pnlUsd: number }[] };

/**
 * ΔV = Σ_a E_a · β̃_a · Δp: the book's first-order USD change when the event odds move by Δp.
 * Ref: MacKinlay (1997) for β̃. Null when any input is non-finite.
 */
export function scenarioPnl(exposures: readonly AssetExposure[], oddsChange: number): ScenarioPnl | null {
  if (!Number.isFinite(oddsChange)) return null;
  if (!exposures.every((entry) => Number.isFinite(entry.exposureUsd) && Number.isFinite(entry.beta))) return null;
  const byAsset = exposures.map((entry) => ({ asset: entry.asset, pnlUsd: entry.exposureUsd * entry.beta * oddsChange }));
  return { totalUsd: byAsset.reduce((sum, entry) => sum + entry.pnlUsd, 0), byAsset };
}

/** Δp = 1 − p: the move in YES odds if the event resolves YES. Null for p outside [0, 1] or non-finite. */
export function oddsChangeIfYes(probability: number): number | null {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) return null;
  return 1 - probability;
}
