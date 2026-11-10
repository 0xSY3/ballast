export type SignalSource = "kalshi" | "polymarket" | "injective";

export type SignalMetric = "yes_odds" | "funding_rate" | "basis" | "spread" | "depth" | "oracle_age";

export type SignalQuality = { fresh: boolean; twoSided: boolean | null; note?: string };

/**
 * One observation. Units by metric:
 * - yes_odds: YES probability 0..1; `change` is in probability units (0.05 = 5 pts).
 * - funding_rate: rate per funding interval; `change` is the z-score against `baseline` (trailing mean).
 * - basis: (mark - oracle) / oracle as a fraction; spread: (ask - bid) / mid as a fraction.
 * - depth: USD resting within the price band; oracle_age: seconds.
 */
export type Signal = {
  id: string;
  kind: "macro" | "market";
  source: SignalSource;
  subject: string;
  metric: SignalMetric;
  value: number;
  baseline: number | null;
  change: number | null;
  observedAt: string;
  quality: SignalQuality;
};

export type Driver = { signalId: string; strength: number; note: string };

export type HedgeSide = "sell" | "buy";

export type RiskVector = {
  id: string;
  createdAt: string;
  market: { ticker: string; marketId: string };
  hedgeSide: HedgeSide;
  intensity: number;
  confidence: number;
  ttlSeconds: number;
  drivers: Driver[];
};

export type HedgeOrder = {
  vectorId: string;
  marketId: string;
  ticker: string;
  side: "BUY" | "SELL";
  quantity: string;
  worstPrice: string;
  margin: string;
  notionalUsd: string;
  limitsApplied: string[];
};

export type Skipped = { reason: string; detail: string };

/**
 * Injective exchange v2 MsgCreateDerivativeMarketOrder in proto JSON. Decimal fields are
 * LegacyDec integers (human value x 10^18); orderType 1 = BUY, 2 = SELL.
 */
export type DerivativeMarketOrderMsg = {
  "@type": "/injective.exchange.v2.MsgCreateDerivativeMarketOrder";
  sender: string;
  order: {
    marketId: string;
    orderInfo: { subaccountId: string; feeRecipient: string; price: string; quantity: string; cid: string };
    orderType: 1 | 2;
    margin: string;
    triggerPrice: string;
    expirationBlock: string;
  };
};

export type OrderPayload = { msg: DerivativeMarketOrderMsg };

export type RunOutput = {
  runAt: string;
  mode: "dry-run" | "replay";
  /** Only in replay mode: the moment whose recorded macro odds were replayed. */
  replayAt?: string;
  signals: Signal[];
  vectors: RiskVector[];
  orders: HedgeOrder[];
  payloads: OrderPayload[];
  skipped: Skipped[];
};
