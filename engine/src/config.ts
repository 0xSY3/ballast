import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFixed } from "./decimal.ts";
import {
  asArray,
  asRecord,
  readNumber,
  readString,
  type JsonRecord,
} from "./json.ts";

export type RiskOffWhen = "yes_up" | "yes_down";

export type KalshiLeg = { source: "kalshi"; series: string; ticker: string };
export type PolymarketLeg = { source: "polymarket"; slug: string };
export type OddsLeg = KalshiLeg | PolymarketLeg;

export type WatchEvent = {
  id: string;
  label: string;
  resolvesAt: string;
  riskOffWhen: RiskOffWhen;
  legs: OddsLeg[];
  affects: { asset: string; weight: number }[];
};

export type BookPosition = {
  asset: string;
  label: string;
  exposureUsd: bigint;
  currentHedgeUsd: bigint;
  market: { ticker: string; marketId: string };
};

export type Policy = {
  macro: {
    windowMinutes: number;
    thresholdPts: number;
    fullScalePts: number;
    maxQuoteSpreadPts: number;
    maxLastTradeAgeMinutes: number;
    historyLookbackHours: number;
  };
  funding: { zThreshold: number; zFullScale: number; historyDays: number; minSamples: number };
  basis: { thresholdPct: number; fullScalePct: number };
  spread: { thresholdBps: number; fullScaleBps: number };
  oracle: { maxAgeSeconds: number };
  hedge: {
    maxHedgeRatio: number;
    minOrderUsd: bigint;
    maxOrderUsd: bigint;
    cooldownMinutes: number;
    priceBandBps: number;
    leverage: bigint;
    minConfidence: number;
  };
  confidence: { singleVenue: number; oneSided: number };
  vector: { ttlSeconds: number };
  watch: { intervalSeconds: number };
  network: { timeoutMs: number; retries: number; backoffMs: number };
};

export type EngineConfig = { watchlist: WatchEvent[]; book: BookPosition[]; policy: Policy };

export async function loadConfig(directory: string): Promise<EngineConfig> {
  const [watchlist, book, policy] = await Promise.all(
    ["watchlist.json", "book.json", "policy.json"].map((name) => readJsonFile(join(directory, name))),
  );
  return {
    watchlist: parseWatchlist(watchlist),
    book: parseBook(book),
    policy: parsePolicy(policy),
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON`, { cause: error });
  }
}

export function parseWatchlist(raw: unknown): WatchEvent[] {
  const events = asArray(asRecord(raw, "watchlist").events, "watchlist.events");
  if (events.length === 0) throw new Error("watchlist.events is empty");
  const parsed = events.map((entry, index) => parseWatchEvent(entry, `watchlist.events[${index}]`));
  assertUnique(parsed.map((event) => event.id), "watchlist event id");
  // One market feeding two events would count the same move twice in a vector's intensity.
  assertUnique(
    parsed.flatMap((event) => event.legs.map((leg) => (leg.source === "kalshi" ? `kalshi:${leg.ticker}` : `polymarket:${leg.slug}`))),
    "watchlist leg",
  );
  return parsed;
}

function parseWatchEvent(raw: unknown, path: string): WatchEvent {
  const record = asRecord(raw, path);
  const riskOffWhen = readString(record, "riskOffWhen", path);
  if (riskOffWhen !== "yes_up" && riskOffWhen !== "yes_down") {
    throw new Error(`${path}.riskOffWhen must be "yes_up" or "yes_down"`);
  }
  const legs = asArray(record.legs, `${path}.legs`).map((leg, index) => parseLeg(leg, `${path}.legs[${index}]`));
  if (legs.length === 0) throw new Error(`${path}.legs is empty`);
  const affects = asArray(record.affects, `${path}.affects`).map((item, index) => {
    const entry = asRecord(item, `${path}.affects[${index}]`);
    const weight = readNumber(entry, "weight", `${path}.affects[${index}]`);
    if (weight <= 0 || weight > 1) throw new Error(`${path}.affects[${index}].weight must be in (0, 1]`);
    return { asset: readString(entry, "asset", `${path}.affects[${index}]`), weight };
  });
  return {
    id: readString(record, "id", path),
    label: readString(record, "label", path),
    resolvesAt: readIsoDate(record, "resolvesAt", path),
    riskOffWhen,
    legs,
    affects,
  };
}

function parseLeg(raw: unknown, path: string): OddsLeg {
  const record = asRecord(raw, path);
  const source = readString(record, "source", path);
  if (source === "kalshi") {
    return { source, series: readString(record, "series", path), ticker: readString(record, "ticker", path) };
  }
  if (source === "polymarket") return { source, slug: readString(record, "slug", path) };
  throw new Error(`${path}.source must be "kalshi" or "polymarket"`);
}

export function parseBook(raw: unknown): BookPosition[] {
  const positions = asArray(asRecord(raw, "book").positions, "book.positions");
  const parsed = positions.map((entry, index) => {
    const path = `book.positions[${index}]`;
    const record = asRecord(entry, path);
    const market = asRecord(record.market, `${path}.market`);
    const currentHedgeUsd = readAmount(record, "currentHedgeUsd", path);
    if (currentHedgeUsd < 0n) throw new Error(`${path}.currentHedgeUsd must not be negative`);
    return {
      asset: readString(record, "asset", path),
      label: readString(record, "label", path),
      exposureUsd: readAmount(record, "exposureUsd", path),
      currentHedgeUsd,
      market: {
        ticker: readString(market, "ticker", `${path}.market`),
        marketId: readMarketId(market, `${path}.market`),
      },
    };
  });
  assertUnique(parsed.map((position) => position.market.marketId), "book market id");
  return parsed;
}

export function parsePolicy(raw: unknown): Policy {
  const root = asRecord(raw, "policy");
  const section = (name: string) => asRecord(root[name], `policy.${name}`);
  const macro = section("macro");
  const funding = section("funding");
  const basis = section("basis");
  const spread = section("spread");
  const oracle = section("oracle");
  const hedge = section("hedge");
  const confidence = section("confidence");
  const vector = section("vector");
  const watch = section("watch");
  const network = section("network");
  const policy: Policy = {
    macro: {
      windowMinutes: positive(macro, "windowMinutes", "policy.macro"),
      thresholdPts: positive(macro, "thresholdPts", "policy.macro"),
      fullScalePts: positive(macro, "fullScalePts", "policy.macro"),
      maxQuoteSpreadPts: positive(macro, "maxQuoteSpreadPts", "policy.macro"),
      maxLastTradeAgeMinutes: positive(macro, "maxLastTradeAgeMinutes", "policy.macro"),
      historyLookbackHours: positive(macro, "historyLookbackHours", "policy.macro"),
    },
    funding: {
      zThreshold: positive(funding, "zThreshold", "policy.funding"),
      zFullScale: positive(funding, "zFullScale", "policy.funding"),
      historyDays: positive(funding, "historyDays", "policy.funding"),
      minSamples: positive(funding, "minSamples", "policy.funding"),
    },
    basis: {
      thresholdPct: positive(basis, "thresholdPct", "policy.basis"),
      fullScalePct: positive(basis, "fullScalePct", "policy.basis"),
    },
    spread: {
      thresholdBps: positive(spread, "thresholdBps", "policy.spread"),
      fullScaleBps: positive(spread, "fullScaleBps", "policy.spread"),
    },
    oracle: { maxAgeSeconds: positive(oracle, "maxAgeSeconds", "policy.oracle") },
    hedge: {
      maxHedgeRatio: fraction(hedge, "maxHedgeRatio", "policy.hedge"),
      minOrderUsd: readAmount(hedge, "minOrderUsd", "policy.hedge"),
      maxOrderUsd: readAmount(hedge, "maxOrderUsd", "policy.hedge"),
      cooldownMinutes: positive(hedge, "cooldownMinutes", "policy.hedge"),
      priceBandBps: positive(hedge, "priceBandBps", "policy.hedge"),
      leverage: readAmount(hedge, "leverage", "policy.hedge"),
      minConfidence: fraction(hedge, "minConfidence", "policy.hedge"),
    },
    confidence: {
      singleVenue: fraction(confidence, "singleVenue", "policy.confidence"),
      oneSided: fraction(confidence, "oneSided", "policy.confidence"),
    },
    vector: { ttlSeconds: positive(vector, "ttlSeconds", "policy.vector") },
    watch: { intervalSeconds: positive(watch, "intervalSeconds", "policy.watch") },
    network: {
      timeoutMs: positive(network, "timeoutMs", "policy.network"),
      retries: nonNegativeInteger(network, "retries", "policy.network"),
      backoffMs: positive(network, "backoffMs", "policy.network"),
    },
  };
  assertPolicyConsistent(policy);
  return policy;
}

function assertPolicyConsistent(policy: Policy): void {
  if (policy.macro.fullScalePts < policy.macro.thresholdPts) throw new Error("policy.macro.fullScalePts < thresholdPts");
  if (policy.funding.zFullScale < policy.funding.zThreshold) throw new Error("policy.funding.zFullScale < zThreshold");
  if (policy.basis.fullScalePct < policy.basis.thresholdPct) throw new Error("policy.basis.fullScalePct < thresholdPct");
  if (policy.spread.fullScaleBps < policy.spread.thresholdBps) throw new Error("policy.spread.fullScaleBps < thresholdBps");
  if (policy.hedge.minOrderUsd <= 0n) throw new Error("policy.hedge.minOrderUsd must be positive");
  if (policy.hedge.maxOrderUsd < policy.hedge.minOrderUsd) throw new Error("policy.hedge.maxOrderUsd < minOrderUsd");
  if (policy.hedge.leverage < parseFixed("1")) throw new Error("policy.hedge.leverage must be at least 1");
  if (policy.hedge.priceBandBps >= 10_000) throw new Error("policy.hedge.priceBandBps must be below 10000");
}

function readAmount(record: JsonRecord, key: string, path: string): bigint {
  const text = readString(record, key, path);
  try {
    return parseFixed(text);
  } catch (error) {
    throw new Error(`${path}.${key} must be a decimal string`, { cause: error });
  }
}

function readMarketId(record: JsonRecord, path: string): string {
  const marketId = readString(record, "marketId", path);
  // 0x and 32 bytes of hex: the shape of every Injective derivative market id.
  if (!/^0x[0-9a-fA-F]{64}$/.test(marketId)) throw new Error(`${path}.marketId is not an Injective market id`);
  return marketId;
}

function readIsoDate(record: JsonRecord, key: string, path: string): string {
  const text = readString(record, key, path);
  if (Number.isNaN(Date.parse(text))) throw new Error(`${path}.${key} is not an ISO date`);
  return text;
}

function positive(record: JsonRecord, key: string, path: string): number {
  const value = readNumber(record, key, path);
  if (value <= 0) throw new Error(`${path}.${key} must be positive`);
  return value;
}

function fraction(record: JsonRecord, key: string, path: string): number {
  const value = readNumber(record, key, path);
  if (value <= 0 || value > 1) throw new Error(`${path}.${key} must be in (0, 1]`);
  return value;
}

function nonNegativeInteger(record: JsonRecord, key: string, path: string): number {
  const value = readNumber(record, key, path);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${path}.${key} must be a whole number >= 0`);
  return value;
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}
