const INV_SQRT_TWO_PI = 1 / Math.sqrt(2 * Math.PI);

// Hart (1968) double-precision rational approximation, coefficients as printed by West (2005),
// "Better approximations to cumulative normal functions", Wilmott Magazine, figure 2. Highest power first.
const HART_NUMERATOR = [
  0.0352624965998911, 0.700383064443688, 6.37396220353165, 33.912866078383, 112.079291497871, 221.213596169931,
  220.206867912376,
];
const HART_DENOMINATOR = [
  0.0883883476483184, 1.75566716318264, 16.064177579207, 86.7807322029461, 296.564248779674, 637.333633378831,
  793.826512519948, 440.413735824752,
];
// Past 10/√2 the rational form loses accuracy and Hart switches to a continued fraction.
const HART_SWITCH = 7.07106781186547;
// N(−37) is below the smallest double, so the tail is exactly zero from there.
const HART_UNDERFLOW = 37;

/** φ(x) = e^{−x²/2} / √(2π), the standard normal density. */
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) * INV_SQRT_TWO_PI;
}

/** N(x) = P(Z ≤ x), Z ~ N(0, 1). Ref: Hart (1968) via West (2005); absolute error below 1e-14. NaN in, NaN out. */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const lowerTail = hartLowerTail(Math.abs(x));
  return x > 0 ? 1 - lowerTail : lowerTail;
}

/** N(−z) for z ≥ 0. */
function hartLowerTail(z: number): number {
  if (z > HART_UNDERFLOW) return 0;
  const density = Math.exp(-0.5 * z * z);
  if (z < HART_SWITCH) return (density * horner(HART_NUMERATOR, z)) / horner(HART_DENOMINATOR, z);
  const fraction = z + 1 / (z + 2 / (z + 3 / (z + 4 / (z + 0.65))));
  return density / fraction / Math.sqrt(2 * Math.PI);
}

function horner(coefficients: readonly number[], x: number): number {
  return coefficients.reduce((sum, coefficient) => sum * x + coefficient, 0);
}

export type OptionKind = "call" | "put";

export type BlackScholesInput = {
  kind: OptionKind;
  spot: number;
  strike: number;
  /** σ, annualised, as a fraction. */
  volatility: number;
  /** T in years. */
  timeToExpiry: number;
  /** r, continuously compounded; 0 by default. */
  rate?: number;
};

export type Greeks = { d1: number; delta: number; gamma: number };

/**
 * d1 = [ln(S/K) + (r + σ²/2)T] / (σ√T); call Δ = N(d1), put Δ = N(d1) − 1; Γ = φ(d1) / (S·σ·√T).
 * European, cash-settled, no dividends. Ref: Black & Scholes (1973). Null when S, K, σ or T is not positive or
 * any input is non-finite: d1 is undefined at σ√T = 0, where delta is the intrinsic step.
 */
export function blackScholesGreeks(input: BlackScholesInput): Greeks | null {
  const { kind, spot, strike, volatility, timeToExpiry } = input;
  const rate = input.rate ?? 0;
  if (![spot, strike, volatility, timeToExpiry, rate].every(Number.isFinite)) return null;
  if (spot <= 0 || strike <= 0 || volatility <= 0 || timeToExpiry <= 0) return null;
  const volSqrtT = volatility * Math.sqrt(timeToExpiry);
  const d1 = (Math.log(spot / strike) + (rate + (volatility * volatility) / 2) * timeToExpiry) / volSqrtT;
  const callDelta = normalCdf(d1);
  return { d1, delta: kind === "call" ? callDelta : callDelta - 1, gamma: normalPdf(d1) / (spot * volSqrtT) };
}

export type WhalleyWilmottInput = {
  /** c, proportional transaction cost as a fraction of traded value. */
  costRate: number;
  spot: number;
  /** Γ of the book; the band depends on Γ², so short-gamma books work too. */
  gamma: number;
  /** γ, absolute risk aversion (operator setting). */
  riskAversion: number;
  /** τ = T − t in years. */
  timeToExpiry: number;
  rate?: number;
};

/**
 * Half-width of the no-trade band around the target delta: H₀ = (3·c·S·Γ²·e^{−rτ} / (2γ))^{1/3}.
 * Ref: Whalley & Wilmott (1997). Null for S ≤ 0, τ < 0 or non-finite data; throws RangeError for c < 0 or γ ≤ 0.
 */
export function whalleyWilmottHalfWidth(input: WhalleyWilmottInput): number | null {
  const { costRate, spot, gamma, riskAversion, timeToExpiry } = input;
  const rate = input.rate ?? 0;
  if (!(costRate >= 0) || !Number.isFinite(costRate)) throw new RangeError(`costRate must be zero or more, got ${costRate}`);
  if (!(riskAversion > 0) || !Number.isFinite(riskAversion)) {
    throw new RangeError(`riskAversion must be positive, got ${riskAversion}`);
  }
  if (![spot, gamma, timeToExpiry, rate].every(Number.isFinite) || spot <= 0 || timeToExpiry < 0) return null;
  return Math.cbrt((3 * costRate * spot * gamma * gamma * Math.exp(-rate * timeToExpiry)) / (2 * riskAversion));
}
