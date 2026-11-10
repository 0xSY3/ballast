import { describe, expect, test } from "bun:test";
import { evaluateEvent, oddsStrength } from "../src/detect/macro.ts";
import { checkTwoSided } from "../src/sources/odds.ts";
import { oddsSignal, shippedPolicy, TEST_EVENT } from "./support/builders.ts";

const policy = shippedPolicy();

describe("odds change to strength", () => {
  test("shipped defaults are 5 pts to trigger and 20 pts for full scale over 60 min", () => {
    expect(policy.macro).toMatchObject({ windowMinutes: 60, thresholdPts: 5, fullScalePts: 20 });
  });

  test("moves below the threshold score zero", () => {
    expect(oddsStrength(0, "yes_up", policy.macro)).toBe(0);
    expect(oddsStrength(0.049, "yes_up", policy.macro)).toBe(0);
  });

  test("a move of exactly the threshold triggers despite float noise", () => {
    expect(0.81 - 0.76).not.toBe(0.05);
    expect(oddsStrength(0.81 - 0.76, "yes_up", policy.macro)).toBe(0.25);
  });

  test("strength is linear in points and caps at full scale", () => {
    expect(oddsStrength(0.1, "yes_up", policy.macro)).toBe(0.5);
    expect(oddsStrength(0.2, "yes_up", policy.macro)).toBe(1);
    expect(oddsStrength(0.35, "yes_up", policy.macro)).toBe(1);
  });

  test("direction follows riskOffWhen", () => {
    expect(oddsStrength(-0.1, "yes_up", policy.macro)).toBe(0);
    expect(oddsStrength(-0.1, "yes_down", policy.macro)).toBe(0.5);
    expect(oddsStrength(0.1, "yes_down", policy.macro)).toBe(0);
  });
});

describe("quote checks", () => {
  test("accepts a tight two-sided quote and returns the midpoint", () => {
    expect(checkTwoSided(0.8, 0.81, 10)).toEqual({ ok: true, mid: 0.805 });
  });

  test("rejects one-sided, crossed and wide quotes", () => {
    expect(checkTwoSided(null, 0.4, 10).ok).toBe(false);
    expect(checkTwoSided(0.5, 0.5, 10).ok).toBe(false);
    expect(checkTwoSided(0.41, 0.56, 10)).toEqual({ ok: false, why: "quote 15.0 pts wide" });
  });
});

describe("event evaluation across venues", () => {
  const twoLegEvent = {
    ...TEST_EVENT,
    legs: [
      { source: "kalshi" as const, series: "KXTEST", ticker: "KXTEST-1" },
      { source: "polymarket" as const, slug: "test-slug" },
    ],
  };

  test("two agreeing venues: the smaller move sets the strength, at full confidence", () => {
    const { shock } = evaluateEvent(
      twoLegEvent,
      [
        oddsSignal({ id: "kalshi:KXTEST-1", value: 0.62, baseline: 0.5, change: 0.12 }),
        oddsSignal({ id: "polymarket:test-slug", source: "polymarket", value: 0.6, baseline: 0.5, change: 0.1 }),
      ],
      policy,
    );
    expect(shock?.strength).toBe(0.5);
    expect(shock?.signal.id).toBe("polymarket:test-slug");
    expect(shock?.quality).toBe(1);
    expect(shock?.note).toBe("Test event: odds 50% to 60% in 60 min (Kalshi and Polymarket agree)");
  });

  test("one venue moving alone cannot trigger when the other is flat", () => {
    const { shock } = evaluateEvent(
      twoLegEvent,
      [
        oddsSignal({ id: "kalshi:KXTEST-1", value: 0.7, baseline: 0.5, change: 0.2 }),
        oddsSignal({ id: "polymarket:test-slug", source: "polymarket", value: 0.5, baseline: 0.5, change: 0 }),
      ],
      policy,
    );
    expect(shock).toBeNull();
  });

  test("a single venue still counts, with the single-venue confidence factor", () => {
    const { shock } = evaluateEvent(TEST_EVENT, [oddsSignal({ id: "kalshi:KXTEST-1" })], policy);
    expect(shock?.strength).toBe(0.5);
    expect(shock?.quality).toBe(policy.confidence.singleVenue);
    expect(shock?.note).toEndWith("(Kalshi only)");
  });

  test("a last-trade reading is discounted further", () => {
    const { shock } = evaluateEvent(
      TEST_EVENT,
      [oddsSignal({ id: "kalshi:KXTEST-1", quality: { fresh: true, twoSided: false } })],
      policy,
    );
    expect(shock?.quality).toBe(policy.confidence.singleVenue * policy.confidence.oneSided);
  });

  test("legs without a baseline produce a skip, never a shock", () => {
    const { shock, skipped } = evaluateEvent(
      TEST_EVENT,
      [oddsSignal({ id: "kalshi:KXTEST-1", baseline: null, change: null })],
      policy,
    );
    expect(shock).toBeNull();
    expect(skipped).toEqual([{ reason: "no_baseline", detail: "test-event: no leg has a quote from 60 min ago" }]);
  });

  test("no legs at all adds nothing beyond the leg skips the sources already reported", () => {
    expect(evaluateEvent(TEST_EVENT, [], policy)).toEqual({ shock: null, skipped: [] });
  });
});
