import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { KalshiLeg, PolymarketLeg, WatchEvent } from "../src/config.ts";
import { parseReplayAt } from "../src/cli.ts";
import { createLiveDeps } from "../src/live.ts";
import type { FetchOutcome, JsonFetcher } from "../src/net.ts";
import { emptyState, runPass } from "../src/run.ts";
import { readKalshiLeg } from "../src/sources/kalshi.ts";
import type { LegReading, SenseContext } from "../src/sources/odds.ts";
import { readPolymarketLeg } from "../src/sources/polymarket.ts";
import { FIXTURES_DIR, shippedBook, shippedPolicy, shippedWatchlist, TEST_EVENT } from "./support/builders.ts";
import { createReplayFetcher, loadManifest } from "./support/replay.ts";

const REPLAY_AT = new Date("2026-11-06T13:50:00Z");
const T = REPLAY_AT.getTime() / 1000;
const policy = shippedPolicy();
const event: WatchEvent = TEST_EVENT;
const kalshiLeg: KalshiLeg = { source: "kalshi", series: "KXTEST", ticker: "KXTEST-26DEC-H25" };
const polymarketLeg: PolymarketLeg = { source: "polymarket", slug: "test-fed-hike" };

const candle = (endTs: number, bid: string, ask: string) => ({
  end_period_ts: endTs,
  yes_bid: { close_dollars: bid },
  yes_ask: { close_dollars: ask },
  price: { close_dollars: null },
});

// 68.5% an hour before the replay time, 78.5% a minute before it, 95.5% ten minutes after it.
const RECORDED_CANDLES = [candle(T - 3660, "0.6800", "0.6900"), candle(T - 60, "0.7800", "0.7900"), candle(T + 600, "0.9500", "0.9600")];
const RECORDED_HISTORY = [{ t: T - 3700, p: 0.685 }, { t: T - 50, p: 0.785 }, { t: T + 300, p: 0.97 }];

function kalshiMarket(patch: Record<string, unknown> = {}): FetchOutcome {
  // Today's book is far from the recorded history, so reading it by mistake shows up in the value.
  const market = { status: "active", close_time: "2026-12-09T19:00:00Z", yes_bid_dollars: "0.9900", yes_ask_dollars: "1.0000" };
  return { ok: true, data: { market: { ...market, ...patch } } };
}

function gammaMarket(patch: Record<string, unknown> = {}): FetchOutcome {
  const market = { slug: polymarketLeg.slug, outcomes: '["Yes","No"]', clobTokenIds: '["111","222"]', active: true, closed: false, acceptingOrders: true };
  return { ok: true, data: [{ ...market, ...patch }] };
}

/** Routes by path, records every URL asked for, and fails anything unexpected like a network error. */
function fakeVenues(routes: { market?: FetchOutcome; candles?: unknown[]; gamma?: FetchOutcome; history?: unknown[] } = {}) {
  const requested: string[] = [];
  const fetchJson: JsonFetcher = async (url) => {
    requested.push(url);
    const { pathname } = new URL(url);
    if (pathname.endsWith("/candlesticks")) return { ok: true, data: { candlesticks: routes.candles ?? RECORDED_CANDLES } };
    if (pathname.includes("/markets/")) return routes.market ?? kalshiMarket();
    if (pathname === "/markets") return routes.gamma ?? gammaMarket();
    if (pathname === "/prices-history") return { ok: true, data: { history: routes.history ?? RECORDED_HISTORY } };
    return { ok: false, error: `unexpected request ${url}` };
  };
  return { fetchJson, requested };
}

function replayCtx(fetchJson: JsonFetcher): SenseContext {
  return { fetchJson, now: REPLAY_AT, policy, replay: true };
}

function signalOf(reading: LegReading) {
  if (!reading.ok) throw new Error(`expected a signal, got ${reading.skip.reason}: ${reading.skip.detail}`);
  return reading.signal;
}

const skipReason = (reading: LegReading) => (reading.ok ? "ok" : reading.skip.reason);

describe("Kalshi leg replayed from recorded candles", () => {
  test("reads the quote in force at the replay time, not today's book", async () => {
    // #given recorded candles and a very different book today
    const { fetchJson } = fakeVenues();
    // #when the leg is replayed at REPLAY_AT
    const signal = signalOf(await readKalshiLeg(kalshiLeg, event, replayCtx(fetchJson)));
    // #then value and baseline are the recorded mids
    expect({ value: signal.value, baseline: signal.baseline, change: signal.change }).toEqual({ value: 0.785, baseline: 0.685, change: 0.1 });
  });

  test("never uses a candle recorded after the replay time", async () => {
    // #given only a candle from ten minutes after the replay time
    const { fetchJson } = fakeVenues({ candles: [candle(T + 600, "0.9500", "0.9600")] });
    // #when / #then there is no quote as of the replay time
    expect(skipReason(await readKalshiLeg(kalshiLeg, event, replayCtx(fetchJson)))).toBe("unusable_quote");
  });

  test("ignores the market's status today", async () => {
    // #given a market that has stopped trading since the replay time
    const { fetchJson } = fakeVenues({ market: kalshiMarket({ status: "finalized" }) });
    // #when / #then the replay still reads it
    expect(skipReason(await readKalshiLeg(kalshiLeg, event, replayCtx(fetchJson)))).toBe("ok");
  });

  test("skips a market that had already closed at the replay time", async () => {
    // #given trading closed a day before the replay time
    const { fetchJson } = fakeVenues({ market: kalshiMarket({ close_time: "2026-11-05T13:50:00Z" }) });
    // #when / #then
    expect(skipReason(await readKalshiLeg(kalshiLeg, event, replayCtx(fetchJson)))).toBe("market_closed");
  });

  test("labels the signal as replayed", async () => {
    // #given recorded candles
    const { fetchJson } = fakeVenues();
    // #when replayed
    const signal = signalOf(await readKalshiLeg(kalshiLeg, event, replayCtx(fetchJson)));
    // #then
    expect(signal.quality.note).toBe("replayed from recorded 1-min candles");
  });
});

describe("Polymarket leg replayed from recorded price history", () => {
  test("reads value and baseline from the history as of the replay time", async () => {
    // #given recorded history including a later point at 97%
    const { fetchJson } = fakeVenues();
    // #when replayed
    const signal = signalOf(await readPolymarketLeg(polymarketLeg, event, replayCtx(fetchJson)));
    // #then the later point is ignored
    expect({ value: signal.value, baseline: signal.baseline }).toEqual({ value: 0.785, baseline: 0.685 });
  });

  test("marks two-sidedness unknown, since price history carries no book", async () => {
    // #given recorded history
    const { fetchJson } = fakeVenues();
    // #when replayed
    const signal = signalOf(await readPolymarketLeg(polymarketLeg, event, replayCtx(fetchJson)));
    // #then
    expect(signal.quality.twoSided).toBeNull();
  });

  test("never requests today's order book", async () => {
    // #given a fetcher that records every request
    const { fetchJson, requested } = fakeVenues();
    // #when replayed
    await readPolymarketLeg(polymarketLeg, event, replayCtx(fetchJson));
    // #then
    expect(requested.some((url) => new URL(url).pathname === "/book")).toBe(false);
  });

  test("ignores whether the market still trades today", async () => {
    // #given a market closed since the replay time
    const { fetchJson } = fakeVenues({ gamma: gammaMarket({ closed: true, acceptingOrders: false }) });
    // #when / #then
    expect(skipReason(await readPolymarketLeg(polymarketLeg, event, replayCtx(fetchJson)))).toBe("ok");
  });

  test("skips the leg when the last recorded price is more than 60 min before the replay time", async () => {
    // #given history that stops 61 min before the replay time
    const { fetchJson } = fakeVenues({ history: [{ t: T - 7200, p: 0.6 }, { t: T - 3660, p: 0.62 }] });
    // #when / #then
    expect(skipReason(await readPolymarketLeg(polymarketLeg, event, replayCtx(fetchJson)))).toBe("unusable_quote");
  });

  test("a history outage is reported as source_unavailable", async () => {
    // #given the history endpoint down
    const down: JsonFetcher = async (url) =>
      new URL(url).pathname === "/prices-history" ? { ok: false, error: "HTTP 503" } : fakeVenues().fetchJson(url);
    // #when / #then
    expect(skipReason(await readPolymarketLeg(polymarketLeg, event, replayCtx(down)))).toBe("source_unavailable");
  });
});

describe("a replay pass", () => {
  const DIR = join(FIXTURES_DIR, "live");
  const recordedAt = new Date(loadManifest(DIR).recordedAt);
  const replayAt = new Date(recordedAt.getTime() - 60_000);
  const config = { watchlist: shippedWatchlist(), book: shippedBook(), policy };
  const deps = () => ({ ...createLiveDeps(policy, {}, createReplayFetcher(DIR)), now: () => recordedAt, replayAt });

  test("is labelled replay with its replay time", async () => {
    // #given the recorded session replayed one minute before the recording
    // #when the pass runs
    const { output } = await runPass(config, deps(), emptyState());
    // #then
    expect({ mode: output.mode, replayAt: output.replayAt, runAt: output.runAt }).toEqual({
      mode: "replay",
      replayAt: replayAt.toISOString(),
      runAt: recordedAt.toISOString(),
    });
  });

  test("stamps odds at the replay time and Injective data at the run time", async () => {
    // #given the recorded session
    // #when replayed
    const { output } = await runPass(config, deps(), emptyState());
    // #then each kind of signal carries its own observation time
    const times = new Set(output.signals.map((signal) => `${signal.kind}@${signal.observedAt}`));
    expect([...times].sort()).toEqual([`macro@${replayAt.toISOString()}`, `market@${recordedAt.toISOString()}`]);
  });

  test("a plain run carries no replay time", async () => {
    // #given no replayAt
    const { replayAt: _unused, ...live } = deps();
    // #when the pass runs
    const { output } = await runPass(config, live, emptyState());
    // #then
    expect({ mode: output.mode, hasReplayAt: "replayAt" in output }).toEqual({ mode: "dry-run", hasReplayAt: false });
  });
});

describe("--at argument", () => {
  const now = new Date("2026-11-10T09:40:00Z");

  test("absent means a live run", () => {
    // #given no flag
    // #when / #then
    expect(parseReplayAt([], now)).toBeNull();
  });

  test("an ISO time in the past is the replay time", () => {
    // #given a past time
    // #when / #then
    expect(parseReplayAt(["--at", "2026-11-06T13:50:00Z"], now)?.toISOString()).toBe("2026-11-06T13:50:00.000Z");
  });

  test("a time in the future is refused: a replay reads recorded odds only", () => {
    // #given one minute ahead
    // #when / #then
    expect(() => parseReplayAt(["--at", "2026-11-10T09:41:00Z"], now)).toThrow("is in the future");
  });

  test("a missing or unreadable time is refused", () => {
    // #given the flag without a usable value
    // #when / #then
    expect(() => parseReplayAt(["--at", "yesterday"], now)).toThrow("--at needs an ISO time");
  });
});
