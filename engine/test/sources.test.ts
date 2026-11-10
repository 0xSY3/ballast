import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KalshiLeg, PolymarketLeg, WatchEvent } from "../src/config.ts";
import { isRecord } from "../src/json.ts";
import type { FetchOutcome } from "../src/net.ts";
import { kalshiCandlesUrl, kalshiMarketUrl, readKalshiLeg } from "../src/sources/kalshi.ts";
import type { LegReading } from "../src/sources/odds.ts";
import { clobBookUrl, clobHistoryUrl, gammaMarketUrl, readPolymarketLeg } from "../src/sources/polymarket.ts";
import { FIXTURES_DIR, shippedPolicy, shippedWatchlist } from "./support/builders.ts";
import { createReplayFetcher, fixtureKey, loadManifest } from "./support/replay.ts";

const DIR = join(FIXTURES_DIR, "live");
const manifest = loadManifest(DIR);
const now = new Date(manifest.recordedAt);
const policy = shippedPolicy();
const watchlist = shippedWatchlist();
const fomc = eventById("fomc-dec-2026");
const kalshiLeg = legOf(fomc, "kalshi");
const polymarketLeg = legOf(fomc, "polymarket");
const YES_TOKEN = "111662129652828266889360374468657435151479595863413519836161861837506140152890";

function eventById(id: string): WatchEvent {
  const event = watchlist.find((entry) => entry.id === id);
  if (!event) throw new Error(`watchlist has no ${id}`);
  return event;
}

function legOf(event: WatchEvent, source: "kalshi"): KalshiLeg;
function legOf(event: WatchEvent, source: "polymarket"): PolymarketLeg;
function legOf(event: WatchEvent, source: "kalshi" | "polymarket"): KalshiLeg | PolymarketLeg {
  const leg = event.legs.find((entry) => entry.source === source);
  if (!leg) throw new Error(`${event.id} has no ${source} leg`);
  return leg;
}

/** A recorded response, deep-copied so a test can edit it. */
function recorded(url: string): Record<string, unknown> {
  const file = manifest.responses[fixtureKey(url)];
  if (!file) throw new Error(`no fixture for ${url}`);
  const data: unknown = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  if (isRecord(data)) return data;
  return { list: data };
}

function readKalshi(overrides: Record<string, FetchOutcome> = {}, leg: KalshiLeg = kalshiLeg) {
  const fetchJson = createReplayFetcher(DIR, overrides);
  return readKalshiLeg(leg, fomc, { fetchJson, now, policy });
}

function readPolymarket(overrides: Record<string, FetchOutcome> = {}) {
  const fetchJson = createReplayFetcher(DIR, overrides);
  return readPolymarketLeg(polymarketLeg, fomc, { fetchJson, now, policy });
}

function kalshiMarketWith(patch: Record<string, unknown>): FetchOutcome {
  const response = recorded(kalshiMarketUrl(kalshiLeg));
  const market = response.market;
  if (!isRecord(market)) throw new Error("fixture has no market");
  return { ok: true, data: { ...response, market: { ...market, ...patch } } };
}

function expectSignal(reading: LegReading) {
  if (!reading.ok) throw new Error(`expected a signal, got ${reading.skip.reason}: ${reading.skip.detail}`);
  return reading.signal;
}

function expectSkip(reading: LegReading, reason: string) {
  if (reading.ok) throw new Error(`expected ${reason}, got a signal`);
  expect(reading.skip.reason).toBe(reason);
  return reading.skip.detail;
}

const key = (url: string) => fixtureKey(url);
const nowTs = Math.floor(now.getTime() / 1000);

describe("Kalshi source on recorded responses", () => {
  test("reads the live FOMC leg as a two-sided midpoint with a 60-minute baseline", async () => {
    const signal = expectSignal(await readKalshi());
    expect(signal.id).toBe("kalshi:KXFEDDECISION-26DEC-H25");
    expect(signal.metric).toBe("yes_odds");
    expect(signal.quality).toEqual({ fresh: true, twoSided: true });
    expect(signal.baseline).not.toBeNull();
    expect(signal.change).toBe(Math.round((signal.value - (signal.baseline ?? 0)) * 1e4) / 1e4);
    expect(signal.observedAt).toBe(manifest.recordedAt);
  });

  test("skips a market that is no longer active or past its close", async () => {
    expectSkip(await readKalshi({ [key(kalshiMarketUrl(kalshiLeg))]: kalshiMarketWith({ status: "closed" }) }), "market_not_active");
    const closed = kalshiMarketWith({ close_time: "2026-11-10T08:00:00Z" });
    expectSkip(await readKalshi({ [key(kalshiMarketUrl(kalshiLeg))]: closed }), "market_closed");
  });

  test("falls back to a recent last trade when the quote is one-sided", async () => {
    const oneSided = kalshiMarketWith({ yes_bid_dollars: "0.0000" });
    const candles = {
      ok: true as const,
      data: {
        candlesticks: [
          { end_period_ts: nowTs - 7200, yes_bid: { close_dollars: "0.7000" }, yes_ask: { close_dollars: "0.7100" }, price: {} },
          { end_period_ts: nowTs - 600, yes_bid: {}, yes_ask: {}, price: { close_dollars: "0.7800" } },
        ],
      },
    };
    const signal = expectSignal(
      await readKalshi({ [key(kalshiMarketUrl(kalshiLeg))]: oneSided, [key(kalshiCandlesUrl(kalshiLeg, 0, 0))]: candles }),
    );
    expect(signal.value).toBe(0.78);
    expect(signal.baseline).toBe(0.705);
    expect(signal.change).toBe(0.075);
    expect(signal.quality).toEqual({ fresh: true, twoSided: false, note: "one-sided quote; using last trade" });
  });

  test("skips a one-sided or wide quote when the last trade is too old", async () => {
    const wide = kalshiMarketWith({ yes_bid_dollars: "0.4100", yes_ask_dollars: "0.5600" });
    const candles = {
      ok: true as const,
      data: { candlesticks: [{ end_period_ts: nowTs - 3 * 3600, yes_bid: {}, yes_ask: {}, price: { close_dollars: "0.5" } }] },
    };
    const detail = expectSkip(
      await readKalshi({ [key(kalshiMarketUrl(kalshiLeg))]: wide, [key(kalshiCandlesUrl(kalshiLeg, 0, 0))]: candles }),
      "unusable_quote",
    );
    expect(detail).toContain("quote 15.0 pts wide and no trade in the last 60 min");
  });

  test("reports a missing baseline in the signal instead of inventing one", async () => {
    const candles = { ok: true as const, data: { candlesticks: [] } };
    const signal = expectSignal(await readKalshi({ [key(kalshiCandlesUrl(kalshiLeg, 0, 0))]: candles }));
    expect(signal.baseline).toBeNull();
    expect(signal.change).toBeNull();
    expect(signal.quality.note).toBe("no usable quote from 60 min ago");
  });

  test("network failures and malformed payloads become skips", async () => {
    const down = { ok: false as const, error: "timed out after 10000 ms (api.elections.kalshi.com/x)" };
    const detail = expectSkip(await readKalshi({ [key(kalshiMarketUrl(kalshiLeg))]: down }), "source_unavailable");
    expect(detail).toContain("timed out");
    const malformed = { ok: true as const, data: { market: { status: "active" } } };
    expectSkip(await readKalshi({ [key(kalshiMarketUrl(kalshiLeg))]: malformed }), "bad_response");
  });
});

describe("Polymarket source on recorded responses", () => {
  test("reads the live FOMC leg from the CLOB book with a prices-history baseline", async () => {
    const signal = expectSignal(await readPolymarket());
    expect(signal.id).toBe(`polymarket:${polymarketLeg.slug}`);
    expect(signal.quality).toEqual({ fresh: true, twoSided: true });
    expect(signal.baseline).not.toBeNull();
  });

  test("skips a closed market", async () => {
    const gamma = recorded(gammaMarketUrl(polymarketLeg)).list;
    if (!Array.isArray(gamma) || !isRecord(gamma[0])) throw new Error("fixture has no gamma market");
    const closed = { ok: true as const, data: [{ ...gamma[0], closed: true }] };
    expectSkip(await readPolymarket({ [key(gammaMarketUrl(polymarketLeg))]: closed }), "market_not_active");
  });

  test("skips a one-sided book; it has no trade time to fall back on", async () => {
    const book = { ok: true as const, data: { bids: [], asks: [{ price: "0.8", size: "100" }] } };
    const detail = expectSkip(await readPolymarket({ [key(clobBookUrl(YES_TOKEN))]: book }), "unusable_quote");
    expect(detail).toContain("one-sided quote");
  });

  test("takes the best levels whatever order the book lists them in", async () => {
    const book = {
      ok: true as const,
      data: {
        bids: [{ price: "0.70", size: "5" }, { price: "0.79", size: "5" }, { price: "0.75", size: "5" }],
        asks: [{ price: "0.90", size: "5" }, { price: "0.80", size: "5" }],
      },
    };
    const history = { ok: true as const, data: { history: [{ t: nowTs - 4000, p: 0.7 }, { t: nowTs - 60, p: 0.79 }] } };
    const signal = expectSignal(
      await readPolymarket({ [key(clobBookUrl(YES_TOKEN))]: book, [key(clobHistoryUrl(YES_TOKEN, 0, 0))]: history }),
    );
    expect(signal.value).toBe(0.795);
    expect(signal.baseline).toBe(0.7);
    expect(signal.change).toBe(0.095);
  });

  test("an unknown slug or a fetch failure becomes a skip", async () => {
    expectSkip(await readPolymarket({ [key(gammaMarketUrl(polymarketLeg))]: { ok: true, data: [] } }), "bad_response");
    const down = { ok: false as const, error: "HTTP 503 from clob.polymarket.com/prices-history" };
    expectSkip(await readPolymarket({ [key(clobHistoryUrl(YES_TOKEN, 0, 0))]: down }), "source_unavailable");
  });
});
