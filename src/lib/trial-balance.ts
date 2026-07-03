import { Decimal } from 'decimal.js';

/**
 * RAJ-288 — Trial Balance computation.
 *
 * Pure: aggregate POSTED journal lines per account, net each account to a
 * single side (debit or credit), and report grand totals. In a sound
 * double-entry ledger total debits equal total credits, so `isBalanced` is the
 * headline integrity check. No DB — the caller supplies accounts + lines.
 */

export interface TrialBalanceAccount {
  id: string;
  name: string;
  code: string | null;
  type: string;
}

export interface TrialBalanceLine {
  accountId: string;
  amount: Decimal | string | number;
  isDebit: boolean;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string | null;
  name: string;
  type: string;
  debit: Decimal;
  credit: Decimal;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: Decimal;
  totalCredit: Decimal;
  isBalanced: boolean;
}

/**
 * Only accounts that actually have postings appear in the report. An account
 * with offsetting activity that nets to zero still appears (it was active);
 * an account with no lines is omitted. Rows are ordered by account code
 * (codeless accounts last), then name.
 */
export function computeTrialBalance(
  accounts: TrialBalanceAccount[],
  lines: TrialBalanceLine[],
): TrialBalance {
  const netByAccount = new Map<string, Decimal>();
  for (const line of lines) {
    const amount = new Decimal(line.amount.toString());
    const delta = line.isDebit ? amount : amount.negated();
    netByAccount.set(line.accountId, (netByAccount.get(line.accountId) ?? new Decimal(0)).plus(delta));
  }

  const byId = new Map(accounts.map((a) => [a.id, a]));

  const rows: TrialBalanceRow[] = [];
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);

  for (const [accountId, net] of netByAccount) {
    const account = byId.get(accountId);
    if (!account) continue; // line references an account not in the provided set — skip

    const debit = net.greaterThan(0) ? net : new Decimal(0);
    const credit = net.lessThan(0) ? net.negated() : new Decimal(0);

    rows.push({ accountId, code: account.code, name: account.name, type: account.type, debit, credit });
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
  }

  rows.sort((a, b) => {
    if (a.code && b.code) return a.code.localeCompare(b.code) || a.name.localeCompare(b.name);
    if (a.code) return -1; // coded accounts before codeless
    if (b.code) return 1;
    return a.name.localeCompare(b.name);
  });

  return { rows, totalDebit, totalCredit, isBalanced: totalDebit.equals(totalCredit) };
}
