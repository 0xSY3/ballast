import type { BookPosition, EngineConfig, OddsLeg, WatchEvent } from "./config.ts";
import { formatFixed, parseFixed } from "./decimal.ts";
import { evaluateEvent, type EventShock } from "./detect/macro.ts";
import { roundTo } from "./math.ts";
import { errorText, type JsonFetcher } from "./net.ts";
import { sizeHedge, type HedgeMarket } from "./policy.ts";
import { buildVector, type DriverCandidate } from "./score.ts";
import { readKalshiLeg } from "./sources/kalshi.ts";
import type { LegReading, SenseContext } from "./sources/odds.ts";
import { readPolymarketLeg } from "./sources/polymarket.ts";
import type { HedgeOrder, OrderPayload, RiskVector, RunOutput, Signal, Skipped } from "./types.ts";

export type MarketReading =
  | { ok: true; market: HedgeMarket; signals: Signal[]; drivers: DriverCandidate[]; skipped: Skipped[] }
  | { ok: false; skip: Skipped };

export type MarketReader = (position: BookPosition, ctx: SenseContext) => Promise<MarketReading>;

export type OrderSender = { address: string; subaccountId: string; isPlaceholder: boolean };

export type PayloadBuilder = (order: HedgeOrder, market: HedgeMarket, sender: OrderSender) => OrderPayload;

export type RunDeps = {
  fetchJson: JsonFetcher;
  now: () => Date;
  killSwitch: boolean;
  sender: OrderSender;
  readMarket: MarketReader;
  buildPayload: PayloadBuilder;
  /** Replay the odds legs as recorded at this moment; Injective data stays as of `now`. */
  replayAt?: Date;
};

/**
 * Memory carried between passes of `watch`. Dry-run orders count as filled so the next pass
 * sizes against the hedge it would already hold, and cooldowns apply as they would live.
 */
export type EngineState = {
  lastOrderAt: Record<string, number>;
  paperHedgeUsd: Record<string, string>;
};

export const emptyState = (): EngineState => ({ lastOrderAt: {}, paperHedgeUsd: {} });

export async function runPass(
  config: EngineConfig,
  deps: RunDeps,
  state: EngineState,
): Promise<{ output: RunOutput; state: EngineState }> {
  const now = deps.now();
  const ctx: SenseContext = { fetchJson: deps.fetchJson, now, policy: config.policy };
  // Orders are sized against the books, oracle and funding an order sent now would meet,
  // so only the odds legs move back to the replay time.
  const oddsCtx: SenseContext = deps.replayAt ? { ...ctx, now: deps.replayAt, replay: true } : ctx;
  const skipped: Skipped[] = [];

  const [macro, markets] = await Promise.all([
    senseMacro(config.watchlist, oddsCtx),
    Promise.all(
      config.book.map(async (position) => ({ position, reading: await guardedMarketRead(deps.readMarket, position, ctx) })),
    ),
  ]);
  skipped.push(...macro.skipped);

  const signals: Signal[] = [...macro.signals];
  const vectors: RiskVector[] = [];
  const orders: HedgeOrder[] = [];
  const payloads: OrderPayload[] = [];
  const nextState: EngineState = {
    lastOrderAt: { ...state.lastOrderAt },
    paperHedgeUsd: { ...state.paperHedgeUsd },
  };

  for (const { position, reading } of markets) {
    if (reading.ok) {
      signals.push(...reading.signals);
      skipped.push(...reading.skipped);
    } else {
      skipped.push(reading.skip);
    }
    const candidates = [...macroDriversFor(position, macro.shocks), ...(reading.ok ? reading.drivers : [])];
    const vector = buildVector({ position, candidates, now, policy: config.policy });
    if (!vector) continue;
    vectors.push(vector);
    // Without fresh market data the vector is still reported, but nothing is sized against it.
    if (!reading.ok) continue;

    const marketId = position.market.marketId;
    const paperHedge = parseFixed(nextState.paperHedgeUsd[marketId] ?? "0");
    const decision = sizeHedge(vector, reading.market, {
      policy: config.policy,
      killSwitch: deps.killSwitch,
      now,
      lastOrderAt: nextState.lastOrderAt[marketId] ?? null,
      currentHedgeUsd: position.currentHedgeUsd + paperHedge,
      exposureUsd: position.exposureUsd,
    });
    if (!decision.ok) {
      skipped.push(decision.skip);
      continue;
    }
    let payload: OrderPayload;
    try {
      payload = deps.buildPayload(decision.order, reading.market, deps.sender);
    } catch (error) {
      skipped.push({ reason: "payload_error", detail: `${position.market.ticker}: ${errorText(error)}` });
      continue;
    }
    orders.push(decision.order);
    payloads.push(payload);
    nextState.lastOrderAt[marketId] = now.getTime();
    nextState.paperHedgeUsd[marketId] = formatFixed(paperHedge + parseFixed(decision.order.notionalUsd));
  }

  return {
    output: {
      runAt: now.toISOString(),
      ...(deps.replayAt ? { mode: "replay", replayAt: deps.replayAt.toISOString() } : { mode: "dry-run" }),
      signals,
      vectors,
      orders,
      payloads,
      skipped,
    },
    state: nextState,
  };
}

async function senseMacro(
  watchlist: WatchEvent[],
  ctx: SenseContext,
): Promise<{ signals: Signal[]; shocks: EventShock[]; skipped: Skipped[] }> {
  const perEvent = await Promise.all(
    watchlist.map(async (event) => {
      const readings = await Promise.all(event.legs.map((leg) => guardedLegRead(leg, event, ctx)));
      const legSignals = readings.flatMap((reading) => (reading.ok ? [reading.signal] : []));
      const legSkips = readings.flatMap((reading) => (reading.ok ? [] : [reading.skip]));
      const evaluated = evaluateEvent(event, legSignals, ctx.policy);
      return { legSignals, skipped: [...legSkips, ...evaluated.skipped], shock: evaluated.shock };
    }),
  );
  return {
    signals: perEvent.flatMap((entry) => entry.legSignals),
    shocks: perEvent.flatMap((entry) => (entry.shock ? [entry.shock] : [])),
    skipped: perEvent.flatMap((entry) => entry.skipped),
  };
}

function macroDriversFor(position: BookPosition, shocks: EventShock[]): DriverCandidate[] {
  return shocks.flatMap((shock) => {
    const link = shock.event.affects.find((entry) => entry.asset === position.asset);
    if (!link) return [];
    return [{
      signalId: shock.signal.id,
      strength: roundTo(shock.strength * link.weight, 4),
      quality: shock.quality,
      note: shock.note,
    }];
  });
}

// Sources already turn network and parse failures into skips; this catches anything they missed
// so one bad source can never take the whole pass down.
async function guardedLegRead(leg: OddsLeg, event: WatchEvent, ctx: SenseContext): Promise<LegReading> {
  const label = leg.source === "kalshi" ? `kalshi:${leg.ticker}` : `polymarket:${leg.slug}`;
  try {
    return leg.source === "kalshi" ? await readKalshiLeg(leg, event, ctx) : await readPolymarketLeg(leg, event, ctx);
  } catch (error) {
    return { ok: false, skip: { reason: "internal_error", detail: `${label}: ${errorText(error)}` } };
  }
}

async function guardedMarketRead(
  readMarket: MarketReader,
  position: BookPosition,
  ctx: SenseContext,
): Promise<MarketReading> {
  try {
    return await readMarket(position, ctx);
  } catch (error) {
    return { ok: false, skip: { reason: "internal_error", detail: `${position.market.ticker}: ${errorText(error)}` } };
  }
}
