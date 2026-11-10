import { clamp01, roundTo } from "../math.ts";

/**
 * FOMC statement days (the second day of each meeting), from
 * https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm, read 2026-11-10. The Fed treats each date as
 * tentative until the meeting before it confirms it, so re-check the 2027 entries as they come up.
 */
export const FOMC_DECISION_DATES: readonly string[] = [
  "2026-01-28",
  "2026-03-18",
  "2026-04-29",
  "2026-06-17",
  "2026-07-29",
  "2026-09-16",
  "2026-10-28",
  "2026-12-09",
  "2027-01-27",
  "2027-03-17",
  "2027-04-28",
  "2027-06-09",
  "2027-07-28",
  "2027-09-15",
  "2027-10-27",
  "2027-12-08",
];

/** One standard policy move, in percent (25 bp). */
export const FED_STEP = 0.25;

/**
 * Solving the meeting month's average for r_end multiplies price noise by N / (N − d); below this many days at
 * the new rate FedWatch reads the next month's contract instead.
 */
export const MIN_DAYS_AFTER_DECISION = 7;

/** A 30-day fed funds future (ZQ) price for one contract month ("YYYY-MM"); 100 − price is the month-average EFFR in percent. */
export type ZqPrice = { month: string; price: number };

export type MoveDirection = "cut" | "hike" | "hold";

export type MeetingMove = { probability: number; direction: MoveDirection; changeBp: number };

export type MeetingImplied = MeetingMove & {
  decisionDate: string;
  rateBefore: number;
  rateAfter: number;
  startFrom: "prior_month" | "previous_meeting" | "effective_rate";
  endFrom: "meeting_month" | "next_month";
};

export type UnpricedMeeting = { decisionDate: string; reason: string };

export type FedPath = { meetings: MeetingImplied[]; unpriced: UnpricedMeeting[] };

export type FedPathInput = {
  prices: readonly ZqPrice[];
  /** UTC date ("YYYY-MM-DD") of the reading; meetings decided before it are history. */
  asOf: string;
  decisionDates?: readonly string[];
  /** Current EFFR in percent; anchors the first meeting only when the month before it has a meeting or no price. */
  effectiveRate?: number;
  step?: number;
  minDaysAfterDecision?: number;
};

/**
 * r_end = (N·r_m − d·r_start) / (N − d) with r_m = 100 − F_m, the old rate holding days 1..d of an N-day month.
 * Ref: CME Group, FedWatch Tool methodology. Null unless 1 ≤ d < N (integers) and the inputs are finite.
 */
export function impliedRateAfterMeeting(input: {
  monthPrice: number;
  rateBefore: number;
  daysInMonth: number;
  decisionDay: number;
}): number | null {
  const { monthPrice, rateBefore, daysInMonth, decisionDay } = input;
  if (!Number.isFinite(monthPrice) || !Number.isFinite(rateBefore)) return null;
  if (!Number.isInteger(daysInMonth) || !Number.isInteger(decisionDay)) return null;
  if (decisionDay < 1 || decisionDay >= daysInMonth) return null;
  const monthRate = 100 - monthPrice;
  return (daysInMonth * monthRate - decisionDay * rateBefore) / (daysInMonth - decisionDay);
}

/**
 * P(move) = clip(|r_end − r_start| / step, 0, 1), step = 0.25; direction = sign(r_end − r_start).
 * Ref: CME Group, FedWatch Tool methodology. Null for non-finite rates; throws RangeError for step ≤ 0.
 */
export function meetingMove(rateBefore: number, rateAfter: number, step = FED_STEP): MeetingMove | null {
  if (!(step > 0) || !Number.isFinite(step)) throw new RangeError(`step must be a positive number, got ${step}`);
  if (!Number.isFinite(rateBefore) || !Number.isFinite(rateAfter)) return null;
  // ZQ ticks are at least 0.25 bp, so nine decimals of a percent drop float noise without hiding a real move.
  const change = roundTo(rateAfter - rateBefore, 9);
  return {
    probability: clamp01(Math.abs(change) / step),
    direction: directionOf(change),
    changeBp: roundTo(change * 100, 7),
  };
}

/**
 * Chains {@link impliedRateAfterMeeting} over upcoming meetings: r_start = 100 − F_{m−1} when month m−1 has no meeting,
 * else the previous meeting's r_end (or the current EFFR for the first meeting); when N − d < 7 and month m+1 has no
 * meeting, r_end = 100 − F_{m+1}. Ref: CME Group, FedWatch Tool methodology. Throws RangeError on malformed dates.
 */
export function fedPathFromFutures(input: FedPathInput): FedPath {
  const decisionDates = [...(input.decisionDates ?? FOMC_DECISION_DATES)].sort();
  for (const date of [...decisionDates, input.asOf]) assertIsoDate(date);
  const minDays = input.minDaysAfterDecision ?? MIN_DAYS_AFTER_DECISION;
  if (!Number.isInteger(minDays) || minDays < 1) {
    throw new RangeError(`minDaysAfterDecision must be a positive integer, got ${minDays}`);
  }
  const step = input.step ?? FED_STEP;
  if (!(step > 0) || !Number.isFinite(step)) throw new RangeError(`step must be a positive number, got ${step}`);
  const context: PathContext = {
    prices: pricesByMonth(input.prices),
    meetingMonths: new Set(decisionDates.map(monthOf)),
    minDays,
    step,
  };
  const meetings: MeetingImplied[] = [];
  const unpriced: UnpricedMeeting[] = [];
  let previousAfter: number | null = null;
  const upcoming = decisionDates.filter((date) => date >= input.asOf);
  for (const [position, decisionDate] of upcoming.entries()) {
    // The EFFR is today's rate, so it can only stand in for the rate before the nearest meeting.
    const effectiveRate = position === 0 ? input.effectiveRate : undefined;
    const priced = priceMeeting(decisionDate, context, { previousAfter, effectiveRate });
    if (priced.ok) {
      meetings.push(priced.meeting);
      previousAfter = priced.meeting.rateAfter;
    } else {
      unpriced.push({ decisionDate, reason: priced.reason });
      previousAfter = null;
    }
  }
  return { meetings, unpriced };
}

type PathContext = { prices: Map<string, number>; meetingMonths: Set<string>; minDays: number; step: number };
type Chain = { previousAfter: number | null; effectiveRate: number | undefined };
type Failure = { ok: false; reason: string };
type Rate<Source> = { ok: true; rate: number; from: Source };

function priceMeeting(
  decisionDate: string,
  context: PathContext,
  chain: Chain,
): { ok: true; meeting: MeetingImplied } | Failure {
  const start = startingRate(decisionDate, context, chain);
  if (!start.ok) return start;
  const end = endingRate(decisionDate, start.rate, context);
  if (!end.ok) return end;
  const move = meetingMove(start.rate, end.rate, context.step);
  if (move === null) return { ok: false, reason: "implied rates are not finite" };
  return {
    ok: true,
    meeting: {
      decisionDate,
      rateBefore: start.rate,
      rateAfter: end.rate,
      startFrom: start.from,
      endFrom: end.from,
      ...move,
    },
  };
}

function startingRate(
  decisionDate: string,
  context: PathContext,
  chain: Chain,
): Rate<MeetingImplied["startFrom"]> | Failure {
  const prior = shiftMonth(monthOf(decisionDate), -1);
  const priorPrice = context.prices.get(prior);
  if (!context.meetingMonths.has(prior) && priorPrice !== undefined) {
    return { ok: true, rate: 100 - priorPrice, from: "prior_month" };
  }
  if (chain.previousAfter !== null) return { ok: true, rate: chain.previousAfter, from: "previous_meeting" };
  if (chain.effectiveRate !== undefined && Number.isFinite(chain.effectiveRate)) {
    return { ok: true, rate: chain.effectiveRate, from: "effective_rate" };
  }
  const why = context.meetingMonths.has(prior) ? `${prior} has a meeting` : `no usable ZQ price for ${prior}`;
  return { ok: false, reason: `no starting rate: ${why}, and no earlier priced meeting or EFFR to chain from` };
}

function endingRate(
  decisionDate: string,
  rateBefore: number,
  context: PathContext,
): Rate<MeetingImplied["endFrom"]> | Failure {
  const month = monthOf(decisionDate);
  const days = daysInMonth(month);
  const decisionDay = Number(decisionDate.slice(8, 10));
  const daysAfter = days - decisionDay;
  if (daysAfter < context.minDays) {
    const next = shiftMonth(month, 1);
    const nextPrice = context.prices.get(next);
    const thin = `only ${daysAfter} days of ${month} follow the decision`;
    if (context.meetingMonths.has(next)) return { ok: false, reason: `${thin} and ${next} has a meeting` };
    if (nextPrice === undefined) return { ok: false, reason: `${thin} and there is no usable ZQ price for ${next}` };
    return { ok: true, rate: 100 - nextPrice, from: "next_month" };
  }
  const monthPrice = context.prices.get(month);
  if (monthPrice === undefined) return { ok: false, reason: `no usable ZQ price for ${month}` };
  const rate = impliedRateAfterMeeting({ monthPrice, rateBefore, daysInMonth: days, decisionDay });
  if (rate === null) return { ok: false, reason: `cannot solve ${month} for the post-meeting rate` };
  return { ok: true, rate, from: "meeting_month" };
}

function directionOf(change: number): MoveDirection {
  if (change < 0) return "cut";
  if (change > 0) return "hike";
  return "hold";
}

// "YYYY-MM" with a real month number.
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
// "YYYY-MM-DD"; the calendar check happens after parsing.
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Non-finite prices count as missing, so the meetings that need them report why they are unpriced. */
function pricesByMonth(prices: readonly ZqPrice[]): Map<string, number> {
  const byMonth = new Map<string, number>();
  for (const { month, price } of prices) {
    if (!MONTH_PATTERN.test(month)) throw new RangeError(`expected a YYYY-MM contract month, got "${month}"`);
    if (byMonth.has(month)) throw new RangeError(`two ZQ prices for ${month}`);
    if (Number.isFinite(price)) byMonth.set(month, price);
  }
  return byMonth;
}

function assertIsoDate(text: string): void {
  const match = DATE_PATTERN.exec(text);
  const time = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : Number.NaN;
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== text) {
    throw new RangeError(`expected a YYYY-MM-DD date, got "${text}"`);
  }
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const shifted = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1));
  return shifted.toISOString().slice(0, 7);
}

function daysInMonth(month: string): number {
  // Day 0 of the following month is the last day of this one.
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}
