import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineConfig } from "../src/config.ts";
import { parseFixed } from "../src/decimal.ts";
import { createLiveDeps } from "../src/live.ts";
import { emptyState, runPass, type MarketReader, type RunDeps } from "../src/run.ts";
import { FIXTURES_DIR, shippedBook, shippedPolicy, shippedWatchlist } from "./support/builders.ts";
import { createReplayFetcher, loadManifest } from "./support/replay.ts";

const DIR = join(FIXTURES_DIR, "live");
const manifest = loadManifest(DIR);
const recordedAt = new Date(manifest.recordedAt);

function replayDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  return { ...createLiveDeps(shippedPolicy(), {}, createReplayFetcher(DIR)), now: () => recordedAt, ...overrides };
}

function config(): EngineConfig {
  return { watchlist: shippedWatchlist(), book: shippedBook(), policy: shippedPolicy() };
}

describe("a full pass on the recorded live session", () => {
  test("replaying the recording reproduces the recorded output exactly", async () => {
    // #given the responses and output saved by scripts/record-fixtures.ts
    const expected: unknown = JSON.parse(readFileSync(join(DIR, "expected-output.json"), "utf8"));
    // #when the same pass is replayed at the recording time
    const { output } = await runPass(config(), replayDeps(), emptyState());
    // #then every signal, vector, order and payload matches
    expect(JSON.parse(JSON.stringify(output))).toEqual(expected);
  });

  test("the recorded Fed-hike jump confirmed on both venues drives every book market", async () => {
    // #given the recording, where Kalshi and Polymarket both moved 9 pts in 60 min
    // #when the pass runs with the shipped operator thresholds
    const { output } = await runPass(config(), replayDeps(), emptyState());
    // #then all four vectors carry the Fed leg as a driver
    const drivenByFed = output.vectors.map((vector) =>
      vector.drivers.some((driver) => driver.signalId === "kalshi:KXFEDDECISION-26DEC-H25"),
    );
    expect(drivenByFed).toEqual([true, true, true, true]);
  });

  test("each payload carries its order's market and the vector id's first 32 hex chars as cid", async () => {
    // #given the recorded pass
    // #when it runs
    const { output } = await runPass(config(), replayDeps(), emptyState());
    // #then payload i matches order i
    expect(output.payloads.map((payload) => [payload.msg.order.marketId, payload.msg.order.orderInfo.cid])).toEqual(
      output.orders.map((order) => [order.marketId, order.vectorId.slice(0, 32)]),
    );
  });

  test("every order respects the $25,000 cap", async () => {
    // #given the recorded pass
    // #when it runs
    const { output } = await runPass(config(), replayDeps(), emptyState());
    // #then no order exceeds the cap
    expect(output.orders.every((order) => parseFixed(order.notionalUsd) <= parseFixed("25000"))).toBe(true);
  });

  test("a second pass with carried state is held by the cooldown on every market", async () => {
    // #given a first pass that sent four dry-run orders
    const deps = replayDeps();
    const first = await runPass(config(), deps, emptyState());
    // #when the next pass runs inside the 10-minute cooldown
    const second = await runPass(config(), deps, first.state);
    // #then every market is skipped for cooldown
    expect(second.output.skipped.map((entry) => entry.reason)).toEqual(["cooldown", "cooldown", "cooldown", "cooldown"]);
  });

  test("dry-run fills are remembered as paper hedges", async () => {
    // #given the recorded pass
    // #when it runs from empty state
    const { output, state } = await runPass(config(), replayDeps(), emptyState());
    // #then the BTC paper hedge equals the BTC order notional
    const btc = output.orders.find((order) => order.ticker === "BTC/USDC PERP");
    expect(parseFixed(state.paperHedgeUsd[btc?.marketId ?? ""] ?? "0")).toBe(parseFixed(btc?.notionalUsd ?? "-1"));
  });

  test("kill switch keeps sensing and scoring but sends nothing", async () => {
    // #given BALLAST_KILL=1
    // #when the recorded pass runs
    const { output } = await runPass(config(), replayDeps({ killSwitch: true }), emptyState());
    // #then vectors exist, orders do not, and every skip says why
    expect({
      vectors: output.vectors.length,
      orders: output.orders.length,
      reasons: [...new Set(output.skipped.map((entry) => entry.reason))],
    }).toEqual({ vectors: 4, orders: 0, reasons: ["kill_switch"] });
  });
});

describe("failure handling", () => {
  test("every source down still yields a valid run with nothing sensed, scored or sent", async () => {
    // #given a fetcher where every request fails
    const offline = replayDeps({ fetchJson: async (url) => ({ ok: false, error: `offline (${new URL(url).host})` }) });
    // #when the pass runs
    const { output } = await runPass(config(), offline, emptyState());
    // #then
    expect({ signals: output.signals.length, vectors: output.vectors.length, orders: output.orders.length }).toEqual({
      signals: 0,
      vectors: 0,
      orders: 0,
    });
  });

  test("a market reader that throws becomes one internal_error skip per market", async () => {
    // #given a reader that throws
    const throwing: MarketReader = async () => {
      throw new Error("boom");
    };
    // #when the pass runs
    const { output } = await runPass(config(), replayDeps({ readMarket: throwing }), emptyState());
    // #then
    expect(output.skipped.filter((entry) => entry.reason === "internal_error").length).toBe(shippedBook().length);
  });

  test("vectors survive a market-data outage but no order is sized without it", async () => {
    // #given the Injective reader failing for every market
    const down: MarketReader = async (position) => ({
      ok: false,
      skip: { reason: "source_unavailable", detail: `${position.market.ticker}: down` },
    });
    // #when the pass runs on the recorded macro shock
    const { output } = await runPass(config(), replayDeps({ readMarket: down }), emptyState());
    // #then the macro vectors are reported and no order is emitted
    expect({ vectors: output.vectors.length, orders: output.orders.length }).toEqual({ vectors: 4, orders: 0 });
  });
});
