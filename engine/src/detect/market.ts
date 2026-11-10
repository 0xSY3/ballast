import type { Policy } from "../config.ts";
import { divFixed, fixedFromRatio, fixedToNumber, mulFixed } from "../decimal.ts";
import { roundTo, scaledStrength } from "../math.ts";
import type { BookLevel } from "../policy.ts";
import type { DriverCandidate } from "../score.ts";
import type { HedgeSide, Signal, SignalMetric } from "../types.ts";

export type FundingPoint = { rate: number; timestampMs: number };

/** A derivative market as the detectors see it; prices are human units (quote per base). */
export type MarketObservation = {
  ticker: string;
  /** The market's own price, compared with the oracle for basis. */
  perpPrice: bigint | null;
  oraclePrice: bigint | null;
  oracleTimestampMs: number | null;
  bids: BookLevel[];
  asks: BookLevel[];
  fundingHistory: FundingPoint[];
};

export type MarketAssessment = {
  signals: Signal[];
  drivers: DriverCandidate[];
  oracleAgeSeconds: number | null;
};

type Reading = { signal: Signal; driver: DriverCandidate | null };

const BPS = 10_000;
// Funding rates are quoted to at most 18 decimals and sit around 1e-5..1e-3 per interval, so a
// spread below this is float residue from averaging identical values, not real dispersion.
const FLAT_FUNDING_STDEV = 1e-12;

export function assessMarket(
  observation: MarketObservation,
  hedgeSide: HedgeSide,
  now: Date,
  policy: Policy,
): MarketAssessment {
  const oracleAgeSeconds = observation.oracleTimestampMs === null
    ? null
    : Math.max(0, (now.getTime() - observation.oracleTimestampMs) / 1000);
  const oracleFresh = oracleAgeSeconds !== null && oracleAgeSeconds <= policy.oracle.maxAgeSeconds;
  const readings: Reading[] = [
    oracleAgeReading(observation, oracleAgeSeconds, oracleFresh, now, policy),
    spreadReading(observation, now, policy),
    basisReading(observation, oracleFresh, now, policy),
    fundingReading(observation, now, policy),
    depthReading(observation, hedgeSide, now, policy),
  ].filter((reading): reading is Reading => reading !== null);
  return {
    signals: readings.map((reading) => reading.signal),
    drivers: readings.flatMap((reading) => (reading.driver ? [reading.driver] : [])),
    oracleAgeSeconds,
  };
}

function marketSignal(
  observation: MarketObservation,
  metric: SignalMetric,
  now: Date,
  fields: Pick<Signal, "value" | "baseline" | "change" | "quality"> & { subject: string },
): Signal {
  return {
    id: `injective:${observation.ticker}:${metric}`,
    kind: "market",
    source: "injective",
    subject: fields.subject,
    metric,
    value: fields.value,
    baseline: fields.baseline,
    change: fields.change,
    observedAt: now.toISOString(),
    quality: fields.quality,
  };
}

function oracleAgeReading(
  observation: MarketObservation,
  ageSeconds: number | null,
  fresh: boolean,
  now: Date,
  policy: Policy,
): Reading | null {
  if (ageSeconds === null) return null;
  const quality: Signal["quality"] = { fresh, twoSided: null };
  if (!fresh) quality.note = `older than ${policy.oracle.maxAgeSeconds} s; no new hedge on this market`;
  return {
    signal: marketSignal(observation, "oracle_age", now, {
      subject: `${observation.ticker} oracle age`,
      value: roundTo(ageSeconds, 1),
      baseline: null,
      change: null,
      quality,
    }),
    driver: null,
  };
}

function topOfBook(observation: MarketObservation): { bid: bigint; ask: bigint; mid: bigint } | null {
  const bids = observation.bids.filter((level) => level.quantity > 0n).map((level) => level.price);
  const asks = observation.asks.filter((level) => level.quantity > 0n).map((level) => level.price);
  if (bids.length === 0 || asks.length === 0) return null;
  const bid = bids.reduce((best, price) => (price > best ? price : best));
  const ask = asks.reduce((best, price) => (price < best ? price : best));
  if (ask <= bid) return null;
  return { bid, ask, mid: (bid + ask) / 2n };
}

function spreadReading(observation: MarketObservation, now: Date, policy: Policy): Reading | null {
  const top = topOfBook(observation);
  if (!top) return null;
  const fraction = fixedToNumber(divFixed(top.ask - top.bid, top.mid));
  const bps = roundTo(fraction * BPS, 2);
  const strength = scaledStrength(bps, policy.spread.thresholdBps, policy.spread.fullScaleBps);
  const signalId = `injective:${observation.ticker}:spread`;
  return {
    signal: marketSignal(observation, "spread", now, {
      subject: `${observation.ticker} bid-ask spread`,
      value: roundTo(fraction, 6),
      baseline: null,
      change: null,
      quality: { fresh: true, twoSided: true },
    }),
    driver: strength > 0
      ? { signalId, strength, quality: 1, note: `${observation.ticker} spread widened to ${bps} bps` }
      : null,
  };
}

function basisReading(observation: MarketObservation, oracleFresh: boolean, now: Date, policy: Policy): Reading | null {
  const { perpPrice, oraclePrice } = observation;
  if (perpPrice === null || oraclePrice === null || oraclePrice <= 0n) return null;
  const fraction = fixedToNumber(divFixed(perpPrice - oraclePrice, oraclePrice));
  const pct = roundTo(Math.abs(fraction) * 100, 4);
  // A stale oracle makes the gap meaningless, so it is reported but never drives a hedge.
  const strength = oracleFresh ? scaledStrength(pct, policy.basis.thresholdPct, policy.basis.fullScalePct) : 0;
  const quality: Signal["quality"] = { fresh: oracleFresh, twoSided: null };
  if (!oracleFresh) quality.note = "oracle is stale or missing; basis not used";
  const direction = fraction >= 0 ? "above" : "below";
  return {
    signal: marketSignal(observation, "basis", now, {
      subject: `${observation.ticker} perp vs oracle`,
      value: roundTo(fraction, 6),
      baseline: null,
      change: null,
      quality,
    }),
    driver: strength > 0
      ? {
          signalId: `injective:${observation.ticker}:basis`,
          strength,
          quality: 1,
          note: `${observation.ticker} trades ${roundTo(pct, 2)}% ${direction} its oracle price`,
        }
      : null,
  };
}

/**
 * Z-score of the latest funding rate against the trailing window before it. Either tail counts:
 * crowded longs and forced selling both show up as funding far from its norm.
 */
function fundingReading(observation: MarketObservation, now: Date, policy: Policy): Reading | null {
  const ordered = [...observation.fundingHistory].sort((a, b) => a.timestampMs - b.timestampMs);
  const latest = ordered.at(-1);
  if (!latest) return null;
  const windowStartMs = now.getTime() - policy.funding.historyDays * 86_400_000;
  const prior = ordered.slice(0, -1).filter((point) => point.timestampMs >= windowStartMs);
  const unscored = (baseline: number | null, note: string): Reading => ({
    signal: marketSignal(observation, "funding_rate", now, {
      subject: `${observation.ticker} funding rate`,
      value: latest.rate,
      baseline,
      change: null,
      quality: { fresh: true, twoSided: null, note },
    }),
    driver: null,
  });
  if (prior.length < policy.funding.minSamples) {
    return unscored(null, `only ${prior.length} funding samples in ${policy.funding.historyDays} days`);
  }
  const mean = prior.reduce((sum, point) => sum + point.rate, 0) / prior.length;
  const variance = prior.reduce((sum, point) => sum + (point.rate - mean) ** 2, 0) / prior.length;
  const stdev = Math.sqrt(variance);
  if (stdev < FLAT_FUNDING_STDEV) return unscored(roundTo(mean, 10), "funding history is flat; no z-score");
  const z = roundTo((latest.rate - mean) / stdev, 2);
  const strength = scaledStrength(Math.abs(z), policy.funding.zThreshold, policy.funding.zFullScale);
  const direction = z >= 0 ? "above" : "below";
  return {
    signal: marketSignal(observation, "funding_rate", now, {
      subject: `${observation.ticker} funding rate`,
      value: latest.rate,
      baseline: roundTo(mean, 10),
      change: z,
      quality: { fresh: true, twoSided: null },
    }),
    driver: strength > 0
      ? {
          signalId: `injective:${observation.ticker}:funding_rate`,
          strength,
          quality: 1,
          note: `${observation.ticker} funding ${Math.abs(z)} standard deviations ${direction} its ${policy.funding.historyDays}-day mean`,
        }
      : null,
  };
}

/** USD resting within the price band on the side a hedge would take; reported, not scored. */
function depthReading(observation: MarketObservation, hedgeSide: HedgeSide, now: Date, policy: Policy): Reading | null {
  const top = topOfBook(observation);
  if (!top) return null;
  const band = fixedFromRatio(policy.hedge.priceBandBps / BPS);
  const takesBids = hedgeSide === "sell";
  const limit = takesBids ? top.mid - mulFixed(top.mid, band) : top.mid + mulFixed(top.mid, band);
  const levels = (takesBids ? observation.bids : observation.asks).filter(
    (level) => level.quantity > 0n && (takesBids ? level.price >= limit : level.price <= limit),
  );
  const usd = levels.reduce((sum, level) => sum + mulFixed(level.price, level.quantity), 0n);
  return {
    signal: marketSignal(observation, "depth", now, {
      subject: `${observation.ticker} ${takesBids ? "bid" : "ask"} depth within ${policy.hedge.priceBandBps / 100}% of mid`,
      value: Math.floor(fixedToNumber(usd)),
      baseline: null,
      change: null,
      quality: { fresh: true, twoSided: true },
    }),
    driver: null,
  };
}
