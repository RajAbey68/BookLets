/**
 * RAJ-674 punch-list #3 — the server action behind the review-queue "Edit"
 * form: updateDraftJournalEntry(entryId, expectedVersion, updates).
 *
 * Mirrors approval-actions.test.ts's mocking style. Under test:
 *  - the organization is resolved from the SESSION, never from client input;
 *  - the entry lookup (to read makerIdentity for the response, and to give a
 *    clean "not found" instead of a raw Prisma error) is org-scoped;
 *  - the actual write goes through LedgerService.updateDraftEntryFields, so
 *    the version+status guard and the two-equal-lines amount check apply —
 *    this action does not duplicate or weaken them;
 *  - a stale version / already-decided entry surfaces as a clean error
 *    result, never an unhandled throw to the client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const draftEntry = {
  id: 'je-1',
  organizationId: 'org-1',
  status: 'DRAFT',
  version: 3,
};

function setup(overrides: {
  entry?: typeof draftEntry | null;
  updateImpl?: () => Promise<unknown>;
  unauthenticated?: boolean;
} = {}) {
  const findFirst = vi.fn().mockResolvedValue(
    overrides.entry === undefined ? draftEntry : overrides.entry,
  );
  vi.doMock('../../src/lib/prisma', () => ({
    prisma: { journalEntry: { findFirst } },
  }));

  vi.doMock('../../src/lib/auth-context', () => ({
    resolveActiveContext: vi.fn().mockResolvedValue(
      overrides.unauthenticated
        ? { ok: false, error: 'Not authenticated. Sign in to continue.' }
        : { ok: true, context: { organizationId: 'org-1', organizationName: 'Test Org', userId: 'user-1', role: 'OWNER' } },
    ),
  }));

  const updateDraftEntryFields = vi.fn().mockImplementation(
    overrides.updateImpl ?? (async () => ({ id: 'je-1', version: 4 })),
  );
  vi.doMock('../../src/lib/ledger.service', () => ({
    LedgerService: { updateDraftEntryFields },
    OptimisticLockError: class OptimisticLockError extends Error {},
  }));

  vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));

  return { findFirst, updateDraftEntryFields };
}

beforeEach(() => vi.resetModules());

describe('updateDraftJournalEntry', () => {
  it('rejects when there is no authenticated session', async () => {
    setup({ unauthenticated: true });
    const { updateDraftJournalEntry } = await import('../../src/app/actions/approval.actions');

    const result = await updateDraftJournalEntry('je-1', 3, { memo: 'x' });

    expect(result.success).toBe(false);
  });

  it('returns a clean not-found result for an entry outside the caller\'s organisation', async () => {
    setup({ entry: null });
    const { updateDraftJournalEntry } = await import('../../src/app/actions/approval.actions');

    const result = await updateDraftJournalEntry('je-foreign', 3, { memo: 'x' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not found/i);
  });

  it('loads the entry ORG-SCOPED before writing — never trusts a bare id', async () => {
    const { findFirst } = setup();
    const { updateDraftJournalEntry } = await import('../../src/app/actions/approval.actions');

    await updateDraftJournalEntry('je-1', 3, { memo: 'Corrected' });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'je-1', organizationId: 'org-1' } }),
    );
  });

  it('delegates the write to LedgerService.updateDraftEntryFields with the org and expected version', async () => {
    const { updateDraftEntryFields } = setup();
    const { updateDraftJournalEntry } = await import('../../src/app/actions/approval.actions');

    const result = await updateDraftJournalEntry('je-1', 3, { memo: 'Corrected vendor', amount: '1750.00' });

    expect(updateDraftEntryFields).toHaveBeenCalledWith(
      'je-1',
      'org-1',
      3,
      { memo: 'Corrected vendor', amount: '1750.00' },
    );
    expect(result.success).toBe(true);
  });

  it('surfaces an OptimisticLockError as a clean error result, not a thrown exception', async () => {
    class FakeOptimisticLockError extends Error {}
    setup({
      updateImpl: async () => {
        throw new FakeOptimisticLockError('stale');
      },
    });
    // Re-mock ledger.service so the thrown class matches what the action imports.
    vi.doMock('../../src/lib/ledger.service', () => ({
      LedgerService: {
        updateDraftEntryFields: vi.fn().mockRejectedValue(new FakeOptimisticLockError('stale')),
      },
      OptimisticLockError: FakeOptimisticLockError,
    }));
    const { updateDraftJournalEntry } = await import('../../src/app/actions/approval.actions');

    const result = await updateDraftJournalEntry('je-1', 1, { memo: 'x' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/modified|stale|version/i);
  });

  it('surfaces a plain validation error (e.g. non-positive amount) as a clean error result', async () => {
    setup({
      updateImpl: async () => {
        throw new Error('Amount must be a positive number; got "-5".');
      },
    });
    const { updateDraftJournalEntry } = await import('../../src/app/actions/approval.actions');

    const result = await updateDraftJournalEntry('je-1', 3, { amount: '-5' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/positive/i);
  });
});
