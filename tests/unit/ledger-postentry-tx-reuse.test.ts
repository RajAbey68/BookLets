/**
 * S3 (rls-lock) review finding #2 — LedgerService.postEntry transaction reuse.
 *
 * AutomationService opens ONE interactive transaction for the expense row and
 * the journal entry; postEntry must write inside that caller-supplied
 * transaction (atomicity + shared RLS org context) instead of opening its own
 * nested prisma.$transaction. Pinned here:
 *
 *  - reuse mode: no prisma.$transaction, entry + evidence go through the tx;
 *  - the RLS org context is set with the EXPLICIT organizationId (finding #1);
 *  - the idempotency fast path and fiscal-period gate read through the tx;
 *  - validation (trial balance, closed period) is identical in both modes;
 *  - P2002 in reuse mode is rethrown (the caller's transaction is aborted at
 *    the DB level — returning the race winner would hide that);
 *  - owned mode still passes the explicit org id to setRlsOrgContext.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Decimal } from 'decimal.js';
import type { JournalEntryInput } from '../../src/lib/types';

const openPeriod = { id: 'fp1', name: '2026', isClosed: false, locked: false };
const createdEntry = { id: 'entry-1', lines: [] };
const existingEntry = { id: 'existing-1', lines: [] };

const balancedLines = [
  { accountId: 'a', amount: new Decimal('100.00'), isDebit: true },
  { accountId: 'b', amount: new Decimal('100.00'), isDebit: false },
];

function makeTx(over: {
  entryFindFirst?: ReturnType<typeof vi.fn>;
  entryCreate?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    journalEntry: {
      findFirst: over.entryFindFirst ?? vi.fn().mockResolvedValue(null),
      create: over.entryCreate ?? vi.fn().mockResolvedValue(createdEntry),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    fiscalPeriod: { findFirst: vi.fn().mockResolvedValue(openPeriod) },
    evidenceLog: { findFirst: vi.fn(), create: vi.fn() },
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}

/** Shared prisma-module mock: `prisma` must NOT be touched in reuse mode. */
function mockPrismaModule() {
  const prisma = {
    journalEntry: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    fiscalPeriod: { findFirst: vi.fn().mockResolvedValue(openPeriod) },
    $transaction: vi.fn(),
  };
  const setRlsOrgContext = vi.fn().mockResolvedValue(undefined);
  vi.doMock('../../src/lib/prisma', () => ({ prisma, setRlsOrgContext }));
  return { prisma, setRlsOrgContext };
}

function mockEvidence() {
  const record = vi.fn().mockResolvedValue({ id: 'ev-1' });
  vi.doMock('../../src/lib/evidence-log.service', () => ({ EvidenceLogService: { record } }));
  return record;
}

const baseInput = (over: Partial<JournalEntryInput> = {}): JournalEntryInput => ({
  organizationId: 'org1',
  date: new Date('2026-07-01'),
  lines: balancedLines,
  ...over,
});

describe('LedgerService.postEntry — caller-supplied transaction (reuse mode)', () => {
  beforeEach(() => vi.resetModules());

  it('writes entry + evidence through the caller tx and never opens its own transaction', async () => {
    const { prisma } = mockPrismaModule();
    const record = mockEvidence();
    const tx = makeTx();
    const { LedgerService } = await import('../../src/lib/ledger.service');

    const result = await LedgerService.postEntry(baseInput(), tx as never);

    expect(result).toBe(createdEntry);
    expect(tx.journalEntry.create).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toBe(tx); // evidence rides the SAME tx
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.journalEntry.findFirst).not.toHaveBeenCalled();
  });

  it('sets the RLS org context on the caller tx with the EXPLICIT organizationId', async () => {
    const { setRlsOrgContext } = mockPrismaModule();
    mockEvidence();
    const tx = makeTx();
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.postEntry(baseInput(), tx as never);

    expect(setRlsOrgContext).toHaveBeenCalledWith(tx, 'org1');
  });

  it('runs the idempotency fast path through the caller tx (org-scoped), skipping the write', async () => {
    const { prisma } = mockPrismaModule();
    mockEvidence();
    const entryFindFirst = vi.fn().mockResolvedValue(existingEntry);
    const tx = makeTx({ entryFindFirst });
    const { LedgerService } = await import('../../src/lib/ledger.service');

    const result = await LedgerService.postEntry(
      baseInput({ source: 'hostaway', sourceId: 'res-42' }),
      tx as never,
    );

    expect(result).toBe(existingEntry);
    expect(entryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org1' }) }),
    );
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
    expect(prisma.journalEntry.findFirst).not.toHaveBeenCalled(); // not the shared client
  });

  it('runs the fiscal-period gate through the caller tx and still rejects closed periods', async () => {
    const { prisma } = mockPrismaModule();
    mockEvidence();
    const tx = makeTx();
    tx.fiscalPeriod.findFirst = vi
      .fn()
      .mockResolvedValue({ id: 'fp1', name: 'July 2026', isClosed: true, locked: false });
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(LedgerService.postEntry(baseInput(), tx as never)).rejects.toThrow(/closed/);
    expect(tx.fiscalPeriod.findFirst).toHaveBeenCalledOnce();
    expect(prisma.fiscalPeriod.findFirst).not.toHaveBeenCalled();
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
  });

  it('still enforces trial-balance validation in reuse mode', async () => {
    mockPrismaModule();
    mockEvidence();
    const tx = makeTx();
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(
      LedgerService.postEntry(
        baseInput({
          lines: [
            { accountId: 'a', amount: new Decimal('100.00'), isDebit: true },
            { accountId: 'b', amount: new Decimal('99.00'), isDebit: false },
          ],
        }),
        tx as never,
      ),
    ).rejects.toThrow(/CRITICAL LEDGER ERROR/);
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
  });

  it('rethrows a P2002 idempotency conflict instead of recovering (caller tx is aborted)', async () => {
    const { prisma } = mockPrismaModule();
    mockEvidence();
    const { Prisma } = await import('@prisma/client');
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['organizationId', 'idempotencyKey'] },
    });
    const tx = makeTx({
      entryFindFirst: vi.fn().mockResolvedValue(null),
      entryCreate: vi.fn().mockRejectedValue(p2002),
    });
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(
      LedgerService.postEntry(baseInput({ source: 'hostaway', sourceId: 'res-42' }), tx as never),
    ).rejects.toThrow(/Unique constraint failed/);
    // No silent recovery read outside the doomed transaction:
    expect(prisma.journalEntry.findFirst).not.toHaveBeenCalled();
  });
});

describe('AutomationService.processReceipt — expense + journal entry in ONE transaction', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    // doMock registrations outlive resetModules — drop the ledger.service /
    // gemini-ocr / http mocks so later suites import the real modules.
    vi.doUnmock('../../src/lib/ledger.service');
    vi.doUnmock('../../src/lib/gemini-ocr');
    vi.doUnmock('../../src/lib/http');
  });

  it('forwards its open transaction into LedgerService.postEntry and sets the explicit RLS context', async () => {
    const txExpenseCreate = vi.fn().mockResolvedValue({ id: 'exp-1' });
    const innerTx = { expense: { create: txExpenseCreate } };
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(innerTx));
    const setRlsOrgContext = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      property: { findFirst: vi.fn().mockResolvedValue({ id: 'prop-1' }) },
      vendor: { findFirst: vi.fn().mockResolvedValue({ id: 'ven-1' }) },
      account: { findFirst: vi.fn().mockResolvedValue({ id: 'acc-suspense' }) },
      expenseCategory: {
        findFirst: vi.fn().mockResolvedValue({ id: 'cat-1', accountId: 'acc-exp' }),
      },
      $transaction,
    };
    vi.doMock('../../src/lib/prisma', () => ({ prisma, setRlsOrgContext }));
    const postEntry = vi.fn().mockResolvedValue({ id: 'entry-1' });
    vi.doMock('../../src/lib/ledger.service', () => ({ LedgerService: { postEntry } }));
    vi.doMock('../../src/lib/gemini-ocr', () => ({
      extractReceipt: vi.fn().mockResolvedValue({
        extraction: {
          vendorName: 'ACME',
          date: '2026-07-01',
          totalAmount: 42,
          categorySuggestion: 'Repairs',
          confidence: 0.95,
        },
      }),
    }));
    vi.doMock('../../src/lib/http', () => ({ fetchWithTimeout: vi.fn() }));
    const { AutomationService } = await import('../../src/lib/automation.service');

    const result = await AutomationService.processReceipt('org1', 'prop-1', 'base64img');

    expect($transaction).toHaveBeenCalledOnce();
    // Explicit org id on the shared transaction (finding #1):
    expect(setRlsOrgContext).toHaveBeenCalledWith(innerTx, 'org1');
    expect(txExpenseCreate).toHaveBeenCalledOnce();
    // The SAME tx client is forwarded — expense + journal entry are atomic
    // (finding #2: previously postEntry opened its own nested transaction).
    expect(postEntry).toHaveBeenCalledOnce();
    expect(postEntry.mock.calls[0][1]).toBe(innerTx);
    expect(result.journalEntryId).toBe('entry-1');
    // D3 conf-gate: automated extraction is always human-in-the-loop — no
    // SUCCESS status exists; even confidence 0.95 lands as DRAFT/HIL_REQUIRED.
    expect(result.status).toBe('HIL_REQUIRED');
  });
});

describe('LedgerService.postEntry — owned transaction (unchanged mode)', () => {
  beforeEach(() => vi.resetModules());

  it('opens its own transaction and sets the RLS context with the explicit org id', async () => {
    const { prisma, setRlsOrgContext } = mockPrismaModule();
    mockEvidence();
    const innerTx = makeTx();
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(innerTx),
    );
    const { LedgerService } = await import('../../src/lib/ledger.service');

    const result = await LedgerService.postEntry(baseInput());

    expect(result).toBe(createdEntry);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(setRlsOrgContext).toHaveBeenCalledWith(innerTx, 'org1');
    expect(innerTx.journalEntry.create).toHaveBeenCalledOnce();
  });
});
