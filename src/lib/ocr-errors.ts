/**
 * Classification of OCR failures.
 *
 * WHY THIS EXISTS
 * Every upstream problem used to reach the operator as the same sentence:
 * "couldn't be read (OCR service could not read them)". That sentence is a
 * verdict on the PHOTO, and for the failure that actually happens most often
 * it is simply false. A 225-receipt import reported 225 unreadable receipts
 * when the receipts were fine and the OCR provider was rate-limiting us — so
 * the operator went looking for bad photographs, and re-uploading (the one
 * thing that felt productive) made the rate limiting worse.
 *
 * The distinction that matters to a human is not which HTTP code came back,
 * it is: *is this receipt the problem, or is the service the problem, and
 * should I wait or should I act?* That is what `OcrErrorKind` encodes.
 *
 * CLASSIFY ON THE BODY, NOT THE STATUS
 * The OCR microservice wraps upstream Gemini errors in its OWN 500 —
 * a Gemini 429 arrives here as:
 *
 *   HTTP 500 {"error":"Gemini OCR API Error: 429 Too Many Requests — {…
 *             \"status\": \"RESOURCE_EXHAUSTED\" … Please retry in 3.48s…}"}
 *
 * so a status-only classifier reads the single most common, most recoverable
 * failure in the system as an unrecoverable server fault. The body text is
 * the only place the truth is written down, so it is what we parse.
 */

export type OcrErrorKind =
  /** Provider quota / rate limit. The receipt is fine. Wait and retry. */
  | 'rate-limit'
  /** Bad or missing API credentials upstream. Retrying cannot help. */
  | 'auth'
  /** Request timed out. Usually transient. */
  | 'timeout'
  /** Service unreachable or 5xx. Usually transient. */
  | 'unavailable'
  /** Anything unrecognised, including a malformed 200 — non-retryable. */
  | 'unknown';

/*
 * There is deliberately NO 'unreadable' kind. A receipt the service genuinely
 * could not read is not a service failure at all: it comes back as a
 * successful response with a zero amount, and the ingest layer rejects that one
 * photo by name (see ingest-item.ts) while the rest of the run continues. Every
 * kind in this union means "the service is the problem", which is precisely
 * what lets callers treat them differently from a bad photograph.
 */

/** Kinds where trying the SAME image again later can reasonably succeed. */
const RETRYABLE: ReadonlySet<OcrErrorKind> = new Set<OcrErrorKind>([
  'rate-limit',
  'timeout',
  'unavailable',
]);

export class OcrError extends Error {
  readonly kind: OcrErrorKind;
  /** Provider's own "retry in N" hint, in ms, when it gave one. */
  readonly retryAfterMs?: number;
  /** Upstream status, when there was an HTTP response at all. */
  readonly status?: number;

  constructor(
    kind: OcrErrorKind,
    message: string,
    options: { retryAfterMs?: number; status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'OcrError';
    this.kind = kind;
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/** True when `err` is an OcrError of the given kind. */
export function isOcrErrorOfKind(err: unknown, kind: OcrErrorKind): boolean {
  return err instanceof OcrError && err.kind === kind;
}

/**
 * Google's error bodies carry a machine-readable hint, in one of two shapes:
 *   "Please retry in 3.485022129s"      (prose, inside the message)
 *   "retryDelay": "5s"                  (RetryInfo detail)
 * Both are parsed; the larger wins, so we never retry sooner than asked.
 */
export function parseRetryAfterMs(bodyText: string): number | undefined {
  const candidates: number[] = [];

  const prose = /retry\s+in\s+([\d.]+)\s*s/i.exec(bodyText);
  if (prose) {
    const seconds = Number(prose[1]);
    if (Number.isFinite(seconds) && seconds > 0) candidates.push(seconds * 1000);
  }

  const detail = /"retryDelay"\s*:\s*"([\d.]+)s"/i.exec(bodyText);
  if (detail) {
    const seconds = Number(detail[1]);
    if (Number.isFinite(seconds) && seconds > 0) candidates.push(seconds * 1000);
  }

  if (candidates.length === 0) return undefined;
  return Math.ceil(Math.max(...candidates));
}

/**
 * Decide what an OCR failure actually was, from the HTTP status plus the
 * response body.
 *
 * The body is checked FIRST and wins: the microservice's own status describes
 * the proxy hop, while the body describes what went wrong at the provider —
 * and it is the provider's problem the operator needs named.
 */
export function classifyOcrFailure(status: number | undefined, bodyText: string): OcrError {
  const body = bodyText ?? '';

  // Quota / rate limit. Matched on several independent markers because the
  // provider's wording changes more often than its semantics do.
  //
  // The NUMERIC markers are anchored to a status/code context; a bare /\b429\b/
  // would also fire on an id, a byte count or a model name that merely contains
  // those digits, and a false positive here is expensive — the item route turns
  // it into a real 429 and halts the whole import. The SEMANTIC markers stay
  // unanchored: "RESOURCE_EXHAUSTED" in a body means one thing only.
  if (
    /(?:code|status|error)"?\s*[:=]?\s*429\b/i.test(body) ||
    /\b(?:HTTP\s*)?429\s+too\s+many/i.test(body) ||
    /RESOURCE_EXHAUSTED/i.test(body) ||
    /too many requests/i.test(body) ||
    /rate.?limit/i.test(body) ||
    /exceeded your current quota/i.test(body) ||
    status === 429
  ) {
    return new OcrError(
      'rate-limit',
      'The OCR service is rate limited right now — this receipt was not read. ' +
        'Nothing is wrong with the photo. Wait a moment and import again; ' +
        'receipts already imported are skipped automatically.',
      { retryAfterMs: parseRetryAfterMs(body), status },
    );
  }

  // Credentials. Distinguished from a rate limit because retrying is futile
  // and the fix is an administrator's, not the operator's.
  if (
    /(?:code|status|error)"?\s*[:=]?\s*40[13]\b/i.test(body) ||
    /\b(?:HTTP\s*)?40[13]\s+(?:un)?(?:authoriz|authenticat|forbidden)/i.test(body) ||
    /PERMISSION_DENIED|UNAUTHENTICATED/i.test(body) ||
    /api[\s_-]?key.*(invalid|expired|not valid)/i.test(body) ||
    status === 401 ||
    status === 403
  ) {
    return new OcrError(
      'auth',
      'The OCR service rejected our credentials, so no receipt can be read until ' +
        'that is fixed. This needs an administrator — retrying will not help.',
      { status },
    );
  }

  if (/timed?\s?out|ETIMEDOUT|deadline exceeded/i.test(body) || status === 408 || status === 504) {
    return new OcrError('timeout', 'The OCR service did not respond in time.', {
      retryAfterMs: parseRetryAfterMs(body),
      status,
    });
  }

  if ((typeof status === 'number' && status >= 500) || /UNAVAILABLE/i.test(body)) {
    return new OcrError(
      'unavailable',
      'The OCR service is temporarily unavailable. Try the import again shortly.',
      { retryAfterMs: parseRetryAfterMs(body), status },
    );
  }

  return new OcrError(
    'unknown',
    `The OCR service returned an error${typeof status === 'number' ? ` (HTTP ${status})` : ''}.`,
    { status },
  );
}

/**
 * Classify a thrown transport error (no HTTP response at all): DNS failure,
 * connection refused, or our own AbortController firing on the timeout.
 */
export function classifyOcrTransportError(err: unknown): OcrError {
  if (err instanceof OcrError) return err;

  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);

  if (name === 'AbortError' || name === 'TimeoutError' || /abort|timed?\s?out/i.test(message)) {
    return new OcrError('timeout', 'The OCR service did not respond in time.', { cause: err });
  }
  return new OcrError(
    'unavailable',
    'The OCR service could not be reached. Try the import again shortly.',
    { cause: err },
  );
}
