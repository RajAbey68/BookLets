const DEFAULT_TIMEOUT_MS = (() => {
  const raw = process.env.EXTERNAL_FETCH_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
})();

export class FetchTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
  }
}

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new FetchTimeoutError(input, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  isRetryable?: (response: Response | null, err: unknown) => boolean;
}

const DEFAULT_RETRYABLE = (response: Response | null, err: unknown): boolean => {
  if (response) return response.status >= 500 && response.status !== 501;
  // Network/abort errors: timeout is retryable, explicit caller-aborts are not.
  if (err instanceof FetchTimeoutError) return true;
  return err instanceof Error;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * fetchWithTimeout + bounded retry with full-jitter exponential backoff.
 * Retries network errors, timeouts, and 5xx responses (501 excluded).
 * Non-retryable responses (4xx, 2xx, 3xx) are returned to the caller as-is.
 */
export async function fetchWithRetry(
  input: string,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const {
    retries = 2,
    baseDelayMs = 250,
    maxDelayMs = 4_000,
    timeoutMs,
    isRetryable = DEFAULT_RETRYABLE,
  } = options;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(input, init, timeoutMs);
      if (attempt < retries && isRetryable(res, null)) {
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        await sleep(Math.random() * delay);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isRetryable(null, err)) {
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        await sleep(Math.random() * delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
