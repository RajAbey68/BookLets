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

  it('uses the SymbiOS fallback when the service is unreachable and a key is set', async () => {
    // The other half of the gating rule: the fallback is skipped for
    // rate-limit/auth, but it MUST still run for genuine unreachability.
    process.env.SYMBIOS_API_KEY = 'test-key';
    process.env.OCR_RETRY_ATTEMPTS = '1';
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('symbios')
        ? jsonResponse({
            extraction: {
              vendorName: 'FALLBACK VENDOR',
              date: '2026-07-12',
              totalAmount: 42,
              categorySuggestion: 'Other',
              confidence: 0.5,
            },
          })
        : errorResponse(503, 'UNAVAILABLE'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { extractReceipt } = await loadExtractReceipt();
    const result = await extractReceipt('deadbeef');

    expect(result.extraction.vendorName).toBe('FALLBACK VENDOR');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('symbios'))).toBe(true);
  });

  it('classifies a malformed 200 as a payload fault, not as unreachable', async () => {
    // A bad body used to reach classifyOcrTransportError and come back
    // 'unavailable' — which both diverted it to SymbiOS and told the operator
    // the service could not be reached, when it had in fact answered.
    process.env.SYMBIOS_API_KEY = 'test-key';
    process.env.OCR_RETRY_ATTEMPTS = '1';
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('symbios')
        ? jsonResponse({ extraction: { vendorName: 'FALLBACK' } })
        : ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token < in JSON');
            },
          } as unknown as Response),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { extractReceipt } = await loadExtractReceipt();
    const error = await extractReceipt('deadbeef').catch((e: unknown) => e);

    expect((error as OcrErrorType).kind).toBe('unknown');
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('symbios'))).toBe(true);
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
