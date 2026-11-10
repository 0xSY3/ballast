import type { Policy, RiskOffWhen, WatchEvent } from "../config.ts";
import { roundTo, scaledStrength } from "../math.ts";
import type { Signal, Skipped } from "../types.ts";

export type EventShock = {
  event: WatchEvent;
  strength: number;
  /** The leg that set the strength; drivers point at it. */
  signal: Signal;
  /** Confidence factor in (0, 1] from quote quality and cross-venue confirmation. */
  quality: number;
  note: string;
};

/**
 * Strength of a risk-off odds move: zero below the threshold, then linear in points
 * so the full-scale move (and anything larger) scores 1.
 */
export function oddsStrength(change: number, riskOffWhen: RiskOffWhen, macro: Policy["macro"]): number {
  const riskOffPts = (riskOffWhen === "yes_up" ? change : -change) * 100;
  return scaledStrength(riskOffPts, macro.thresholdPts, macro.fullScalePts);
}

/**
 * Collapses an event's legs into one shock so a single outcome quoted on two venues
 * counts once. With two usable legs the smaller move wins: one venue cannot trigger a hedge alone.
 */
export function evaluateEvent(
  event: WatchEvent,
  legSignals: Signal[],
  policy: Policy,
): { shock: EventShock | null; skipped: Skipped[] } {
  const usable = legSignals.filter((signal) => signal.change !== null && signal.quality.fresh);
  if (usable.length === 0) {
    const skipped = legSignals.length > 0
      ? [{ reason: "no_baseline", detail: `${event.id}: no leg has a quote from ${policy.macro.windowMinutes} min ago` }]
      : [];
    return { shock: null, skipped };
  }

  const scored = usable.map((signal) => ({
    signal,
    strength: oddsStrength(signal.change ?? 0, event.riskOffWhen, policy.macro),
  }));
  const weakest = scored.reduce((min, entry) => (entry.strength < min.strength ? entry : min));
  if (weakest.strength === 0) return { shock: null, skipped: [] };

  const confirmed = usable.length >= 2;
  const quoteFactor = weakest.signal.quality.twoSided === false ? policy.confidence.oneSided : 1;
  const venueFactor = confirmed ? 1 : policy.confidence.singleVenue;
  return {
    shock: {
      event,
      strength: weakest.strength,
      signal: weakest.signal,
      quality: quoteFactor * venueFactor,
      note: describeMove(event, weakest.signal, usable, policy.macro.windowMinutes),
    },
    skipped: [],
  };
}

function describeMove(event: WatchEvent, signal: Signal, usable: Signal[], windowMinutes: number): string {
  const from = asPercent(signal.baseline ?? signal.value);
  const to = asPercent(signal.value);
  const venues = usable.map((leg) => venueName(leg.source));
  const where = venues.length >= 2 ? `${venues.join(" and ")} agree` : `${venues[0] ?? "one venue"} only`;
  return `${event.label}: odds ${from} to ${to} in ${windowMinutes} min (${where})`;
}

function asPercent(probability: number): string {
  return `${roundTo(probability * 100, 1)}%`;
}

function venueName(source: Signal["source"]): string {
  if (source === "kalshi") return "Kalshi";
  if (source === "polymarket") return "Polymarket";
  return "Injective";
}
