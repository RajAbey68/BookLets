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
 *
 * The load-bearing distinction pinned here: the panel degrades when a data
 * source BREAKS (any of the three, plus a rejecting session lookup), but NOT
 * when the OCR staging pile merely does not apply to this deployment — which
 * is the everyday state, since OCR_BRIDGE_ORG_ID is unset. Getting that
 * backwards is either a hidden outage or a permanent false alarm, and both
 * end the same way: Raj stops trusting the panel.
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
    // Default: the books are open. The blocker line has its own cases below.
    hasOpenPeriodForToday: true,
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

describe('deriveActionItems — the no-open-period blocker', () => {
  it('leads with it: nothing else on the panel can happen until it is fixed', () => {
    const items = deriveActionItems(
      makeInputs({ hasOpenPeriodForToday: false, draftsAwaitingApproval: 3 }),
    );
    expect(items[0].priority).toBe('urgent');
    expect(items[0].text).toMatch(/accounting period/i);
    expect(items[0].href).toBe('/periods');
    // Approvals still appear — they are just no longer the first thing.
    expect(items[1].text).toBe('3 entries await your approval');
  });

  it('explains the consequence in the operator\'s own terms, not the ledger\'s', () => {
    const [item] = deriveActionItems(makeInputs({ hasOpenPeriodForToday: false }));
    expect(item.text).toMatch(/receipt/i);
    expect(item.text).not.toMatch(/fiscal|checkFiscalPeriod|DRAFT/i);
  });

  it('says nothing at all when a period is open — no permanent nagging', () => {
    const items = deriveActionItems(makeInputs({ hasOpenPeriodForToday: true }));
    expect(items).toEqual([{ priority: 'info', text: 'All caught up — nothing needs you.' }]);
  });
});

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

  it('renders action-intent decisions in plain English', () => {
    const items = deriveActionItems(
      makeInputs({
        recentEvents: [
          {
            eventType: 'ACTION_INTENT_APPROVED',
            createdAt: hoursAgo(2),
            description: 'raw evidence description',
            payload: {},
          },
          {
            eventType: 'ACTION_INTENT_REJECTED',
            createdAt: hoursAgo(5),
            description: 'raw evidence description',
            payload: {},
          },
        ],
      }),
    );
    expect(items[0].text).toBe('2 hours ago: an action was approved');
    expect(items[1].text).toBe('5 hours ago: an action was rejected');
  });

  it('gives every narrated event type its own wording, never the raw evidence row', () => {
    // Guards the ACTION_EVENT_TYPES ↔ describeEvent pairing: adding a type to
    // the query filter without wording would leak a raw DB description at Raj.
    for (const eventType of ACTION_EVENT_TYPES) {
      const [item] = deriveActionItems(
        makeInputs({
          recentEvents: [
            {
              eventType,
              createdAt: hoursAgo(1),
              description: 'RAW_DB_DESCRIPTION',
              // Ingest types read counts from the payload; decision types ignore it.
              payload: { created: 2, deduped: 0 },
            },
          ],
        }),
      );
      expect(item.priority).toBe('info');
      expect(item.text).not.toContain('RAW_DB_DESCRIPTION');
    }
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

/**
 * The staging-summary shapes fetchOcrStagingSummary can hand back. The
 * `unavailableReason` discriminator is the whole point: three of these are
 * "this feature does not apply to you" (the normal production state, because
 * OCR_BRIDGE_ORG_ID is unset) and only 'query_failed' is a genuine outage.
 */
const STAGING_OK = {
  available: true,
  unavailableReason: null,
  importable: 2,
  parked: [],
  alreadyImported: 0,
  total: 2,
};

function stagingUnavailable(reason: string) {
  return {
    available: false,
    unavailableReason: reason,
    importable: 0,
    parked: [],
    alreadyImported: 0,
    total: 0,
  };
}

const EVIDENCE_ROW = {
  eventType: 'ZIP_INGEST_COMPLETED',
  createdAt: new Date(),
  description: 'Zip ingest',
  payload: { created: 3, deduped: 1 },
};

interface SetupOverrides {
  unauthenticated?: boolean;
  /** resolveActiveContext REJECTS rather than returning {ok:false}. */
  authRejects?: boolean;
  organizationId?: string;
  draftCount?: number;
  /** prisma.journalEntry.count rejects. */
  draftCountFails?: boolean;
  /** prisma.evidenceLog.findMany rejects. */
  evidenceFails?: boolean;
  /** fetchOcrStagingSummary itself rejects (rather than degrading politely). */
  stagingRejects?: boolean;
  /** No OPEN FiscalPeriod covers today — the production blocker state. */
  noOpenPeriod?: boolean;
  /** prisma.fiscalPeriod.findFirst rejects. */
  periodLookupFails?: boolean;
  /** The summary fetchOcrStagingSummary resolves with. */
  staging?: ReturnType<typeof stagingUnavailable> | typeof STAGING_OK;
}

function setup(overrides: SetupOverrides = {}) {
  const orgId = overrides.organizationId ?? ORG;
  const prisma = {
    journalEntry: {
      count: overrides.draftCountFails
        ? vi.fn().mockRejectedValue(new Error('db down'))
        : vi.fn().mockResolvedValue(overrides.draftCount ?? 0),
    },
    evidenceLog: {
      findMany: overrides.evidenceFails
        ? vi.fn().mockRejectedValue(new Error('evidence log unreadable'))
        : vi.fn().mockResolvedValue([EVIDENCE_ROW]),
    },
    fiscalPeriod: {
      findFirst: overrides.periodLookupFails
        ? vi.fn().mockRejectedValue(new Error('db down'))
        : vi.fn().mockResolvedValue(overrides.noOpenPeriod ? null : { id: 'fp-1' }),
    },
  };
  const setRlsOrgContext = vi.fn().mockResolvedValue(undefined);
  const fetchOcrStagingSummary = overrides.stagingRejects
    ? vi.fn().mockRejectedValue(new Error('staging summary blew up'))
    : vi.fn().mockResolvedValue(overrides.staging ?? STAGING_OK);
  const resolveActiveContext = overrides.authRejects
    ? vi.fn().mockRejectedValue(new Error('session store unreachable'))
    : vi.fn().mockResolvedValue(
        overrides.unauthenticated
          ? { ok: false, error: 'Not authenticated. Sign in to continue.' }
          : {
              ok: true,
              context: {
                organizationId: orgId,
                organizationName: 'Test Org',
                userId: 'u-1',
                role: 'OWNER',
              },
            },
      );
  vi.doMock('../../src/lib/prisma', () => ({ prisma, setRlsOrgContext }));
  vi.doMock('../../src/app/actions/sandbox.actions', () => ({ fetchOcrStagingSummary }));
  vi.doMock('../../src/lib/auth-context', () => ({ resolveActiveContext }));
  return { prisma, fetchOcrStagingSummary, setRlsOrgContext, orgId };
}

async function importAction() {
  return import('../../src/app/actions/action-centre.actions');
}

const DEGRADED = { unavailable: true, items: [] };

beforeEach(() => vi.resetModules());

describe('fetchActionCentre — the fiscal-period blocker', () => {
  it('asks whether an OPEN period covers today, scoped to the session org', async () => {
    const { prisma } = setup({ noOpenPeriod: true });
    const { fetchActionCentre } = await importAction();

    const result = await fetchActionCentre();

    expect(prisma.fiscalPeriod.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG,
          isClosed: false,
          locked: false,
        }),
      }),
    );
    expect(result.items[0].href).toBe('/periods');
  });

  it('degrades the panel rather than claiming the books are shut when the lookup fails', async () => {
    setup({ periodLookupFails: true });
    const { fetchActionCentre } = await importAction();

    expect(await fetchActionCentre()).toEqual(DEGRADED);
  });
});

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

  it('scopes EVERY tenant query to the org resolved from the session, not a constant', async () => {
    const { prisma } = setup({ organizationId: 'org-other', draftCount: 1 });
    const { fetchActionCentre } = await importAction();

    await fetchActionCentre();

    expect(prisma.journalEntry.count).toHaveBeenCalledWith({
      where: { organizationId: 'org-other', status: 'DRAFT' },
    });
    expect(prisma.evidenceLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 'org-other' }) }),
    );
    // Nothing is queried without an org predicate.
    for (const call of [
      ...prisma.journalEntry.count.mock.calls,
      ...prisma.evidenceLog.findMany.mock.calls,
    ]) {
      const where = (call[0] as { where?: Record<string, unknown> })?.where ?? {};
      expect(where.organizationId ?? where.tenantId).toBe('org-other');
    }
  });

  it('opens no interactive transaction, so it never has to inject the RLS GUC itself', async () => {
    // setRlsOrgContext exists for prisma.$transaction(async (tx) => ...) openers
    // (see src/lib/prisma.ts). This action issues plain model reads, which the
    // rls-org-context extension wraps on its own; calling setRlsOrgContext here
    // would be impossible (no tx client) and pinning zero calls documents that.
    const { setRlsOrgContext } = setup();
    const { fetchActionCentre } = await importAction();

    await fetchActionCentre();

    expect(setRlsOrgContext).not.toHaveBeenCalled();
  });

  // ── degradation: each data source must be able to fail the panel loudly ──

  it('degrades to {unavailable: true} when the DRAFT count query fails', async () => {
    setup({ draftCountFails: true });
    const { fetchActionCentre } = await importAction();

    await expect(fetchActionCentre()).resolves.toEqual(DEGRADED);
  });

  it('degrades to {unavailable: true} when the evidence-log query fails', async () => {
    setup({ evidenceFails: true });
    const { fetchActionCentre } = await importAction();

    await expect(fetchActionCentre()).resolves.toEqual(DEGRADED);
  });

  it('degrades to {unavailable: true} when the staging summary throws', async () => {
    setup({ stagingRejects: true });
    const { fetchActionCentre } = await importAction();

    await expect(fetchActionCentre()).resolves.toEqual(DEGRADED);
  });

  it('degrades to {unavailable: true} when unauthenticated, touching NO data source', async () => {
    const { prisma, fetchOcrStagingSummary } = setup({ unauthenticated: true });
    const { fetchActionCentre } = await importAction();

    await expect(fetchActionCentre()).resolves.toEqual(DEGRADED);
    expect(prisma.journalEntry.count).not.toHaveBeenCalled();
    expect(prisma.evidenceLog.findMany).not.toHaveBeenCalled();
    expect(fetchOcrStagingSummary).not.toHaveBeenCalled();
  });

  it('degrades instead of throwing when resolving the session REJECTS', async () => {
    // resolveActiveContext is documented to return {ok:false}, but it also does
    // IO — if it rejects, the page it renders on must degrade, not 500.
    setup({ authRejects: true });
    const { fetchActionCentre } = await importAction();

    await expect(fetchActionCentre()).resolves.toEqual(DEGRADED);
  });

  // ── the distinction this change exists for ──────────────────────────────

  it('degrades ONLY when the staging summary reports a genuine query failure', async () => {
    setup({ draftCount: 4, staging: stagingUnavailable('query_failed') });
    const { fetchActionCentre } = await importAction();

    await expect(fetchActionCentre()).resolves.toEqual(DEGRADED);
  });

  it('treats a malformed unavailable summary (no reason) as an outage, never as calm', async () => {
    setup({ draftCount: 4, staging: stagingUnavailable(null as unknown as string) });
    const { fetchActionCentre } = await importAction();

    await expect(fetchActionCentre()).resolves.toEqual(DEGRADED);
  });

  it.each(['not_configured', 'unauthenticated', 'org_mismatch'])(
    'carries on normally when staging is simply not applicable (%s)',
    async (reason) => {
      // OCR_BRIDGE_ORG_ID is unset in this deployment, so this is the EVERYDAY
      // state. A permanent "status unavailable" warning here would be a standing
      // false alarm and would train Raj to ignore the panel.
      setup({ draftCount: 4, staging: stagingUnavailable(reason) });
      const { fetchActionCentre } = await importAction();

      const result = await fetchActionCentre();

      expect(result.unavailable).toBe(false);
      expect(result.items[0]).toEqual({
        priority: 'urgent',
        text: '4 entries await your approval',
        href: '/sandbox',
      });
      // Recent activity still narrated; no staged/parked lines invented from zeros.
      expect(result.items.some((i) => i.priority === 'info')).toBe(true);
      expect(result.items.some((i) => i.text.includes('staged'))).toBe(false);
      expect(result.items.some((i) => i.text.includes('All caught up'))).toBe(false);
    },
  );

  it('still narrates activity when staging is not applicable and nothing awaits approval', async () => {
    setup({ draftCount: 0, staging: stagingUnavailable('not_configured') });
    const { fetchActionCentre } = await importAction();

    const result = await fetchActionCentre();

    expect(result.unavailable).toBe(false);
    expect(result.items).toEqual([
      { priority: 'info', text: 'just now: 3 receipts uploaded, 1 duplicate skipped' },
    ]);
  });
});
