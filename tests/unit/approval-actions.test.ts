/**
 * RAJ-292 [P1-10] + RAJ-294 [P1-12] — Approval server actions.
 *
 * decideActionIntent / decideDraftJournalEntry are the only writers for the
 * 4-eyes queue. Invariants under test (mocked Prisma, style of
 * journal-optimistic-lock.test.ts):
 *
 *  - the approver is resolved from the SESSION (resolveActiveContext), never
 *    from client input — so self-approval cannot be spoofed;
 *  - self-approval is blocked even for OWNER role (role never enters the check);
 *  - decisions are guarded updates (where includes the expected status) so a
 *    concurrent double-decide loses cleanly instead of double-writing;
 *  - every decision writes an EvidenceLog row in the SAME transaction;
 *  - DRAFT journal promotion re-runs the balance and fiscal-period gates —
 *    approval is not a bypass of ledger validation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type AnyRecord = Record<string, unknown>;

const pendingIntent = {
  id: 'aiq-1',
  status: 'PENDING',
  action: 'POST_JOURNAL',
  payload: { amount: '12000.00' },
  organizationId: 'org-1',
  makerIdentity: 'maker-1',
  checkerIdentity: null,
  confidence: 0.92,
  createdAt: new Date('2026-06-01T10:00:00Z'),
  approvedAt: null,
  executedAt: null,
};

const draftEntry = {
  id: 'je-1',
  organizationId: 'org-1',
  status: 'DRAFT',
  date: new Date('2026-06-15T00:00:00Z'),
  memo: 'Revenue Recognition: Booking #42',
  makerIdentity: 'maker-1',
  createdBy: null,
  version: 1,
  lines: [
    { accountId: 'acc-1', amount: '12000.00', isDebit: true },
    { accountId: 'acc-2', amount: '12000.00', isDebit: false },
  ],
};

interface SetupOverrides {
  userId?: string;
  intent?: AnyRecord | null;
  entry?: AnyRecord | null;
  fiscalPeriod?: AnyRecord | null;
  intentUpdateCount?: number;
  entryUpdateCount?: number;
  unauthenticated?: boolean;
}

function setup(overrides: SetupOverrides = {}) {
  const tx = {
    actionIntentQueue: {
      updateMany: vi.fn().mockResolvedValue({ count: overrides.intentUpdateCount ?? 1 }),
    },
    journalEntry: {
      updateMany: vi.fn().mockResolvedValue({ count: overrides.entryUpdateCount ?? 1 }),
    },
    evidenceLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'ev-1', hash: 'h1', previousHash: null }),
    },
  };
  const prisma = {
    actionIntentQueue: {
      findUnique: vi.fn().mockResolvedValue(
        overrides.intent === undefined ? pendingIntent : overrides.intent,
      ),
      findMany: vi.fn().mockResolvedValue([]),
    },
    journalEntry: {
      findFirst: vi.fn().mockResolvedValue(
        overrides.entry === undefined ? draftEntry : overrides.entry,
      ),
      findMany: vi.fn().mockResolvedValue([]),
    },
    fiscalPeriod: {
      findFirst: vi.fn().mockResolvedValue(
        overrides.fiscalPeriod === undefined
          ? { name: 'FY2026', isClosed: false }
          : overrides.fiscalPeriod,
      ),
    },
    evidenceLog: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn().mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx)),
  };

  vi.doMock('../../src/lib/prisma', () => ({ prisma, setRlsOrgContext: vi.fn().mockResolvedValue(undefined) }));
  vi.doMock('../../src/lib/auth-context', () => ({
    resolveActiveContext: vi.fn().mockResolvedValue(
      overrides.unauthenticated
        ? { ok: false, error: 'Not authenticated. Sign in to continue.' }
        : {
            ok: true,
            context: {
              organizationId: 'org-1',
              organizationName: 'Test Org',
              userId: overrides.userId ?? 'approver-1',
              role: 'OWNER', // OWNER on purpose — role must NOT bypass 4-eyes
            },
          },
    ),
  }));
  vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));

  return { prisma, tx };
}

async function importActions() {
  return import('../../src/app/actions/approval.actions');
}

beforeEach(() => vi.resetModules());

// ─── fetchPendingActionIntents ───────────────────────────────────────────────

describe('fetchPendingActionIntents', () => {
  it('filters by the caller organisation (multi-tenant isolation)', async () => {
    const { prisma } = setup();
    const { fetchPendingActionIntents } = await importActions();

    await fetchPendingActionIntents();

    expect(prisma.actionIntentQueue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PENDING', organizationId: 'org-1' }),
      }),
    );
  });

  it('returns nothing when unauthenticated', async () => {
    const { prisma } = setup({ unauthenticated: true });
    const { fetchPendingActionIntents } = await importActions();

    const result = await fetchPendingActionIntents();

    expect(result).toEqual([]);
    expect(prisma.actionIntentQueue.findMany).not.toHaveBeenCalled();
  });
});

// ─── decideActionIntent ──────────────────────────────────────────────────────

describe('decideActionIntent', () => {
  it('blocks self-approval even when the approver has OWNER role (RAJ-294)', async () => {
    const { prisma } = setup({ userId: 'maker-1' }); // approver === maker, role OWNER
    const { decideActionIntent } = await importActions();

    const result = await decideActionIntent('aiq-1', 'APPROVE');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/self/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('approves a PENDING intent: guarded update + evidence in one transaction', async () => {
    const { prisma, tx } = setup();
    const { decideActionIntent } = await importActions();

    const result = await decideActionIntent('aiq-1', 'APPROVE');

    expect(result.success).toBe(true);
    // Guarded on status AND org so a concurrent decision cannot double-write
    // and a cross-tenant id can never flip another org's item.
    expect(tx.actionIntentQueue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'aiq-1', status: 'PENDING', organizationId: 'org-1' },
        data: expect.objectContaining({
          status: 'APPROVED',
          checkerIdentity: 'approver-1',
          approvedAt: expect.any(Date),
        }),
      }),
    );
    // Evidence row written via the SAME tx client.
    expect(tx.evidenceLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'ACTION_INTENT_APPROVED',
          tenantId: 'org-1',
          makerIdentity: 'maker-1',
          checkerIdentity: 'approver-1',
        }),
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('rejects a PENDING intent without setting approvedAt', async () => {
    const { tx } = setup();
    const { decideActionIntent } = await importActions();

    const result = await decideActionIntent('aiq-1', 'REJECT');

    expect(result.success).toBe(true);
    const updateArgs = tx.actionIntentQueue.updateMany.mock.calls[0][0] as AnyRecord;
    expect((updateArgs.data as AnyRecord).status).toBe('REJECTED');
    expect((updateArgs.data as AnyRecord).approvedAt).toBeUndefined();
    expect(tx.evidenceLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'ACTION_INTENT_REJECTED' }),
      }),
    );
  });

  it('refuses to decide an intent that is not PENDING', async () => {
    const { prisma } = setup({ intent: { ...pendingIntent, status: 'APPROVED' } });
    const { decideActionIntent } = await importActions();

    const result = await decideActionIntent('aiq-1', 'APPROVE');

    expect(result.success).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns an error when the intent does not exist', async () => {
    setup({ intent: null });
    const { decideActionIntent } = await importActions();

    const result = await decideActionIntent('missing', 'APPROVE');

    expect(result.success).toBe(false);
  });

  it("refuses to decide another organisation's intent (multi-tenant isolation)", async () => {
    const { prisma } = setup({ intent: { ...pendingIntent, organizationId: 'org-2' } });
    const { decideActionIntent } = await importActions();

    const result = await decideActionIntent('aiq-1', 'APPROVE');

    expect(result.success).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails cleanly when it loses the race (guarded update matches 0 rows)', async () => {
    const { tx } = setup({ intentUpdateCount: 0 });
    const { decideActionIntent } = await importActions();

    const result = await decideActionIntent('aiq-1', 'APPROVE');

    expect(result.success).toBe(false);
    expect(tx.evidenceLog.create).not.toHaveBeenCalled();
  });

  it('returns an error when unauthenticated, touching nothing', async () => {
    const { prisma } = setup({ unauthenticated: true });
    const { decideActionIntent } = await importActions();

    const result = await decideActionIntent('aiq-1', 'APPROVE');

    expect(result.success).toBe(false);
    expect(prisma.actionIntentQueue.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ─── decideDraftJournalEntry ─────────────────────────────────────────────────

describe('decideDraftJournalEntry', () => {
  it('blocks self-approval via makerIdentity even for OWNER role (RAJ-294)', async () => {
    const { prisma } = setup({ userId: 'maker-1' });
    const { decideDraftJournalEntry } = await importActions();

    const result = await decideDraftJournalEntry('je-1', 'APPROVE');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/self/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('falls back to createdBy as maker when makerIdentity is null', async () => {
    const { prisma } = setup({
      userId: 'creator-1',
      entry: { ...draftEntry, makerIdentity: null, createdBy: 'creator-1' },
    });
    const { decideDraftJournalEntry } = await importActions();

    const result = await decideDraftJournalEntry('je-1', 'APPROVE');

    expect(result.success).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('approve promotes DRAFT → POSTED (org-scoped, status-guarded) with evidence', async () => {
    const { prisma, tx } = setup();
    const { decideDraftJournalEntry } = await importActions();

    const result = await decideDraftJournalEntry('je-1', 'APPROVE');

    expect(result.success).toBe(true);
    // Load is org-scoped — never trust a bare entry id from the client.
    expect(prisma.journalEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'je-1', organizationId: 'org-1' }),
      }),
    );
    expect(tx.journalEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'je-1', organizationId: 'org-1', status: 'DRAFT' },
        data: expect.objectContaining({ status: 'POSTED', updatedBy: 'approver-1' }),
      }),
    );
    expect(tx.evidenceLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'JOURNAL_DRAFT_APPROVED',
          tenantId: 'org-1',
          makerIdentity: 'maker-1',
          checkerIdentity: 'approver-1',
        }),
      }),
    );
  });

  it('reject voids the DRAFT without a fiscal-period lookup', async () => {
    const { prisma, tx } = setup();
    const { decideDraftJournalEntry } = await importActions();

    const result = await decideDraftJournalEntry('je-1', 'REJECT');

    expect(result.success).toBe(true);
    expect(prisma.fiscalPeriod.findFirst).not.toHaveBeenCalled();
    const updateArgs = tx.journalEntry.updateMany.mock.calls[0][0] as AnyRecord;
    expect((updateArgs.data as AnyRecord).status).toBe('VOIDED');
    expect(tx.evidenceLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'JOURNAL_DRAFT_REJECTED' }),
      }),
    );
  });

  it('approve is blocked when the fiscal period is closed', async () => {
    const { prisma } = setup({ fiscalPeriod: { name: 'FY2025', isClosed: true } });
    const { decideDraftJournalEntry } = await importActions();

    const result = await decideDraftJournalEntry('je-1', 'APPROVE');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/closed/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('approve is blocked when the draft is unbalanced — approval never bypasses ledger validation', async () => {
    const { prisma } = setup({
      entry: {
        ...draftEntry,
        lines: [
          { accountId: 'acc-1', amount: '12000.00', isDebit: true },
          { accountId: 'acc-2', amount: '9000.00', isDebit: false },
        ],
      },
    });
    const { decideDraftJournalEntry } = await importActions();

    const result = await decideDraftJournalEntry('je-1', 'APPROVE');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/unbalanced/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('F9: approve is blocked when the draft has zero-amount lines — same invariant as a direct POST', async () => {
    // A zero-amount draft BALANCES (0 debit − 0 credit = 0), so trial-balance
    // passes; only the zero-line check catches it. Before F9 this path skipped
    // that check, letting a 0.00 draft POST past the ledger's own compliance rule.
    const { prisma } = setup({
      entry: {
        ...draftEntry,
        lines: [
          { accountId: 'acc-1', amount: '0.00', isDebit: true },
          { accountId: 'acc-2', amount: '0.00', isDebit: false },
        ],
      },
    });
    const { decideDraftJournalEntry } = await importActions();

    const result = await decideDraftJournalEntry('je-1', 'APPROVE');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/zero-amount lines/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns an error when the entry is not found in the caller org', async () => {
    const { prisma } = setup({ entry: null });
    const { decideDraftJournalEntry } = await importActions();

    const result = await decideDraftJournalEntry('other-org-entry', 'APPROVE');

    expect(result.success).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails cleanly when it loses the race (guarded update matches 0 rows)', async () => {
    const { tx } = setup({ entryUpdateCount: 0 });
    const { decideDraftJournalEntry } = await importActions();

    const result = await decideDraftJournalEntry('je-1', 'APPROVE');

    expect(result.success).toBe(false);
    expect(tx.evidenceLog.create).not.toHaveBeenCalled();
  });
});
