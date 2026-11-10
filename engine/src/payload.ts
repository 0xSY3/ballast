/**
 * Builds Injective's exchange v2 MsgCreateDerivativeMarketOrder for a sized hedge.
 * Field mapping per the dev-stack notes, section 2.1 (@injectivelabs/sdk-ts 1.20.66,
 * MsgCreateDerivativeMarketOrderV2): typeUrl /injective.exchange.v2.MsgCreateDerivativeMarketOrder,
 * proto shape { sender, order: { marketId, orderInfo: { subaccountId, feeRecipient, price, quantity,
 * cid }, orderType, margin, triggerPrice, expirationBlock } }. v2 takes human-readable values on the
 * market's ticks and encodes each LegacyDec as value x 10^18 (the SDK's toChainFormat), which is
 * exactly the bigint this engine already carries, so no float ever touches the amounts.
 */
import { formatFixed, parseFixed, stepForPlaces } from "./decimal.ts";
import type { HedgeMarket } from "./policy.ts";
import type { OrderSender } from "./run.ts";
import type { HedgeOrder, OrderPayload } from "./types.ts";

// The chain caps a client order id at 36 characters, so the cid is the vector id's first 128 bits.
export const CID_LENGTH = 32;

export function orderCid(vectorId: string): string {
  if (!/^[0-9a-f]{64}$/.test(vectorId)) throw new Error(`vector id is not a sha256 hex digest: ${vectorId}`);
  return vectorId.slice(0, CID_LENGTH);
}

export function buildMarketOrderPayload(order: HedgeOrder, market: HedgeMarket, sender: OrderSender): OrderPayload {
  const price = onGrid(order.worstPrice, market.minPriceTick, "worst price", "price tick");
  const quantity = onGrid(order.quantity, market.minQuantityTick, "quantity", "quantity tick");
  const margin = onGrid(order.margin, stepForPlaces(market.quoteDecimals), "margin", "quote unit");
  return {
    msg: {
      "@type": "/injective.exchange.v2.MsgCreateDerivativeMarketOrder",
      sender: sender.address,
      order: {
        marketId: market.marketId,
        orderInfo: {
          subaccountId: sender.subaccountId,
          feeRecipient: sender.address,
          price: price.toString(),
          quantity: quantity.toString(),
          cid: orderCid(order.vectorId),
        },
        orderType: order.side === "BUY" ? 1 : 2,
        margin: margin.toString(),
        triggerPrice: "0",
        expirationBlock: "0",
      },
    },
  };
}

/** Refuses any value off the market's grid: the chain would reject it, so it must never be emitted. */
function onGrid(text: string, step: bigint, label: string, stepLabel: string): bigint {
  const value = parseFixed(text);
  if (value <= 0n) throw new Error(`${label} must be positive, got ${text}`);
  if (value % step !== 0n) throw new Error(`${label} ${text} is not on the ${stepLabel} ${formatFixed(step)}`);
  return value;
}
