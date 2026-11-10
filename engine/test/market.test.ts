import { describe, expect, test } from "bun:test";
import { parseFixed } from "../src/decimal.ts";
import { assessMarket, type FundingPoint, type MarketObservation } from "../src/detect/market.ts";
import { shippedPolicy } from "./support/builders.ts";

const policy = shippedPolicy();
const now = new Date("2026-11-10T09:00:00.000Z");
const HOUR = 3_600_000;

/** A calm BTC-like market: 2 bps spread around $100,000, oracle 5 s old, no funding history. */
function observation(overrides: Partial<MarketObservation> = {}): MarketObservation {
  return {
    ticker: "BTC/USDT PERP",
    perpPrice: parseFixed("100000"),
    oraclePrice: parseFixed("100000"),
    oracleTimestampMs: now.getTime() - 5_000,
    bids: [
      { price: parseFixed("99990"), quantity: parseFixed("0.5") },
      { price: parseFixed("98000"), quantity: parseFixed("5") },
    ],
    asks: [
      { price: parseFixed("100010"), quantity: parseFixed("0.5") },
      { price: parseFixed("102000"), quantity: parseFixed("5") },
    ],
    fundingHistory: [],
    ...overrides,
  };
}

/** Hourly history alternating between two rates (mean 0.0002, stdev 0.0001), then `latest`. */
function fundingHistory(count: number, latest: number): FundingPoint[] {
  const prior = Array.from({ length: count }, (_, index) => ({
    rate: index % 2 === 0 ? 0.0001 : 0.0003,
    timestampMs: now.getTime() - (count - index + 1) * HOUR,
  }));
  return [...prior, { rate: latest, timestampMs: now.getTime() - HOUR }];
}

function driverStrength(input: MarketObservation, metric: string): number | undefined {
  const { drivers } = assessMarket(input, "sell", now, policy);
  return drivers.find((driver) => driver.signalId === `injective:${input.ticker}:${metric}`)?.strength;
}

function signalOf(input: MarketObservation, metric: string) {
  return assessMarket(input, "sell", now, policy).signals.find((signal) => signal.metric === metric);
}

describe("spread detector", () => {
  test("a 32 bps spread scores 0.32 against the 25 bps trigger and 100 bps full scale", () => {
    // #given a book quoted 99,840 / 100,160
    const wide = observation({
      bids: [{ price: parseFixed("99840"), quantity: parseFixed("1") }],
      asks: [{ price: parseFixed("100160"), quantity: parseFixed("1") }],
    });
    // #when the market is assessed
    const strength = driverStrength(wide, "spread");
    // #then the spread driver is linear in bps
    expect(strength).toBe(0.32);
  });

  test("a spread of exactly 25 bps triggers at the threshold", () => {
    // #given a book quoted 99,875 / 100,125
    const atThreshold = observation({
      bids: [{ price: parseFixed("99875"), quantity: parseFixed("1") }],
      asks: [{ price: parseFixed("100125"), quantity: parseFixed("1") }],
    });
    // #when / #then the boundary value counts
    expect(driverStrength(atThreshold, "spread")).toBe(0.25);
  });

  test("a tight spread is reported as a signal without a driver", () => {
    // #given the default 2 bps book
    // #when the market is assessed
    const spread = signalOf(observation(), "spread");
    // #then the signal carries the fraction of mid and no driver exists
    expect({ value: spread?.value, driver: driverStrength(observation(), "spread") }).toEqual({ value: 0.0002, driver: undefined });
  });

  test("a one-sided book produces no spread signal at all", () => {
    // #given a book with no asks
    const oneSided = observation({ asks: [] });
    // #when / #then nothing is invented for the missing side
    expect(signalOf(oneSided, "spread")).toBeUndefined();
  });
});

describe("basis detector", () => {
  test("a perp 0.6% above a fresh oracle scores 0.4 against 0.4% trigger and 1.5% full scale", () => {
    // #given the perp at 100,600 and the oracle at 100,000
    const rich = observation({ perpPrice: parseFixed("100600") });
    // #when / #then
    expect(driverStrength(rich, "basis")).toBe(0.4);
  });

  test("a perp below the oracle counts the same as above it", () => {
    // #given the perp at 99,400 against a 100,000 oracle
    const cheap = observation({ perpPrice: parseFixed("99400") });
    // #when / #then
    expect(driverStrength(cheap, "basis")).toBe(0.4);
  });

  test("basis never drives a hedge when the oracle is stale", () => {
    // #given a 0.6% gap but an oracle 10 minutes old
    const stale = observation({ perpPrice: parseFixed("100600"), oracleTimestampMs: now.getTime() - 600_000 });
    // #when / #then
    expect(driverStrength(stale, "basis")).toBeUndefined();
  });

  test("a 0.3% gap stays under the trigger", () => {
    // #given the perp at 100,300
    const small = observation({ perpPrice: parseFixed("100300") });
    // #when / #then
    expect(driverStrength(small, "basis")).toBeUndefined();
  });
});

describe("funding detector", () => {
  test("a rate 3 standard deviations above its 7-day mean scores 0.6", () => {
    // #given 30 hourly samples (mean 0.0002, stdev 0.0001) and a latest rate of 0.0005
    const spiking = observation({ fundingHistory: fundingHistory(30, 0.0005) });
    // #when / #then z = 3 against the 2.5 trigger and 5 full scale
    expect(driverStrength(spiking, "funding_rate")).toBe(0.6);
  });

  test("the negative tail counts too", () => {
    // #given the same history and a latest rate of -0.0001 (z = -3)
    const crashing = observation({ fundingHistory: fundingHistory(30, -0.0001) });
    // #when / #then
    expect(driverStrength(crashing, "funding_rate")).toBe(0.6);
  });

  test("the signal reports the latest rate, the trailing mean and the z-score", () => {
    // #given a z = 3 history
    const spiking = observation({ fundingHistory: fundingHistory(30, 0.0005) });
    // #when
    const funding = signalOf(spiking, "funding_rate");
    // #then
    expect({ value: funding?.value, baseline: funding?.baseline, change: funding?.change }).toEqual({
      value: 0.0005,
      baseline: 0.0002,
      change: 3,
    });
  });

  test("too few samples gives a signal with no z-score and no driver", () => {
    // #given 10 prior samples where policy needs 24
    const thin = observation({ fundingHistory: fundingHistory(10, 0.0005) });
    // #when
    const funding = signalOf(thin, "funding_rate");
    // #then
    expect({ change: funding?.change, note: funding?.quality.note }).toEqual({
      change: null,
      note: "only 10 funding samples in 7 days",
    });
  });

  test("a flat history cannot produce a z-score", () => {
    // #given 30 identical samples and a different latest rate
    const flat = observation({
      fundingHistory: [
        ...Array.from({ length: 30 }, (_, index) => ({ rate: 0.0001, timestampMs: now.getTime() - (31 - index) * HOUR })),
        { rate: 0.0009, timestampMs: now.getTime() - HOUR },
      ],
    });
    // #when / #then
    expect(driverStrength(flat, "funding_rate")).toBeUndefined();
  });

  test("samples older than the history window are ignored", () => {
    // #given 30 samples that are all more than 7 days old
    const old = fundingHistory(30, 0.0005).map((point, index, all) =>
      index < all.length - 1 ? { ...point, timestampMs: point.timestampMs - 8 * 24 * HOUR } : point,
    );
    // #when
    const funding = signalOf(observation({ fundingHistory: old }), "funding_rate");
    // #then
    expect(funding?.quality.note).toBe("only 0 funding samples in 7 days");
  });
});

describe("oracle age and depth", () => {
  test("an oracle older than 120 s is marked stale", () => {
    // #given an oracle timestamp 121 s old
    const stale = observation({ oracleTimestampMs: now.getTime() - 121_000 });
    // #when / #then
    expect(signalOf(stale, "oracle_age")?.quality.fresh).toBe(false);
  });

  test("an oracle exactly 120 s old is still fresh", () => {
    // #given an oracle timestamp 120 s old
    const boundary = observation({ oracleTimestampMs: now.getTime() - 120_000 });
    // #when / #then
    expect(signalOf(boundary, "oracle_age")?.quality.fresh).toBe(true);
  });

  test("a missing oracle timestamp reports no age for the hedge gate", () => {
    // #given no oracle timestamp
    const missing = observation({ oracleTimestampMs: null });
    // #when / #then
    expect(assessMarket(missing, "sell", now, policy).oracleAgeSeconds).toBeNull();
  });

  test("depth for a sell hedge counts only bids within 1% of mid", () => {
    // #given 0.5 BTC bid at 99,990 and 5 BTC bid at 98,000 (outside the band)
    // #when / #then only the first level counts: 0.5 x 99,990
    expect(signalOf(observation(), "depth")?.value).toBe(49995);
  });

  test("an empty market yields no drivers", () => {
    // #given no book, no prices, no oracle and no funding
    const empty = observation({ perpPrice: null, oraclePrice: null, oracleTimestampMs: null, bids: [], asks: [] });
    // #when / #then
    expect(assessMarket(empty, "sell", now, policy)).toEqual({ signals: [], drivers: [], oracleAgeSeconds: null });
  });
});
