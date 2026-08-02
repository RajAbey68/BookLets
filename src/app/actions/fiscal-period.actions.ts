'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { prisma, setRlsOrgContext } from '@/lib/prisma';
import { resolveActiveContext } from '@/lib/auth-context';
import { EvidenceLogService } from '@/lib/evidence-log.service';
import {
  FISCAL_PERIOD_CLOSED_EVENT,
  FISCAL_PERIOD_OPENED_EVENT,
  FISCAL_PERIOD_PAGE_PATH,
  formatPeriodSpan,
  hasOpenPeriodCovering,
  isPeriodOpen,
  suggestCurrentYearPeriod,
  validateNewPeriod,
  type NewPeriodInput,
  type PeriodWindow,
} from '@/lib/fiscal-period';

/**
 * Accounting periods — the only way the running application can open or close
 * one.
 *
 * WHY THIS FILE EXISTS
 * LedgerService.checkFiscalPeriod refuses to post any entry whose date is not
 * inside an OPEN FiscalPeriod. The only code that ever created one was
 * prisma/seed.ts, which also seeds demo properties and must never be run
 * against production (AGENTS.md). A freshly deployed organisation — which is
 * exactly what production is — therefore could not import a single receipt:
 * every one failed with "No fiscal period defined for the date 7/12/2026".
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 * There is no auto-creation. A period is opened by a named human, on the
 * record, because a period is the control that lets a stretch of the books be
 * closed and locked; software that opens periods whenever a posting needs one
 * has no such control at all — it just has a date column.
 *
 * There is also NO REOPEN. Nothing in this module can set isClosed back to
 * false or clear `locked`, and createFiscalPeriodAction refuses to create a
 * period that overlaps an existing one (closed periods included), so a closed
 * period cannot be resurrected by laying a fresh one on top of it either.
 * Reopening a closed year is a decision with consequences an accountant should
 * make deliberately in the database, not a button in an importer.
 *
 * Everything is org-scoped from resolveActiveContext — never from client
 * input — and every mutation writes a hash-chained evidence row.
 */

/**
 * Roles that may open or close a period.
 *
 * Wider than the OWNER/ADMIN gate on the import routes by exactly one role:
 * ACCOUNTANT, because closing a period is an accountant's job. BOOKKEEPER and
 * VIEWER may see periods but not change the boundaries of the books.
 * (`role` is a plain string in schema.prisma; the documented values are
 * OWNER | BOOKKEEPER | ACCOUNTANT | VIEWER, and ADMIN is honoured should it
 * ever be introduced.)
 */
const MANAGE_PERIOD_ROLES = new Set(['OWNER', 'ADMIN', 'ACCOUNTANT']);

export type FiscalPeriodStatus = 'OPEN' | 'CLOSED' | 'LOCKED';

/** One period as the page renders it — no Decimals, no raw Prisma types. */
export interface FiscalPeriodRow {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  /** "1 January 2026 – 31 December 2026". */
  span: string;
  status: FiscalPeriodStatus;
  closedAt: Date | null;
}

export interface FiscalPeriodsView {
  periods: FiscalPeriodRow[];
  /**
   * True when an OPEN period covers today — i.e. a receipt dated today could
   * actually be recorded. This is the single fact that decides whether an
   * import can run at all, so it is computed here rather than re-derived by
   * every caller.
   */
  coversToday: boolean;
  /** Pre-fill for the create form: the calendar year the operator is in. */
  suggestion: NewPeriodInput;
  /** True when this member's role may open or close periods. */
  canManage: boolean;
  /**
   * True only when the periods could NOT be read (unauthenticated, or the
   * query failed). Distinguishes an outage from an organisation that genuinely
   * has no periods yet — the page must never render a database failure as
   * "you have no periods", which would invite the operator to create one that
   * already exists. Mirrors fetchBooksView's discriminator.
   */
  unavailable: boolean;
}

export type FiscalPeriodMutationResult =
  | { success: true; message: string }
  | { success: false; error: string };

/** Thrown inside the transaction to abort it with an operator-facing reason. */
class PeriodRuleError extends Error {}

/**
 * A stable signed 64-bit key for pg_advisory_xact_lock, derived here in JS
 * rather than with Postgres' `hashtext()` — that function is undocumented, and
 * this lock is the only thing preventing two simultaneous creates from
 * producing overlapping periods, so it must not rest on an internal.
 *
 * The top 8 bytes of a sha256 read as big-endian signed give exactly the
 * bigint range the lock function takes, and the same organisation always maps
 * to the same key.
 */
function advisoryLockKey(organizationId: string): string {
  return createHash('sha256')
    .update(`fiscal-period:${organizationId}`)
    .digest()
    .readBigInt64BE(0)
    .toString();
}

function toRow(period: PeriodWindow & { id?: string; closedAt?: Date | null }): FiscalPeriodRow {
  return {
    id: period.id ?? '',
    name: period.name,
    startDate: period.startDate,
    endDate: period.endDate,
    span: formatPeriodSpan(period),
    status: period.locked ? 'LOCKED' : period.isClosed ? 'CLOSED' : 'OPEN',
    closedAt: period.closedAt ?? null,
  };
}

function unavailableView(now: Date): FiscalPeriodsView {
  return {
    periods: [],
    coversToday: false,
    suggestion: suggestCurrentYearPeriod(now),
    canManage: false,
    unavailable: true,
  };
}

/**
 * Every period of the caller's organisation, oldest first, plus the two facts
 * the page leads with: whether anything can be posted today, and what to
 * suggest if not.
 *
 * `now` is injectable purely so the suggestion and the coverage flag are
 * testable without a clock; production never passes it.
 */
export async function fetchFiscalPeriods(now: Date = new Date()): Promise<FiscalPeriodsView> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return unavailableView(now);

  const { organizationId, role } = resolved.context;

  try {
    const periods = await prisma.fiscalPeriod.findMany({
      where: { organizationId },
      orderBy: [{ startDate: 'asc' }],
    });

    return {
      periods: periods.map(toRow),
      coversToday: hasOpenPeriodCovering(periods, now),
      suggestion: suggestCurrentYearPeriod(now),
      canManage: MANAGE_PERIOD_ROLES.has(role),
      unavailable: false,
    };
  } catch (error) {
    console.error('[fiscal-period.actions] fetchFiscalPeriods failed:', error);
    return unavailableView(now);
  }
}

/**
 * Open a new accounting period.
 *
 * The shape is validated first (cheap, no IO), then the whole write runs in
 * ONE transaction that:
 *   1. takes a per-organisation advisory lock, so two operators clicking at
 *      once cannot each read "no overlap" and both insert. There is no DB
 *      exclusion constraint on the table (that would need btree_gist and a
 *      migration production has not had), so this lock IS the guarantee;
 *   2. re-reads every existing period — closed and locked ones included — and
 *      re-runs the overlap rule against them;
 *   3. inserts, and records the evidence row in the same transaction so the
 *      period cannot exist without its audit entry.
 *
 * `organizationId` and `createdBy` come from the session. Nothing about the
 * caller's organisation is taken from the argument.
 */
export async function createFiscalPeriodAction(
  input: NewPeriodInput,
): Promise<FiscalPeriodMutationResult> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { success: false, error: resolved.error };

  const { organizationId, userId, role } = resolved.context;
  if (!MANAGE_PERIOD_ROLES.has(role)) {
    return {
      success: false,
      error: 'Your role cannot open or close accounting periods. Ask an owner or your accountant.',
    };
  }

  // Shape check before any database work, so a typo costs nothing.
  const preflight = validateNewPeriod(input, []);
  if (!preflight.ok) return { success: false, error: preflight.error };

  try {
    const created = await prisma.$transaction(async (tx) => {
      await setRlsOrgContext(tx, organizationId);
      // Serialises concurrent creates for THIS organisation only. hashtext()
      // maps the key to the bigint pg_advisory_xact_lock wants; the lock is
      // released at COMMIT/ROLLBACK, so it cannot outlive the request.
      // The cast is explicit: the parameter reaches Postgres untyped and
      // pg_advisory_xact_lock is overloaded (bigint / int,int), so leaving the
      // choice to inference is how this becomes a runtime "could not determine
      // data type" on the one path that must not fail.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${advisoryLockKey(organizationId)}::bigint)`;

      const existing = await tx.fiscalPeriod.findMany({ where: { organizationId } });
      const validated = validateNewPeriod(input, existing);
      if (!validated.ok) throw new PeriodRuleError(validated.error);

      const period = await tx.fiscalPeriod.create({
        data: {
          organizationId,
          name: validated.value.name,
          startDate: validated.value.startDate,
          endDate: validated.value.endDate,
          isClosed: false,
          locked: false,
          createdBy: userId,
        },
      });

      await EvidenceLogService.record(tx, {
        eventType: FISCAL_PERIOD_OPENED_EVENT,
        tenantId: organizationId,
        makerIdentity: userId,
        description: `Accounting period "${period.name}" opened (${formatPeriodSpan(period)}).`,
        payload: {
          fiscalPeriodId: period.id,
          name: period.name,
          startDate: period.startDate.toISOString(),
          endDate: period.endDate.toISOString(),
        },
      });

      return period;
    });

    revalidatePath(FISCAL_PERIOD_PAGE_PATH);
    revalidatePath('/sandbox');
    revalidatePath('/books');
    revalidatePath('/');

    return {
      success: true,
      message: `"${created.name}" is open (${formatPeriodSpan(created)}). Receipts dated inside it can now be imported.`,
    };
  } catch (error) {
    if (error instanceof PeriodRuleError) {
      return { success: false, error: error.message };
    }
    console.error('[fiscal-period.actions] createFiscalPeriodAction failed:', error);
    return {
      success: false,
      error: 'The period could not be saved just now. Nothing was changed — try again in a moment.',
    };
  }
}

/**
 * Close a period: no further entry may be dated inside it, ever.
 *
 * This is the control the whole model exists for, so it is deliberately
 * one-way. There is no matching reopen action, and createFiscalPeriodAction
 * will not create a period overlapping this one afterwards.
 *
 * The period is looked up scoped to the session organisation, so an id
 * belonging to another tenant is simply "not found" — it is never confirmed to
 * exist.
 */
export async function closeFiscalPeriodAction(input: {
  id: string;
}): Promise<FiscalPeriodMutationResult> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { success: false, error: resolved.error };

  const { organizationId, userId, role } = resolved.context;
  if (!MANAGE_PERIOD_ROLES.has(role)) {
    return {
      success: false,
      error: 'Your role cannot open or close accounting periods. Ask an owner or your accountant.',
    };
  }

  const id = typeof input?.id === 'string' ? input.id.trim() : '';
  if (id.length === 0) {
    return { success: false, error: 'No period was selected.' };
  }

  try {
    const closed = await prisma.$transaction(async (tx) => {
      await setRlsOrgContext(tx, organizationId);

      const period = await tx.fiscalPeriod.findFirst({ where: { id, organizationId } });
      if (!period) {
        throw new PeriodRuleError('That accounting period was not found in your books.');
      }
      if (!isPeriodOpen(period)) {
        throw new PeriodRuleError(
          `"${period.name}" is already ${period.locked ? 'locked' : 'closed'}, so nothing changed.`,
        );
      }

      const updated = await tx.fiscalPeriod.update({
        where: { id: period.id },
        data: { isClosed: true, closedAt: new Date() },
      });

      await EvidenceLogService.record(tx, {
        eventType: FISCAL_PERIOD_CLOSED_EVENT,
        tenantId: organizationId,
        makerIdentity: userId,
        description: `Accounting period "${period.name}" closed (${formatPeriodSpan(period)}). No further entries may be dated inside it.`,
        payload: {
          fiscalPeriodId: period.id,
          name: period.name,
          startDate: period.startDate.toISOString(),
          endDate: period.endDate.toISOString(),
        },
      });

      return updated;
    });

    revalidatePath(FISCAL_PERIOD_PAGE_PATH);
    revalidatePath('/sandbox');
    revalidatePath('/books');
    revalidatePath('/');

    return {
      success: true,
      message: `"${closed.name}" is closed. Its figures are now fixed — nothing new can be dated inside it.`,
    };
  } catch (error) {
    if (error instanceof PeriodRuleError) {
      return { success: false, error: error.message };
    }
    console.error('[fiscal-period.actions] closeFiscalPeriodAction failed:', error);
    return {
      success: false,
      error: 'The period could not be closed just now. Nothing was changed — try again in a moment.',
    };
  }
}
