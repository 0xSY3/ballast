import { describe, expect, test } from "bun:test";
import {
  ceilToStep,
  divFixed,
  fixedFromRatio,
  floorToStep,
  formatFixed,
  formatFixedPlaces,
  mulFixed,
  parseFixed,
} from "../src/decimal.ts";

describe("fixed-point decimals", () => {
  test("parse and format round-trip without float error", () => {
    for (const text of ["0", "1", "0.1", "0.000000000000000001", "123456789.123456789", "-42.5"]) {
      expect(formatFixed(parseFixed(text))).toBe(text);
    }
    expect(formatFixed(parseFixed("0.1") + parseFixed("0.2"))).toBe("0.3");
  });

  test("rejects text that is not a plain decimal", () => {
    for (const text of ["", "1e5", "0x10", "1.2.3", "abc", "1.0000000000000000001"]) {
      expect(() => parseFixed(text)).toThrow();
    }
  });

  test("multiplies and divides exactly to 18 places", () => {
    expect(formatFixed(mulFixed(parseFixed("25000"), parseFixed("0.3")))).toBe("7500");
    expect(formatFixed(divFixed(parseFixed("25000"), parseFixed("100005")))).toBe("0.249987500624968751");
    expect(() => divFixed(parseFixed("1"), 0n)).toThrow("division by zero");
  });

  test("rounds to a step in both directions", () => {
    const tick = parseFixed("0.001");
    expect(formatFixed(floorToStep(parseFixed("0.24998"), tick))).toBe("0.249");
    expect(formatFixed(ceilToStep(parseFixed("0.24901"), tick))).toBe("0.25");
    expect(formatFixed(ceilToStep(parseFixed("0.249"), tick))).toBe("0.249");
    expect(() => floorToStep(parseFixed("-1"), tick)).toThrow();
    expect(() => floorToStep(parseFixed("1"), 0n)).toThrow();
  });

  test("formats with a fixed number of places only when the value is on that grid", () => {
    expect(formatFixedPlaces(parseFixed("12.5"), 2)).toBe("12.50");
    expect(formatFixedPlaces(parseFixed("7"), 0)).toBe("7");
    expect(() => formatFixedPlaces(parseFixed("12.345"), 2)).toThrow();
  });

  test("turns policy ratios into fixed point at nine-decimal precision", () => {
    expect(formatFixed(fixedFromRatio(0.6))).toBe("0.6");
    expect(formatFixed(fixedFromRatio(0.30000000000000004))).toBe("0.3");
    expect(() => fixedFromRatio(Number.NaN)).toThrow();
  });
});
