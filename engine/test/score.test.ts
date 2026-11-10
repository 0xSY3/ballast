import { describe, expect, test } from "bun:test";
import type { BookPosition } from "../src/config.ts";
import { parseFixed } from "../src/decimal.ts";
import { buildVector, combineConfidence, combineIntensity, vectorId, windowStart } from "../src/score.ts";
import { shippedPolicy } from "./support/builders.ts";

const policy = shippedPolicy();
const position: BookPosition = {
  asset: "BTC",
  label: "Treasury BTC",
  exposureUsd: parseFixed("400000"),
  currentHedgeUsd: 0n,
  market: { ticker: "BTC/USDT PERP", marketId: "0xmarket" },
};
const now = new Date("2026-11-10T09:07:30.000Z");

describe("intensity", () => {
  test("is the probabilistic OR of driver strengths", () => {
    expect(combineIntensity([0.5])).toBe(0.5);
    expect(combineIntensity([0.5, 0.5])).toBe(0.75);
    expect(combineIntensity([0.25, 0.4, 0.1])).toBe(0.595);
    expect(combineIntensity([1, 0.3])).toBe(1);
    expect(combineIntensity([])).toBe(0);
  });

  test("ignores out-of-range inputs instead of going negative or above one", () => {
    expect(combineIntensity([1.7])).toBe(1);
    expect(combineIntensity([-0.4, 0.5])).toBe(0.5);
  });
});

describe("confidence", () => {
  test("is the strength-weighted mean of driver quality", () => {
    expect(combineConfidence([{ strength: 0.5, quality: 1 }])).toBe(1);
    expect(combineConfidence([{ strength: 0.6, quality: 1 }, { strength: 0.2, quality: 0.5 }])).toBe(0.875);
    expect(combineConfidence([])).toBe(0);
  });
});

describe("vector ids", () => {
  const base = {
    marketId: "0xmarket",
    hedgeSide: "sell" as const,
    drivers: [
      { signalId: "kalshi:A", strength: 0.25 },
      { signalId: "injective:B:spread", strength: 0.4 },
    ],
    window: windowStart(now, 10),
  };

  test("are sha256 hex and stable for the same inputs in any driver order", () => {
    const id = vectorId(base);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(vectorId({ ...base, drivers: [...base.drivers].reverse() })).toBe(id);
  });

  test("change with the market, a driver strength or the window", () => {
    const id = vectorId(base);
    expect(vectorId({ ...base, marketId: "0xother" })).not.toBe(id);
    expect(vectorId({ ...base, drivers: [{ signalId: "kalshi:A", strength: 0.26 }] })).not.toBe(id);
    expect(vectorId({ ...base, window: windowStart(new Date("2026-11-10T09:10:00.000Z"), 10) })).not.toBe(id);
  });

  test("windows align to the cooldown length", () => {
    expect(windowStart(now, 10)).toBe("2026-11-10T09:00:00.000Z");
    expect(windowStart(new Date("2026-11-10T09:09:59.999Z"), 10)).toBe("2026-11-10T09:00:00.000Z");
  });
});

describe("buildVector", () => {
  test("returns null when no driver is active", () => {
    const candidates = [{ signalId: "kalshi:A", strength: 0, quality: 1, note: "calm" }];
    expect(buildVector({ position, candidates, now, policy })).toBeNull();
  });

  test("returns null for a flat position", () => {
    const candidates = [{ signalId: "kalshi:A", strength: 0.5, quality: 1, note: "shock" }];
    expect(buildVector({ position: { ...position, exposureUsd: 0n }, candidates, now, policy })).toBeNull();
  });

  test("hedges a long book with a sell and a short book with a buy", () => {
    const candidates = [{ signalId: "kalshi:A", strength: 0.5, quality: 1, note: "shock" }];
    expect(buildVector({ position, candidates, now, policy })?.hedgeSide).toBe("sell");
    const short = { ...position, exposureUsd: parseFixed("-1000") };
    expect(buildVector({ position: short, candidates, now, policy })?.hedgeSide).toBe("buy");
  });

  test("combines drivers, sorts them by strength and drops inactive ones", () => {
    const vector = buildVector({
      position,
      candidates: [
        { signalId: "kalshi:A", strength: 0.25, quality: 0.8, note: "odds" },
        { signalId: "injective:B:spread", strength: 0.4, quality: 1, note: "spread" },
        { signalId: "injective:B:basis", strength: 0, quality: 1, note: "calm" },
      ],
      now,
      policy,
    });
    expect(vector).not.toBeNull();
    expect(vector?.intensity).toBe(0.55);
    expect(vector?.confidence).toBe(0.9231);
    expect(vector?.ttlSeconds).toBe(policy.vector.ttlSeconds);
    expect(vector?.drivers.map((driver) => driver.signalId)).toEqual(["injective:B:spread", "kalshi:A"]);
    expect(vector?.createdAt).toBe(now.toISOString());
  });
});
