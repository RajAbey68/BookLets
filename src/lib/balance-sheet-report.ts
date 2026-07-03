import { prisma } from './prisma';
import { resolveActiveContext } from './auth-context';
import { computeBalanceSheet, type BalanceSheet } from './balance-sheet';

/**
 * RAJ-290 — Server-only data assembly for the Balance Sheet report.
 *
 * Shared by the /reports/balance-sheet page and the CSV export route so the
 * query + as-of filter live in one place. Not a 'use server' action — it is
 * called directly from a server component / route handler, so Decimals never
 * cross an RPC boundary.
 *
 * The as-of filter is `date <= end of the chosen day` with NO lower bound:
 * a balance sheet is a stock (cumulative position since inception), not a
 * flow, so every posted entry up to the date participates.
 */

export type BalanceSheetReport =
  | {
      ok: true;
      organizationName: string;
      /** The as-of date actually applied, as YYYY-MM-DD. */
      asOf: string;
      balanceSheet: BalanceSheet;
    }
  | { ok: false; error: string };

const AS_OF_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a YYYY-MM-DD search param; anything else falls back to today. */
export function resolveAsOf(input?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (!input || !AS_OF_PATTERN.test(input)) return today;
  // Reject calendar-impossible strings like 2026-13-45 (Date would roll over).
  const parsed = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input) return today;
  return input;
}

export async function getBalanceSheetReport(asOfParam?: string): Promise<BalanceSheetReport> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const { organizationId, organizationName } = resolved.context;
  const asOf = resolveAsOf(asOfParam);
  const endOfDay = new Date(`${asOf}T23:59:59.999Z`);

  const [accounts, lines] = await Promise.all([
    prisma.account.findMany({
      where: { organizationId },
      select: { id: true, parentId: true, name: true, code: true, type: true },
    }),
    prisma.journalLine.findMany({
      where: {
        journalEntry: { organizationId, status: 'POSTED', date: { lte: endOfDay } },
      },
      select: { accountId: true, amount: true, isDebit: true },
    }),
  ]);

  const balanceSheet = computeBalanceSheet(
    accounts,
    lines.map((l) => ({ accountId: l.accountId, amount: l.amount.toString(), isDebit: l.isDebit })),
  );

  return { ok: true, organizationName, asOf, balanceSheet };
}
