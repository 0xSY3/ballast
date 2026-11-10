import type { PolymarketLeg, WatchEvent } from "../config.ts";
import { asArray, asRecord, decimalTextToNumber, readBoolean, readNumber, readString } from "../json.ts";
import { errorText } from "../net.ts";
import { buildOddsSignal, checkTwoSided, legSkip, type LegReading, type SenseContext } from "./odds.ts";

export const GAMMA_API = "https://gamma-api.polymarket.com";
export const CLOB_API = "https://clob.polymarket.com";

type GammaMarket = { active: boolean; closed: boolean; acceptingOrders: boolean; yesTokenId: string };
export type HistoryPoint = { t: number; p: number };

export function gammaMarketUrl(leg: PolymarketLeg): string {
  return `${GAMMA_API}/markets?slug=${encodeURIComponent(leg.slug)}`;
}

export function clobBookUrl(tokenId: string): string {
  return `${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`;
}

export function clobHistoryUrl(tokenId: string, startTs: number, endTs: number): string {
  return `${CLOB_API}/prices-history?market=${encodeURIComponent(tokenId)}&startTs=${startTs}&endTs=${endTs}&fidelity=1`;
}

export async function readPolymarketLeg(leg: PolymarketLeg, event: WatchEvent, ctx: SenseContext): Promise<LegReading> {
  const signalId = `polymarket:${leg.slug}`;
  const gamma = await ctx.fetchJson(gammaMarketUrl(leg));
  if (!gamma.ok) return legSkip("source_unavailable", signalId, gamma.error);
  let market: GammaMarket;
  try {
    market = parseGammaMarket(gamma.data, leg.slug);
  } catch (error) {
    return legSkip("bad_response", signalId, errorText(error));
  }
  // A replay asks whether the market traded at that moment; its status today does not matter.
  if (ctx.replay) return readReplayedLeg(leg, event, ctx, market.yesTokenId);
  if (market.closed || !market.active || !market.acceptingOrders) {
    return legSkip("market_not_active", signalId, "market is closed or not accepting orders");
  }

  const nowTs = Math.floor(ctx.now.getTime() / 1000);
  const startTs = nowTs - Math.round(ctx.policy.macro.historyLookbackHours * 3600);
  const [book, history] = await Promise.all([
    ctx.fetchJson(clobBookUrl(market.yesTokenId)),
    ctx.fetchJson(clobHistoryUrl(market.yesTokenId, startTs, nowTs)),
  ]);
  if (!book.ok) return legSkip("source_unavailable", signalId, book.error);
  if (!history.ok) return legSkip("source_unavailable", signalId, history.error);
  let top: { bid: number | null; ask: number | null };
  let points: HistoryPoint[];
  try {
    top = parseTopOfBook(book.data);
    points = parseHistory(history.data);
  } catch (error) {
    return legSkip("bad_response", signalId, errorText(error));
  }

  const { macro } = ctx.policy;
  const quote = checkTwoSided(top.bid, top.ask, macro.maxQuoteSpreadPts);
  if (!quote.ok) {
    // These feeds carry no trade timestamps, so a last-trade fallback could be hours old.
    return legSkip("unusable_quote", signalId, quote.why);
  }
  const cutoffTs = nowTs - macro.windowMinutes * 60;
  const baselinePoint = points.findLast((point) => point.t <= cutoffTs);
  return {
    ok: true,
    signal: buildOddsSignal({
      source: "polymarket",
      key: leg.slug,
      event,
      value: quote.mid,
      baseline: baselinePoint ? baselinePoint.p : null,
      now: ctx.now,
      twoSided: true,
      ...(baselinePoint ? {} : { note: `no price from ${macro.windowMinutes} min ago` }),
    }),
  };
}

/** Value and baseline both from recorded price history; today's book is never read. */
async function readReplayedLeg(
  leg: PolymarketLeg,
  event: WatchEvent,
  ctx: SenseContext,
  yesTokenId: string,
): Promise<LegReading> {
  const signalId = `polymarket:${leg.slug}`;
  const { macro } = ctx.policy;
  const nowTs = Math.floor(ctx.now.getTime() / 1000);
  const startTs = nowTs - Math.round(macro.historyLookbackHours * 3600);
  const history = await ctx.fetchJson(clobHistoryUrl(yesTokenId, startTs, nowTs));
  if (!history.ok) return legSkip("source_unavailable", signalId, history.error);
  let points: HistoryPoint[];
  try {
    points = parseHistory(history.data).filter((point) => point.t <= nowTs);
  } catch (error) {
    return legSkip("bad_response", signalId, errorText(error));
  }
  const current = points.at(-1);
  if (!current || nowTs - current.t > macro.maxLastTradeAgeMinutes * 60) {
    return legSkip("unusable_quote", signalId, `no recorded price in the ${macro.maxLastTradeAgeMinutes} min before ${ctx.now.toISOString()}`);
  }
  const baselinePoint = points.findLast((point) => point.t <= nowTs - macro.windowMinutes * 60);
  const notes = ["replayed from recorded price history"];
  if (!baselinePoint) notes.push(`no price from ${macro.windowMinutes} min ago`);
  return {
    ok: true,
    signal: buildOddsSignal({
      source: "polymarket",
      key: leg.slug,
      event,
      value: current.p,
      baseline: baselinePoint ? baselinePoint.p : null,
      now: ctx.now,
      // Price history carries no book, so whether both sides were quoted is unknown rather than false.
      twoSided: null,
      note: notes.join("; "),
    }),
  };
}

export function parseGammaMarket(raw: unknown, slug: string): GammaMarket {
  const match = asArray(raw, "gamma.markets").find(
    (entry) => typeof entry === "object" && entry !== null && "slug" in entry && entry.slug === slug,
  );
  if (match === undefined) throw new Error(`gamma returned no market with slug ${slug}`);
  const market = asRecord(match, "gamma.market");
  const outcomes = parseEmbeddedStringArray(readString(market, "outcomes", "gamma.market"), "gamma.market.outcomes");
  const tokenIds = parseEmbeddedStringArray(
    readString(market, "clobTokenIds", "gamma.market"),
    "gamma.market.clobTokenIds",
  );
  const yesIndex = outcomes.indexOf("Yes");
  const yesTokenId = tokenIds[yesIndex];
  if (yesIndex < 0 || yesTokenId === undefined || outcomes.length !== tokenIds.length) {
    throw new Error("gamma.market has no YES token");
  }
  return {
    active: readBoolean(market, "active", "gamma.market"),
    closed: readBoolean(market, "closed", "gamma.market"),
    acceptingOrders: readBoolean(market, "acceptingOrders", "gamma.market"),
    yesTokenId,
  };
}

// Gamma ships outcomes and token ids as JSON text inside a string field.
function parseEmbeddedStringArray(text: string, path: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: not JSON text`, { cause: error });
  }
  return asArray(parsed, path).map((item, index) => {
    if (typeof item !== "string") throw new Error(`${path}[${index}]: expected a string`);
    return item;
  });
}

function parseTopOfBook(raw: unknown): { bid: number | null; ask: number | null } {
  const book = asRecord(raw, "clob.book");
  const prices = (side: "bids" | "asks") =>
    asArray(book[side], `clob.book.${side}`).map((level, index) => {
      const path = `clob.book.${side}[${index}]`;
      return decimalTextToNumber(readString(asRecord(level, path), "price", path), `${path}.price`);
    });
  const bids = prices("bids");
  const asks = prices("asks");
  // Level order differs between bids and asks in this feed, so take the extremes explicitly.
  return {
    bid: bids.length > 0 ? Math.max(...bids) : null,
    ask: asks.length > 0 ? Math.min(...asks) : null,
  };
}

export function parseHistory(raw: unknown): HistoryPoint[] {
  const points = asArray(asRecord(raw, "clob.history").history, "clob.history.history").map((entry, index) => {
    const path = `clob.history.history[${index}]`;
    const point = asRecord(entry, path);
    return { t: readNumber(point, "t", path), p: readNumber(point, "p", path) };
  });
  return points.sort((a, b) => a.t - b.t);
}
