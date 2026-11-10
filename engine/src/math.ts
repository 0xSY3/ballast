/** Float helpers for scores and odds. Amounts use decimal.ts instead. */

export function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Zero below the threshold, linear up to 1 at full scale, capped at 1, at 4 decimals. */
export function scaledStrength(magnitude: number, threshold: number, fullScale: number): number {
  const rounded = roundTo(magnitude, 9);
  if (rounded < threshold) return 0;
  return roundTo(Math.min(1, rounded / fullScale), 4);
}
