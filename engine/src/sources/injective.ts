/**
 * Injective derivative market data over public HTTPS (no keys).
 * Endpoints and number formats per the dev-stack notes (LCD exchange v2 returns human-readable
 * decimals; the Indexer is used only for funding history, whose rates are unscaled fractions):
 *   market   GET {LCD}/injective/exchange/v2/derivative/markets/{marketId}
 *   book     GET {LCD}/injective/exchange/v2/derivative/orderbook/{marketId}?limit=N
 *   oracle   GET {LCD}/injective/oracle/v1beta1/price?oracle_type=..&base=..&quote=..
 *   funding  GET {IDX}/api/exchange/derivative/v1/fundingRates?marketId=..&limit=..
 */
import type { BookPosition } from "../config.ts";
import { parseFixed } from "../decimal.ts";
import { assessMarket, type FundingPoint, type MarketObservation } from "../detect/market.ts";
import { asArray, asRecord, decimalTextToNumber, readNumber, readString, type JsonRecord } from "../json.ts";
import { errorText, type FetchOutcome } from "../net.ts";
import type { BookLevel, HedgeMarket } from "../policy.ts";
import type { MarketReader, MarketReading } from "../run.ts";
import type { Skipped } from "../types.ts";
import type { SenseContext } from "./odds.ts";

export const INJECTIVE_LCD = "https://sentry.lcd.injective.network";
export const INJECTIVE_INDEXER = "https://sentry.exchange.grpc-web.injective.network";
const BOOK_LEVELS = 50;
// Hourly funding for the 7-day window plus slack; the Indexer returns newest first.
const FUNDING_LIMIT = 200;

export type MarketMeta = {
  marketId: string;
  ticker: string;
  status: string;
  quoteDecimals: number;
  minPriceTick: bigint;
  minQuantityTick: bigint;
  minNotional: bigint;
  initialMarginRatio: bigint;
  oracleType: string;
  oracleBase: string;
  oracleQuote: string;
};

export const injectiveMarketUrl = (marketId: string) =>
  `${INJECTIVE_LCD}/injective/exchange/v2/derivative/markets/${encodeURIComponent(marketId)}`;

export const injectiveBookUrl = (marketId: string) =>
  `${INJECTIVE_LCD}/injective/exchange/v2/derivative/orderbook/${encodeURIComponent(marketId)}?limit=${BOOK_LEVELS}`;

export const injectiveOracleUrl = (meta: Pick<MarketMeta, "oracleType" | "oracleBase" | "oracleQuote">) =>
  `${INJECTIVE_LCD}/injective/oracle/v1beta1/price?oracle_type=${encodeURIComponent(meta.oracleType)}` +
  `&base=${encodeURIComponent(meta.oracleBase)}&quote=${encodeURIComponent(meta.oracleQuote)}`;

export const injectiveFundingUrl = (marketId: string) =>
  `${INJECTIVE_INDEXER}/api/exchange/derivative/v1/fundingRates?marketId=${encodeURIComponent(marketId)}&limit=${FUNDING_LIMIT}`;

export const readInjectiveMarket: MarketReader = async (position, ctx) => {
  const where = position.market.ticker;
  const marketResult = await ctx.fetchJson(injectiveMarketUrl(position.market.marketId));
  if (!marketResult.ok) return fail("source_unavailable", where, marketResult.error);
  let meta: MarketMeta;
  try {
    meta = parseMarketMeta(marketResult.data);
  } catch (error) {
    return fail("bad_response", where, errorText(error));
  }
  if (meta.marketId.toLowerCase() !== position.market.marketId.toLowerCase() || meta.ticker !== position.market.ticker) {
    return fail("bad_response", where, `market id resolves to "${meta.ticker}", expected "${position.market.ticker}"`);
  }
  if (meta.status !== "Active") return fail("market_not_active", where, `status is "${meta.status}"`);

  const [bookResult, oracleResult, fundingResult] = await Promise.all([
    ctx.fetchJson(injectiveBookUrl(meta.marketId)),
    ctx.fetchJson(injectiveOracleUrl(meta)),
    ctx.fetchJson(injectiveFundingUrl(meta.marketId)),
  ]);
  if (!bookResult.ok) return fail("source_unavailable", where, bookResult.error);
  let book: { bids: BookLevel[]; asks: BookLevel[] };
  try {
    book = parseOrderbook(bookResult.data);
  } catch (error) {
    return fail("bad_response", where, errorText(error));
  }
  const skipped: Skipped[] = [];
  const oracle = optional(oracleResult, parseOracle, `${where} oracle`, skipped);
  const funding = optional(fundingResult, parseFundingHistory, `${where} funding history`, skipped) ?? [];
  return assemble(position, meta, book, oracle, funding, ctx, skipped);
};

/** The book is required to size anything; oracle and funding gaps are reported and handled by the gates. */
function optional<T>(result: FetchOutcome, parse: (raw: unknown) => T, label: string, skipped: Skipped[]): T | null {
  if (!result.ok) {
    skipped.push({ reason: "source_unavailable", detail: `${label}: ${result.error}` });
    return null;
  }
  try {
    return parse(result.data);
  } catch (error) {
    skipped.push({ reason: "bad_response", detail: `${label}: ${errorText(error)}` });
    return null;
  }
}

function assemble(
  position: BookPosition,
  meta: MarketMeta,
  book: { bids: BookLevel[]; asks: BookLevel[] },
  oracle: { price: bigint; timestampMs: number } | null,
  funding: FundingPoint[],
  ctx: SenseContext,
  skipped: Skipped[],
): MarketReading {
  const observation: MarketObservation = {
    ticker: meta.ticker,
    // Injective's mark price tracks the oracle, so the book mid is the perp's own price for basis.
    perpPrice: bookMid(book),
    oraclePrice: oracle?.price ?? null,
    oracleTimestampMs: oracle?.timestampMs ?? null,
    bids: book.bids,
    asks: book.asks,
    fundingHistory: funding,
  };
  const hedgeSide = position.exposureUsd < 0n ? "buy" : "sell";
  const assessment = assessMarket(observation, hedgeSide, ctx.now, ctx.policy);
  const market: HedgeMarket = {
    marketId: meta.marketId,
    ticker: meta.ticker,
    bids: book.bids,
    asks: book.asks,
    minPriceTick: meta.minPriceTick,
    minQuantityTick: meta.minQuantityTick,
    minNotional: meta.minNotional,
    initialMarginRatio: meta.initialMarginRatio,
    quoteDecimals: meta.quoteDecimals,
    oracleAgeSeconds: assessment.oracleAgeSeconds,
  };
  return { ok: true, market, signals: assessment.signals, drivers: assessment.drivers, skipped };
}

function bookMid(book: { bids: BookLevel[]; asks: BookLevel[] }): bigint | null {
  const bids = book.bids.map((level) => level.price);
  const asks = book.asks.map((level) => level.price);
  if (bids.length === 0 || asks.length === 0) return null;
  const bid = bids.reduce((best, price) => (price > best ? price : best));
  const ask = asks.reduce((best, price) => (price < best ? price : best));
  return ask > bid ? (bid + ask) / 2n : null;
}

export function parseMarketMeta(raw: unknown): MarketMeta {
  const wrapper = asRecord(asRecord(raw, "lcd").market, "lcd.market");
  const market = asRecord(wrapper.market, "lcd.market.market");
  const path = "lcd.market.market";
  const quoteDecimals = readNumber(market, "quote_decimals", path);
  if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 18) {
    throw new Error(`${path}.quote_decimals out of range: ${quoteDecimals}`);
  }
  const minPriceTick = decimalField(market, "min_price_tick_size", path);
  const minQuantityTick = decimalField(market, "min_quantity_tick_size", path);
  if (minPriceTick <= 0n || minQuantityTick <= 0n) throw new Error(`${path}: tick sizes must be positive`);
  return {
    marketId: readString(market, "market_id", path),
    ticker: readString(market, "ticker", path),
    status: readString(market, "status", path),
    quoteDecimals,
    minPriceTick,
    minQuantityTick,
    minNotional: decimalField(market, "min_notional", path),
    initialMarginRatio: decimalField(market, "initial_margin_ratio", path),
    oracleType: readString(market, "oracle_type", path),
    oracleBase: readString(market, "oracle_base", path),
    oracleQuote: readString(market, "oracle_quote", path),
  };
}

export function parseOrderbook(raw: unknown): { bids: BookLevel[]; asks: BookLevel[] } {
  const book = asRecord(raw, "lcd.orderbook");
  const levels = (key: string) =>
    asArray(book[key] ?? [], `lcd.orderbook.${key}`).map((entry, index) => {
      const path = `lcd.orderbook.${key}[${index}]`;
      const level = asRecord(entry, path);
      return { price: decimalField(level, "p", path), quantity: decimalField(level, "q", path) };
    });
  return { bids: levels("buys_price_level"), asks: levels("sells_price_level") };
}

/** Pair price with the older of its two feed timestamps, since either leg going quiet stales it. */
export function parseOracle(raw: unknown): { price: bigint; timestampMs: number } {
  const state = asRecord(asRecord(raw, "lcd.oracle").price_pair_state, "lcd.oracle.price_pair_state");
  const path = "lcd.oracle.price_pair_state";
  const baseTs = integerText(readString(state, "base_timestamp", path), `${path}.base_timestamp`);
  const quoteTs = integerText(readString(state, "quote_timestamp", path), `${path}.quote_timestamp`);
  return { price: decimalField(state, "pair_price", path), timestampMs: Math.min(baseTs, quoteTs) * 1000 };
}

export function parseFundingHistory(raw: unknown): FundingPoint[] {
  const list = asArray(asRecord(raw, "indexer.funding").fundingRates, "indexer.funding.fundingRates");
  return list.map((entry, index) => {
    const path = `indexer.funding.fundingRates[${index}]`;
    const point = asRecord(entry, path);
    return {
      rate: decimalTextToNumber(readString(point, "rate", path), `${path}.rate`),
      timestampMs: readNumber(point, "timestamp", path),
    };
  });
}

function decimalField(record: JsonRecord, key: string, path: string): bigint {
  const text = readString(record, key, path);
  try {
    return parseFixed(text);
  } catch (error) {
    throw new Error(`${path}.${key}: ${errorText(error)}`, { cause: error });
  }
}

function integerText(text: string, path: string): number {
  if (!/^\d+$/.test(text)) throw new Error(`${path}: expected whole seconds, got "${text}"`);
  return Number(text);
}

function fail(reason: string, where: string, detail: string): MarketReading {
  return { ok: false, skip: { reason, detail: `${where}: ${detail}` } };
}
