/**
 * Cross-tenant leak fix — AutomationService.processReceipt's ExpenseCategory
 * resolution (audit finding, RAJ-674). ExpenseCategory has no organization
 * column by design (documented shared reference data — see
 * prisma/migrations/20260712_rls_org_isolation/migration.sql), but its
 * accountId is org-scoped. A name match against a category created by a
 * DIFFERENT org can carry that org's Account onto this org's journal line —
 * the exact leak vector src/lib/ocr-bridge.deps.ts resolveExpenseAccountId
 * already closed for the newer S1b path. This backports the same guard to
 * the older single-receipt path.
 *
 * Mocked Prisma (vi.doMock), no live DB — matches the repo's existing style
 * for prisma-singleton-backed modules (ocr-bridge-deps.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

function mockDeps(overrides: {
  categoryFindFirst?: ReturnType<typeof vi.fn>;
  categoryFindMany?: ReturnType<typeof vi.fn>;
} = {}) {
  const postEntry = vi.fn().mockResolvedValue({ id: 'je-1' });
  const propertyFindFirst = vi.fn().mockResolvedValue({ id: 'prop-1' });
  const vendorFindFirst = vi.fn().mockResolvedValue({ id: 'vendor-1', name: 'Keells' });
  const vendorCreate = vi.fn();
  const expenseCreate = vi.fn().mockResolvedValue({ id: 'exp-1' });

  // Suspense (9999) resolved org-scoped, as today.
  const suspenseAccount = { id: `suspense-${ORG_A}` };
  const accountFindFirst = vi.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
    if (where.code === '9999') return Promise.resolve(suspenseAccount);
    return Promise.resolve(null); // no bank account seeded — irrelevant to this test
  });

  const tx = {
    expense: { create: expenseCreate },
  };

  vi.doMock('../../src/lib/prisma', () => ({
    prisma: {
      property: { findFirst: propertyFindFirst },
      vendor: { findFirst: vendorFindFirst, create: vendorCreate },
      expenseCategory: {
        findFirst: overrides.categoryFindFirst ?? vi.fn().mockResolvedValue(null),
        findMany: overrides.categoryFindMany ?? vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'cat-new', accountId: suspenseAccount.id }),
      },
      account: { findFirst: accountFindFirst },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    },
    setRlsOrgContext: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock('../../src/lib/ledger.service', () => ({ LedgerService: { postEntry } }));
  vi.doMock('../../src/lib/gemini-ocr', () => ({
    extractReceipt: vi.fn().mockResolvedValue({
      extraction: {
        vendorName: 'Keells',
        date: '2026-07-01',
        totalAmount: 1500,
        categorySuggestion: 'Groceries',
        confidence: 0.4,
      },
    }),
  }));

  return { postEntry, accountFindFirst, suspenseAccount };
}

describe('AutomationService.processReceipt — cross-tenant account leak (RAJ-674)', () => {
  beforeEach(() => vi.resetModules());

  it('never uses another organization\'s Account for a shared-name ExpenseCategory match', async () => {
    // A category named "Groceries" already exists, but it was created by
    // ORG_B and its accountId points at an Account belonging to ORG_B.
    const foreignAccountId = `account-${ORG_B}`;
    const { postEntry, accountFindFirst, suspenseAccount } = mockDeps({
      categoryFindFirst: vi.fn().mockResolvedValue({ id: 'cat-shared', name: 'Groceries', accountId: foreignAccountId }),
    });
    // account.findFirst({ id: foreignAccountId, organizationId: ORG_A }) must
    // resolve to null — the foreign account does not belong to ORG_A.
    accountFindFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      if (where.code === '9999') return Promise.resolve(suspenseAccount);
      if (where.id === foreignAccountId) return Promise.resolve(null);
      return Promise.resolve(null);
    });

    const { AutomationService } = await import('../../src/lib/automation.service');
    await AutomationService.processReceipt(ORG_A, 'prop-1', 'base64img');

    expect(postEntry).toHaveBeenCalledOnce();
    const arg = postEntry.mock.calls[0][0];
    const debitLine = arg.lines.find((l: { isDebit: boolean }) => l.isDebit);
    // Must fall back to ORG_A's own Suspense account — never the foreign one.
    expect(debitLine.accountId).toBe(suspenseAccount.id);
    expect(debitLine.accountId).not.toBe(foreignAccountId);
  });

  it('uses the existing category\'s account when it DOES belong to this organization', async () => {
    const ownAccountId = `account-${ORG_A}-groceries`;
    const { postEntry, accountFindFirst, suspenseAccount } = mockDeps({
      categoryFindFirst: vi.fn().mockResolvedValue({ id: 'cat-own', name: 'Groceries', accountId: ownAccountId }),
    });
    accountFindFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      if (where.code === '9999') return Promise.resolve(suspenseAccount);
      if (where.id === ownAccountId) return Promise.resolve({ id: ownAccountId });
      return Promise.resolve(null);
    });

    const { AutomationService } = await import('../../src/lib/automation.service');
    await AutomationService.processReceipt(ORG_A, 'prop-1', 'base64img');

    const arg = postEntry.mock.calls[0][0];
    const debitLine = arg.lines.find((l: { isDebit: boolean }) => l.isDebit);
    expect(debitLine.accountId).toBe(ownAccountId);
  });
});
