import { roundTo } from "../math.ts";

// Equal to the variance of a 1-point spread, so a zero-spread quote cannot take infinite weight.
export const BLEND_EPSILON = 1e-4;
export const MAX_DIVERGENCE = 0.05;

/** One venue's YES probability and its bid/ask spread, both in probability units (0.02 = 2 pts). */
export type VenueQuote = { venue: string; probability: number; spread: number };

export type OddsBlend = {
  probability: number;
  /** D = max_k |p_k − p̂|. */
  divergence: number;
  /** D above the limit: the venues disagree, so the blend deserves less confidence. */
  isDivergent: boolean;
  /** w_k / Σw, in input order. */
  weights: { venue: string; weight: number }[];
};

export type BlendOptions = { epsilon?: number; maxDivergence?: number };

/**
 * p̂ = Σ w_k·p_k / Σ w_k with w_k = 1/(spread_k² + ε), ε = 1e-4; D = max_k |p_k − p̂|, divergent when D > 0.05.
 * Inverse-variance weighting (Cochran 1954), the quoted spread standing in for each venue's price noise. Null for no
 * quotes, a probability outside [0, 1], or a negative or non-finite spread.
 */
export function blendOdds(quotes: readonly VenueQuote[], options: BlendOptions = {}): OddsBlend | null {
  const epsilon = options.epsilon ?? BLEND_EPSILON;
  const maxDivergence = options.maxDivergence ?? MAX_DIVERGENCE;
  if (!(epsilon > 0) || !Number.isFinite(epsilon)) throw new RangeError(`epsilon must be positive, got ${epsilon}`);
  if (!(maxDivergence >= 0) || !Number.isFinite(maxDivergence)) {
    throw new RangeError(`maxDivergence must be zero or more, got ${maxDivergence}`);
  }
  if (quotes.length === 0 || !quotes.every(isUsableQuote)) return null;
  const weighted = quotes.map((quote) => ({ quote, weight: 1 / (quote.spread ** 2 + epsilon) }));
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  const probability = weighted.reduce((sum, entry) => sum + entry.weight * entry.quote.probability, 0) / totalWeight;
  const divergence = Math.max(...quotes.map((quote) => Math.abs(quote.probability - probability)));
  return {
    probability,
    divergence,
    // Rounding keeps float noise at the limit from flipping the flag.
    isDivergent: roundTo(divergence, 9) > maxDivergence,
    weights: weighted.map(({ quote, weight }) => ({ venue: quote.venue, weight: weight / totalWeight })),
  };
}

function isUsableQuote(quote: VenueQuote): boolean {
  return (
    Number.isFinite(quote.probability) &&
    quote.probability >= 0 &&
    quote.probability <= 1 &&
    Number.isFinite(quote.spread) &&
    quote.spread >= 0
  );
}
