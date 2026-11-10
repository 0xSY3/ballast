import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BookPosition } from "../src/config.ts";
import { parseFixed } from "../src/decimal.ts";
import { asRecord } from "../src/json.ts";
import type { FetchOutcome } from "../src/net.ts";
import type { MarketReading } from "../src/run.ts";
import {
  injectiveBookUrl,
  injectiveFundingUrl,
  injectiveMarketUrl,
  injectiveOracleUrl,
  parseOracle,
  parseOrderbook,
  readInjectiveMarket,
} from "../src/sources/injective.ts";
import { FIXTURES_DIR, shippedBook, shippedPolicy } from "./support/builders.ts";
import { createReplayFetcher, fixtureKey, loadManifest } from "./support/replay.ts";

const DIR = join(FIXTURES_DIR, "live");
const manifest = loadManifest(DIR);
const now = new Date(manifest.recordedAt);
const policy = shippedPolicy();
const btc = positionFor("BTC");
const BTC_ORACLE = {
  oracleType: "ChainlinkDataStreams",
  oracleBase: "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8",
  oracleQuote: "0x00038f83323b6b08116d1614cf33a9bd71ab5e0abf0c9f1b783a74a43e7bd992",
};

function positionFor(asset: string): BookPosition {
  const position = shippedBook().find((entry) => entry.asset === asset);
  if (!position) throw new Error(`book has no ${asset}`);
  return position;
}

function read(overrides: Record<string, FetchOutcome> = {}, position: BookPosition = btc): Promise<MarketReading> {
  return readInjectiveMarket(position, { fetchJson: createReplayFetcher(DIR, overrides), now, policy });
}

function recordedMarket(): Record<string, unknown> {
  const file = manifest.responses[fixtureKey(injectiveMarketUrl(btc.market.marketId))];
  if (!file) throw new Error("no BTC market fixture");
  return asRecord(JSON.parse(readFileSync(join(DIR, file), "utf8")), "fixture");
}

function marketWith(patch: Record<string, unknown>): FetchOutcome {
  const raw = recordedMarket();
  const wrapper = asRecord(raw.market, "market");
  const inner = asRecord(wrapper.market, "market.market");
  return { ok: true, data: { ...raw, market: { ...wrapper, market: { ...inner, ...patch } } } };
}

function expectOk(reading: MarketReading) {
  if (!reading.ok) throw new Error(`expected a reading, got ${reading.skip.reason}: ${reading.skip.detail}`);
  return reading;
}

const down = (what: string): FetchOutcome => ({ ok: false, error: `HTTP 503 from ${what}` });

describe("Injective reader on the recorded session", () => {
  test("reads BTC/USDC PERP ticks and quote decimals from LCD exchange v2 in human units", async () => {
    // #given the recorded LCD v2 market response
    // #when the BTC market is read
    const { market } = expectOk(await read());
    // #then
    expect({ price: market.minPriceTick, quantity: market.minQuantityTick, decimals: market.quoteDecimals }).toEqual({
      price: parseFixed("1"),
      quantity: parseFixed("0.00001"),
      decimals: 6,
    });
  });

  test("measures oracle age from the recorded oracle timestamps", async () => {
    // #given the recorded oracle state a few seconds before the recording time
    // #when read
    const { market } = expectOk(await read());
    // #then the age is fresh under the 120 s limit
    expect(market.oracleAgeSeconds !== null && market.oracleAgeSeconds < policy.oracle.maxAgeSeconds).toBe(true);
  });

  test("a market id that resolves to another ticker is refused", async () => {
    // #given the LCD answering with a different ticker for the configured id
    const wrongTicker = marketWith({ ticker: "SOL/USDC PERP" });
    // #when / #then
    const reading = await read({ [fixtureKey(injectiveMarketUrl(btc.market.marketId))]: wrongTicker });
    expect(reading.ok ? "ok" : reading.skip.reason).toBe("bad_response");
  });

  test("a paused market is skipped", async () => {
    // #given status Paused
    const paused = marketWith({ status: "Paused" });
    // #when / #then
    const reading = await read({ [fixtureKey(injectiveMarketUrl(btc.market.marketId))]: paused });
    expect(reading.ok ? "ok" : reading.skip.reason).toBe("market_not_active");
  });

  test("an order book outage fails the market: nothing can be sized without it", async () => {
    // #given the order book endpoint down
    // #when / #then
    const reading = await read({ [fixtureKey(injectiveBookUrl(btc.market.marketId))]: down("lcd orderbook") });
    expect(reading.ok ? "ok" : reading.skip.reason).toBe("source_unavailable");
  });

  test("an oracle outage keeps the reading but leaves no oracle age, so the gate blocks orders", async () => {
    // #given the oracle endpoint down
    // #when read
    const reading = expectOk(await read({ [fixtureKey(injectiveOracleUrl(BTC_ORACLE))]: down("lcd oracle") }));
    // #then the age is unknown and the outage is reported
    expect({ age: reading.market.oracleAgeSeconds, reasons: reading.skipped.map((entry) => entry.reason) }).toEqual({
      age: null,
      reasons: ["source_unavailable"],
    });
  });

  test("a funding history outage drops only the funding signal", async () => {
    // #given the Indexer funding endpoint down
    // #when read
    const reading = expectOk(await read({ [fixtureKey(injectiveFundingUrl(btc.market.marketId))]: down("indexer") }));
    // #then the other market signals remain
    expect(reading.signals.map((signal) => signal.metric)).toEqual(["oracle_age", "spread", "basis", "depth"]);
  });
});

describe("Injective response parsing", () => {
  test("the oracle timestamp is the older of the base and quote feeds", () => {
    // #given a base feed 30 s behind the quote feed
    const raw = { price_pair_state: { pair_price: "74358.5", base_timestamp: "1794302833", quote_timestamp: "1794302863" } };
    // #when / #then
    expect(parseOracle(raw)).toEqual({ price: parseFixed("74358.5"), timestampMs: 1794302833000 });
  });

  test("an order book with an empty side parses to an empty list, not an error", () => {
    // #given only bids
    const raw = { buys_price_level: [{ p: "182.52", q: "2.739" }], sells_price_level: [] };
    // #when / #then
    expect(parseOrderbook(raw).asks).toEqual([]);
  });

  test("a non-decimal price is rejected at the boundary", () => {
    // #given a level priced in scientific notation
    const raw = { buys_price_level: [{ p: "1e5", q: "1" }], sells_price_level: [] };
    // #when / #then
    expect(() => parseOrderbook(raw)).toThrow("lcd.orderbook.buys_price_level[0].p");
  });
});
