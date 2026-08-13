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
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);

  // Combine caller's signal (if any) with timeout signal using AbortSignal.any()
  // to allow abort from either source: explicit caller abort OR timeout.
  let signal: AbortSignal = timeoutController.signal;
  if (init.signal) {
    signal = AbortSignal.any([timeoutController.signal, init.signal]);
  }

  try {
    return await fetch(input, { ...init, signal });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      // Check if it was our timeout that aborted, not the caller's signal.
      if (timeoutController.signal.aborted) {
        throw new FetchTimeoutError(input, timeoutMs);
      }
    }
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
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
 * Prevents socket leaks by consuming response bodies on failed retries.
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
        // Drain response body to release socket before retrying.
        // Prevents socket/connection leak when response is not consumed.
        await res.body?.cancel().catch(() => {
          /* ignore cancel errors */
        });
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
