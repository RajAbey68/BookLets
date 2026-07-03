import { Decimal } from 'decimal.js';
import { AccountService, type AccountNode, type LedgerAccountType } from './account.service';

/**
 * RAJ-290 — Balance Sheet computation.
 *
 * Pure: given the chart of accounts and POSTED journal-line aggregates
 * CUMULATIVE from inception up to an as-of date (the caller filters by date —
 * a balance sheet is a stock, not a flow), compute the three sections of
 * Assets = Liabilities + Equity.
 *
 * Sign convention comes from AccountService.normalBalance: debit-normal
 * accounts (ASSET, SUSPENSE) present their net debit as positive; credit-
 * normal accounts (LIABILITY, EQUITY) present their net credit as positive.
 * A contra balance (e.g. accumulated depreciation held as a credit inside an
 * ASSET account) therefore shows negative — it reduces the section total
 * rather than being hidden.
 *
 * Because no closing entries exist, cumulative REVENUE − EXPENSE (the life-to-
 * date profit) is injected into EQUITY as a synthetic "Current Period
 * Earnings" row; without it the equation could never balance. Hierarchy
 * rollup uses AccountService.rollup per section; section totals sum ROOT
 * rollups only, so parent+child are never double-counted. No DB access.
 */

export interface BalanceSheetAccount {
  id: string;
  parentId: string | null;
  name: string;
  code: string | null;
  type: string;
}

export interface BalanceSheetLine {
  accountId: string;
  amount: Decimal | string | number;
  isDebit: boolean;
}

export interface BalanceSheetRow {
  accountId: string;
  parentId: string | null;
  code: string | null;
  name: string;
  type: string;
  /** Nesting level within the section (roots are 0) for indented display. */
  depth: number;
  /** This account's own natural-sign balance, excluding descendants. */
  ownBalance: Decimal;
  /** Own balance plus all descendants, natural sign. */
  rolledUpBalance: Decimal;
  /** True for the synthetic Current Period Earnings row. */
  synthetic: boolean;
}

export interface BalanceSheetSection {
  rows: BalanceSheetRow[];
  /** Sum of ROOT rolled-up balances — children are inside their parents. */
  total: Decimal;
}

export interface BalanceSheet {
  assets: BalanceSheetSection;
  liabilities: BalanceSheetSection;
  equity: BalanceSheetSection;
  /** Cumulative REVENUE − EXPENSE (life-to-date profit, natural sign). */
  currentPeriodEarnings: Decimal;
  /** The accounting equation: assets === liabilities + equity. */
  balances: boolean;
}

/** Stable id for the synthetic equity row (not a real account id). */
export const CURRENT_PERIOD_EARNINGS_ID = '__current-period-earnings__';

const SECTION_TYPES: Record<'assets' | 'liabilities' | 'equity', LedgerAccountType[]> = {
  assets: ['ASSET', 'SUSPENSE'],
  liabilities: ['LIABILITY'],
  equity: ['EQUITY'],
};

const ZERO = new Decimal(0);

export function computeBalanceSheet(
  accounts: BalanceSheetAccount[],
  lines: BalanceSheetLine[],
): BalanceSheet {
  // 1. Net raw activity per account, in debit terms (debit positive).
  const netDebitByAccount = new Map<string, Decimal>();
  const activeAccounts = new Set<string>();
  for (const l of lines) {
    const amount = new Decimal(l.amount.toString());
    const delta = l.isDebit ? amount : amount.negated();
    netDebitByAccount.set(l.accountId, (netDebitByAccount.get(l.accountId) ?? ZERO).plus(delta));
    activeAccounts.add(l.accountId);
  }

  const byId = new Map(accounts.map((a) => [a.id, a]));

  // 2. Natural-sign own balance per account (normal-balance convention).
  const naturalOwn = (account: BalanceSheetAccount): Decimal => {
    const netDebit = netDebitByAccount.get(account.id) ?? ZERO;
    const convention = AccountService.normalBalance(account.type as LedgerAccountType);
    return convention === 'DEBIT' ? netDebit : netDebit.negated();
  };

  // 3. Cumulative earnings = natural REVENUE − natural EXPENSE.
  let currentPeriodEarnings = ZERO;
  let hasPnlActivity = false;
  for (const account of accounts) {
    if (account.type !== 'REVENUE' && account.type !== 'EXPENSE') continue;
    if (!activeAccounts.has(account.id)) continue;
    hasPnlActivity = true;
    const natural = naturalOwn(account); // revenue credit-normal (+), expense debit-normal (+)
    currentPeriodEarnings =
      account.type === 'REVENUE'
        ? currentPeriodEarnings.plus(natural)
        : currentPeriodEarnings.minus(natural);
  }

  const buildSection = (types: LedgerAccountType[]): BalanceSheetSection => {
    const typeSet = new Set<string>(types);
    const sectionAccounts = accounts.filter((a) => typeSet.has(a.type));
    const sectionIds = new Set(sectionAccounts.map((a) => a.id));

    // Include an account when it, or any account in its subtree, has activity.
    // Walk each active account's ancestor chain (bounded — rollup throws on
    // cycles, and chains here are short) so empty parents of active children
    // still appear as headers.
    const included = new Set<string>();
    for (const account of sectionAccounts) {
      if (!activeAccounts.has(account.id)) continue;
      let cursor: BalanceSheetAccount | undefined = account;
      const seen = new Set<string>();
      while (cursor && sectionIds.has(cursor.id) && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        included.add(cursor.id);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
    }

    const includedAccounts = sectionAccounts.filter((a) => included.has(a.id));
    const nodes: AccountNode[] = includedAccounts.map((a) => ({
      id: a.id,
      // A parent outside the included set collapses this node to a root.
      parentId: a.parentId && included.has(a.parentId) ? a.parentId : null,
      balance: naturalOwn(a),
    }));
    const rolled = AccountService.rollup(nodes);

    // Depth-first ordering: roots by code (codeless last) then name, children
    // listed under their parent in the same order.
    const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
    const childrenOf = new Map<string, string[]>();
    const roots: string[] = [];
    for (const node of nodes) {
      if (node.parentId) {
        childrenOf.set(node.parentId, [...(childrenOf.get(node.parentId) ?? []), node.id]);
      } else {
        roots.push(node.id);
      }
    }
    const byCode = (x: string, y: string): number => {
      const a = byId.get(x)!;
      const b = byId.get(y)!;
      if (a.code && b.code) return a.code.localeCompare(b.code) || a.name.localeCompare(b.name);
      if (a.code) return -1;
      if (b.code) return 1;
      return a.name.localeCompare(b.name);
    };

    const rows: BalanceSheetRow[] = [];
    const visit = (id: string, depth: number): void => {
      const account = byId.get(id)!;
      const entry = rolled.get(id)!;
      rows.push({
        accountId: id,
        parentId: parentOf.get(id) ?? null,
        code: account.code,
        name: account.name,
        type: account.type,
        depth,
        ownBalance: entry.ownBalance,
        rolledUpBalance: entry.rolledUpBalance,
        synthetic: false,
      });
      for (const childId of [...(childrenOf.get(id) ?? [])].sort(byCode)) {
        visit(childId, depth + 1);
      }
    };
    for (const rootId of [...roots].sort(byCode)) visit(rootId, 0);

    const total = roots.reduce((sum, id) => sum.plus(rolled.get(id)!.rolledUpBalance), ZERO);
    return { rows, total };
  };

  const assets = buildSection(SECTION_TYPES.assets);
  const liabilities = buildSection(SECTION_TYPES.liabilities);
  const equity = buildSection(SECTION_TYPES.equity);

  // 4. Inject life-to-date profit into equity so the equation can balance.
  if (hasPnlActivity && !currentPeriodEarnings.isZero()) {
    equity.rows.push({
      accountId: CURRENT_PERIOD_EARNINGS_ID,
      parentId: null,
      code: null,
      name: 'Current Period Earnings',
      type: 'EQUITY',
      depth: 0,
      ownBalance: currentPeriodEarnings,
      rolledUpBalance: currentPeriodEarnings,
      synthetic: true,
    });
    equity.total = equity.total.plus(currentPeriodEarnings);
  }

  return {
    assets,
    liabilities,
    equity,
    currentPeriodEarnings,
    balances: assets.total.equals(liabilities.total.plus(equity.total)),
  };
}
