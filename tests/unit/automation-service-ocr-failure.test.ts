/**
 * The SECOND OCR failure path — the single-receipt uploader.
 *
 * `AutomationService.processReceipt` had its own, differently-written
 * Gemini→SymbiOS fallback, and it repeated every defect the WhatsApp import
 * path had just been cured of:
 *
 *   • it caught EVERY error from extractReceipt — including a rate limit —
 *     and pushed it at a second provider, which cannot help with a throttle;
 *   • that second provider defaulted to `http://localhost:8080`, a host that
 *     does not exist in production, so the real diagnosis was replaced by a
 *     connection error;
 *   • when the second provider answered at all, it threw
 *     `SymbiOS Extraction Failed: 500 … <raw provider body>`, and
 *     receipt.actions.ts hands that message straight to the screen — so the
 *     provider's body, quota URLs and internal metric names included, was
 *     operator-facing text.
 *
 * There is now ONE provider. A classified OcrError travels intact to the
 * caller, which is the only text the operator ever sees.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const EXTRACTION = {
  vendorName: 'Keells Super',
  date: '2026-07-01',
  totalAmount: 4500,
  categorySuggestion: 'Groceries',
  confidence: 0.8,
};

/**
 * Stub every IO collaborator except OCR, which the caller supplies so each
 * test can decide how the provider fails. `fetchWithTimeout` is handed a spy
 * that FAILS the test if it is ever called: nothing may reach a second
 * provider, and a silent extra network call is exactly the bug under test.
 */
function mockDeps(ocr: () => Promise<unknown>) {
  const postEntry = vi.fn().mockResolvedValue({ id: 'je-1' });
  const fetchWithTimeout = vi.fn(async () => {
    throw new Error('fetchWithTimeout must not be called — there is no second OCR provider');
  });

  vi.doMock('../../src/lib/gemini-ocr', () => ({ extractReceipt: vi.fn(ocr) }));

  vi.doMock('../../src/lib/prisma', () => ({
    prisma: {
      property: { findFirst: vi.fn().mockResolvedValue({ id: 'prop-1' }) },
      vendor: {
        findFirst: vi.fn().mockResolvedValue({ id: 'ven-1', name: 'Keells Super' }),
        create: vi.fn(),
      },
      account: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: 'acct-suspense', code: '9999' })
          .mockResolvedValueOnce({ id: 'acct-bank', code: '1000' }),
      },
      expenseCategory: {
        findFirst: vi.fn().mockResolvedValue({ id: 'cat-1', accountId: 'acct-exp' }),
        create: vi.fn(),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ expense: { create: vi.fn().mockResolvedValue({ id: 'exp-1' }) } }),
      ),
    },
    setRlsOrgContext: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock('../../src/lib/ledger.service', () => ({ LedgerService: { postEntry } }));
  vi.doMock('../../src/lib/http', () => ({ fetchWithTimeout }));

  return { postEntry, fetchWithTimeout };
}

async function processWithOcr(ocr: () => Promise<unknown>) {
  const deps = mockDeps(ocr);
  const { AutomationService } = await import('../../src/lib/automation.service');
  const error = await AutomationService.processReceipt('org-1', 'prop-1', 'aW1hZ2U=').catch(
    (e: unknown) => e,
  );
  return { ...deps, error };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('AutomationService.processReceipt — OCR failures', () => {
  it('surfaces the classified rate-limit message unchanged, and calls no second provider', async () => {
    const { OcrError } = await import('../../src/lib/ocr-errors');
    const throttle = new OcrError(
      'rate-limit',
      'The OCR service is rate limited right now — this receipt was not read. ' +
        'Nothing is wrong with the photo.',
      { retryAfterMs: 3000 },
    );

    const { error, fetchWithTimeout, postEntry } = await processWithOcr(async () => {
      throw throttle;
    });

    expect((error as Error).message).toMatch(/rate limited/i);
    expect((error as Error).message).not.toMatch(/SymbiOS/i);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    // Nothing was written: the receipt was never read.
    expect(postEntry).not.toHaveBeenCalled();
  });

  it('surfaces an exhausted quota as an account limit, not as a bad photo', async () => {
    const { OcrError } = await import('../../src/lib/ocr-errors');
    const { error, fetchWithTimeout } = await processWithOcr(async () => {
      throw new OcrError('quota-exhausted', 'quota gone', {});
    });

    // The kind must survive the trip so callers can branch on it, and the
    // message must be OURS — never the provider's body.
    expect((error as { kind?: string }).kind).toBe('quota-exhausted');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('does not send the receipt image to a second provider when the service is down', async () => {
    const { OcrError } = await import('../../src/lib/ocr-errors');
    const { error, fetchWithTimeout } = await processWithOcr(async () => {
      throw new OcrError('unavailable', 'The OCR service could not be reached.');
    });

    expect((error as Error).message).toMatch(/could not be reached/i);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('still posts a DRAFT when OCR succeeds', async () => {
    const { postEntry, fetchWithTimeout } = await processWithOcr(async () => ({
      extraction: EXTRACTION,
    }));

    expect(postEntry).toHaveBeenCalledOnce();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});
