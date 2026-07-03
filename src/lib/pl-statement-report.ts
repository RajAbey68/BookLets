import { prisma } from './prisma';
import { resolveActiveContext } from './auth-context';
import {
  computePLStatement,
  isPLPreset,
  presetRange,
  type PLPreset,
  type PLStatement,
} from './pl-statement';

/**
 * RAJ-289 — Server-only data assembly for the P&L Statement report.
 *
 * Shared by the /reports/pl page and the CSV export route so the query +
 * period logic live in one place. Not a 'use server' action — it is called
 * directly from a server component / route handler, so Decimals never cross
 * an RPC boundary.
 */

export interface PLPresetOption {
  value: PLPreset;
  label: string;
}

export const PL_PRESET_OPTIONS: readonly PLPresetOption[] = [
  { value: 'MTD', label: 'Month to date' },
  { value: 'QTD', label: 'Quarter to date' },
  { value: 'YTD', label: 'Year to date' },
];

export type PLReport =
  | {
      ok: true;
      organizationName: string;
      preset: PLPreset;
      range: { start: Date; endExclusive: Date };
      presetOptions: readonly PLPresetOption[];
      statement: PLStatement;
    }
  | { ok: false; error: string };

/**
 * @param requestedPreset raw `?period=` value — anything outside MTD/QTD/YTD
 *   falls back to MTD.
 * @param referenceDate the "as of" date the period is computed from. Callers
 *   pass it in (route handlers pass `new Date()`) so the period math stays
 *   deterministic under test.
 */
export async function getPLStatementReport(
  requestedPreset: string | undefined,
  referenceDate: Date,
): Promise<PLReport> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const { organizationId, organizationName } = resolved.context;

  const preset: PLPreset = requestedPreset && isPLPreset(requestedPreset) ? requestedPreset : 'MTD';
  const range = presetRange(preset, referenceDate);

  const [accounts, sums] = await Promise.all([
    prisma.account.findMany({
      where: { organizationId },
      select: { id: true, parentId: true, name: true, code: true, type: true },
    }),
    prisma.journalLine.groupBy({
      by: ['accountId', 'isDebit'],
      where: {
        journalEntry: {
          organizationId,
          status: 'POSTED',
          date: { gte: range.start, lt: range.endExclusive },
        },
      },
      _sum: { amount: true },
    }),
  ]);

  const lines = sums.flatMap((sum) =>
    sum._sum.amount === null
      ? []
      : [{ accountId: sum.accountId, amount: sum._sum.amount.toString(), isDebit: sum.isDebit }],
  );

  const statement = computePLStatement(accounts, lines);

  return {
    ok: true,
    organizationName,
    preset,
    range,
    presetOptions: PL_PRESET_OPTIONS,
    statement,
  };
}
