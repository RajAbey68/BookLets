import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OcrError as OcrErrorType } from '@/lib/ocr-errors';

/**
 * Behaviour of extractReceipt around FAILURE. The happy path is covered by the
 * ingest tests; what is pinned here is the set of properties whose absence
 * turned a rate-limited 225-receipt import into "225 receipts couldn't be read":
 *
 *   1. a rate limit is raised as a rate limit, not flattened
 *   2. the provider's own diagnosis survives all the way to the caller
 *   3. the SymbiOS fallback cannot overwrite that diagnosis
 *   4. short throttles are absorbed by an inline retry
 */

const QUOTA_BODY = JSON.stringify({
  error:
    'Gemini OCR API Error: 429 Too Many Requests — {"error":{"code":429,' +
    '"status":"RESOURCE_EXHAUSTED","message":"Please retry in 0.01s."}}',
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
    delete process.env.SYMBIOS_API_KEY;
    process.env.OCR_RETRY_ATTEMPTS = '3';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OCR_RETRY_ATTEMPTS;
    delete process.env.SYMBIOS_API_KEY;
    vi.restoreAllMocks();
  });

  it('retries a short throttle inline and succeeds without the caller ever seeing it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(500, QUOTA_BODY))
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
      .mockResolvedValue(errorResponse(500, QUOTA_BODY)) as unknown as typeof fetch;

    const { extractReceipt, OcrError } = await loadExtractReceipt();
    const error = await extractReceipt('deadbeef').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OcrError);
    expect((error as OcrErrorType).kind).toBe('rate-limit');
  });

  it('does not divert a rate limit to the fallback provider', async () => {
    // The fallback answers ONLY the /api/v1/automation/extract-receipt path;
    // if the implementation wrongly routed a rate limit there, the call would
    // succeed and this expectation would fail.
    process.env.SYMBIOS_API_KEY = 'test-key';
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('symbios')
        ? jsonResponse({ extraction: { vendorName: 'FALLBACK' } })
        : errorResponse(500, QUOTA_BODY),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { extractReceipt } = await loadExtractReceipt();
    const error = await extractReceipt('deadbeef').catch((e: unknown) => e);

    expect((error as OcrErrorType).kind).toBe('rate-limit');
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('symbios'))).toBe(true);
  });

  it('keeps the real diagnosis when the fallback is unconfigured', async () => {
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
