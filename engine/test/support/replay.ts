import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asRecord, readString } from "../../src/json.ts";
import type { FetchOutcome, JsonFetcher } from "../../src/net.ts";

// Query parameters derived from the clock. Dropping them lets a replay at the recorded time
// hit the same fixture even if a lookback setting changes later.
const TIME_PARAMS = ["start_ts", "end_ts", "startTs", "endTs", "start_time", "end_time", "startTime", "endTime"];

export type FixtureManifest = {
  recordedAt: string;
  note: string;
  responses: Record<string, string>;
};

export function fixtureKey(url: string): string {
  const parsed = new URL(url);
  for (const name of TIME_PARAMS) parsed.searchParams.delete(name);
  parsed.searchParams.sort();
  return parsed.toString();
}

export function fixtureFileName(key: string): string {
  const parsed = new URL(key);
  const readable = `${parsed.host.split(".")[0]}${parsed.pathname}`
    .replace(/[^A-Za-z0-9.-]+/g, "_")
    .slice(0, 80);
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 10);
  return `${readable}_${digest}.json`;
}

export function loadManifest(directory: string): FixtureManifest {
  const raw: unknown = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const record = asRecord(raw, "manifest");
  const responses = asRecord(record.responses, "manifest.responses");
  const files: Record<string, string> = {};
  for (const [key, file] of Object.entries(responses)) {
    if (typeof file !== "string") throw new Error(`manifest.responses[${key}] is not a file name`);
    files[key] = file;
  }
  return {
    recordedAt: readString(record, "recordedAt", "manifest"),
    note: readString(record, "note", "manifest"),
    responses: files,
  };
}

/** Serves recorded responses; any URL that was not recorded fails like a network error. */
export function createReplayFetcher(directory: string, overrides: Record<string, FetchOutcome> = {}): JsonFetcher {
  const manifest = loadManifest(directory);
  return async (url) => {
    const key = fixtureKey(url);
    const override = overrides[key];
    if (override) return override;
    const file = manifest.responses[key];
    if (!file) return { ok: false, error: `no fixture for ${key}` };
    return { ok: true, data: JSON.parse(readFileSync(join(directory, file), "utf8")) };
  };
}
