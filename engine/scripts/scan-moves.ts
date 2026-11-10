/**
 * Ranks the largest 60-minute risk-off odds moves per watchlist event over the last N days, to pick
 * a moment worth replaying with `bun run once --at <ISO>`. Ranking only: the replay itself applies
 * every engine rule (quote checks, staleness, thresholds, limits).
 * Usage: bun run scripts/scan-moves.ts [--days 30] [--top 10]
 */
import { join } from "node:path";
import { loadConfig, type OddsLeg, type Policy, type WatchEvent } from "../src/config.ts";
import { roundTo } from "../src/math.ts";
import { createLiveFetcher, errorText, type JsonFetcher } from "../src/net.ts";
import { kalshiCandlesUrl, parseCandles } from "../src/sources/kalshi.ts";
import { checkTwoSided } from "../src/sources/odds.ts";
import { clobHistoryUrl, gammaMarketUrl, parseGammaMarket, parseHistory } from "../src/sources/polymarket.ts";

const ENGINE_DIR = join(import.meta.dir, "..");
// Kalshi serves at most 5000 one-minute candles per request and Polymarket rejects one-minute
// ranges much past a few days, so history is read in 3-day chunks.
const CHUNK_SECONDS = 3 * 86400;
// Moves of one event closer together than this are one episode, listed once.
const EPISODE_SECONDS = 3 * 3600;

/** `trade`: a Kalshi trade print taken because the quote then was one-sided or too wide. */
type Level = { t: number; p: number; trade?: boolean };
type LegSeries = { label: string; levels: Level[] };
type Move = { event: WatchEvent; t: number; pts: number; legs: { label: string; from: number; to: number; trade: boolean }[] };

function flag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number`);
  return value;
}

function chunks(startTs: number, endTs: number): [number, number][] {
  const ranges: [number, number][] = [];
  for (let from = startTs; from < endTs; from += CHUNK_SECONDS) ranges.push([from, Math.min(from + CHUNK_SECONDS, endTs)]);
  return ranges;
}

async function legLevels(leg: OddsLeg, fetchJson: JsonFetcher, policy: Policy, startTs: number, endTs: number): Promise<LegSeries> {
  const label = leg.source === "kalshi" ? `Kalshi ${leg.ticker}` : `Polymarket ${leg.slug.slice(0, 48)}`;
  const levels: Level[] = [];
  let tokenId = "";
  if (leg.source === "polymarket") {
    const gamma = await fetchJson(gammaMarketUrl(leg));
    if (!gamma.ok) throw new Error(`${label}: ${gamma.error}`);
    tokenId = parseGammaMarket(gamma.data, leg.slug).yesTokenId;
  }
  for (const [from, to] of chunks(startTs, endTs)) {
    const url = leg.source === "kalshi" ? kalshiCandlesUrl(leg, from, to) : clobHistoryUrl(tokenId, from, to);
    const result = await fetchJson(url);
    if (!result.ok) {
      console.warn(`warning: ${label} ${new Date(from * 1000).toISOString()} chunk unavailable (${result.error}); gap left`);
      continue;
    }
    if (leg.source === "kalshi") {
      for (const candle of parseCandles(result.data)) {
        const quote = checkTwoSided(candle.bid, candle.ask, policy.macro.maxQuoteSpreadPts);
        if (quote.ok) levels.push({ t: candle.endTs, p: quote.mid });
        else if (candle.tradePrice !== null) levels.push({ t: candle.endTs, p: candle.tradePrice, trade: true });
      }
    } else {
      levels.push(...parseHistory(result.data));
    }
  }
  levels.sort((a, b) => a.t - b.t);
  return { label, levels };
}

/** Index of the last level at or before `t`, or -1. */
function lastAtOrBefore(levels: Level[], t: number): number {
  let low = 0;
  let high = levels.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const level = levels[mid];
    if (level !== undefined && level.t <= t) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function eventMoves(event: WatchEvent, series: LegSeries[], policy: Policy, startTs: number, endTs: number): Move[] {
  const windowSeconds = policy.macro.windowMinutes * 60;
  const maxAgeSeconds = policy.macro.maxLastTradeAgeMinutes * 60;
  const sign = event.riskOffWhen === "yes_up" ? 1 : -1;
  const moves: Move[] = [];
  for (let t = Math.ceil((startTs + windowSeconds) / 60) * 60; t <= endTs; t += 60) {
    const legs: Move["legs"] = [];
    for (const leg of series) {
      const now = leg.levels[lastAtOrBefore(leg.levels, t)];
      const then = leg.levels[lastAtOrBefore(leg.levels, t - windowSeconds)];
      if (now === undefined || then === undefined || t - now.t > maxAgeSeconds) continue;
      legs.push({ label: leg.label, from: then.p, to: now.p, trade: now.trade === true });
    }
    if (legs.length === 0) continue;
    // Same cross-venue rule as the engine: the smaller of the confirming moves counts.
    const pts = Math.min(...legs.map((leg) => sign * (leg.to - leg.from) * 100));
    if (pts > 0) moves.push({ event, t, pts: roundTo(pts, 2), legs });
  }
  return moves;
}

function episodes(moves: Move[], top: number): Move[] {
  const picked: Move[] = [];
  for (const move of [...moves].sort((a, b) => b.pts - a.pts || a.t - b.t)) {
    const overlaps = picked.some((entry) => entry.event.id === move.event.id && Math.abs(entry.t - move.t) < EPISODE_SECONDS);
    if (!overlaps) picked.push(move);
    if (picked.length === top) break;
  }
  return picked;
}

const pct = (p: number) => `${roundTo(p * 100, 1)}%`;

async function main(): Promise<void> {
  const days = flag("--days", 30);
  const top = flag("--top", 10);
  const config = await loadConfig(join(ENGINE_DIR, "config"));
  const { policy } = config;
  const fetchJson = createLiveFetcher(policy.network);
  const endTs = Math.floor(Date.now() / 60_000) * 60;
  const startTs = endTs - days * 86400;

  const all: Move[] = [];
  for (const event of config.watchlist) {
    const settled = await Promise.allSettled(event.legs.map((leg) => legLevels(leg, fetchJson, policy, startTs, endTs)));
    const series: LegSeries[] = [];
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") series.push(outcome.value);
      else console.warn(`warning: ${event.id}: ${errorText(outcome.reason)}`);
    }
    // Leaving out an unreadable leg would let one venue alone rank a move the engine would not confirm.
    if (series.length !== event.legs.length) {
      console.warn(`warning: ${event.id}: skipped, not every leg could be read`);
      continue;
    }
    all.push(...eventMoves(event, series, policy, startTs, endTs));
  }

  const best = episodes(all, top);
  console.log(`Largest ${policy.macro.windowMinutes}-min risk-off odds moves, last ${days} days (threshold ${policy.macro.thresholdPts} pts):`);
  for (const move of best) {
    const legs = move.legs
      .map((leg) => `${leg.label} ${pct(leg.from)} -> ${pct(leg.to)}${leg.trade ? " (trade print, quote too wide)" : ""}`)
      .join("; ");
    const scores = move.pts >= policy.macro.thresholdPts ? "scores" : "below threshold";
    console.log(`  ${new Date(move.t * 1000).toISOString()}  ${move.event.id}  +${move.pts} pts (${scores})  ${legs}`);
  }
  const first = best[0];
  if (first) console.log(`\nlargest: bun run once --at ${new Date(first.t * 1000).toISOString()}`);
  // The engine discounts a single venue and a trade print, so this is the largest move it reads at full confidence.
  const confirmed = best.find((move) => move.legs.length >= 2 && move.legs.every((leg) => !leg.trade));
  if (confirmed) console.log(`largest confirmed on two venues: bun run once --at ${new Date(confirmed.t * 1000).toISOString()}`);
}

await main();
