import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBook, parsePolicy, parseWatchlist, type BookPosition, type Policy, type WatchEvent } from "../../src/config.ts";
import { parseFixed } from "../../src/decimal.ts";
import type { HedgeMarket } from "../../src/policy.ts";
import type { RiskVector, Signal } from "../../src/types.ts";

export const ENGINE_DIR = join(import.meta.dir, "..", "..");
export const FIXTURES_DIR = join(ENGINE_DIR, "test", "fixtures");

function readConfigFile(name: string): unknown {
  return JSON.parse(readFileSync(join(ENGINE_DIR, "config", name), "utf8"));
}

/** The shipped operator defaults, so tests exercise the same numbers the README documents. */
export function shippedPolicy(): Policy {
  return parsePolicy(readConfigFile("policy.json"));
}

export function shippedWatchlist(): WatchEvent[] {
  return parseWatchlist(readConfigFile("watchlist.json"));
}

export function shippedBook(): BookPosition[] {
  return parseBook(readConfigFile("book.json"));
}

export function policyWith(patch: (policy: Policy) => void): Policy {
  const policy = shippedPolicy();
  patch(policy);
  return policy;
}

export const TEST_EVENT: WatchEvent = {
  id: "test-event",
  label: "Test event",
  resolvesAt: "2026-12-09T19:00:00Z",
  riskOffWhen: "yes_up",
  legs: [{ source: "kalshi", series: "KXTEST", ticker: "KXTEST-1" }],
  affects: [{ asset: "BTC", weight: 1 }],
};

export function oddsSignal(overrides: Partial<Signal> & Pick<Signal, "id">): Signal {
  return {
    kind: "macro",
    source: "kalshi",
    subject: "Test event",
    metric: "yes_odds",
    value: 0.6,
    baseline: 0.5,
    change: 0.1,
    observedAt: "2026-11-10T09:00:00.000Z",
    quality: { fresh: true, twoSided: true },
    ...overrides,
  };
}

/** A BTC-like perp: $100,000 mid, 0.0001 BTC quantity tick, $1 price tick, 5% initial margin. */
export function hedgeMarket(overrides: Partial<HedgeMarket> = {}): HedgeMarket {
  return {
    marketId: "0xmarket",
    ticker: "BTC/USDT PERP",
    bids: [
      { price: parseFixed("99990"), quantity: parseFixed("0.5") },
      { price: parseFixed("99500"), quantity: parseFixed("1") },
      { price: parseFixed("98000"), quantity: parseFixed("5") },
    ],
    asks: [
      { price: parseFixed("100010"), quantity: parseFixed("0.5") },
      { price: parseFixed("100500"), quantity: parseFixed("1") },
      { price: parseFixed("102000"), quantity: parseFixed("5") },
    ],
    minPriceTick: parseFixed("1"),
    minQuantityTick: parseFixed("0.0001"),
    minNotional: parseFixed("1"),
    initialMarginRatio: parseFixed("0.05"),
    quoteDecimals: 6,
    oracleAgeSeconds: 5,
    ...overrides,
  };
}

export function riskVector(overrides: Partial<RiskVector> = {}): RiskVector {
  return {
    id: "a".repeat(64),
    createdAt: "2026-11-10T09:00:00.000Z",
    market: { ticker: "BTC/USDT PERP", marketId: "0xmarket" },
    hedgeSide: "sell",
    intensity: 0.5,
    confidence: 1,
    ttlSeconds: 600,
    drivers: [{ signalId: "kalshi:KXTEST-1", strength: 0.5, note: "test" }],
    ...overrides,
  };
}
