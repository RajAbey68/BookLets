import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OcrError as OcrErrorType } from '@/lib/ocr-errors';

/**
 * Behaviour of extractReceipt around FAILURE. The happy path is covered by the
 * ingest tests; what is pinned here is the set of properties whose absence
 * turned a rate-limited 225-receipt import into "225 receipts couldn't be read":
 *
 *   1. a rate limit is raised as a rate limit, not flattened
 *   2. the provider's own diagnosis survives all the way to the caller
 *   3. an EXHAUSTED quota is never retried — retrying spends money and makes
 *      the very condition it is reacting to worse
 *   4. short throttles are absorbed by an inline retry
 *   5. there is exactly ONE provider: nothing here may quietly call another
 */

/** A momentary burst throttle — short hint, no tier/plan wording. Retryable. */
const THROTTLE_BODY = JSON.stringify({
  error:
    'Gemini OCR API Error: 429 Too Many Requests — {"error":{"code":429,' +
    '"status":"RESOURCE_EXHAUSTED","message":"Please retry in 0.01s."}}',
});

/** The real production body: free-tier allowance spent. NOT retryable. */
const QUOTA_EXHAUSTED_BODY = JSON.stringify({
  error:
    'Gemini OCR API Error: 429 Too Many Requests — {"error":{"code":429,"message":' +
    '"You exceeded your current quota, please check your plan and billing details. ' +
    'Quota exceeded for metric: generativelanguage.googleapis.com/' +
    'generate_content_free_tier_requests, limit: 20","status":"RESOURCE_EXHAUSTED"}}',
});

const OK_BODY = {
  text: JSON.stringify({
    vendorName: 'SPAR SUPERMARKET',
    date: '2026-07-12',
    totalAmount: 1550,
    categorySuggestion: 'Groceries',
    confidence: 1,
  }),
  confidence: 0.9,
};

const jsonResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const errorResponse = (status: number, text: string) =>
  ({ ok: false, status, statusText: 'Error', text: async () => text }) as unknown as Response;

/**
 * Fresh module per test — extractReceipt reads its config at module load.
 *
 * `OcrError` is re-imported from the SAME reloaded graph and returned
 * alongside: resetModules gives the reload its own copy of ocr-errors, so the
 * class object differs from the one this file imported at the top and a naive
 * `instanceof` would fail against an error that is in fact the right type.
 */
async function loadExtractReceipt() {
  vi.resetModules();
  const [mod, errors] = await Promise.all([
    import('@/lib/gemini-ocr'),
    import('@/lib/ocr-errors'),
  ]);
  return { extractReceipt: mod.extractReceipt, OcrError: errors.OcrError };
}

describe('extractReceipt — failure handling', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Deliberately SET, to prove it is inert: the second-provider fallback was
    // removed, so no environment variable can bring a second provider back.
    process.env.SYMBIOS_API_KEY = 'test-key';
    process.env.SYMBIOS_URL = 'https://api.symbios.ai';
    process.env.OCR_RETRY_ATTEMPTS = '3';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OCR_RETRY_ATTEMPTS;
    delete process.env.SYMBIOS_API_KEY;
    delete process.env.SYMBIOS_URL;
    vi.restoreAllMocks();
  });

  it('retries a short throttle inline and succeeds without the caller ever seeing it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(500, THROTTLE_BODY))
      .mockResolvedValueOnce(jsonResponse(OK_BODY));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { extractReceipt } = await loadExtractReceipt();
    const result = await extractReceipt('deadbeef');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.extraction.vendorName).toBe('SPAR SUPERMARKET');
    expect(result.extraction.totalAmount).toBe(1550);
  });

  it('raises a rate limit as a rate limit once retries are spent', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(errorResponse(500, THROTTLE_BODY)) as unknown as typeof fetch;

    const { extractReceipt, OcrError } = await loadExtractReceipt();
    const error = await extractReceipt('deadbeef').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OcrError);
    expect((error as OcrErrorType).kind).toBe('rate-limit');
  });

  it('spends exactly ONE call on an exhausted quota, then stops', async () => {
    // Receipt 3 of 225 must not pay to discover what receipt 2 already learned.
    // The allowance is gone; a retry cannot succeed, and every extra attempt
    // deepens the hole and costs real money.
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(500, QUOTA_EXHAUSTED_BODY));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { extractReceipt, OcrError } = await loadExtractReceipt();
    const error = await extractReceipt('deadbeef').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OcrError);
    expect((error as OcrErrorType).kind).toBe('quota-exhausted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the real diagnosis instead of a fallback’s complaint', async () => {
    // The regression: EVERY failure used to fall through to SymbiOS, which then
    // threw "no SymbiOS API key configured" — discarding the upstream
    // explanation the operator actually needed.
    process.env.OCR_RETRY_ATTEMPTS = '1';
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(errorResponse(503, 'UNAVAILABLE')) as unknown as typeof fetch;

    const { extractReceipt, OcrError } = await loadExtractReceipt();
    const error = await extractReceipt('deadbeef').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OcrError);
    expect((error as OcrErrorType).kind).toBe('unavailable');
    expect((error as Error).message).not.toMatch(/SymbiOS/i);
  });

  it.each([
    ['an exhausted quota', 500, QUOTA_EXHAUSTED_BODY],
    ['a throttle', 500, THROTTLE_BODY],
    ['an unreachable service', 503, 'UNAVAILABLE'],
    ['a credential rejection', 500, 'PERMISSION_DENIED: API key not valid'],
  ])('never calls a second provider on %s', async (_label, status, body) => {
    // There is ONE OCR provider. The old SymbiOS fallback pointed at a domain
    // that is parked for sale, was never exercised against a real key, and
    // returned an unvalidated body straight into the ledger path. Receipt
    // images must never be posted anywhere except OCR_MICROSERVICE_URL.
    process.env.OCR_RETRY_ATTEMPTS = '1';
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      return errorResponse(status, body);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { extractReceipt } = await loadExtractReceipt();
    await extractReceipt('deadbeef').catch(() => undefined);

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toMatch(/symbios/i);
    }
  });

  it('classifies a malformed 200 as a payload fault, not as unreachable', async () => {
    // A bad body used to reach classifyOcrTransportError and come back
    // 'unavailable' — which told the operator the service could not be
    // reached, when it had in fact answered.
    process.env.OCR_RETRY_ATTEMPTS = '1';
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON');
          },
        }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { extractReceipt } = await loadExtractReceipt();
    const error = await extractReceipt('deadbeef').catch((e: unknown) => e);

    expect((error as OcrErrorType).kind).toBe('unknown');
  });

  it('still returns a zero-amount extraction when the receipt itself is illegible', async () => {
    // A receipt the service genuinely could not read is NOT a service fault:
    // it must come back as a normal result so the ingest layer can reject that
    // one photo by name, instead of aborting the whole run.
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ text: 'not json at all', confidence: 0.1 }),
    ) as unknown as typeof fetch;

    const { extractReceipt } = await loadExtractReceipt();
    const result = await extractReceipt('deadbeef');

    expect(result.extraction.totalAmount).toBe(0);
    expect(result.extraction.vendorName).toBe('Unknown');
  });

  it('does not retry a credential rejection', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errorResponse(500, 'PERMISSION_DENIED: API key not valid'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { extractReceipt } = await loadExtractReceipt();
    const error = await extractReceipt('deadbeef').catch((e: unknown) => e);

    expect((error as OcrErrorType).kind).toBe('auth');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
