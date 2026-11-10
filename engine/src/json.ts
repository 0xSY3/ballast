/** Narrowing helpers for untrusted API payloads. Each throws with the field path on mismatch. */

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${path}: expected an object`);
  return value;
}

export function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected an array`);
  return value;
}

export function readString(record: JsonRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${path}.${key}: expected a string`);
  return value;
}

export function readOptionalString(record: JsonRecord, key: string, path: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${path}.${key}: expected a string`);
  return value;
}

export function readNumber(record: JsonRecord, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path}.${key}: expected a finite number`);
  }
  return value;
}

export function readOptionalNumber(record: JsonRecord, key: string, path: string): number | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path}.${key}: expected a finite number`);
  }
  return value;
}

export function readBoolean(record: JsonRecord, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`${path}.${key}: expected a boolean`);
  return value;
}

/** Parses a decimal string such as "0.8100" into a float; for odds, never for amounts. */
export function decimalTextToNumber(text: string, path: string): number {
  // Plain decimal with an optional sign; rejects "", "1e5", "0x10" and similar.
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`${path}: expected a decimal string, got "${text}"`);
  return Number(text);
}
