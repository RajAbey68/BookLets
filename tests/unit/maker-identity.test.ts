/**
 * E5 — maker identity: session user on human paths, shared service
 * constant on automated paths, SoD (maker ≠ checker) still binding.
 *
 * Invariants under test (backed by CI gate P1.4):
 *
 *  1. A HUMAN-initiated ledger write (createManualJournalEntry) carries
 *     the SESSION user id as makerIdentity — resolved from
 *     resolveActiveContext, never a hardcoded service identity.
 *  2. The AUTOMATED OCR pipeline (AutomationService.processReceipt) posts
 *     with AUTOMATION_MAKER_IDENTITY — the single exported constant, not a
 *     re-inlined string literal.
 *  3. assertNotSelfApproval binds on real session user ids: the user who
 *     made an entry cannot check it, and the automation identity cannot
 *     check its own entries either — but a human CAN check an
 *     automation-made entry (that is the whole 4-eyes flow for OCR drafts).
 *
 * Mocking follows the repo convention: Prisma singleton and IO-bearing
 * collaborators stubbed via vi.doMock + vi.resetModules (see
 * tests/unit/approval-actions.test.ts, tests/unit/receipt-confidence-gate.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AUTOMATION_MAKER_IDENTITY } from '../../src/lib/maker-identity';
import { assertNotSelfApproval, SelfApprovalError } from '../../src/lib/approval.service';

// Realistic session user ids (cuid-shaped, as issued by Auth.js/Prisma).
const SESSION_USER_ID = 'clx9f2ab40001ml08h7yc2r4d';
const OTHER_USER_ID = 'clx9f2ab40002ml08qs1t9e6k';

beforeEach(() => vi.resetModules());

// ─── 1. Human path: manual journal entry carries the session user ───────────

function mockManualEntryDeps(userId: string) {
  const postEntry = vi.fn().mockResolvedValue({ id: 'je-1', lines: [] });

  vi.doMock('../../src/lib/prisma', () => ({
    prisma: {
      account: {
        findMany: vi.fn().mockResolvedValue([{ id: 'acc-1' }, { id: 'acc-2' }]),
      },
    },
  }));
  vi.doMock('../../src/lib/auth-context', () => ({
    resolveActiveContext: vi.fn().mockResolvedValue({
      ok: true,
      context: {
        organizationId: 'org-1',
        organizationName: 'Test Org',
        userId,
        role: 'ACCOUNTANT',
      },
    }),
  }));
  vi.doMock('../../src/lib/ledger.service', () => ({ LedgerService: { postEntry } }));
  vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));

  return { postEntry };
}

const manualInput = {
  date: '2026-07-10',
  memo: 'Manual accrual',
  lines: [
    { accountId: 'acc-1', amount: '250.00', isDebit: true },
    { accountId: 'acc-2', amount: '250.00', isDebit: false },
  ],
};

describe('createManualJournalEntry (human-initiated path)', () => {
  it('passes the session user id as makerIdentity', async () => {
    const { postEntry } = mockManualEntryDeps(SESSION_USER_ID);
    const { createManualJournalEntry } = await import('../../src/app/actions/ledger.actions');

    const result = await createManualJournalEntry(manualInput);

    expect(result).toEqual({ success: true, entryId: 'je-1' });
    expect(postEntry).toHaveBeenCalledOnce();
    expect(postEntry.mock.calls[0][0].makerIdentity).toBe(SESSION_USER_ID);
  });

  it('never posts with the automation service identity', async () => {
    const { postEntry } = mockManualEntryDeps(SESSION_USER_ID);
    const { createManualJournalEntry } = await import('../../src/app/actions/ledger.actions');

    await createManualJournalEntry(manualInput);

    expect(postEntry.mock.calls[0][0].makerIdentity).not.toBe(AUTOMATION_MAKER_IDENTITY);
  });
});

// ─── 2. Automated path: OCR pipeline posts as the shared constant ───────────

function mockReceiptDeps() {
  const postEntry = vi.fn().mockResolvedValue({ id: 'je-1' });

  vi.doMock('../../src/lib/gemini-ocr', () => ({
    extractReceipt: vi.fn().mockResolvedValue({
      extraction: {
        vendorName: 'Keells Super',
        date: '2026-07-01',
        totalAmount: 4500,
        categorySuggestion: 'Groceries',
        confidence: 0.97,
      },
    }),
  }));
  vi.doMock('../../src/lib/prisma', () => ({
    prisma: {
      property: { findFirst: vi.fn().mockResolvedValue({ id: 'prop-1' }) },
      vendor: {
        findFirst: vi.fn().mockResolvedValue({ id: 'ven-1', name: 'Keells Super' }),
        create: vi.fn(),
      },
      account: {
        // Call order inside processReceipt: Suspense (9999) first, Bank (1000) second.
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
  }));
  vi.doMock('../../src/lib/ledger.service', () => ({ LedgerService: { postEntry } }));
  vi.doMock('../../src/lib/http', () => ({ fetchWithTimeout: vi.fn() }));

  return { postEntry };
}

describe('AutomationService.processReceipt (automated path)', () => {
  it('posts with the shared AUTOMATION_MAKER_IDENTITY constant', async () => {
    const { postEntry } = mockReceiptDeps();
    const { AutomationService } = await import('../../src/lib/automation.service');

    await AutomationService.processReceipt('org-1', 'prop-1', 'aW1hZ2U=');

    expect(postEntry).toHaveBeenCalledOnce();
    expect(postEntry.mock.calls[0][0].makerIdentity).toBe(AUTOMATION_MAKER_IDENTITY);
    expect(postEntry.mock.calls[0][0].makerIdentity).toBe('booklets-automation-service');
  });
});

// ─── 3. SoD still binds on the identities these paths now produce ───────────

describe('assertNotSelfApproval with session-derived identities', () => {
  it('rejects maker == checker for a real session user id', () => {
    expect(() => assertNotSelfApproval(SESSION_USER_ID, SESSION_USER_ID)).toThrow(
      SelfApprovalError,
    );
  });

  it('allows a distinct session user to check another user\'s entry', () => {
    expect(() => assertNotSelfApproval(SESSION_USER_ID, OTHER_USER_ID)).not.toThrow();
  });

  it('allows a human checker to decide an automation-made entry', () => {
    expect(() => assertNotSelfApproval(AUTOMATION_MAKER_IDENTITY, SESSION_USER_ID)).not.toThrow();
  });

  it('rejects the automation identity checking its own entry', () => {
    expect(() =>
      assertNotSelfApproval(AUTOMATION_MAKER_IDENTITY, AUTOMATION_MAKER_IDENTITY),
    ).toThrow(SelfApprovalError);
  });
});
