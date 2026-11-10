import { describe, expect, test } from "bun:test";
import { parseFixed } from "../src/decimal.ts";
import { depthWithinBand, safeWorstPrice, sizeHedge, type HedgeContext } from "../src/policy.ts";
import { hedgeMarket, riskVector, shippedPolicy } from "./support/builders.ts";

const policy = shippedPolicy();
const now = new Date("2026-11-10T09:00:00.000Z");

function context(overrides: Partial<HedgeContext> = {}): HedgeContext {
  return {
    policy,
    killSwitch: false,
    now,
    lastOrderAt: null,
    currentHedgeUsd: 0n,
    exposureUsd: parseFixed("400000"),
    ...overrides,
  };
}

function expectSkip(result: ReturnType<typeof sizeHedge>, reason: string): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a skip");
  expect(result.skip.reason).toBe(reason);
  return result.skip.detail;
}

function expectOrder(result: ReturnType<typeof sizeHedge>) {
  if (!result.ok) throw new Error(`expected an order, got ${result.skip.reason}: ${result.skip.detail}`);
  return result.order;
}

describe("hedge sizing", () => {
  test("shipped limits: 0.6 hedge ratio, $500 minimum, $25,000 cap, 10 min cooldown, 1% band", () => {
    expect(policy.hedge.maxHedgeRatio).toBe(0.6);
    expect(policy.hedge.minOrderUsd).toBe(parseFixed("500"));
    expect(policy.hedge.maxOrderUsd).toBe(parseFixed("25000"));
    expect(policy.hedge.cooldownMinutes).toBe(10);
    expect(policy.hedge.priceBandBps).toBe(100);
    expect(policy.oracle.maxAgeSeconds).toBe(120);
  });

  test("target = intensity x ratio x exposure, capped at the max order notional", () => {
    const order = expectOrder(sizeHedge(riskVector(), hedgeMarket(), context()));
    expect(order).toEqual({
      vectorId: "a".repeat(64),
      marketId: "0xmarket",
      ticker: "BTC/USDT PERP",
      side: "SELL",
      quantity: "0.25",
      worstPrice: "99000",
      margin: "12500",
      notionalUsd: "25000.00",
      limitsApplied: ["cap:max_order_notional"],
    });
  });

  test("orders only the gap between target and the hedge already held", () => {
    // target 400,000 x 0.5 x 0.6 = 120,000; 110,000 is already hedged.
    const order = expectOrder(sizeHedge(riskVector(), hedgeMarket(), context({ currentHedgeUsd: parseFixed("110000") })));
    expect(order.notionalUsd).toBe("10000.00");
    expect(order.quantity).toBe("0.1");
    expect(order.limitsApplied).toEqual([]);
  });

  test("skips when the hedge already meets the target", () => {
    const detail = expectSkip(
      sizeHedge(riskVector(), hedgeMarket(), context({ currentHedgeUsd: parseFixed("120000") })),
      "hedge_at_target",
    );
    expect(detail).toContain("hedged $120000.00 of a $120000.00 target");
  });

  test("caps size to the depth resting within the band on the side it takes", () => {
    const thin = hedgeMarket({ bids: [{ price: parseFixed("99990"), quantity: parseFixed("0.1") }] });
    const order = expectOrder(sizeHedge(riskVector(), thin, context()));
    expect(order.quantity).toBe("0.1");
    expect(order.limitsApplied).toEqual(["cap:max_order_notional", "cap:book_depth"]);
  });

  test("depth ignores levels beyond the band", () => {
    const market = hedgeMarket();
    const mid = parseFixed("100000");
    const band = parseFixed("0.01");
    expect(depthWithinBand(market.bids, mid, band, "SELL")).toBe(parseFixed("1.5"));
    expect(depthWithinBand(market.asks, mid, band, "BUY")).toBe(parseFixed("1.5"));
  });

  test("skips orders below the minimum, including after a depth cap", () => {
    expectSkip(sizeHedge(riskVector(), hedgeMarket(), context({ exposureUsd: parseFixed("1000") })), "below_min_order");
    const thin = hedgeMarket({ bids: [{ price: parseFixed("99990"), quantity: parseFixed("0.004") }] });
    const detail = expectSkip(sizeHedge(riskVector(), thin, context()), "below_min_order");
    expect(detail).toContain("order would be $400.00, minimum is $500.00");
  });

  test("cooldown blocks a second order on the same market for 10 minutes", () => {
    const fiveMinutesAgo = now.getTime() - 5 * 60_000;
    const detail = expectSkip(sizeHedge(riskVector(), hedgeMarket(), context({ lastOrderAt: fiveMinutesAgo })), "cooldown");
    expect(detail).toContain("last order 300 s ago, 300 s to go");
    const tenMinutesAgo = now.getTime() - 10 * 60_000;
    expect(sizeHedge(riskVector(), hedgeMarket(), context({ lastOrderAt: tenMinutesAgo })).ok).toBe(true);
  });

  test("kill switch stops every order before anything else is checked", () => {
    const stale = hedgeMarket({ oracleAgeSeconds: 999 });
    expectSkip(sizeHedge(riskVector(), stale, context({ killSwitch: true })), "kill_switch");
  });

  test("stale or missing oracle data blocks new hedges on that market", () => {
    expectSkip(sizeHedge(riskVector(), hedgeMarket({ oracleAgeSeconds: 121 }), context()), "stale_oracle");
    expect(sizeHedge(riskVector(), hedgeMarket({ oracleAgeSeconds: 120 }), context()).ok).toBe(true);
    expectSkip(sizeHedge(riskVector(), hedgeMarket({ oracleAgeSeconds: null }), context()), "missing_oracle");
  });

  test("a one-sided or crossed book is treated as bad data", () => {
    expectSkip(sizeHedge(riskVector(), hedgeMarket({ asks: [] }), context()), "one_sided_book");
    const crossed = hedgeMarket({ asks: [{ price: parseFixed("99000"), quantity: parseFixed("1") }] });
    expectSkip(sizeHedge(riskVector(), crossed, context()), "one_sided_book");
  });

  test("low confidence blocks the order", () => {
    expectSkip(sizeHedge(riskVector({ confidence: 0.4 }), hedgeMarket(), context()), "low_confidence");
  });

  test("a short book is hedged with a buy against the asks", () => {
    const vector = riskVector({ hedgeSide: "buy" });
    const order = expectOrder(sizeHedge(vector, hedgeMarket(), context({ exposureUsd: parseFixed("-400000") })));
    expect(order.side).toBe("BUY");
    expect(order.worstPrice).toBe("101000");
    // Buy margin uses the worst price, the most the order could cost.
    expect(order.margin).toBe("12625");
  });

  test("raises margin to the market's initial margin when policy leverage is too high", () => {
    const order = expectOrder(sizeHedge(riskVector(), hedgeMarket({ initialMarginRatio: parseFixed("0.6") }), context()));
    expect(order.margin).toBe("15000");
    expect(order.limitsApplied).toContain("floor:initial_margin");
  });
});

describe("tick rounding", () => {
  test("quantity rounds down to the quantity tick", () => {
    const order = expectOrder(
      sizeHedge(riskVector(), hedgeMarket(), context({ currentHedgeUsd: parseFixed("107654.33") })),
    );
    // gap 12,345.67 / 100,000 = 0.1234567 -> 0.1234
    expect(order.quantity).toBe("0.1234");
    expect(order.notionalUsd).toBe("12340.00");
  });

  test("worst price rounds toward mid: up for a sell, down for a buy", () => {
    const mid = parseFixed("100000.5");
    const band = parseFixed("0.01");
    const tick = parseFixed("1");
    expect(safeWorstPrice(mid, band, tick, "SELL")).toBe(parseFixed("99001"));
    expect(safeWorstPrice(mid, band, tick, "BUY")).toBe(parseFixed("101000"));
  });

  test("margin rounds up to the quote token's smallest unit", () => {
    const market = hedgeMarket({
      bids: [{ price: parseFixed("3.3333331"), quantity: parseFixed("100000") }],
      asks: [{ price: parseFixed("3.3333333"), quantity: parseFixed("100000") }],
      minPriceTick: parseFixed("0.0001"),
      minQuantityTick: parseFixed("1"),
    });
    const order = expectOrder(sizeHedge(riskVector(), market, context({ exposureUsd: parseFixed("1678") })));
    // target 503.4 / mid 3.3333332 = 151.02 -> 151; margin 151 x 3.3333332 / 2 = 251.6666566 -> 251.666657
    expect(order.quantity).toBe("151");
    expect(order.notionalUsd).toBe("503.33");
    expect(order.margin).toBe("251.666657");
  });
});
