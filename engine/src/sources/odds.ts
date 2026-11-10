import type { Policy, WatchEvent } from "../config.ts";
import { roundTo } from "../math.ts";
import type { JsonFetcher } from "../net.ts";
import type { Signal, SignalSource, Skipped } from "../types.ts";

export type LegReading = { ok: true; signal: Signal } | { ok: false; skip: Skipped };

/**
 * `replay` reads odds legs from recorded history as of `now` instead of live quotes;
 * nothing after `now` is used.
 */
export type SenseContext = { fetchJson: JsonFetcher; now: Date; policy: Policy; replay?: boolean };

export type TwoSidedCheck =
  | { ok: true; mid: number }
  | { ok: false; why: string };

/** YES quote as probabilities; null means that side has no resting order. */
export function checkTwoSided(bid: number | null, ask: number | null, maxSpreadPts: number): TwoSidedCheck {
  if (bid === null || ask === null) return { ok: false, why: "one-sided quote" };
  if (ask <= bid) return { ok: false, why: `crossed quote ${bid}/${ask}` };
  const spreadPts = roundTo((ask - bid) * 100, 6);
  if (spreadPts > maxSpreadPts) return { ok: false, why: `quote ${spreadPts.toFixed(1)} pts wide` };
  return { ok: true, mid: (bid + ask) / 2 };
}

export function buildOddsSignal(input: {
  source: SignalSource;
  key: string;
  event: WatchEvent;
  value: number;
  baseline: number | null;
  now: Date;
  twoSided: boolean | null;
  note?: string;
}): Signal {
  const value = roundTo(input.value, 4);
  const baseline = input.baseline === null ? null : roundTo(input.baseline, 4);
  const quality: Signal["quality"] = { fresh: true, twoSided: input.twoSided };
  if (input.note) quality.note = input.note;
  return {
    id: `${input.source}:${input.key}`,
    kind: "macro",
    source: input.source,
    subject: input.event.label,
    metric: "yes_odds",
    value,
    baseline,
    change: baseline === null ? null : roundTo(value - baseline, 4),
    observedAt: input.now.toISOString(),
    quality,
  };
}

export function legSkip(reason: string, signalId: string, detail: string): LegReading {
  return { ok: false, skip: { reason, detail: `${signalId}: ${detail}` } };
}
