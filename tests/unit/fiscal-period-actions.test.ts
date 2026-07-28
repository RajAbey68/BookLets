/**
 * Fiscal-period server actions — the only way the running application can
 * create or close an accounting period.
 *
 * What is pinned here is the accounting control, not the CRUD:
 *   - the organisation always comes from the session (resolveActiveContext),
 *     never from client input;
 *   - only a role that is allowed to manage the books may create or close;
 *   - creation re-validates against the periods that exist INSIDE the same
 *     transaction, behind a per-organisation advisory lock, so two
 *     simultaneous creates cannot produce overlapping periods;
 *   - a closed period is never reopened and never overlaid — there is no
 *     reopen action at all, and a new period may not overlap a closed one;
 *   - every create and close writes a hash-chained evidence row, so opening
 *     the books is on the record like any other financial act.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ORG = 'org-1';
const USER = 'user-1';

const FY2026 = {
  id: 'fp-2026',
  organizationId: ORG,
  name: 'FY 2026',
  startDate: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-12-31T23:59:59.999Z'),
  isClosed: false,
  locked: false,
  closedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  createdBy: USER,
};

interface SetupOverrides {
  unauthenticated?: boolean;
  role?: string;
  existing?: unknown[];
  dbError?: boolean;
  createError?: Error;
}

function setup(overrides: SetupOverrides = {}) {
  const existing = overrides.existing ?? [];
  const evidence = { record: vi.fn().mockResolvedValue(undefined) };

  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    fiscalPeriod: {
      findMany: vi.fn().mockResolvedValue(existing),
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) =>
        (existing as { id: string }[]).find((p) => p.id === where.id) ?? null,
      ),
      create: overrides.createError
        ? vi.fn().mockRejectedValue(overrides.createError)
        : vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
            id: 'fp-new',
            ...data,
          })),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...(existing as { id: string }[]).find((p) => p.id === where.id),
        ...data,
      })),
    },
  };

  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    fiscalPeriod: {
      findMany: overrides.dbError
        ? vi.fn().mockRejectedValue(new Error('db down'))
        : vi.fn().mockResolvedValue(existing),
    },
  };

  vi.doMock('../../src/lib/prisma', () => ({ prisma, setRlsOrgContext: vi.fn() }));
  vi.doMock('../../src/lib/evidence-log.service', () => ({ EvidenceLogService: evidence }));
  vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
  vi.doMock('../../src/lib/auth-context', () => ({
    resolveActiveContext: vi.fn().mockResolvedValue(
      overrides.unauthenticated
        ? { ok: false, error: 'Not authenticated. Sign in to continue.' }
        : {
            ok: true,
            context: {
              organizationId: ORG,
              organizationName: 'Ko Lake',
              userId: USER,
              role: overrides.role ?? 'OWNER',
            },
          },
    ),
  }));

  return { prisma, tx, evidence };
}

async function importActions() {
  return import('../../src/app/actions/fiscal-period.actions');
}

beforeEach(() => vi.resetModules());

// ─── reading ─────────────────────────────────────────────────────────────────

describe('fetchFiscalPeriods', () => {
  it('is org-scoped from the session and reports whether today can be posted into', async () => {
    const { prisma } = setup({ existing: [FY2026] });
    const { fetchFiscalPeriods } = await importActions();

    const view = await fetchFiscalPeriods(new Date('2026-07-12T00:00:00Z'));

    expect(prisma.fiscalPeriod.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG } }),
    );
    expect(view.unavailable).toBe(false);
    expect(view.coversToday).toBe(true);
    expect(view.periods).toHaveLength(1);
    expect(view.periods[0].status).toBe('OPEN');
    expect(view.periods[0].span).toBe('1 January 2026 – 31 December 2026');
  });

  it('reports the blocker state — periods exist but none is open for today', async () => {
    setup({ existing: [{ ...FY2026, isClosed: true, closedAt: new Date() }] });
    const { fetchFiscalPeriods } = await importActions();

    const view = await fetchFiscalPeriods(new Date('2026-07-12T00:00:00Z'));

    expect(view.coversToday).toBe(false);
    expect(view.periods[0].status).toBe('CLOSED');
  });

  it('offers the current calendar year as a one-click suggestion when there is nothing', async () => {
    setup();
    const { fetchFiscalPeriods } = await importActions();

    const view = await fetchFiscalPeriods(new Date('2026-07-12T00:00:00Z'));

    expect(view.periods).toEqual([]);
    expect(view.coversToday).toBe(false);
    expect(view.suggestion).toEqual({
      name: 'FY 2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
  });

  it('degrades to unavailable rather than rendering a DB outage as "no periods"', async () => {
    setup({ dbError: true });
    const { fetchFiscalPeriods } = await importActions();

    const view = await fetchFiscalPeriods(new Date('2026-07-12T00:00:00Z'));

    expect(view.unavailable).toBe(true);
    // An outage must never be reported as "you may post today".
    expect(view.coversToday).toBe(false);
  });

  it('returns unavailable when the caller has no organisation', async () => {
    setup({ unauthenticated: true });
    const { fetchFiscalPeriods } = await importActions();

    expect((await fetchFiscalPeriods(new Date())).unavailable).toBe(true);
  });

  it('tells a read-only member they may not manage periods', async () => {
    setup({ role: 'VIEWER', existing: [FY2026] });
    const { fetchFiscalPeriods } = await importActions();

    expect((await fetchFiscalPeriods(new Date('2026-07-12T00:00:00Z'))).canManage).toBe(false);
  });
});

// ─── creating ────────────────────────────────────────────────────────────────

describe('createFiscalPeriodAction', () => {
  const input = { name: 'FY 2026', startDate: '2026-01-01', endDate: '2026-12-31' };

  it('creates the period against the SESSION organisation and records evidence', async () => {
    const { tx, evidence } = setup();
    const { createFiscalPeriodAction } = await importActions();

    const result = await createFiscalPeriodAction(input);

    expect(result.success).toBe(true);
    expect(tx.fiscalPeriod.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORG,
        name: 'FY 2026',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        endDate: new Date('2026-12-31T23:59:59.999Z'),
        isClosed: false,
        locked: false,
        createdBy: USER,
      }),
    });
    expect(evidence.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventType: 'FISCAL_PERIOD_OPENED',
        tenantId: ORG,
        makerIdentity: USER,
      }),
    );
  });

  it('takes a per-organisation advisory lock before reading the existing periods', async () => {
    const { tx } = setup();
    const { createFiscalPeriodAction } = await importActions();

    await createFiscalPeriodAction(input);

    expect(tx.$executeRaw).toHaveBeenCalled();
    const lockCallOrder = tx.$executeRaw.mock.invocationCallOrder[0];
    const readCallOrder = tx.fiscalPeriod.findMany.mock.invocationCallOrder[0];
    expect(lockCallOrder).toBeLessThan(readCallOrder);
  });

  it('re-checks overlap INSIDE the transaction and refuses, naming the clashing period', async () => {
    const { tx } = setup({ existing: [FY2026] });
    const { createFiscalPeriodAction } = await importActions();

    const result = await createFiscalPeriodAction({
      name: 'July 2026',
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    });

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain('FY 2026');
    expect(tx.fiscalPeriod.create).not.toHaveBeenCalled();
  });

  it('cannot lay a new period over a CLOSED one — closed stays closed', async () => {
    const { tx } = setup({ existing: [{ ...FY2026, isClosed: true, closedAt: new Date() }] });
    const { createFiscalPeriodAction } = await importActions();

    const result = await createFiscalPeriodAction({
      name: 'Reopen 2026',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });

    expect(result.success).toBe(false);
    expect(tx.fiscalPeriod.create).not.toHaveBeenCalled();
  });

  it('rejects invalid input in plain language, without touching the database', async () => {
    const { prisma } = setup();
    const { createFiscalPeriodAction } = await importActions();

    const result = await createFiscalPeriodAction({ ...input, name: '  ' });

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toMatch(/name/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a role that may not manage the books', async () => {
    const { prisma } = setup({ role: 'VIEWER' });
    const { createFiscalPeriodAction } = await importActions();

    const result = await createFiscalPeriodAction(input);

    expect(result.success).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    const { prisma } = setup({ unauthenticated: true });
    const { createFiscalPeriodAction } = await importActions();

    expect((await createFiscalPeriodAction(input)).success).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reports a database failure as a failure, never as a silent success', async () => {
    setup({ createError: new Error('db down') });
    const { createFiscalPeriodAction } = await importActions();

    const result = await createFiscalPeriodAction(input);

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).not.toContain('db down');
  });
});

// ─── closing ─────────────────────────────────────────────────────────────────

describe('closeFiscalPeriodAction', () => {
  it('closes an open period, stamps closedAt and records evidence', async () => {
    const { tx, evidence } = setup({ existing: [FY2026] });
    const { closeFiscalPeriodAction } = await importActions();

    const result = await closeFiscalPeriodAction({ id: 'fp-2026' });

    expect(result.success).toBe(true);
    expect(tx.fiscalPeriod.update).toHaveBeenCalledWith({
      where: { id: 'fp-2026' },
      data: expect.objectContaining({ isClosed: true, closedAt: expect.any(Date) }),
    });
    expect(evidence.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ eventType: 'FISCAL_PERIOD_CLOSED', tenantId: ORG }),
    );
  });

  it('looks the period up scoped to the session organisation', async () => {
    const { tx } = setup({ existing: [FY2026] });
    const { closeFiscalPeriodAction } = await importActions();

    await closeFiscalPeriodAction({ id: 'fp-2026' });

    expect(tx.fiscalPeriod.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'fp-2026', organizationId: ORG } }),
    );
  });

  it('refuses a period belonging to another organisation without saying it exists', async () => {
    const { tx } = setup({ existing: [] });
    const { closeFiscalPeriodAction } = await importActions();

    const result = await closeFiscalPeriodAction({ id: 'fp-someone-else' });

    expect(result.success).toBe(false);
    expect(tx.fiscalPeriod.update).not.toHaveBeenCalled();
  });

  it('is idempotent-safe: closing an already closed period changes nothing', async () => {
    const { tx } = setup({ existing: [{ ...FY2026, isClosed: true, closedAt: new Date() }] });
    const { closeFiscalPeriodAction } = await importActions();

    const result = await closeFiscalPeriodAction({ id: 'fp-2026' });

    expect(result.success).toBe(false);
    expect(tx.fiscalPeriod.update).not.toHaveBeenCalled();
  });

  it('refuses a role that may not manage the books', async () => {
    const { prisma } = setup({ role: 'BOOKKEEPER', existing: [FY2026] });
    const { closeFiscalPeriodAction } = await importActions();

    const result = await closeFiscalPeriodAction({ id: 'fp-2026' });

    expect(result.success).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('the module surface', () => {
  it('exposes no way to reopen a closed period', async () => {
    setup();
    const actions = await importActions();
    const names = Object.keys(actions).join(' ');
    expect(names).not.toMatch(/reopen|unclose|unlock/i);
  });
});
