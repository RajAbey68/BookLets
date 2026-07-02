import { prisma } from './prisma';
import { resolveActiveContext } from './auth-context';
import { computeTrialBalance, type TrialBalance } from './trial-balance';

/**
 * RAJ-288 — Server-only data assembly for the Trial Balance report.
 *
 * Shared by the /reports/trial-balance page and the CSV export route so the
 * query + period filter live in one place. Not a 'use server' action — it is
 * called directly from a server component / route handler, so Decimals never
 * cross an RPC boundary.
 */

export interface TrialBalancePeriodOption {
  value: string;
  label: string;
}

export type TrialBalanceReport =
  | {
      ok: true;
      organizationName: string;
      selectedPeriod: string;
      periodOptions: TrialBalancePeriodOption[];
      trialBalance: TrialBalance;
    }
  | { ok: false; error: string };

/** Month bucket key, matching the General Ledger page (`year-monthIndex`). */
const monthKey = (date: Date | string) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${d.getMonth()}`;
};

export async function getTrialBalanceReport(period?: string): Promise<TrialBalanceReport> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const { organizationId, organizationName } = resolved.context;

  const [accounts, lines] = await Promise.all([
    prisma.account.findMany({
      where: { organizationId },
      select: { id: true, name: true, code: true, type: true },
    }),
    prisma.journalLine.findMany({
      where: { journalEntry: { organizationId, status: 'POSTED' } },
      select: {
        accountId: true,
        amount: true,
        isDebit: true,
        journalEntry: { select: { date: true } },
      },
    }),
  ]);

  // Period options derived from the actual posting months, newest first.
  const monthLabels = new Map<string, string>();
  for (const line of lines) {
    const key = monthKey(line.journalEntry.date);
    if (!monthLabels.has(key)) {
      monthLabels.set(
        key,
        new Date(line.journalEntry.date).toLocaleString('en-IE', { month: 'long', year: 'numeric' }),
      );
    }
  }
  const sortedMonths = [...monthLabels.entries()].sort((a, b) => {
    const [ay, am] = a[0].split('-').map(Number);
    const [by, bm] = b[0].split('-').map(Number);
    return by !== ay ? by - ay : bm - am;
  });
  const periodOptions: TrialBalancePeriodOption[] = [
    { value: 'all', label: 'All Time' },
    ...sortedMonths.map(([value, label]) => ({ value, label })),
  ];

  const selectedPeriod = period && monthLabels.has(period) ? period : 'all';
  const scopedLines = selectedPeriod === 'all'
    ? lines
    : lines.filter((l) => monthKey(l.journalEntry.date) === selectedPeriod);

  const trialBalance = computeTrialBalance(accounts, scopedLines);

  return { ok: true, organizationName, selectedPeriod, periodOptions, trialBalance };
}
