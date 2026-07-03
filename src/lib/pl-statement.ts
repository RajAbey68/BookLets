import { Decimal } from 'decimal.js';
import { AccountService, type LedgerAccountType } from './account.service';

/**
 * RAJ-289 [P1-07] — P&L Statement computation.
 *
 * Pure: given the org's chart of accounts and POSTED journal-line aggregates
 * for a period, produce Revenue and Expense sections with hierarchy rollup
 * (AccountService.rollup) and netProfit = revenue − expenses. Amounts follow
 * AccountService.normalBalance: REVENUE is credit-normal so credits show
 * positive; EXPENSE is debit-normal so debits show positive. Contra activity
 * (e.g. a refund debited to a revenue account) therefore shows negative.
 * Only REVENUE and EXPENSE accounts appear — balance-sheet types are excluded.
 * No DB — the caller supplies accounts + line aggregates.
 */

export interface PLAccount {
  id: string;
  parentId: string | null;
  name: string;
  code: string | null;
  type: string;
}

/** A journal-line aggregate: pre-summed per (accountId, isDebit) or raw lines. */
export interface PLLineAggregate {
  accountId: string;
  amount: Decimal | string | number;
  isDebit: boolean;
}

export interface PLRow {
  accountId: string;
  code: string | null;
  name: string;
  /** Nesting level within the section (roots are 0). */
  depth: number;
  /** This account's own natural-sign activity, excluding descendants. */
  ownAmount: Decimal;
  /** Own activity plus the recursive sum of every descendant's. */
  rolledUpAmount: Decimal;
}

export interface PLSection {
  rows: PLRow[];
  total: Decimal;
}

export interface PLStatement {
  revenue: PLSection;
  expenses: PLSection;
  /** revenue.total − expenses.total (negative = net loss). */
  netProfit: Decimal;
}

const ZERO = new Decimal(0);

export function computePLStatement(accounts: PLAccount[], lines: PLLineAggregate[]): PLStatement {
  const revenue = computeSection(accounts, lines, 'REVENUE');
  const expenses = computeSection(accounts, lines, 'EXPENSE');
  return { revenue, expenses, netProfit: revenue.total.minus(expenses.total) };
}

/**
 * Build one section (REVENUE or EXPENSE):
 * 1. Net each section account's lines with the type's normal-balance sign.
 * 2. Roll descendants into ancestors via AccountService.rollup. An account
 *    whose parent is outside the section (wrong type / missing) is treated as
 *    a section root — rollup already collapses orphaned parentIds to roots.
 * 3. Emit rows depth-first (code order, codeless last) for accounts that were
 *    active this period or have an active descendant; everything else is
 *    omitted so the report shows only what moved.
 */
function computeSection(
  accounts: PLAccount[],
  lines: PLLineAggregate[],
  type: Extract<LedgerAccountType, 'REVENUE' | 'EXPENSE'>,
): PLSection {
  const sectionAccounts = accounts.filter((a) => a.type === type);
  const inSection = new Map(sectionAccounts.map((a) => [a.id, a]));
  const sign = AccountService.normalBalance(type); // REVENUE → CREDIT, EXPENSE → DEBIT

  const net = new Map<string, Decimal>();
  const active = new Set<string>();
  for (const line of lines) {
    if (!inSection.has(line.accountId)) continue;
    const amount = new Decimal(line.amount.toString());
    const natural = (sign === 'CREDIT') !== line.isDebit ? amount : amount.negated();
    net.set(line.accountId, (net.get(line.accountId) ?? ZERO).plus(natural));
    active.add(line.accountId);
  }

  const rolled = AccountService.rollup(
    sectionAccounts.map((a) => ({ id: a.id, parentId: a.parentId, balance: net.get(a.id) ?? ZERO })),
  );

  // An account appears if it or any descendant had activity this period.
  const childrenOf = new Map<string, PLAccount[]>();
  const roots: PLAccount[] = [];
  for (const account of sectionAccounts) {
    if (account.parentId && inSection.has(account.parentId)) {
      const siblings = childrenOf.get(account.parentId) ?? [];
      siblings.push(account);
      childrenOf.set(account.parentId, siblings);
    } else {
      roots.push(account);
    }
  }

  const included = new Set<string>();
  const markIncluded = (account: PLAccount): boolean => {
    let include = active.has(account.id);
    for (const child of childrenOf.get(account.id) ?? []) {
      if (markIncluded(child)) include = true;
    }
    if (include) included.add(account.id);
    return include;
  };
  for (const root of roots) markIncluded(root);

  const byCode = (a: PLAccount, b: PLAccount): number => {
    if (a.code && b.code) return a.code.localeCompare(b.code) || a.name.localeCompare(b.name);
    if (a.code) return -1; // coded accounts before codeless
    if (b.code) return 1;
    return a.name.localeCompare(b.name);
  };

  const rows: PLRow[] = [];
  const emit = (account: PLAccount, depth: number): void => {
    if (!included.has(account.id)) return;
    rows.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      depth,
      ownAmount: net.get(account.id) ?? ZERO,
      rolledUpAmount: rolled.get(account.id)?.rolledUpBalance ?? ZERO,
    });
    for (const child of [...(childrenOf.get(account.id) ?? [])].sort(byCode)) emit(child, depth + 1);
  };
  for (const root of [...roots].sort(byCode)) emit(root, 0);

  // Excluded roots had no activity anywhere below, so their rollup is zero —
  // summing every root equals summing only the included ones.
  let total = ZERO;
  for (const root of roots) total = total.plus(rolled.get(root.id)?.rolledUpBalance ?? ZERO);

  return { rows, total };
}

// ─── Period presets ───────────────────────────────────────────────────────────

export type PLPreset = 'MTD' | 'QTD' | 'YTD';

export const PL_PRESETS: readonly PLPreset[] = ['MTD', 'QTD', 'YTD'];

export function isPLPreset(value: string): value is PLPreset {
  return (PL_PRESETS as readonly string[]).includes(value);
}

export interface PLPeriodRange {
  /** Inclusive period start (00:00:00.000 UTC). */
  start: Date;
  /** Inclusive period end — end of the reference day (23:59:59.999 UTC). */
  end: Date;
}

/**
 * Resolve an MTD/QTD/YTD window from an explicit reference date (callers pass
 * the date in — never an implicit `now()` — so period math is testable and
 * reproducible). Boundaries are computed in UTC to match how JournalEntry
 * dates are stored.
 */
export function presetRange(preset: PLPreset, reference: Date): PLPeriodRange {
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();

  const startMonth = preset === 'MTD' ? month : preset === 'QTD' ? month - (month % 3) : 0;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, month, reference.getUTCDate(), 23, 59, 59, 999));

  return { start, end };
}
