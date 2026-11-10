import { createHash } from "node:crypto";
import type { BookPosition, Policy } from "./config.ts";
import { clamp01, roundTo } from "./math.ts";
import type { HedgeSide, RiskVector } from "./types.ts";

export type DriverCandidate = {
  signalId: string;
  strength: number;
  /** Confidence factor in (0, 1] for the data behind this driver. */
  quality: number;
  note: string;
};

/** Probabilistic OR: the chance at least one independent driver is "on". */
export function combineIntensity(strengths: number[]): number {
  const calm = strengths.reduce((product, strength) => product * (1 - clamp01(strength)), 1);
  return roundTo(1 - calm, 4);
}

/** Strength-weighted mean of driver quality, so the drivers doing the work dominate. */
export function combineConfidence(drivers: Pick<DriverCandidate, "strength" | "quality">[]): number {
  const total = drivers.reduce((sum, driver) => sum + driver.strength, 0);
  if (total <= 0) return 0;
  const weighted = drivers.reduce((sum, driver) => sum + driver.strength * clamp01(driver.quality), 0);
  return roundTo(weighted / total, 4);
}

/**
 * Start of the id window. Identical inputs inside one cooldown window hash to the same id,
 * so a retried pass reuses the order cid instead of minting a second order.
 */
export function windowStart(now: Date, cooldownMinutes: number): string {
  const windowMs = cooldownMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs).toISOString();
}

export function vectorId(input: {
  marketId: string;
  hedgeSide: HedgeSide;
  drivers: { signalId: string; strength: number }[];
  window: string;
}): string {
  const drivers = input.drivers
    .map((driver) => `${driver.signalId}=${driver.strength.toFixed(4)}`)
    .sort();
  const canonical = JSON.stringify({ market: input.marketId, side: input.hedgeSide, drivers, window: input.window });
  return createHash("sha256").update(canonical).digest("hex");
}

export function buildVector(input: {
  position: BookPosition;
  candidates: DriverCandidate[];
  now: Date;
  policy: Policy;
}): RiskVector | null {
  const { position, now, policy } = input;
  if (position.exposureUsd === 0n) return null;
  const drivers = input.candidates
    .map((driver) => ({ ...driver, strength: roundTo(clamp01(driver.strength), 4) }))
    .filter((driver) => driver.strength > 0)
    .sort((a, b) => b.strength - a.strength || a.signalId.localeCompare(b.signalId));
  if (drivers.length === 0) return null;

  const hedgeSide: HedgeSide = position.exposureUsd > 0n ? "sell" : "buy";
  return {
    id: vectorId({
      marketId: position.market.marketId,
      hedgeSide,
      drivers,
      window: windowStart(now, policy.hedge.cooldownMinutes),
    }),
    createdAt: now.toISOString(),
    market: { ticker: position.market.ticker, marketId: position.market.marketId },
    hedgeSide,
    intensity: combineIntensity(drivers.map((driver) => driver.strength)),
    confidence: combineConfidence(drivers),
    ttlSeconds: policy.vector.ttlSeconds,
    drivers: drivers.map(({ signalId, strength, note }) => ({ signalId, strength, note })),
  };
}
