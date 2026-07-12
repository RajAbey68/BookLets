/**
 * S6 review-ui — /review page plumbing over the existing 4-eyes actions.
 *
 * The heavy invariants (self-approval, org scoping, DRAFT-only state machine,
 * batch partial-failure isolation) are covered by approval-actions.test.ts and
 * batch-approval-actions.test.ts. This file covers what the dedicated /review
 * page adds on top (mocked Prisma, same style):
 *
 *  - fetchDraftReviewCount: the sidebar badge number is org-scoped and
 *    DRAFT-only, and degrades to 0 (never throws) when unauthenticated or the
 *    DB is unavailable — a badge must not take down the app shell;
 *  - fetchDraftReviewQueue: bounded (take: 100) and deterministically newest
 *    first (date desc, then createdAt desc for same-day entries);
 *  - decisions revalidate /review so the queue AND the badge refresh.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const draftEntry = {
  id: 'je-1',
  organizationId: 'org-1',
  status: 'DRAFT',
  date: new Date('2026-06-15T00:00:00Z'),
  memo: 'AUTOMATED: Receipt for Colombo Hardware',
  makerIdentity: 'booklets-automation-service',
  createdBy: null,
  version: 1,
  lines: [
    { accountId: 'acc-1', amount: '150.00', isDebit: true, account: { name: 'Repairs', code: '6100' } },
    { accountId: 'acc-2', amount: '150.00', isDebit: false, account: { name: 'Cash', code: '1000' } },
  ],
  source: 'receipt',
  sourceId: 'rcpt-1',
  agentConfidence: 0.82,
};

interface SetupOverrides {
  userId?: string;
  unauthenticated?: boolean;
  countError?: boolean;
}

function setup(overrides: SetupOverrides = {}) {
  const revalidatePath = vi.fn();
  const tx = {
    journalEntry: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    evidenceLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'ev-1', hash: 'h1', previousHash: null }),
    },
  };
  const prisma = {
    journalEntry: {
      findFirst: vi.fn().mockResolvedValue(draftEntry),
      findMany: vi.fn().mockResolvedValue([draftEntry]),
      count: overrides.countError
        ? vi.fn().mockRejectedValue(new Error('db down'))
        : vi.fn().mockResolvedValue(7),
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
              role: 'OWNER',
            },
          },
    ),
  }));
  vi.doMock('next/cache', () => ({ revalidatePath }));

  return { prisma, tx, revalidatePath };
}

async function importActions() {
  return import('../../src/app/actions/approval.actions');
}

beforeEach(() => vi.resetModules());

// ─── fetchDraftReviewCount (sidebar badge) ───────────────────────────────────

describe('fetchDraftReviewCount', () => {
  it('counts only DRAFT entries in the caller organisation', async () => {
    const { prisma } = setup();
    const { fetchDraftReviewCount } = await importActions();

    const count = await fetchDraftReviewCount();

    expect(count).toBe(7);
    expect(prisma.journalEntry.count).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', status: 'DRAFT' },
    });
  });

  it('returns 0 when unauthenticated, touching nothing', async () => {
    const { prisma } = setup({ unauthenticated: true });
    const { fetchDraftReviewCount } = await importActions();

    const count = await fetchDraftReviewCount();

    expect(count).toBe(0);
    expect(prisma.journalEntry.count).not.toHaveBeenCalled();
  });

  it('degrades to 0 instead of throwing when the count query fails (badge must not break the shell)', async () => {
    setup({ countError: true });
    const { fetchDraftReviewCount } = await importActions();

    await expect(fetchDraftReviewCount()).resolves.toBe(0);
  });
});

// ─── fetchDraftReviewQueue bounds & ordering ─────────────────────────────────

describe('fetchDraftReviewQueue (review page bounds)', () => {
  it('applies the caller-provided cap and deterministic newest-first ordering', async () => {
    const { prisma } = setup();
    const { fetchDraftReviewQueue } = await importActions();

    await fetchDraftReviewQueue({ limit: 100 });

    expect(prisma.journalEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1', status: 'DRAFT' },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      }),
    );
  });

  it('applies NO cap when called without options — /approvals keeps the full draft set', async () => {
    const { prisma } = setup();
    const { fetchDraftReviewQueue } = await importActions();

    await fetchDraftReviewQueue();

    const args = (prisma.journalEntry.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args).not.toHaveProperty('take');
    expect(args.orderBy).toEqual([{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]);
  });
});

// ─── decisions refresh /review ───────────────────────────────────────────────

describe('decision revalidation', () => {
  it('decideDraftJournalEntry revalidates /review so the queue and badge refresh', async () => {
    const { revalidatePath } = setup();
    const { decideDraftJournalEntry } = await importActions();

    const result = await decideDraftJournalEntry('je-1', 'APPROVE');

    expect(result.success).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith('/review');
  });
});
