import type { Policy } from "./config.ts";
import {
  ceilToStep,
  divFixed,
  fixedFromRatio,
  floorToStep,
  formatFixed,
  formatFixedPlaces,
  maxFixed,
  minFixed,
  mulFixed,
  parseFixed,
  stepForPlaces,
} from "./decimal.ts";
import type { HedgeOrder, RiskVector, Skipped } from "./types.ts";

export type BookLevel = { price: bigint; quantity: bigint };

/** What the sizer needs from a derivative market, in human units (quote per base). */
export type HedgeMarket = {
  marketId: string;
  ticker: string;
  bids: BookLevel[];
  asks: BookLevel[];
  minPriceTick: bigint;
  minQuantityTick: bigint;
  /** Smallest order notional the market accepts, in quote units. */
  minNotional: bigint;
  initialMarginRatio: bigint;
  quoteDecimals: number;
  oracleAgeSeconds: number | null;
};

export type HedgeContext = {
  policy: Policy;
  killSwitch: boolean;
  now: Date;
  /** Epoch ms of the last order this agent sent to the market, if any. */
  lastOrderAt: number | null;
  /** Absolute USD notional already hedged on this market. */
  currentHedgeUsd: bigint;
  exposureUsd: bigint;
};

export type HedgeDecision = { ok: true; order: HedgeOrder; mid: bigint } | { ok: false; skip: Skipped };

const BPS = 10_000;
const CENT = parseFixed("0.01");

export function sizeHedge(vector: RiskVector, market: HedgeMarket, ctx: HedgeContext): HedgeDecision {
  const where = `${market.ticker} (${vector.id.slice(0, 12)})`;
  const blocked = checkGates(vector, market, ctx, where);
  if (blocked) return { ok: false, skip: blocked };

  const { hedge } = ctx.policy;
  const side = vector.hedgeSide === "sell" ? "SELL" : "BUY";
  const bestBid = bestPrice(market.bids, "bid");
  const bestAsk = bestPrice(market.asks, "ask");
  if (bestBid === null || bestAsk === null || bestAsk <= bestBid) {
    return skip("one_sided_book", where, "order book is one-sided or crossed");
  }
  const mid = (bestBid + bestAsk) / 2n;

  const exposure = ctx.exposureUsd < 0n ? -ctx.exposureUsd : ctx.exposureUsd;
  const target = mulFixed(exposure, fixedFromRatio(vector.intensity * hedge.maxHedgeRatio));
  const gap = target - ctx.currentHedgeUsd;
  if (gap <= 0n) {
    return skip("hedge_at_target", where, `hedged $${usd(ctx.currentHedgeUsd)} of a $${usd(target)} target`);
  }

  const limitsApplied: string[] = [];
  let notional = gap;
  if (notional > hedge.maxOrderUsd) {
    notional = hedge.maxOrderUsd;
    limitsApplied.push("cap:max_order_notional");
  }

  const band = fixedFromRatio(hedge.priceBandBps / BPS);
  const depth = depthWithinBand(side === "SELL" ? market.bids : market.asks, mid, band, side);
  let quantity = divFixed(notional, mid);
  if (quantity > depth) {
    quantity = depth;
    limitsApplied.push("cap:book_depth");
  }
  quantity = floorToStep(quantity, market.minQuantityTick);
  const roundedNotional = mulFixed(quantity, mid);
  const floor = maxFixed(hedge.minOrderUsd, market.minNotional);
  if (quantity === 0n || roundedNotional < floor) {
    return skip("below_min_order", where, `order would be $${usd(roundedNotional)}, minimum is $${usd(floor)}`);
  }

  const worstPrice = safeWorstPrice(mid, band, market.minPriceTick, side);
  if (worstPrice === 0n) return skip("bad_price", where, "worst price rounds to zero");
  const margin = requiredMargin(quantity, maxFixed(mid, worstPrice), ctx.policy, market, limitsApplied);

  return {
    ok: true,
    mid,
    order: {
      vectorId: vector.id,
      marketId: market.marketId,
      ticker: market.ticker,
      side,
      quantity: formatFixed(quantity),
      worstPrice: formatFixed(worstPrice),
      margin: formatFixed(margin),
      notionalUsd: usd(roundedNotional),
      limitsApplied,
    },
  };
}

function checkGates(vector: RiskVector, market: HedgeMarket, ctx: HedgeContext, where: string): Skipped | null {
  const { policy } = ctx;
  if (ctx.killSwitch) return { reason: "kill_switch", detail: `${where}: BALLAST_KILL=1, no orders this pass` };
  if (market.oracleAgeSeconds === null) return { reason: "missing_oracle", detail: `${where}: no oracle timestamp` };
  if (market.oracleAgeSeconds > policy.oracle.maxAgeSeconds) {
    return {
      reason: "stale_oracle",
      detail: `${where}: oracle is ${Math.round(market.oracleAgeSeconds)} s old, limit ${policy.oracle.maxAgeSeconds} s`,
    };
  }
  if (vector.confidence < policy.hedge.minConfidence) {
    return {
      reason: "low_confidence",
      detail: `${where}: confidence ${vector.confidence} below ${policy.hedge.minConfidence}`,
    };
  }
  if (ctx.lastOrderAt !== null) {
    const elapsedMs = ctx.now.getTime() - ctx.lastOrderAt;
    const cooldownMs = policy.hedge.cooldownMinutes * 60_000;
    if (elapsedMs < cooldownMs) {
      const waitSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
      return { reason: "cooldown", detail: `${where}: last order ${Math.floor(elapsedMs / 1000)} s ago, ${waitSeconds} s to go` };
    }
  }
  return null;
}

function bestPrice(levels: BookLevel[], kind: "bid" | "ask"): bigint | null {
  const prices = levels.filter((level) => level.quantity > 0n && level.price > 0n).map((level) => level.price);
  if (prices.length === 0) return null;
  return prices.reduce((best, price) => (kind === "bid" ? maxFixed(best, price) : minFixed(best, price)));
}

/** Base quantity resting no worse than `band` from mid on the side the hedge would take. */
export function depthWithinBand(levels: BookLevel[], mid: bigint, band: bigint, side: "SELL" | "BUY"): bigint {
  const limit = side === "SELL" ? mid - mulFixed(mid, band) : mid + mulFixed(mid, band);
  return levels
    .filter((level) => level.quantity > 0n && (side === "SELL" ? level.price >= limit : level.price <= limit))
    .reduce((sum, level) => sum + level.quantity, 0n);
}

/**
 * Worst acceptable fill: mid minus the band for a sell, plus the band for a buy. Rounding is
 * toward mid (up for a sell, down for a buy) so tick rounding never widens the slippage allowed.
 */
export function safeWorstPrice(mid: bigint, band: bigint, tick: bigint, side: "SELL" | "BUY"): bigint {
  const offset = mulFixed(mid, band);
  return side === "SELL" ? ceilToStep(mid - offset, tick) : floorToStep(mid + offset, tick);
}

/**
 * Margin for the position at the policy leverage, raised to the market's initial margin
 * requirement when the policy asks for more leverage than the market allows.
 */
function requiredMargin(
  quantity: bigint,
  price: bigint,
  policy: Policy,
  market: HedgeMarket,
  limitsApplied: string[],
): bigint {
  const notional = mulFixed(quantity, price);
  const atPolicyLeverage = divFixed(notional, policy.hedge.leverage);
  const atMarketMinimum = mulFixed(notional, market.initialMarginRatio);
  let margin = atPolicyLeverage;
  if (atMarketMinimum > atPolicyLeverage) {
    margin = atMarketMinimum;
    limitsApplied.push("floor:initial_margin");
  }
  // Rounded up to the quote token's smallest unit so the margin never falls short.
  return ceilToStep(margin, stepForPlaces(market.quoteDecimals));
}

function usd(value: bigint): string {
  return formatFixedPlaces(floorToStep(value < 0n ? 0n : value, CENT), 2);
}

function skip(reason: string, where: string, detail: string): HedgeDecision {
  return { ok: false, skip: { reason, detail: `${where}: ${detail}` } };
}
