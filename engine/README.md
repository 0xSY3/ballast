# Ballast engine

The agent behind Ballast: **Sense → Score → Hedge**. It reads macro event odds from Kalshi and
Polymarket and market stress from Injective derivative markets, turns them into risk vectors, sizes
hedges against a book under hard limits, and writes Injective `MsgCreateDerivativeMarketOrder`
payloads. It runs in **dry-run mode only**: nothing is signed or broadcast, and no key is needed.

Status: prototype. Everything below runs from this folder. Sizing, limits and payloads are plain
deterministic code with tests; there is no model call anywhere in the loop.

## Run

Needs [Bun](https://bun.sh) 1.3+.

```bash
bun install
bun run once                      # one pass, writes out/latest.json
bun run once --at 2026-11-06T13:50:00Z   # replay recorded odds at that moment, writes out/replay.json
bun run watch                     # a pass every 60 s (policy.watch.intervalSeconds); Ctrl-C stops
bun run watch --interval 30       # override the interval
bun run scripts/scan-moves.ts     # largest 60-min odds moves of the last 30 days (--days, --top)
bun test                          # offline: replays recorded API responses
bun run typecheck
```

Environment (all optional):

| Variable | Effect |
| --- | --- |
| `BALLAST_KILL=1` | Kill switch. Sensing and scoring still run; every order is skipped with `kill_switch`. |
| `BALLAST_SENDER`, `BALLAST_SUBACCOUNT_ID` | Fill the payload sender. Without both, payloads carry a placeholder that is deliberately not a valid address, so they cannot be signed as-is. |

`once` starts with no memory. `watch` keeps memory between passes: the cooldown per market, and
dry-run orders counted as filled (a paper hedge) so the next pass sizes against the hedge it would
already hold.

## Config

All three files live in `config/`. Policy numbers are operator settings, not forecasts.

- **`watchlist.json`**: macro events. Each event has `legs` (the same outcome quoted on one or two
  venues), `riskOffWhen` (`yes_up` if a rising YES price is bad for the book, `yes_down` if falling
  is), and `affects` (asset weights in (0, 1]). Tickers and slugs were resolved from the live APIs on
  2026-11-10:
  - Fed hikes 25 bp at the 9 Dec 2026 FOMC: Kalshi `KXFEDDECISION-26DEC-H25` and Polymarket
    `will-the-fed-increase-interest-rates-by-25-bps-after-the-december-2026-meeting-20260729232808636`
  - US CPI above 3.7% y/y for November (released 10 Dec 2026): Kalshi `KXCPIYOY-26NOV-T3.7`
  - US recession in 2027: Kalshi `KXRECSSNBER-27`
- **`book.json`**: the demo book. `exposureUsd` is spot exposure (positive long, negative short);
  `currentHedgeUsd` is the perp hedge already held. Each position names its Injective mainnet
  perpetual (all USDC-quoted, 6 quote decimals), checked against the chain on every pass:

  | Asset | Ticker | Market id |
  | --- | --- | --- |
  | BTC | `BTC/USDC PERP` | `0x0ee7ca44147bab6ec81ac293b5fe7915488e612af59964b2d663d6008d861dee` |
  | ETH | `ETH/USDC PERP` | `0xe9c90a90ec75194ba9693f12b58a88a06937599e00c2adbc565a7b1a6ffbe4ed` |
  | INJ | `INJ/USDC PERP` | `0x790aee464fbbd02cf4476444554c71d1225f7edfe15e6dc7f874c455fd883d31` |
  | NVDA | `NVDA/USDC PERP` | `0xb9d9202c588e860382c96aee096f9655fce339f6b51833a939a37d2437080c17` |

  NVDA is the one real-world-asset perp with a usable book on 2026-11-10; the gold, index and FX
  perps listed then had empty or one-sided books.
- **`policy.json`**: detector thresholds, hedge limits, confidence factors, network settings.
  Amounts are decimal strings; ratios are numbers.

## How scoring works

**Sense.** Each macro leg yields a `yes_odds` signal: the midpoint of a two-sided quote now, and the
quote as of 60 minutes ago from the venue's own history (Kalshi one-minute candlesticks, Polymarket
CLOB `prices-history`), so the first run already has a change. A one-sided Kalshi quote falls back
to the last trade only if it is under 60 minutes old; Polymarket legs need a two-sided book. Quotes
wider than 10 pts are not used.

Injective data comes from public endpoints, no key:

| Read | Endpoint |
| --- | --- |
| Market (ticks, min notional, margin ratio, oracle, status) | LCD `/injective/exchange/v2/derivative/markets/{id}` |
| Order book, 50 levels | LCD `/injective/exchange/v2/derivative/orderbook/{id}?limit=50` |
| Oracle price and time | LCD `/injective/oracle/v1beta1/price?oracle_type&base&quote` |
| Funding history (hourly) | Indexer `/api/exchange/derivative/v1/fundingRates?marketId&limit=200` |

LCD exchange v2 returns human-readable decimals. The oracle's time is the older of its base and
quote feed times. Injective's mark price is its oracle price, so basis compares the book mid (the
perp's own traded price) to the oracle. The market and book are required; an oracle or funding
outage is reported in `skipped` and leaves that signal out (no oracle time also blocks any order).

**Detect.** Every detector is zero below its trigger, then linear up to 1 at full scale:

| Detector | Measures | Trigger | Full scale |
| --- | --- | --- | --- |
| Macro odds | risk-off change over 60 min | 5 pts | 20 pts |
| Funding rate | z-score of the latest rate vs the 7 days before it, either tail | 2.5 | 5 |
| Basis | \|perp − oracle\| / oracle | 0.4% | 1.5% |
| Spread | (ask − bid) / mid | 25 bps | 100 bps |

So a 5 pt odds move scores 0.25 and a 10 pt move 0.5. When a macro event has two legs, the smaller
move counts: one venue moving alone cannot trigger a hedge. A macro driver's strength for an asset
is the event strength times its `affects` weight. Funding needs at least 24 samples in the window
and a history that is not flat. Basis is never scored while the oracle is stale. Oracle age and
depth are reported as signals but do not score; they feed the limits below.

**Score.** Per Injective market, `intensity = 1 − Π(1 − strength_i)` over its drivers.
`confidence` is the strength-weighted mean of driver quality: 1 for a two-sided quote confirmed by a
second venue, × 0.8 for a single venue, × 0.5 for a last-trade reading. The vector id is the
sha256 of the market, side, drivers (id and strength) and the 10-minute window, and is reused as the
order's client id, so a repeated pass in the same window cannot mint a second order.

## How limits work

Checked in this order; the first that fails becomes a `skipped` entry with a reason.

1. `kill_switch`: `BALLAST_KILL=1`.
2. `missing_oracle` / `stale_oracle`: no oracle timestamp, or older than 120 s.
3. `low_confidence`: vector confidence under 0.5.
4. `cooldown`: an order on the same market in the last 10 minutes.
5. `one_sided_book`: the market's book has no bid or no ask, or is crossed.
6. Sizing: `target = intensity × 0.6 × |exposure|`; `order = target − current hedge`
   (`hedge_at_target` if nothing is left to add).
7. `cap:max_order_notional`: at most $25,000 per order.
8. `cap:book_depth`: at most the quantity resting within 1% of mid on the side the order takes.
9. Quantity rounds **down** to the market's quantity tick; `below_min_order` if the result is under
   $500 or under the market's own `min_notional`, whichever is higher.
10. Worst price is mid ∓ 1%, rounded **toward mid** on the price tick (up for a sell, down for a
    buy), so rounding never widens the slippage allowed.
11. Margin is the notional at the worse of mid and worst price over the policy leverage (2×),
    raised to the market's initial margin ratio if that is higher (`floor:initial_margin`), and
    rounded up to the quote token's smallest unit.

Any network failure (10 s timeout, 2 retries with backoff), malformed response, closed market or
unusable quote becomes a `skipped` entry. A pass never throws on bad data and never hedges on it.
The payload builder refuses a price, quantity or margin off the market's grid (`payload_error`).

## Output

`out/latest.json` (and `out/replay.json`, see below):

```ts
{ runAt, mode: "dry-run" | "replay", replayAt?, signals: Signal[], vectors: RiskVector[],
  orders: HedgeOrder[], payloads: { msg }[], skipped: { reason, detail }[] }
```

Types are in `src/types.ts`. Signal units:

| Metric | `value` / `baseline` | `change` |
| --- | --- | --- |
| `yes_odds` | YES probability, 0 to 1 | probability units (0.05 = 5 pts) |
| `funding_rate` | rate per hourly interval / trailing 7-day mean | z-score |
| `basis` | (book mid − oracle) / oracle, a fraction | null |
| `spread` | (ask − bid) / mid, a fraction | null |
| `depth` | USD resting within 1% of mid on the hedge side | null |
| `oracle_age` | seconds | null |

Orders (`HedgeOrder`) carry human-readable decimal strings. Each payload is the Injective exchange
v2 message in proto JSON, camelCase, as the TypeScript SDK builds it:

```json
{ "msg": {
    "@type": "/injective.exchange.v2.MsgCreateDerivativeMarketOrder",
    "sender": "inj1-dry-run-placeholder-sender",
    "order": {
      "marketId": "0x0ee7…1dee",
      "orderInfo": { "subaccountId": "0x-dry-run-placeholder-subaccount",
                     "feeRecipient": "inj1-dry-run-placeholder-sender",
                     "price": "73618000000000000000000", "quantity": "336190000000000000",
                     "cid": "978ceacb0db9156a095a5fbdca0c63ec" },
      "orderType": 2, "margin": "12499796343000000000000",
      "triggerPrice": "0", "expirationBlock": "0" } } }
```

`price`, `quantity` and `margin` are LegacyDec integers: the human value × 10^18 (73618 USDC per
BTC, 0.33619 BTC, 12499.796343 USDC margin above). `orderType` 1 is BUY, 2 is SELL. `cid` is the
first 32 hex characters of the risk vector id (the chain allows 36).

## Replay

`bun run once --at <ISO>` re-runs the odds legs as they were recorded at that moment: Kalshi from
the one-minute candle in force then, Polymarket from its price history (marked `twoSided: null`,
since history carries no book). Nothing recorded after that moment is read, and each replayed
signal says so in `quality.note`. Injective books, oracle and funding stay as of the run, because
those are what an order sent now would meet. Thresholds and limits are the shipped ones. The
output goes to `out/replay.json` with `mode: "replay"` and `replayAt`.

`scripts/scan-moves.ts` finds moments worth replaying: it reads 30 days of one-minute history for
every leg (in 3-day chunks, the most each venue serves per request), applies the same cross-venue
rule (the smaller move counts), and lists the largest 60-minute risk-off moves. It marks a Kalshi
reading that is a trade print inside a quote wider than 10 pts, which the engine scores at half
confidence, and names the largest move confirmed on two venues.

## Tests

`bun test` needs no network. `test/fixtures/<name>/` holds API responses recorded by

```bash
bun run scripts/record-fixtures.ts <name>
```

which runs one live pass, saves every response it read plus `expected-output.json`. Tests replay
the recording at its `recordedAt` time and must reproduce that output exactly. Replay-mode and
failure tests use small in-memory responses or the recording with one endpoint replaced.
