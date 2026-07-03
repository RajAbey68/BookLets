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
}
