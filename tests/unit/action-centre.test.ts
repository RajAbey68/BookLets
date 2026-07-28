/**
 * Action centre — "progress + current actions" panel data layer.
 *
 *  - deriveActionItems & formatRelativeTime (action-centre.ts, pure): the
 *    priority ladder (approvals → staged receipts → parked receipts → recent
 *    activity → all-caught-up), plain-English wording, relative times, and
 *    the overall line cap. Everything is injected (counts, events, now) so
 *    the panel logic is fully unit-tested without a database.
 *  - fetchActionCentre (action-centre.actions.ts, mocked Prisma): org
 *    scoping, reuse of fetchOcrStagingSummary, the bounded evidence query,
 *    and the {unavailable} degradation discriminator (mirrors books.actions).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ACTION_EVENT_TYPES,
  MAX_ACTION_ITEMS,
  deriveActionItems,
  formatRelativeTime,
  type ActionCentreInputs,
} from '../../src/lib/action-centre';

const NOW = new Date('2026-07-30T12:00:00Z');

function makeInputs(overrides: Partial<ActionCentreInputs> = {}): ActionCentreInputs {
  return {
    draftsAwaitingApproval: 0,
    staging: { available: true, importable: 0, parked: [] },
    recentEvents: [],
    now: NOW,
    ...overrides,
  };
}

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
}

// ─── relative time ────────────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  it('reads naturally at each granularity', () => {
    expect(formatRelativeTime(new Date(NOW.getTime() - 30 * 1000), NOW)).toBe('just now');
    expect(formatRelativeTime(new Date(NOW.getTime() - 60 * 1000), NOW)).toBe('1 minute ago');
    expect(formatRelativeTime(new Date(NOW.getTime() - 45 * 60 * 1000), NOW)).toBe(
      '45 minutes ago',
    );
    expect(formatRelativeTime(hoursAgo(1), NOW)).toBe('1 hour ago');
    expect(formatRelativeTime(hoursAgo(2), NOW)).toBe('2 hours ago');
    expect(formatRelativeTime(hoursAgo(26), NOW)).toBe('1 day ago');
    expect(formatRelativeTime(hoursAgo(72), NOW)).toBe('3 days ago');
  });
});

// ─── priority rules ───────────────────────────────────────────────────────────

describe('deriveActionItems — rules', () => {
  it('surfaces drafts awaiting approval as the urgent item, linked to the queue', () => {
    const items = deriveActionItems(makeInputs({ draftsAwaitingApproval: 3 }));
    expect(items[0]).toEqual({
      priority: 'urgent',
      text: '3 entries await your approval',
      href: '/sandbox',
    });
  });

  it('speaks singular for one draft', () => {
    const items = deriveActionItems(makeInputs({ draftsAwaitingApproval: 1 }));
    expect(items[0].text).toBe('1 entry awaits your approval');
  });

  it('surfaces importable staged receipts as attention, linked to the sandbox', () => {
    const items = deriveActionItems(
      makeInputs({ staging: { available: true, importable: 5, parked: [] } }),
    );
    expect(items[0]).toEqual({
      priority: 'attention',
      text: '5 receipts staged, ready to feed into books',
      href: '/sandbox',
    });
    const one = deriveActionItems(
      makeInputs({ staging: { available: true, importable: 1, parked: [] } }),
    );
    expect(one[0].text).toBe('1 receipt staged, ready to feed into books');
  });

  it('summarizes parked receipts with the shared park-reason wording', () => {
    const items = deriveActionItems(
      makeInputs({
        staging: {
          available: true,
          importable: 0,
          parked: [
            { reason: 'NO_DOC_DATE', count: 3 },
            { reason: 'FX_UNSUPPORTED', count: 1 },
          ],
        },
      }),
    );
    expect(items[0]).toEqual({
      priority: 'attention',
      text: '4 receipts parked: 3 no date on receipt, 1 foreign currency (books are LKR-only for now)',
    });
  });

  it('ignores staging counts entirely when the staging summary is unavailable', () => {
    const items = deriveActionItems(
      makeInputs({
        staging: { available: false, importable: 7, parked: [{ reason: 'NO_DOC_DATE', count: 2 }] },
      }),
    );
    expect(items).toEqual([{ priority: 'info', text: 'All caught up — nothing needs you.' }]);
  });

  it('renders recent ingest activity as info lines with relative time', () => {
    const items = deriveActionItems(
      makeInputs({
        recentEvents: [
          {
            eventType: 'ZIP_INGEST_COMPLETED',
            createdAt: hoursAgo(2),
            description: 'Zip ingest',
            payload: { created: 34, deduped: 3 },
          },
        ],
      }),
    );
    expect(items[0]).toEqual({
      priority: 'info',
      text: '2 hours ago: 34 receipts uploaded, 3 duplicates skipped',
    });
  });

  it('renders statement ingest events as bank-transaction lines', () => {
    const items = deriveActionItems(
      makeInputs({
        recentEvents: [
          {
            eventType: 'STATEMENT_INGEST_COMPLETED',
            createdAt: hoursAgo(1),
            description: 'Statement ingest',
            payload: { created: 12, deduped: 1 },
          },
        ],
      }),
    );
    expect(items[0].text).toBe('1 hour ago: 12 bank transactions imported, 1 duplicate skipped');
  });

  it('renders approval decisions in plain English', () => {
    const items = deriveActionItems(
      makeInputs({
        recentEvents: [
          {
            eventType: 'JOURNAL_DRAFT_APPROVED',
            createdAt: hoursAgo(3),
            description: 'x',
            payload: {},
          },
          {
            eventType: 'JOURNAL_DRAFT_REJECTED',
            createdAt: hoursAgo(4),
            description: 'x',
            payload: {},
          },
        ],
      }),
    );
    expect(items[0].text).toBe('3 hours ago: an entry was approved into the books');
    expect(items[1].text).toBe('4 hours ago: a draft entry was rejected');
  });

  it('falls back to the event description when payload counts are missing', () => {
    const items = deriveActionItems(
      makeInputs({
        recentEvents: [
          {
            eventType: 'ZIP_INGEST_COMPLETED',
            createdAt: hoursAgo(1),
            description: 'Zip ingest abc123: 3 draft entries created.',
            payload: null,
          },
        ],
      }),
    );
    expect(items[0].text).toBe('1 hour ago: Zip ingest abc123: 3 draft entries created.');
  });

  it('drops events older than 24 hours', () => {
    const items = deriveActionItems(
      makeInputs({
        recentEvents: [
          {
            eventType: 'ZIP_INGEST_COMPLETED',
            createdAt: hoursAgo(25),
            description: 'old',
            payload: { created: 1, deduped: 0 },
          },
        ],
      }),
    );
    expect(items).toEqual([{ priority: 'info', text: 'All caught up — nothing needs you.' }]);
  });

  it('drops event types outside the action-centre set', () => {
    const items = deriveActionItems(
      makeInputs({
        recentEvents: [
          {
            eventType: 'ZIP_CHAT_INGESTED',
            createdAt: hoursAgo(1),
            description: 'chat evidence',
            payload: {},
          },
        ],
      }),
    );
    expect(items).toEqual([{ priority: 'info', text: 'All caught up — nothing needs you.' }]);
  });
});

// ─── ordering, cap, empty state ──────────────────────────────────────────────

describe('deriveActionItems — ordering and cap', () => {
  it('orders urgent, then attention, then info', () => {
    const items = deriveActionItems(
      makeInputs({
        draftsAwaitingApproval: 2,
        staging: {
          available: true,
          importable: 4,
          parked: [{ reason: 'NO_DOC_DATE', count: 1 }],
        },
        recentEvents: [
          {
            eventType: 'STATEMENT_INGEST_COMPLETED',
            createdAt: hoursAgo(1),
            description: 'x',
            payload: { created: 2, deduped: 0 },
          },
        ],
      }),
    );
    expect(items.map((i) => i.priority)).toEqual(['urgent', 'attention', 'attention', 'info']);
  });

  it(`caps the panel at ${MAX_ACTION_ITEMS} lines, never dropping urgent/attention`, () => {
    const manyEvents = Array.from({ length: 12 }, (_, i) => ({
      eventType: 'ZIP_INGEST_COMPLETED',
      createdAt: hoursAgo(1),
      description: `event ${i}`,
      payload: { created: i, deduped: 0 },
    }));
    const items = deriveActionItems(
      makeInputs({ draftsAwaitingApproval: 1, recentEvents: manyEvents }),
    );
    expect(items).toHaveLength(MAX_ACTION_ITEMS);
    expect(items[0].priority).toBe('urgent');
  });

  it('shows the single calm line when nothing is pending and nothing happened', () => {
    expect(deriveActionItems(makeInputs())).toEqual([
      { priority: 'info', text: 'All caught up — nothing needs you.' },
    ]);
  });

  it('does not show the all-caught-up line alongside real items', () => {
    const items = deriveActionItems(makeInputs({ draftsAwaitingApproval: 1 }));
    expect(items.some((i) => i.text.includes('All caught up'))).toBe(false);
  });
});

// ─── fetchActionCentre (action-centre.actions.ts) — mocked deps ──────────────

const ORG = 'org-1';

interface SetupOverrides {
  unauthenticated?: boolean;
  dbError?: boolean;
  draftCount?: number;
}

function setup(overrides: SetupOverrides = {}) {
  const prisma = {
    journalEntry: {
      count: overrides.dbError
        ? vi.fn().mockRejectedValue(new Error('db down'))
        : vi.fn().mockResolvedValue(overrides.draftCount ?? 0),
    },
    evidenceLog: {
      findMany: vi.fn().mockResolvedValue([
        {
          eventType: 'ZIP_INGEST_COMPLETED',
          createdAt: new Date(),
          description: 'Zip ingest',
          payload: { created: 3, deduped: 1 },
        },
      ]),
    },
  };
  const fetchOcrStagingSummary = vi.fn().mockResolvedValue({
    available: true,
    importable: 2,
    parked: [],
    alreadyImported: 0,
    total: 2,
  });
  vi.doMock('../../src/lib/prisma', () => ({ prisma, setRlsOrgContext: vi.fn() }));
  vi.doMock('../../src/app/actions/sandbox.actions', () => ({ fetchOcrStagingSummary }));
  vi.doMock('../../src/lib/auth-context', () => ({
    resolveActiveContext: vi.fn().mockResolvedValue(
      overrides.unauthenticated
        ? { ok: false, error: 'Not authenticated. Sign in to continue.' }
        : {
            ok: true,
            context: { organizationId: ORG, organizationName: 'Test Org', userId: 'u-1', role: 'OWNER' },
          },
    ),
  }));
  return { prisma, fetchOcrStagingSummary };
}

async function importAction() {
  return import('../../src/app/actions/action-centre.actions');
}

beforeEach(() => vi.resetModules());

describe('fetchActionCentre', () => {
  it('gathers org-scoped inputs: DRAFT count, staging summary, bounded evidence slice', async () => {
    const { prisma, fetchOcrStagingSummary } = setup({ draftCount: 2 });
    const { fetchActionCentre } = await importAction();

    const result = await fetchActionCentre();

    expect(prisma.journalEntry.count).toHaveBeenCalledWith({
      where: { organizationId: ORG, status: 'DRAFT' },
    });
    expect(fetchOcrStagingSummary).toHaveBeenCalledTimes(1);
    expect(prisma.evidenceLog.findMany).toHaveBeenCalledWith({
      where: { tenantId: ORG, eventType: { in: [...ACTION_EVENT_TYPES] } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { eventType: true, createdAt: true, description: true, payload: true },
    });
    expect(result.unavailable).toBe(false);
    expect(result.items[0]).toEqual({
      priority: 'urgent',
      text: '2 entries await your approval',
      href: '/sandbox',
    });
  });

  it('degrades to {unavailable: true} instead of throwing when a lookup fails', async () => {
    setup({ dbError: true });
    const { fetchActionCentre } = await importAction();

    await expect(fetchActionCentre()).resolves.toEqual({ unavailable: true, items: [] });
  });

  it('degrades to {unavailable: true} when unauthenticated, touching nothing', async () => {
    const { prisma } = setup({ unauthenticated: true });
    const { fetchActionCentre } = await importAction();

    await expect(fetchActionCentre()).resolves.toEqual({ unavailable: true, items: [] });
    expect(prisma.journalEntry.count).not.toHaveBeenCalled();
  });
});
