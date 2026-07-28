/**
 * Fiscal-period pre-flight on the receipt-import paths.
 *
 * THE BUG THIS PINS
 * LedgerService.checkFiscalPeriod rejects any entry whose date is not covered
 * by an open FiscalPeriod, and a fresh organisation has none. Both upload
 * transports discovered that only at postEntry — AFTER every photo had been
 * sent to OCR. A 120-photo import therefore ran to completion, paid for 120
 * OCR calls and reported 0 imported / 120 failed, with the raw message
 * "No fiscal period defined for the date 7/12/2026".
 *
 * src/lib/ocr-bridge.ts already got this right: it checks for an open period
 * BEFORE spending anything and parks the row as NO_FISCAL_PERIOD. These tests
 * hold the zip and per-item paths to the same standard:
 *
 *   1. no open period at all  → refused BEFORE any OCR call, with copy that
 *      says what to do (this is the production blocker state);
 *   2. periods exist but none covers this receipt's date → refused before the
 *      ledger post, naming the date, not the raw ledger error;
 *   3. a covering open period → nothing changes, the receipt imports.
 *
 * `deps.ocr` is a spy in every case, so "did not spend" is asserted, not
 * assumed.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { ingestItem, type ItemIngestDeps } from '../../src/lib/ingest-item';
import { ingestZip, ZipIngestError, type ZipIngestDeps } from '../../src/lib/zip-ingest';

const CTX = { organizationId: 'org_1', userId: 'user_1' };

function jpeg(seed = 128): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(seed)]);
}

const extraction = {
  vendorName: 'Hardware Store',
  date: '2026-07-12',
  totalAmount: 4500,
  categorySuggestion: 'Other',
  confidence: 0.42,
};

function itemDeps(overrides: Partial<ItemIngestDeps> = {}): ItemIngestDeps {
  return {
    ocr: vi.fn(async () => ({ extraction })),
    postEntry: vi.fn(async () => ({ id: 'je_1', created: true })),
    findExistingIdempotencyKeys: vi.fn(async () => new Set<string>()),
    resolveLedgerAccounts: vi.fn(async () => ({
      expenseAccountId: 'acct_suspense',
      cashAccountId: 'acct_cash',
    })),
    recordEvidence: vi.fn(async () => {}),
    hasAnyOpenFiscalPeriod: vi.fn(async () => true),
    hasOpenFiscalPeriodFor: vi.fn(async () => true),
    ...overrides,
  } as ItemIngestDeps;
}

function zipDeps(overrides: Partial<ZipIngestDeps> = {}): ZipIngestDeps {
  return {
    ocr: vi.fn(async () => ({ extraction })),
    postEntry: vi.fn(async () => ({ id: 'je_1' })),
    findExistingIdempotencyKeys: vi.fn(async () => new Set<string>()),
    resolveLedgerAccounts: vi.fn(async () => ({
      expenseAccountId: 'acct_suspense',
      cashAccountId: 'acct_cash',
    })),
    recordEvidence: vi.fn(async () => {}),
    hasAnyOpenFiscalPeriod: vi.fn(async () => true),
    hasOpenFiscalPeriodFor: vi.fn(async () => true),
    ...overrides,
  } as ZipIngestDeps;
}

function archive(imageCount: number): Buffer {
  const zip = new AdmZip();
  zip.addFile('_chat.txt', Buffer.from('12/07/2026, 10:15 - Raj: receipts\n'));
  for (let i = 0; i < imageCount; i += 1) zip.addFile(`IMG-${i}.jpg`, jpeg(64 + i));
  return zip.toBuffer();
}

// ─── per-item transport ──────────────────────────────────────────────────────

describe('ingestItem — no open accounting period at all', () => {
  it('refuses the receipt BEFORE calling OCR', async () => {
    const deps = itemDeps({ hasAnyOpenFiscalPeriod: vi.fn(async () => false) });

    const result = await ingestItem(jpeg(), 'IMG-1.jpg', CTX, deps);

    expect(deps.ocr).not.toHaveBeenCalled();
    expect(deps.postEntry).not.toHaveBeenCalled();
    expect(result.outcome).toBe('skipped');
  });

  it('says what happened, what to do, and that nothing was charged for', async () => {
    const deps = itemDeps({ hasAnyOpenFiscalPeriod: vi.fn(async () => false) });

    const result = await ingestItem(jpeg(), 'IMG-1.jpg', CTX, deps);

    expect(result.reason).toMatch(/accounting period/i);
    expect(result.reason).toMatch(/Accounting periods page/i);
    expect(result.reason).toMatch(/nothing was charged/i);
    // Never the raw ledger error, and never a US-format date.
    expect(result.reason).not.toMatch(/No fiscal period defined/i);
  });

  it('still records per-item evidence, so the audit trail shows why nothing landed', async () => {
    const deps = itemDeps({ hasAnyOpenFiscalPeriod: vi.fn(async () => false) });

    await ingestItem(jpeg(), 'IMG-1.jpg', CTX, deps);

    expect(deps.recordEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: CTX.organizationId,
        payload: expect.objectContaining({ outcome: 'skipped' }),
      }),
    );
  });

  it('does not gate chat transcripts — they are evidence, never journal entries', async () => {
    const deps = itemDeps({ hasAnyOpenFiscalPeriod: vi.fn(async () => false) });

    const result = await ingestItem(
      Buffer.from('12/07/2026, 10:15 - Raj: hello\n'),
      '_chat.txt',
      CTX,
      deps,
    );

    expect(result.outcome).toBe('created');
    expect(result.kind).toBe('text');
  });

  it('a receipt already in the books is still reported as a duplicate, not as a period problem', async () => {
    const deps = itemDeps({
      hasAnyOpenFiscalPeriod: vi.fn(async () => false),
      findExistingIdempotencyKeys: vi.fn(async (_org: string, keys: string[]) => new Set(keys)),
    });

    const result = await ingestItem(jpeg(), 'IMG-1.jpg', CTX, deps);

    expect(result.outcome).toBe('duplicate');
  });
});

describe('ingestItem — the receipt date falls outside every open period', () => {
  it('refuses before the ledger post and names the date in plain English', async () => {
    const deps = itemDeps({ hasOpenFiscalPeriodFor: vi.fn(async () => false) });

    const result = await ingestItem(jpeg(), 'IMG-1.jpg', CTX, deps);

    expect(deps.postEntry).not.toHaveBeenCalled();
    expect(result.outcome).toBe('failed');
    expect(result.stage).toBe('ledger');
    expect(result.reason).toContain('12 July 2026');
    expect(result.reason).toMatch(/Accounting periods page/i);
  });

  it('checks the receipt date OCR read, not today', async () => {
    const hasOpenFiscalPeriodFor = vi.fn(async () => true);
    await ingestItem(jpeg(), 'IMG-1.jpg', CTX, itemDeps({ hasOpenFiscalPeriodFor }));

    expect(hasOpenFiscalPeriodFor).toHaveBeenCalledWith(
      CTX.organizationId,
      new Date('2026-07-12T00:00:00.000Z'),
    );
  });

  it('imports normally when a period covers the date', async () => {
    const deps = itemDeps();
    const result = await ingestItem(jpeg(), 'IMG-1.jpg', CTX, deps);

    expect(result.outcome).toBe('created');
    expect(deps.postEntry).toHaveBeenCalledTimes(1);
  });
});

// ─── single-shot zip transport ───────────────────────────────────────────────

describe('ingestZip — no open accounting period at all', () => {
  it('rejects the whole archive before a single OCR call', async () => {
    const deps = zipDeps({ hasAnyOpenFiscalPeriod: vi.fn(async () => false) });

    await expect(ingestZip(archive(3), CTX, deps)).rejects.toThrow(ZipIngestError);
    expect(deps.ocr).not.toHaveBeenCalled();
    expect(deps.postEntry).not.toHaveBeenCalled();
  });

  it('carries the NO_FISCAL_PERIOD code and operator-facing copy', async () => {
    const deps = zipDeps({ hasAnyOpenFiscalPeriod: vi.fn(async () => false) });

    try {
      await ingestZip(archive(2), CTX, deps);
      expect.unreachable('the archive should have been rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ZipIngestError);
      expect((err as ZipIngestError).code).toBe('NO_FISCAL_PERIOD');
      expect((err as ZipIngestError).message).toMatch(/Accounting periods page/i);
    }
  });

  it('does not consult the period gate when the archive has no new receipts to post', async () => {
    // Chat-only archive: nothing would reach the ledger, so a missing period is
    // not this import's problem and must not fail it.
    const zip = new AdmZip();
    zip.addFile('_chat.txt', Buffer.from('12/07/2026, 10:15 - Raj: hello\n'));
    const deps = zipDeps({ hasAnyOpenFiscalPeriod: vi.fn(async () => false) });

    const report = await ingestZip(zip.toBuffer(), CTX, deps);

    expect(report.chatFiles).toHaveLength(1);
    expect(report.created).toBe(0);
  });
});

describe('ingestZip — a receipt dated outside every open period', () => {
  it('reports it as a ledger failure naming the date, not the raw ledger error', async () => {
    const deps = zipDeps({ hasOpenFiscalPeriodFor: vi.fn(async () => false) });

    const report = await ingestZip(archive(1), CTX, deps);

    expect(deps.postEntry).not.toHaveBeenCalled();
    expect(report.created).toBe(0);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].stage).toBe('ledger');
    expect(report.failures[0].error).toContain('12 July 2026');
    expect(report.failures[0].error).not.toMatch(/No fiscal period defined/i);
  });

  it('imports normally when a period covers the date', async () => {
    const deps = zipDeps();
    const report = await ingestZip(archive(2), CTX, deps);

    expect(report.created).toBe(2);
    expect(report.failures).toEqual([]);
  });
});
