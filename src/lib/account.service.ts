import { Decimal } from 'decimal.js';

/**
 * A chart-of-accounts node with its OWN balance (the net of its directly
 * posted journal lines) and a link to its parent account. `balance` accepts
 * Decimal | number | string and is coerced to Decimal internally so callers
 * can pass raw values straight from a query without losing precision.
 */
export interface AccountNode {
  id: string;
  parentId: string | null;
  balance: Decimal | number | string;
}

export interface RolledUpAccount {
  id: string;
  /** This account's own balance, excluding descendants. */
  ownBalance: Decimal;
  /** Own balance plus the sum of ALL descendant balances (recursive). */
  rolledUpBalance: Decimal;
}

/**
 * RAJ-283 — Account hierarchy rollup.
 *
 * Pure functions over a flat account list. No DB access — the caller fetches
 * accounts + own balances (e.g. via LedgerService.getAccountBalance) and this
 * service does the tree arithmetic that powers P&L / balance-sheet rollup
 * reporting (RAJ-289/290).
 */
export class AccountService {
  /**
   * Roll descendant balances up into their ancestors.
   *
   * Returns a map keyed by account id. `ownBalance` is unchanged from the
   * input; `rolledUpBalance` is own + the recursive sum of every descendant.
   *
   * - A `parentId` that references an id not present in `nodes` is treated as
   *   a root (defensive against orphaned FKs).
   * - A cycle (a → b → a, or self-parent) throws rather than looping forever.
   */
  static rollup(nodes: AccountNode[]): Map<string, RolledUpAccount> {
    const own = new Map<string, Decimal>();
    const childrenOf = new Map<string, string[]>();

    for (const node of nodes) {
      own.set(node.id, new Decimal(node.balance.toString()));
    }

    // Only wire a child→parent edge when the parent actually exists; an
    // orphaned parentId collapses the node to a root.
    for (const node of nodes) {
      if (node.parentId && own.has(node.parentId)) {
        const siblings = childrenOf.get(node.parentId) ?? [];
        siblings.push(node.id);
        childrenOf.set(node.parentId, siblings);
      }
    }

    const rolled = new Map<string, Decimal>();
    const state = new Map<string, 'visiting' | 'done'>();

    const resolve = (id: string): Decimal => {
      const cached = rolled.get(id);
      if (cached) return cached;

      if (state.get(id) === 'visiting') {
        throw new Error(`Account hierarchy contains a cycle at "${id}".`);
      }
      state.set(id, 'visiting');

      let total = own.get(id) ?? new Decimal(0);
      for (const childId of childrenOf.get(id) ?? []) {
        total = total.plus(resolve(childId));
      }

      state.set(id, 'done');
      rolled.set(id, total);
      return total;
    };

    const result = new Map<string, RolledUpAccount>();
    for (const node of nodes) {
      result.set(node.id, {
        id: node.id,
        ownBalance: own.get(node.id)!,
        rolledUpBalance: resolve(node.id),
      });
    }
    return result;
  }

  /**
   * RAJ-403 — normal-balance sign convention per account type.
   *
   * A DEBIT-normal account (asset/expense) increases on the debit side; a
   * CREDIT-normal account (liability/equity/revenue) increases on the credit
   * side. Reports (P&L, Balance Sheet) use this to turn raw debit/credit
   * totals into "natural" positive balances. SUSPENSE is treated as
   * debit-normal like other clearing accounts.
   *
   * Throws on any value outside the closed AccountType set — free-text types
   * like "INCOME" were silently mis-signed when `type` was a String.
   */
  static normalBalance(type: LedgerAccountType): NormalBalance {
    const conventions: Record<LedgerAccountType, NormalBalance> = {
      ASSET: 'DEBIT',
      EXPENSE: 'DEBIT',
      SUSPENSE: 'DEBIT',
      LIABILITY: 'CREDIT',
      EQUITY: 'CREDIT',
      REVENUE: 'CREDIT',
    };
    const convention = conventions[type];
    if (!convention) {
      throw new Error(`Unknown account type "${type}" — not in the AccountType enum.`);
    }
    return convention;
  }

  /**
   * RAJ-404 — a parent account must belong to the SAME organization.
   *
   * Application-level guard mirroring the DB composite FK
   * (parentId, organizationId) → (id, organizationId): fails fast with a
   * typed error before the write reaches Postgres. Also rejects
   * self-parenting, mirroring the Account_no_self_parent CHECK.
   */
  static assertSameOrgParent(
    child: { id: string; organizationId: string },
    parent: { id: string; organizationId: string } | null,
  ): void {
    if (!parent) return;
    if (parent.id === child.id) {
      throw new AccountParentOrgMismatchError(
        `Account "${child.id}" cannot be its own parent.`,
      );
    }
    if (parent.organizationId !== child.organizationId) {
      throw new AccountParentOrgMismatchError(
        `Parent account "${parent.id}" belongs to organization ` +
          `"${parent.organizationId}" but the child belongs to ` +
          `"${child.organizationId}" — cross-org hierarchy is a tenant-isolation breach.`,
      );
    }
  }
}

/** The closed set of ledger account types (mirrors prisma enum AccountType). */
export type LedgerAccountType =
  | 'ASSET'
  | 'LIABILITY'
  | 'EQUITY'
  | 'REVENUE'
  | 'EXPENSE'
  | 'SUSPENSE';

export type NormalBalance = 'DEBIT' | 'CREDIT';

/** RAJ-404: thrown when a parent account is in a different organization. */
export class AccountParentOrgMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountParentOrgMismatchError';
  }
}
