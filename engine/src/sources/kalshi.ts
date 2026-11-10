import type { KalshiLeg, WatchEvent } from "../config.ts";
import { asArray, asRecord, decimalTextToNumber, isRecord, readNumber, readString } from "../json.ts";
import { errorText } from "../net.ts";
import { buildOddsSignal, checkTwoSided, legSkip, type LegReading, type SenseContext } from "./odds.ts";

export const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";

type KalshiMarket = { status: string; closeTime: string; bid: number | null; ask: number | null };
export type KalshiCandle = { endTs: number; bid: number | null; ask: number | null; tradePrice: number | null };

export function kalshiMarketUrl(leg: KalshiLeg): string {
  return `${KALSHI_API}/markets/${encodeURIComponent(leg.ticker)}`;
}

/** One-minute candles. Kalshi only emits a candle for minutes where a quote or trade changed. */
export function kalshiCandlesUrl(leg: KalshiLeg, startTs: number, endTs: number): string {
  const series = encodeURIComponent(leg.series);
  const ticker = encodeURIComponent(leg.ticker);
  return `${KALSHI_API}/series/${series}/markets/${ticker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`;
}

export async function readKalshiLeg(leg: KalshiLeg, event: WatchEvent, ctx: SenseContext): Promise<LegReading> {
  const signalId = `kalshi:${leg.ticker}`;
  const nowTs = Math.floor(ctx.now.getTime() / 1000);
  const startTs = nowTs - Math.round(ctx.policy.macro.historyLookbackHours * 3600);
  const [marketResult, candleResult] = await Promise.all([
    ctx.fetchJson(kalshiMarketUrl(leg)),
    ctx.fetchJson(kalshiCandlesUrl(leg, startTs, nowTs)),
  ]);
  if (!marketResult.ok) return legSkip("source_unavailable", signalId, marketResult.error);
  if (!candleResult.ok) return legSkip("source_unavailable", signalId, candleResult.error);
  let market: KalshiMarket;
  let candles: KalshiCandle[];
  try {
    market = parseMarket(marketResult.data);
    candles = parseCandles(candleResult.data);
  } catch (error) {
    return legSkip("bad_response", signalId, errorText(error));
  }
  return evaluate(leg, event, ctx, market, candles);
}

function evaluate(
  leg: KalshiLeg,
  event: WatchEvent,
  ctx: SenseContext,
  market: KalshiMarket,
  recorded: KalshiCandle[],
): LegReading {
  const signalId = `kalshi:${leg.ticker}`;
  const nowTs = Math.floor(ctx.now.getTime() / 1000);
  const { macro } = ctx.policy;
  // A replay asks whether the market was open at that moment; its status today does not matter.
  if (!ctx.replay && market.status !== "active") return legSkip("market_not_active", signalId, `status is "${market.status}"`);
  if (Date.parse(market.closeTime) <= ctx.now.getTime()) {
    return legSkip("market_closed", signalId, `trading closed at ${market.closeTime}`);
  }

  // A replay must not see anything recorded after its moment, and takes the quote from the candle
  // in force then instead of today's book.
  const candles = ctx.replay ? recorded.filter((candle) => candle.endTs <= nowTs) : recorded;
  const current = ctx.replay ? quoteAt(candles, nowTs) : { bid: market.bid, ask: market.ask };
  const quote = checkTwoSided(current.bid, current.ask, macro.maxQuoteSpreadPts);
  let value: number;
  let twoSided: boolean;
  const notes: string[] = ctx.replay ? ["replayed from recorded 1-min candles"] : [];
  if (quote.ok) {
    value = quote.mid;
    twoSided = true;
  } else {
    const lastTrade = candles.findLast((candle) => candle.tradePrice !== null);
    const maxAgeSeconds = macro.maxLastTradeAgeMinutes * 60;
    if (!lastTrade || lastTrade.tradePrice === null || nowTs - lastTrade.endTs > maxAgeSeconds) {
      return legSkip("unusable_quote", signalId, `${quote.why} and no trade in the last ${macro.maxLastTradeAgeMinutes} min`);
    }
    value = lastTrade.tradePrice;
    twoSided = false;
    notes.push(`${quote.why}; using last trade`);
  }

  const cutoffTs = nowTs - macro.windowMinutes * 60;
  const baseline = baselineAt(candles, cutoffTs, macro.maxQuoteSpreadPts);
  if (baseline === null) notes.push(`no usable quote from ${macro.windowMinutes} min ago`);

  return {
    ok: true,
    signal: buildOddsSignal({
      source: "kalshi",
      key: leg.ticker,
      event,
      value,
      baseline,
      now: ctx.now,
      twoSided,
      ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
    }),
  };
}

/** Candles are only emitted when something changed, so the last one at or before `ts` still held then. */
function quoteAt(candles: KalshiCandle[], ts: number): { bid: number | null; ask: number | null } {
  const candle = candles.findLast((entry) => entry.endTs <= ts);
  return candle ? { bid: candle.bid, ask: candle.ask } : { bid: null, ask: null };
}

/** Quote state as of `cutoffTs`: the last candle that closed at or before it still held then. */
export function baselineAt(candles: KalshiCandle[], cutoffTs: number, maxSpreadPts: number): number | null {
  const candle = candles.findLast((entry) => entry.endTs <= cutoffTs);
  if (!candle) return null;
  const quote = checkTwoSided(candle.bid, candle.ask, maxSpreadPts);
  if (quote.ok) return quote.mid;
  return candle.tradePrice;
}

function parseMarket(raw: unknown): KalshiMarket {
  const market = asRecord(asRecord(raw, "kalshi").market, "kalshi.market");
  return {
    status: readString(market, "status", "kalshi.market"),
    closeTime: readString(market, "close_time", "kalshi.market"),
    bid: bidOrNull(readString(market, "yes_bid_dollars", "kalshi.market"), "kalshi.market.yes_bid_dollars"),
    ask: askOrNull(readString(market, "yes_ask_dollars", "kalshi.market"), "kalshi.market.yes_ask_dollars"),
  };
}

export function parseCandles(raw: unknown): KalshiCandle[] {
  const list = asArray(asRecord(raw, "kalshi").candlesticks, "kalshi.candlesticks");
  const candles = list.map((entry, index) => {
    const path = `kalshi.candlesticks[${index}]`;
    const candle = asRecord(entry, path);
    return {
      endTs: readNumber(candle, "end_period_ts", path),
      bid: closeOf(candle.yes_bid, `${path}.yes_bid`, bidOrNull),
      ask: closeOf(candle.yes_ask, `${path}.yes_ask`, askOrNull),
      tradePrice: closeOf(candle.price, `${path}.price`, (text, where) => decimalTextToNumber(text, where)),
    };
  });
  // Baseline lookup walks backwards from the cutoff, which needs time order.
  return candles.sort((a, b) => a.endTs - b.endTs);
}

function closeOf(
  raw: unknown,
  path: string,
  convert: (text: string, path: string) => number | null,
): number | null {
  if (!isRecord(raw)) return null;
  const close = raw.close_dollars;
  if (close === undefined || close === null) return null;
  if (typeof close !== "string") throw new Error(`${path}.close_dollars: expected a string`);
  return convert(close, `${path}.close_dollars`);
}

// Kalshi reports an empty bid side as 0.00 and an empty ask side as 1.00.
function bidOrNull(text: string, path: string): number | null {
  const value = decimalTextToNumber(text, path);
  return value <= 0 ? null : value;
}

function askOrNull(text: string, path: string): number | null {
  const value = decimalTextToNumber(text, path);
  return value >= 1 ? null : value;
}
