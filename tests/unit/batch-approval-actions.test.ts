/**
 * S6 review-ui — batch 4-eyes decisions over DRAFT journal entries.
 *
 * batchDecideDraftJournalEntries must be a thin fan-out over the existing
 * decideDraftJournalEntry path (mocked Prisma, style of
 * approval-actions.test.ts). Invariants under test:
 *
 *  - every entry in the batch goes through the SAME per-entry pipeline:
 *    org-scoped load, resolveDraftJournalDecision (DRAFT-only),
 *    assertNotSelfApproval, guarded update + EvidenceLog in one transaction;
 *  - an entry whose maker is the session user is excluded with a PER-ENTRY
 *    error — never silently approved, and it never blocks the rest;
 *  - non-DRAFT entries fail per-entry (DRAFT-only filtering), the rest of
 *    the batch proceeds;
 *  - partial failures are reported per entry with counts;
 *  - duplicate ids are deduplicated (one decision, one evidence row);
 *  - unauthenticated / empty / oversized batches fail wholesale without
 *    touching the database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type AnyRecord = Record<string, unknown>;

const balancedLines = [
  { accountId: 'acc-1', amount: '150.00', isDebit: true },
  { accountId: 'acc-2', amount: '150.00', isDebit: false },
];

const baseEntry = {
  organizationId: 'org-1',
  status: 'DRAFT',
  date: new Date('2026-06-15T00:00:00Z'),
  memo: 'AUTOMATED: Receipt for Colombo Hardware',
  makerIdentity: 'booklets-automation-service',
  createdBy: null,
  version: 1,
  lines: balancedLines,
};

/** Entry fixtures keyed by id — findFirst resolves from this map. */
function defaultEntries(): Record<string, AnyRecord> {
  return {
    'je-ok-1': { ...baseEntry, id: 'je-ok-1' },
    'je-ok-2': { ...baseEntry, id: 'je-ok-2', memo: 'ZIP-INGEST: Lanka Paints [Repairs] — r1.jpg' },
    'je-self': { ...baseEntry, id: 'je-self', makerIdentity: 'approver-1' },
    'je-posted': { ...baseEntry, id: 'je-posted', status: 'POSTED' },
    'je-other-org': { ...baseEntry, id: 'je-other-org', organizationId: 'org-2' },
    'je-unbalanced': {
      ...baseEntry,
      id: 'je-unbalanced',
      lines: [
        { accountId: 'acc-1', amount: '150.00', isDebit: true },
        { accountId: 'acc-2', amount: '90.00', isDebit: false },
      ],
    },
  };
}

interface SetupOverrides {
  userId?: string;
  entries?: Record<string, AnyRecord>;
  unauthenticated?: boolean;
}

function setup(overrides: SetupOverrides = {}) {
  const entries = overrides.entries ?? defaultEntries();

  const tx = {
    journalEntry: {
      // Guarded update: only a DRAFT row in the caller org matches.
      updateMany: vi.fn().mockImplementation(({ where }: { where: AnyRecord }) => {
        const entry = entries[where.id as string];
        const count =
          entry && entry.status === 'DRAFT' && entry.organizationId === where.organizationId
            ? 1
            : 0;
        return Promise.resolve({ count });
      }),
    },
    evidenceLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'ev-1', hash: 'h1', previousHash: null }),
    },
  };

  const prisma = {
    journalEntry: {
      // Org-scoped lookup, mirroring the where clause the action must send.
      findFirst: vi.fn().mockImplementation(({ where }: { where: AnyRecord }) => {
        const entry = entries[where.id as string];
        return Promise.resolve(
          entry && entry.organizationId === where.organizationId ? entry : null,
        );
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    fiscalPeriod: {
      findFirst: vi.fn().mockResolvedValue({ name: 'FY2026', isClosed: false }),
    },
    evidenceLog: { findMany: vi.fn().mockResolvedValue([]) },
    expense: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn().mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx)),
  };

  vi.doMock('../../src/lib/prisma', () => ({ prisma }));
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

function resultFor(batch: AnyRecord, entryId: string): AnyRecord {
  const results = batch.results as AnyRecord[];
  const found = results.find((r) => r.entryId === entryId);
  expect(found, `expected a per-entry result for ${entryId}`).toBeDefined();
  return found as AnyRecord;
}

beforeEach(() => vi.resetModules());

describe('batchDecideDraftJournalEntries', () => {
  it('approves every eligible DRAFT via the guarded per-entry path (evidence per entry)', async () => {
    const { tx } = setup();
    const { batchDecideDraftJournalEntries } = await importActions();

    const batch = await batchDecideDraftJournalEntries(['je-ok-1', 'je-ok-2'], 'APPROVE');

    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.succeeded).toBe(2);
    expect(batch.failed).toBe(0);
    // Each entry got its own status-guarded, org-scoped update…
    expect(tx.journalEntry.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.journalEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'je-ok-1', organizationId: 'org-1', status: 'DRAFT' },
        data: expect.objectContaining({ status: 'POSTED', updatedBy: 'approver-1' }),
      }),
    );
    // …and its own EvidenceLog row naming the session user as checker.
    expect(tx.evidenceLog.create).toHaveBeenCalledTimes(2);
    expect(tx.evidenceLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'JOURNAL_DRAFT_APPROVED',
          tenantId: 'org-1',
          checkerIdentity: 'approver-1',
        }),
      }),
    );
  });

  it('excludes the caller\'s own drafts per entry — never silently approves them (4-eyes)', async () => {
    const { tx } = setup(); // je-self was made by approver-1, the session user
    const { batchDecideDraftJournalEntries } = await importActions();

    const batch = await batchDecideDraftJournalEntries(['je-ok-1', 'je-self'], 'APPROVE');

    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.succeeded).toBe(1);
    expect(batch.failed).toBe(1);
    expect(resultFor(batch, 'je-ok-1').success).toBe(true);
    const self = resultFor(batch, 'je-self');
    expect(self.success).toBe(false);
    expect(String(self.error)).toMatch(/self/i);
    // The self-made entry never reached the write path.
    expect(tx.journalEntry.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.journalEntry.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'je-self' }) }),
    );
    expect(tx.evidenceLog.create).toHaveBeenCalledTimes(1);
  });

  it('filters non-DRAFT entries per entry (DRAFT-only) while the rest proceed', async () => {
    const { tx } = setup();
    const { batchDecideDraftJournalEntries } = await importActions();

    const batch = await batchDecideDraftJournalEntries(['je-posted', 'je-ok-1'], 'APPROVE');

    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.succeeded).toBe(1);
    expect(batch.failed).toBe(1);
    const posted = resultFor(batch, 'je-posted');
    expect(posted.success).toBe(false);
    expect(String(posted.error)).toMatch(/only draft/i);
    expect(resultFor(batch, 'je-ok-1').success).toBe(true);
    expect(tx.journalEntry.updateMany).toHaveBeenCalledTimes(1);
  });

  it('reports partial failures per entry: missing, cross-org and unbalanced entries fail; approval never bypasses ledger validation', async () => {
    const { tx } = setup();
    const { batchDecideDraftJournalEntries } = await importActions();

    const batch = await batchDecideDraftJournalEntries(
      ['je-ok-1', 'je-missing', 'je-other-org', 'je-unbalanced'],
      'APPROVE',
    );

    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.succeeded).toBe(1);
    expect(batch.failed).toBe(3);
    expect(resultFor(batch, 'je-ok-1').success).toBe(true);
    // Missing and cross-org are indistinguishable "not found" (tenant isolation).
    expect(resultFor(batch, 'je-missing').success).toBe(false);
    expect(resultFor(batch, 'je-other-org').success).toBe(false);
    const unbalanced = resultFor(batch, 'je-unbalanced');
    expect(unbalanced.success).toBe(false);
    expect(String(unbalanced.error)).toMatch(/unbalanced/i);
    // Only the eligible entry was written.
    expect(tx.journalEntry.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.evidenceLog.create).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated ids — one decision, one evidence row', async () => {
    const { tx } = setup();
    const { batchDecideDraftJournalEntries } = await importActions();

    const batch = await batchDecideDraftJournalEntries(['je-ok-1', 'je-ok-1'], 'APPROVE');

    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.results).toHaveLength(1);
    expect(batch.succeeded).toBe(1);
    expect(tx.journalEntry.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.evidenceLog.create).toHaveBeenCalledTimes(1);
  });

  it('batch REJECT voids each entry without a fiscal-period lookup', async () => {
    const { prisma, tx } = setup();
    const { batchDecideDraftJournalEntries } = await importActions();

    const batch = await batchDecideDraftJournalEntries(['je-ok-1', 'je-ok-2'], 'REJECT');

    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.succeeded).toBe(2);
    expect(prisma.fiscalPeriod.findFirst).not.toHaveBeenCalled();
    const updateArgs = tx.journalEntry.updateMany.mock.calls[0][0] as AnyRecord;
    expect((updateArgs.data as AnyRecord).status).toBe('VOIDED');
    expect(tx.evidenceLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'JOURNAL_DRAFT_REJECTED' }),
      }),
    );
  });

  it('rejects an empty batch without touching the database', async () => {
    const { prisma } = setup();
    const { batchDecideDraftJournalEntries } = await importActions();

    const batch = await batchDecideDraftJournalEntries([], 'APPROVE');

    expect(batch.ok).toBe(false);
    expect(prisma.journalEntry.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an oversized batch wholesale (bounded work per request)', async () => {
    const { prisma } = setup();
    const { batchDecideDraftJournalEntries } = await importActions();

    const ids = Array.from({ length: 51 }, (_, i) => `je-bulk-${i}`);
    const batch = await batchDecideDraftJournalEntries(ids, 'APPROVE');

    expect(batch.ok).toBe(false);
    expect(prisma.journalEntry.findFirst).not.toHaveBeenCalled();
  });

  it('fails wholesale when unauthenticated, touching nothing', async () => {
    const { prisma } = setup({ unauthenticated: true });
    const { batchDecideDraftJournalEntries } = await importActions();

    const batch = await batchDecideDraftJournalEntries(['je-ok-1'], 'APPROVE');

    expect(batch.ok).toBe(false);
    expect(prisma.journalEntry.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
