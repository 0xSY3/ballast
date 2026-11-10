import { describe, expect, test } from "bun:test";
import { createLiveFetcher } from "../src/net.ts";

type Step = { status: number; body: string } | { throws: string } | { hangs: true };

function scriptedFetch(steps: Step[]) {
  const calls: string[] = [];
  const fetchImpl = (input: string, init: RequestInit): Promise<Response> => {
    calls.push(input);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (!step) return Promise.reject(new Error("no scripted step"));
    if ("throws" in step) return Promise.reject(new Error(step.throws));
    if ("hangs" in step) {
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return Promise.resolve(new Response(step.body, { status: step.status }));
  };
  return { calls, fetchImpl };
}

function fetcher(steps: Step[], timeoutMs = 1000) {
  const scripted = scriptedFetch(steps);
  const sleeps: number[] = [];
  const fetchJson = createLiveFetcher({
    timeoutMs,
    retries: 2,
    backoffMs: 500,
    fetchImpl: scripted.fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { fetchJson, calls: scripted.calls, sleeps };
}

describe("live fetcher", () => {
  test("returns parsed JSON on success", async () => {
    const { fetchJson, calls } = fetcher([{ status: 200, body: '{"a":1}' }]);
    expect(await fetchJson("https://example.test/x")).toEqual({ ok: true, data: { a: 1 } });
    expect(calls).toHaveLength(1);
  });

  test("retries server errors twice with exponential backoff, then reports the last error", async () => {
    const { fetchJson, calls, sleeps } = fetcher([{ status: 503, body: "" }]);
    const result = await fetchJson("https://example.test/x");
    expect(result).toEqual({ ok: false, error: "HTTP 503 from example.test/x" });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  test("recovers when a retry succeeds", async () => {
    const { fetchJson, calls } = fetcher([{ throws: "ECONNRESET" }, { status: 200, body: "[]" }]);
    expect(await fetchJson("https://example.test/x")).toEqual({ ok: true, data: [] });
    expect(calls).toHaveLength(2);
  });

  test("does not retry a client error", async () => {
    const { fetchJson, calls } = fetcher([{ status: 404, body: "" }]);
    expect(await fetchJson("https://example.test/x")).toEqual({ ok: false, error: "HTTP 404 from example.test/x" });
    expect(calls).toHaveLength(1);
  });

  test("retries 429 rate limits", async () => {
    const { fetchJson, calls } = fetcher([{ status: 429, body: "" }, { status: 200, body: "{}" }]);
    expect((await fetchJson("https://example.test/x")).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("times out a hung request on every attempt", async () => {
    const { fetchJson, calls } = fetcher([{ hangs: true }], 20);
    const result = await fetchJson("https://example.test/slow");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("timed out after 20 ms (example.test/slow)");
    expect(calls).toHaveLength(3);
  });

  test("reports invalid JSON without retrying", async () => {
    const { fetchJson, calls } = fetcher([{ status: 200, body: "<html>" }]);
    const result = await fetchJson("https://example.test/x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toStartWith("invalid JSON from example.test/x");
    expect(calls).toHaveLength(1);
  });
});
