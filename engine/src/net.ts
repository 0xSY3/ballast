export type FetchOutcome = { ok: true; data: unknown } | { ok: false; error: string };

/** Every source reads through this, so tests can swap in recorded responses. */
export type JsonFetcher = (url: string) => Promise<FetchOutcome>;

export type LiveFetcherOptions = {
  timeoutMs: number;
  retries: number;
  backoffMs: number;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
};

type Attempt = { ok: true; data: unknown } | { ok: false; error: string; retryable: boolean };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createLiveFetcher(options: LiveFetcherOptions): JsonFetcher {
  const sleep = options.sleep ?? defaultSleep;
  return async (url) => {
    let lastError = "no attempt made";
    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      if (attempt > 0) await sleep(options.backoffMs * 2 ** (attempt - 1));
      const result = await attemptFetch(url, options);
      if (result.ok) return result;
      lastError = result.error;
      if (!result.retryable) break;
    }
    return { ok: false, error: lastError };
  };
}

async function attemptFetch(url: string, options: LiveFetcherOptions): Promise<Attempt> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  // The timer stays armed until the body is read, so a stalled body also times out.
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const where = describeUrl(url);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "ballast-engine/0.1 (dry-run)" },
    });
    if (!response.ok) {
      // 4xx other than 429 means the request itself is wrong; repeating it cannot help.
      const retryable = response.status === 429 || response.status >= 500;
      return { ok: false, error: `HTTP ${response.status} from ${where}`, retryable };
    }
    const body = await response.text();
    return parseBody(body, where);
  } catch (error) {
    const reason = controller.signal.aborted ? `timed out after ${options.timeoutMs} ms` : errorText(error);
    return { ok: false, error: `${reason} (${where})`, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

function parseBody(body: string, where: string): Attempt {
  try {
    return { ok: true, data: JSON.parse(body) };
  } catch (error) {
    return { ok: false, error: `invalid JSON from ${where}: ${errorText(error)}`, retryable: false };
  }
}

function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch (error) {
    return `unparseable URL (${errorText(error)})`;
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
