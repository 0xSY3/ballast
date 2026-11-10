/**
 * Fixed-point decimals on bigint, scaled by 10^18. Every price, quantity, margin and USD
 * amount goes through here so no token amount ever passes through a JS number.
 */

export const FIXED_DIGITS = 18;
export const ONE = 10n ** BigInt(FIXED_DIGITS);

// Optional minus sign, integer digits, optional fractional digits. No exponents, no "+".
const DECIMAL_TEXT = /^(-)?(\d+)(?:\.(\d+))?$/;

export function parseFixed(text: string): bigint {
  const match = DECIMAL_TEXT.exec(text.trim());
  if (!match) throw new Error(`not a plain decimal: "${text}"`);
  const [, sign, whole = "0", fraction = ""] = match;
  if (fraction.length > FIXED_DIGITS) {
    throw new Error(`more than ${FIXED_DIGITS} decimal places: "${text}"`);
  }
  const units = BigInt(whole) * ONE + BigInt(fraction.padEnd(FIXED_DIGITS, "0"));
  return sign ? -units : units;
}

/** Exact decimal text with trailing zeros trimmed. */
export function formatFixed(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / ONE;
  const fraction = (magnitude % ONE).toString().padStart(FIXED_DIGITS, "0").replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : `${whole}`;
  return negative ? `-${text}` : text;
}

/** Decimal text with exactly `places` decimals; the value must already sit on that grid. */
export function formatFixedPlaces(value: bigint, places: number): string {
  const step = stepForPlaces(places);
  if (value % step !== 0n) throw new Error(`${formatFixed(value)} has more than ${places} decimals`);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / ONE;
  const fraction = (magnitude % ONE).toString().padStart(FIXED_DIGITS, "0").slice(0, places);
  const text = places > 0 ? `${whole}.${fraction}` : `${whole}`;
  return negative ? `-${text}` : text;
}

export function stepForPlaces(places: number): bigint {
  if (!Number.isInteger(places) || places < 0 || places > FIXED_DIGITS) {
    throw new Error(`decimal places out of range: ${places}`);
  }
  return 10n ** BigInt(FIXED_DIGITS - places);
}

export function mulFixed(a: bigint, b: bigint): bigint {
  return (a * b) / ONE;
}

/** Division truncated toward zero. */
export function divFixed(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("division by zero");
  return (numerator * ONE) / denominator;
}

export function floorToStep(value: bigint, step: bigint): bigint {
  assertRoundable(value, step);
  return value - (value % step);
}

export function ceilToStep(value: bigint, step: bigint): bigint {
  assertRoundable(value, step);
  const remainder = value % step;
  return remainder === 0n ? value : value - remainder + step;
}

function assertRoundable(value: bigint, step: bigint): void {
  if (step <= 0n) throw new Error(`step must be positive, got ${formatFixed(step)}`);
  if (value < 0n) throw new Error(`cannot round a negative amount: ${formatFixed(value)}`);
}

/**
 * Converts a policy ratio (intensity, hedge ratio, price band) into fixed point.
 * Ratios are model outputs rather than amounts, so nine decimals of precision is plenty
 * and keeps the result independent of float noise past that point.
 */
export function fixedFromRatio(ratio: number): bigint {
  if (!Number.isFinite(ratio)) throw new Error(`ratio is not finite: ${ratio}`);
  return BigInt(Math.round(ratio * 1e9)) * 10n ** BigInt(FIXED_DIGITS - 9);
}

/** Lossy conversion for scoring and display only; never feed the result back into amounts. */
export function fixedToNumber(value: bigint): number {
  return Number(formatFixed(value));
}

export function minFixed(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxFixed(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
