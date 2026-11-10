import { describe, expect, test } from "bun:test";
import { PLACEHOLDER_SENDER } from "../src/live.ts";
import { buildMarketOrderPayload, CID_LENGTH, orderCid } from "../src/payload.ts";
import type { HedgeOrder } from "../src/types.ts";
import { hedgeMarket } from "./support/builders.ts";

const VECTOR_ID = "978ceacb0db9156a095a5fbdca0c63ec7d65aa2c384a5516209c90ab6f769d09";

function order(overrides: Partial<HedgeOrder> = {}): HedgeOrder {
  return {
    vectorId: VECTOR_ID,
    marketId: "0xmarket",
    ticker: "BTC/USDT PERP",
    side: "SELL",
    quantity: "0.25",
    worstPrice: "99000",
    margin: "12500.123456",
    notionalUsd: "25000.00",
    limitsApplied: [],
    ...overrides,
  };
}

const build = (overrides: Partial<HedgeOrder> = {}) => buildMarketOrderPayload(order(overrides), hedgeMarket(), PLACEHOLDER_SENDER);

describe("exchange v2 market order payload", () => {
  test("uses the v2 type URL", () => {
    // #given a sized sell order
    // #when the payload is built
    // #then
    expect(build().msg["@type"]).toBe("/injective.exchange.v2.MsgCreateDerivativeMarketOrder");
  });

  test("encodes price, quantity and margin as LegacyDec integers (value x 10^18)", () => {
    // #given worst price 99000, quantity 0.25, margin 12500.123456
    // #when built
    const { order: msgOrder } = build().msg;
    // #then
    expect([msgOrder.orderInfo.price, msgOrder.orderInfo.quantity, msgOrder.margin]).toEqual([
      "99000000000000000000000",
      "250000000000000000",
      "12500123456000000000000",
    ]);
  });

  test("maps SELL to order type 2 and BUY to 1", () => {
    // #given one order of each side
    // #when / #then
    expect([build().msg.order.orderType, build({ side: "BUY", worstPrice: "101000" }).msg.order.orderType]).toEqual([2, 1]);
  });

  test("uses the first 32 hex chars of the vector id as cid, inside the 36-char limit", () => {
    // #given a 64-char sha256 vector id
    // #when / #then
    expect(build().msg.order.orderInfo.cid).toBe(VECTOR_ID.slice(0, CID_LENGTH));
  });

  test("leaves trigger price and expiration at zero for a plain market order", () => {
    // #given / #when
    const { order: msgOrder } = build().msg;
    // #then
    expect([msgOrder.triggerPrice, msgOrder.expirationBlock]).toEqual(["0", "0"]);
  });

  test("carries the placeholder sender as both sender and fee recipient in dry run", () => {
    // #given no BALLAST_SENDER in the environment
    // #when / #then
    const { msg } = build();
    expect([msg.sender, msg.order.orderInfo.feeRecipient, msg.order.orderInfo.subaccountId]).toEqual([
      PLACEHOLDER_SENDER.address,
      PLACEHOLDER_SENDER.address,
      PLACEHOLDER_SENDER.subaccountId,
    ]);
  });
});

describe("payload refuses values the chain would reject", () => {
  test("a price off the $1 tick", () => {
    // #given worst price 99000.5 on a market with a $1 tick
    // #when / #then
    expect(() => build({ worstPrice: "99000.5" })).toThrow("not on the price tick 1");
  });

  test("a quantity off the 0.0001 tick", () => {
    // #given quantity 0.25001
    // #when / #then
    expect(() => build({ quantity: "0.25001" })).toThrow("not on the quantity tick 0.0001");
  });

  test("a margin finer than one micro-USDC", () => {
    // #given seven decimals of margin on a 6-decimal quote token
    // #when / #then
    expect(() => build({ margin: "1.0000001" })).toThrow("not on the quote unit 0.000001");
  });

  test("a zero quantity", () => {
    // #given quantity 0
    // #when / #then
    expect(() => build({ quantity: "0" })).toThrow("quantity must be positive");
  });

  test("a vector id that is not a sha256 digest", () => {
    // #given a short id
    // #when / #then
    expect(() => orderCid("abc")).toThrow("not a sha256 hex digest");
  });
});
