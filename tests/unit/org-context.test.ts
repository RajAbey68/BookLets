/**
 * S3 (rls-lock) — org-context plumbing.
 *
 * The RLS policies key off the transaction-local Postgres setting
 * `app.current_org_id`; the app-side half of the contract is:
 *
 *  - src/lib/org-context.ts carries the resolved org id across a request's
 *    async call graph (AsyncLocalStorage — module state would bleed across
 *    concurrent requests);
 *  - src/lib/prisma.ts#setRlsOrgContext injects the setting into an open
 *    interactive transaction, and is a strict no-op without a scope
 *    (fail closed: the DB then sees NULL and matches no tenant rows).
 */
import { describe, it, expect, vi } from 'vitest';
import { runWithOrgContext, getActiveOrgId } from '@/lib/org-context';
import { setRlsOrgContext, resolveRlsWrapMode, type RlsContextCapable } from '@/lib/prisma';

describe('runWithOrgContext / getActiveOrgId', () => {
  it('returns undefined outside any scope (fail closed)', () => {
    expect(getActiveOrgId()).toBeUndefined();
  });

  it('exposes the org id inside the scope and restores after', async () => {
    const seen = await runWithOrgContext('org_a', async () => {
      await Promise.resolve();
      return getActiveOrgId();
    });
    expect(seen).toBe('org_a');
    expect(getActiveOrgId()).toBeUndefined();
  });

  it('propagates through awaited async continuations', async () => {
    const result = await runWithOrgContext('org_a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return getActiveOrgId();
    });
    expect(result).toBe('org_a');
  });

  it('propagates into promises created synchronously inside the scope (Promise.all shape)', async () => {
    // Mirrors the trial-balance-report exemplar: the queries are created
    // inside runWithOrgContext and awaited via Promise.all.
    const [a, b] = await runWithOrgContext('org_a', () =>
      Promise.all([
        (async () => { await Promise.resolve(); return getActiveOrgId(); })(),
        (async () => { await new Promise((r) => setTimeout(r, 2)); return getActiveOrgId(); })(),
      ])
    );
    expect(a).toBe('org_a');
    expect(b).toBe('org_a');
  });

  it('isolates concurrent scopes from each other', async () => {
    const results = await Promise.all([
      runWithOrgContext('org_a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return getActiveOrgId();
      }),
      runWithOrgContext('org_b', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getActiveOrgId();
      }),
    ]);
    expect(results).toEqual(['org_a', 'org_b']);
  });

  it('supports nesting — the innermost scope wins, then unwinds', async () => {
    await runWithOrgContext('org_outer', async () => {
      expect(getActiveOrgId()).toBe('org_outer');
      await runWithOrgContext('org_inner', async () => {
        expect(getActiveOrgId()).toBe('org_inner');
      });
      expect(getActiveOrgId()).toBe('org_outer');
    });
  });

  it('rejects an empty organizationId instead of opening an unscoped context', () => {
    expect(() => runWithOrgContext('', () => undefined)).toThrow(/non-empty organizationId/);
  });
});

describe('setRlsOrgContext (interactive-transaction injection)', () => {
  function fakeTx() {
    const calls: Array<{ strings: TemplateStringsArray; values: unknown[] }> = [];
    const tx: RlsContextCapable = {
      $executeRaw: vi.fn((strings: never, ...values: unknown[]) => {
        calls.push({ strings: strings as TemplateStringsArray, values });
        return Promise.resolve(1) as never;
      }) as unknown as RlsContextCapable['$executeRaw'],
    };
    return { tx, calls };
  }

  it('is a no-op without an active org context (fail closed)', async () => {
    const { tx, calls } = fakeTx();
    await setRlsOrgContext(tx);
    expect(calls).toHaveLength(0);
  });

  it('sets app.current_org_id transaction-locally (set_config third arg TRUE) inside a scope', async () => {
    const { tx, calls } = fakeTx();
    await runWithOrgContext('org_a', () => setRlsOrgContext(tx));
    expect(calls).toHaveLength(1);
    const sql = calls[0].strings.join('$');
    // Transaction-local (TRUE) is what makes this safe under pgBouncer /
    // Supavisor transaction-mode pooling — the GUC dies at COMMIT and can
    // never leak onto a connection handed to another client.
    expect(sql).toMatch(/set_config\('app\.current_org_id',\s*\$\s*,\s*TRUE\)/i);
    // The org id travels as a bind parameter, never interpolated into SQL.
    expect(calls[0].values).toEqual(['org_a']);
  });

  // S3 review finding #1 — the ambient AsyncLocalStorage scope is usually NOT
  // open in server actions, so callers must pass the resolved org id
  // explicitly. These tests pin the explicit-id contract.
  it('sets the GUC from an EXPLICIT organizationId with no ambient scope open', async () => {
    const { tx, calls } = fakeTx();
    expect(getActiveOrgId()).toBeUndefined(); // no scope — the old code path was a no-op here
    await setRlsOrgContext(tx, 'org_explicit');
    expect(calls).toHaveLength(1);
    const sql = calls[0].strings.join('$');
    expect(sql).toMatch(/set_config\('app\.current_org_id',\s*\$\s*,\s*TRUE\)/i);
    expect(calls[0].values).toEqual(['org_explicit']);
  });

  it('an explicit organizationId wins over the ambient scope (explicit > fallback)', async () => {
    const { tx, calls } = fakeTx();
    await runWithOrgContext('org_ambient', () => setRlsOrgContext(tx, 'org_explicit'));
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual(['org_explicit']);
  });

  it('an empty explicit organizationId falls back to the ambient scope, then to no-op', async () => {
    const { tx, calls } = fakeTx();
    await runWithOrgContext('org_ambient', () => setRlsOrgContext(tx, ''));
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual(['org_ambient']);

    const empty = fakeTx();
    await setRlsOrgContext(empty.tx, ''); // no scope either → fail closed
    expect(empty.calls).toHaveLength(0);
  });
});

/**
 * S3 review finding #4 — transaction detection in the rls-org-context
 * extension relies on Prisma's PRIVATE `__internalParams.transaction`. These
 * tests pin the fail-safe contract: when the private field disappears
 * (a Prisma upgrade), the extension must NOT blindly batch the operation
 * into base.$transaction — it passes through unwrapped (fails closed under
 * FORCE RLS, never corrupts a caller's open transaction).
 */
describe('resolveRlsWrapMode (rls-org-context transaction detection)', () => {
  it('wraps when __internalParams is present and shows no transaction', () => {
    expect(resolveRlsWrapMode({ __internalParams: {} })).toBe('wrap');
    expect(resolveRlsWrapMode({ __internalParams: { transaction: undefined } })).toBe('wrap');
  });

  it('passes through when a transaction marker is present (never nest $transaction)', () => {
    expect(
      resolveRlsWrapMode({ __internalParams: { transaction: { kind: 'itx', id: 't1' } } }),
    ).toBe('passthrough-in-transaction');
    expect(
      resolveRlsWrapMode({ __internalParams: { transaction: { kind: 'batch' } } }),
    ).toBe('passthrough-in-transaction');
  });

  it('fails SAFE when the private field is absent or malformed: passthrough, never wrap', () => {
    // Prisma upgrade removed __internalParams entirely:
    expect(resolveRlsWrapMode({ args: {}, query: () => {} })).toBe('passthrough-undetectable');
    // Degenerate shapes must not crash or wrap either:
    expect(resolveRlsWrapMode({ __internalParams: null })).toBe('passthrough-undetectable');
    expect(resolveRlsWrapMode({ __internalParams: 'not-an-object' })).toBe('passthrough-undetectable');
    expect(resolveRlsWrapMode(undefined)).toBe('passthrough-undetectable');
    expect(resolveRlsWrapMode(null)).toBe('passthrough-undetectable');
  });
});
