/**
 * BookLets OCR client — calls the shared OCR microservice.
 *
 * Instead of calling the Gemini API directly, this module POSTs to the
 * shared OCR microservice at OCR_MICROSERVICE_URL (default http://localhost:3099).
 * Falls back to SymbiOS if the microservice is genuinely unreachable.
 *
 * Environment:
 *   OCR_MICROSERVICE_URL — URL of the OCR microservice (default: http://localhost:3099)
 *   OCR_TIMEOUT_MS — per-attempt timeout (default 15000)
 *   OCR_RETRY_ATTEMPTS — total attempts per image against the microservice (default 3)
 *   SYMBIOS_API_KEY — enables the SymbiOS fallback; without it there is none
 *
 * FAILURE HANDLING — read before changing
 * A failed OCR call is classified (ocr-errors.ts) rather than flattened into
 * one message, because "the provider is rate limiting us" and "this photo is
 * unreadable" call for opposite responses from the operator and only one of
 * them is about the receipt.
 *
 * Two rules follow, and both exist because breaking them caused a real
 * 225-receipt import to report 225 unreadable receipts that were all fine:
 *
 *  1. A rate limit is retried briefly here, then RAISED — never converted into
 *     a per-receipt verdict. Sustained back-off belongs at the transport layer
 *     (the route answers 429, the browser paces itself), not inside a function
 *     invocation that has a 60 s budget to spend.
 *  2. The SymbiOS fallback runs ONLY for genuine unreachability, and when it
 *     is unconfigured the ORIGINAL diagnosis is re-raised. Previously any
 *     failure fell through to a fallback that then threw "Microservice
 *     unreachable and no SymbiOS API key configured" — discarding the real
 *     cause, which the provider had spelled out in the body we already had.
 */
import {
  OcrError,
  classifyOcrFailure,
  classifyOcrTransportError,
} from './ocr-errors';

const OCR_MICROSERVICE_URL =
  process.env.OCR_MICROSERVICE_URL || 'https://ocr-microservice-gamma.vercel.app';
const OCR_TIMEOUT_MS = (() => {
  const raw = process.env.OCR_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
})();

/** Total attempts per image against the microservice (1 = no retry). */
const OCR_RETRY_ATTEMPTS = (() => {
  const raw = process.env.OCR_RETRY_ATTEMPTS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.trunc(parsed), 5) : 3;
})();

/**
 * Longest in-request wait we will sit through before giving the decision back
 * to the caller. The route's budget is 60 s for ONE photo, so a short provider
 * hint ("retry in 3.5s") is worth absorbing silently, while a long one means
 * the quota is genuinely spent and the run should pace itself rather than
 * burning function time asleep.
 */
const MAX_INLINE_RETRY_WAIT_MS = 8_000;

/** Backoff when the provider gave no hint of its own. */
const DEFAULT_BACKOFF_MS = 1_500;

/**
 * Wall-clock ceiling on ALL attempts for one image, including backoff.
 *
 * Deliberately below the ingest route's `maxDuration = 60` so the classified
 * error always gets back to the caller: a retry budget that outruns the
 * function budget produces a platform timeout, which carries none of the
 * diagnosis (and none of the retry-after) the client needs to pace itself.
 * Kept in sync with that route by intent, not by import — the route is a Next
 * entry point and must not be pulled into this module's graph.
 */
const OCR_TOTAL_BUDGET_MS = 45_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface GeminiExtraction {
  vendorName: string;
  date: string; // ISO-8601 date string, e.g. "2025-03-15" or "" if not visible
  totalAmount: number;
  categorySuggestion: string;
  confidence: number; // 0–1
}

export interface GeminiOcrResult {
  extraction: GeminiExtraction;
}

/**
 * Extract receipt data from a base64-encoded image via the OCR microservice.
 *
 * @param imageBase64 - Base64-encoded image data (with or without data URI prefix)
 * @returns The extraction result
 * @throws Error if the microservice is unreachable or returns an error
 */
export async function extractReceipt(
  imageBase64: string
): Promise<GeminiOcrResult> {
  let lastError: OcrError | undefined;
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= OCR_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await callMicroservice(imageBase64);
    } catch (err) {
      const classified =
        err instanceof OcrError ? err : classifyOcrTransportError(err);
      lastError = classified;

      if (!classified.retryable || attempt === OCR_RETRY_ATTEMPTS) break;

      // Honour the provider's own hint when it gave one. A hint longer than we
      // are willing to hold the request open means the quota is properly spent:
      // stop here so the caller can pace the whole run instead of this one
      // invocation sleeping through its budget.
      const wait = classified.retryAfterMs ?? DEFAULT_BACKOFF_MS * attempt;
      if (wait > MAX_INLINE_RETRY_WAIT_MS) break;

      // Wall-clock deadline. Without this the retry budget can outlast the
      // route's own maxDuration (3 attempts × 15 s timeout + 2 × 8 s backoff =
      // 61 s, and 107 s at the OCR_RETRY_ATTEMPTS ceiling of 5) — the platform
      // then kills the invocation mid-retry and the browser sees a generic
      // timeout instead of the classified 429 + retry-after this whole path
      // exists to deliver. Losing the diagnosis is worse than losing a retry.
      if (Date.now() - startedAt + wait + OCR_TIMEOUT_MS > OCR_TOTAL_BUDGET_MS) break;

      await delay(wait);
    }
  }

  const error = lastError ?? new OcrError('unknown', 'The OCR service failed.');

  // The fallback exists for one situation only: the primary service could not
  // be reached at all. Sending a rate-limited or credential-rejected request to
  // a second provider neither helps nor tells the operator anything new — and
  // routing every failure through it is what used to replace the provider's
  // own explanation with "no SymbiOS API key configured".
  if (error.kind === 'unavailable' || error.kind === 'timeout') {
    if (process.env.SYMBIOS_API_KEY) {
      console.warn(
        '[ocr] microservice unreachable, falling back to SymbiOS:',
        error.message,
      );
      try {
        return await fallbackToSymbios(imageBase64);
      } catch (fallbackErr) {
        console.warn(
          '[ocr] SymbiOS fallback also failed:',
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        );
      }
    }
  }

  // Re-raise the ORIGINAL diagnosis. Callers branch on `kind`; the operator
  // sees `message`, which names what actually went wrong and what to do.
  throw error;
}

/** One attempt against the OCR microservice. Throws a classified OcrError. */
async function callMicroservice(imageBase64: string): Promise<GeminiOcrResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);

  // The timeout is cleared only once the BODY has been read, not when headers
  // arrive: a service that answers instantly and then stalls mid-body would
  // otherwise hang with no deadline at all.
  try {
    let response: Response;
    try {
      response = await fetch(`${OCR_MICROSERVICE_URL}/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64,
          mode: 'receipt',
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw classifyOcrTransportError(err);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      // The microservice wraps upstream provider errors in its OWN 5xx, so the
      // body — not the status — is where a rate limit is legible. See
      // classifyOcrFailure.
      throw classifyOcrFailure(response.status, errorText);
    }

    // A malformed 200 is a PAYLOAD fault, not a reachability fault. Letting it
    // reach classifyOcrTransportError would label it 'unavailable', which both
    // diverts it to the SymbiOS fallback and tells the operator the service
    // could not be reached — when in fact it answered, just not sensibly.
    let data: { text?: unknown; confidence?: unknown };
    try {
      data = (await response.json()) as { text?: unknown; confidence?: unknown };
    } catch (err) {
      throw new OcrError(
        'unknown',
        'The OCR service returned a response BookLets could not read.',
        { status: response.status, cause: err },
      );
    }

    // The microservice returns { text: string, confidence: number }
    // For receipt mode, text is a JSON string matching GeminiExtraction
    const confidence = typeof data.confidence === 'number' ? data.confidence : 0;
    let extraction: GeminiExtraction;
    try {
      if (typeof data.text !== 'string') throw new Error('missing text');
      const parsed: unknown = JSON.parse(data.text);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      extraction = parsed as GeminiExtraction;
    } catch {
      // Still not fatal: a receipt the service genuinely could not read comes
      // back here, and the ingest layer rejects it on the zero amount with a
      // message naming the file. That path is about ONE photo, so it must not
      // abort the run the way a service fault does.
      extraction = {
        vendorName: 'Unknown',
        date: '',
        totalAmount: 0,
        categorySuggestion: 'Other',
        confidence,
      };
    }

    // Validate and clean the extraction
    validateExtraction(extraction);

    return { extraction };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fallback: Call SymbiOS /api/v1/automation/extract-receipt.
 */
async function fallbackToSymbios(
  imageBase64: string
): Promise<GeminiOcrResult> {
  const SYMBIOS_URL = process.env.SYMBIOS_URL || 'https://api.symbios.ai';
  const SYMBIOS_API_KEY = process.env.SYMBIOS_API_KEY || '';

  if (!SYMBIOS_API_KEY) {
    throw new Error(
      'OCR: Microservice unreachable and no SymbiOS API key configured.'
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');

    const response = await fetch(
      `${SYMBIOS_URL}/api/v1/automation/extract-receipt`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SYMBIOS_API_KEY}`,
        },
        body: JSON.stringify({ image: cleanBase64 }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `SymbiOS API Error: ${response.status} ${response.statusText}${
          errorText ? ` — ${errorText.slice(0, 500)}` : ''
        }`
      );
    }

    const data = await response.json();
    return data as GeminiOcrResult;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Validate the parsed extraction fields.
 * Date is allowed to be null/empty when the image doesn't have one.
 */
function validateExtraction(extraction: GeminiExtraction): void {
  if (!extraction.vendorName || typeof extraction.vendorName !== 'string') {
    extraction.vendorName = 'Unknown';
  }

  // Fix #1: Date is allowed to be null/empty when image doesn't have one.
  // Only normalize if it's a non-empty string that isn't YYYY-MM-DD format.
  if (
    extraction.date &&
    typeof extraction.date === 'string' &&
    !/^\d{4}-\d{2}-\d{2}$/.test(extraction.date)
  ) {
    const parsed = new Date(extraction.date);
    if (!isNaN(parsed.getTime())) {
      extraction.date = parsed.toISOString().slice(0, 10);
    } else {
      // Can't parse — empty string is the signal "date not found"
      extraction.date = '';
    }
  }

  if (typeof extraction.totalAmount !== 'number' || isNaN(extraction.totalAmount)) {
    extraction.totalAmount = 0;
  }

  const validCategories = [
    'Groceries', 'Dining', 'Utilities', 'Transport',
    'Office Supplies', 'Accommodation', 'Healthcare', 'Entertainment', 'Other',
  ];

  if (
    !extraction.categorySuggestion ||
    !validCategories.includes(extraction.categorySuggestion)
  ) {
    extraction.categorySuggestion = 'Other';
  }

  if (typeof extraction.confidence !== 'number' || isNaN(extraction.confidence)) {
    extraction.confidence = 0;
  }

  // Clamp confidence to [0, 1]
  extraction.confidence = Math.max(0, Math.min(1, extraction.confidence));
}
