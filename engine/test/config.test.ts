import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBook, parsePolicy, parseWatchlist } from "../src/config.ts";
import { asArray, asRecord } from "../src/json.ts";
import { ENGINE_DIR, shippedBook, shippedPolicy, shippedWatchlist } from "./support/builders.ts";

function shipped(name: string): Record<string, unknown> {
  return asRecord(JSON.parse(readFileSync(join(ENGINE_DIR, "config", name), "utf8")), name);
}

function firstOf(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(asArray(raw[key], key)[0], `${key}[0]`);
}

describe("shipped config", () => {
  test("parses cleanly", () => {
    expect(shippedPolicy().hedge.maxHedgeRatio).toBe(0.6);
    expect(shippedWatchlist().map((event) => event.id)).toEqual(["fomc-dec-2026", "us-cpi-nov-2026", "us-recession-2027"]);
    expect(shippedBook().length).toBeGreaterThanOrEqual(3);
  });

  test("every watchlist event affects at least one asset in the book", () => {
    const assets = new Set(shippedBook().map((position) => position.asset));
    for (const event of shippedWatchlist()) {
      expect(event.affects.some((link) => assets.has(link.asset))).toBe(true);
    }
  });
});

describe("config validation fails fast with the field path", () => {
  test("policy amounts must be decimal strings, not numbers", () => {
    const raw = shipped("policy.json");
    const hedge = { ...asRecord(raw.hedge, "hedge"), maxOrderUsd: 25000 };
    expect(() => parsePolicy({ ...raw, hedge })).toThrow("policy.hedge.maxOrderUsd: expected a string");
  });

  test("policy rejects a full scale below its threshold and a max order below the minimum", () => {
    const raw = shipped("policy.json");
    expect(() => parsePolicy({ ...raw, macro: { ...asRecord(raw.macro, "macro"), fullScalePts: 3 } })).toThrow(
      "policy.macro.fullScalePts < thresholdPts",
    );
    expect(() => parsePolicy({ ...raw, hedge: { ...asRecord(raw.hedge, "hedge"), maxOrderUsd: "100" } })).toThrow(
      "policy.hedge.maxOrderUsd < minOrderUsd",
    );
  });

  test("watchlist rejects an unknown direction, an empty leg list and a reused market", () => {
    const first = firstOf(shipped("watchlist.json"), "events");
    expect(() => parseWatchlist({ events: [{ ...first, riskOffWhen: "up" }] })).toThrow("riskOffWhen");
    expect(() => parseWatchlist({ events: [{ ...first, legs: [] }] })).toThrow("legs is empty");
    expect(() => parseWatchlist({ events: [first, { ...first, id: "copy" }] })).toThrow("duplicate watchlist leg");
  });

  test("book rejects a negative existing hedge and duplicate markets", () => {
    const first = firstOf(shipped("book.json"), "positions");
    expect(() => parseBook({ positions: [{ ...first, currentHedgeUsd: "-1" }] })).toThrow("must not be negative");
    expect(() => parseBook({ positions: [first, first] })).toThrow("duplicate book market id");
  });
});
