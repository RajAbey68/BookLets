'use server';

import { Decimal } from 'decimal.js';
import { resolveActiveContext } from '@/lib/auth-context';
import { createManualJournalEntry } from '@/app/actions/ledger.actions';
import { prisma } from '@/lib/prisma';
import { computePLStatement } from '@/lib/pl-statement';
import { parseQuickEntry, type RawQuickEntry } from '@/lib/quick-entry';

/**
 * RAJ-481 — server boundary for the mobile /quick page.
 *
 * Thin IO wrappers only: parseQuickEntry owns validation and the
 * double-entry mapping; createManualJournalEntry (the existing, governed
 * path) owns posting — quick entries get the same idempotency, balance and
 * org-isolation guarantees as the full ledger form. The monthly summary is
 * computed through the P&L authority (journalLine.groupBy + computePLStatement)
 * per calendar month: POSTED-only, reversal-aware (contra activity nets off),
 * and aggregated in the database — no row cap, no double counting.
 */

export interface QuickMonthSummary {
  month: string; // YYYY-MM
  income: string;
  expenses: string;
  net: string;
}

export interface QuickEntryContext {
  properties: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; name: string; type: string }>;
  counts: { propertyCount: number; accountCount: number; entryCount: number };
  months: QuickMonthSummary[];
}

const SUMMARY_MONTHS = 3;

function monthRange(reference: Date, monthsBack: number): { month: string; start: Date; endExclusive: Date } {
  const start = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() - monthsBack, 1));
  const endExclusive = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { month: start.toISOString().slice(0, 7), start, endExclusive };
}

export async function fetchQuickEntryContext(): Promise<QuickEntryContext | null> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return null;
  const { organizationId } = resolved.context;

  try {
    const [properties, accounts, entryCount] = await Promise.all([
      prisma.property.findMany({ where: { organizationId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.account.findMany({ where: { organizationId }, select: { id: true, parentId: true, name: true, code: true, type: true }, orderBy: { name: 'asc' } }),
      prisma.journalEntry.count({ where: { organizationId } }),
    ]);

    const now = new Date();
    const months: QuickMonthSummary[] = [];
    for (let back = 0; back < SUMMARY_MONTHS; back++) {
      const { month, start, endExclusive } = monthRange(now, back);
      const sums = await prisma.journalLine.groupBy({
        by: ['accountId', 'isDebit'],
        where: {
          journalEntry: { organizationId, status: 'POSTED', date: { gte: start, lt: endExclusive } },
        },
        _sum: { amount: true },
      });
      const lines = sums.flatMap(sum =>
        sum._sum.amount === null
          ? []
          : [{ accountId: sum.accountId, amount: sum._sum.amount.toString(), isDebit: sum.isDebit }],
      );
      if (lines.length === 0) continue;
      const statement = computePLStatement(accounts, lines);
      months.push({
        month,
        income: statement.revenue.total.toString(),
        expenses: statement.expenses.total.toString(),
        net: statement.netProfit.toString(),
      });
    }

    return {
      properties,
      accounts: accounts.map(({ id, name, type }) => ({ id, name, type })),
      counts: { propertyCount: properties.length, accountCount: accounts.length, entryCount },
      months,
    };
  } catch (error) {
    console.error('[quick-entry.actions] fetchQuickEntryContext: DB unreachable:', error);
    return null;
  }
}

export async function submitQuickEntry(
  raw: RawQuickEntry,
): Promise<{ success: true; entryId: string } | { success: false; error: string }> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { success: false, error: resolved.error };
  const { organizationId } = resolved.context;

  let accounts: Array<{ id: string; name: string; type: string }>;
  let property: { id: string; name: string } | null;
  try {
    [accounts, property] = await Promise.all([
      prisma.account.findMany({ where: { organizationId }, select: { id: true, name: true, type: true } }),
      typeof raw.propertyId === 'string' && raw.propertyId
        ? prisma.property.findFirst({ where: { id: raw.propertyId, organizationId }, select: { id: true, name: true } })
        : Promise.resolve(null),
    ]);
  } catch (error) {
    console.error('[quick-entry.actions] submitQuickEntry: DB unreachable:', error);
    return { success: false, error: 'Could not reach the database. Try again.' };
  }

  if (!property) return { success: false, error: 'Choose a property for this entry.' };

  // The memo's property tag comes from the DB record, never the client —
  // a spoofed propertyName can't inject text into the ledger.
  const parsed = parseQuickEntry({ ...raw, propertyName: property.name }, accounts);
  if (!parsed.ok) return { success: false, error: parsed.error };

  // Delegate posting to the existing governed manual-entry path (validated
  // date passed in ISO date form, not the raw client string).
  return createManualJournalEntry({
    date: parsed.value.date.toISOString().slice(0, 10),
    memo: parsed.value.memo,
    lines: parsed.value.lines.map(l => ({
      accountId: l.accountId,
      amount: new Decimal(l.amount as never).toString(),
      isDebit: l.isDebit,
    })),
  });
}
