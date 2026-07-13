import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * S3 (rls-lock) — per-request organisation context for Postgres row-level
 * security.
 *
 * The RLS policies added in prisma/migrations/20260712_rls_org_isolation
 * key every tenant table off the transaction-local Postgres setting
 * `app.current_org_id`. This module carries the resolved organisation id
 * across a request's async call graph so the Prisma client extension in
 * src/lib/prisma.ts can inject that setting per operation.
 *
 * Design constraints:
 *  - AsyncLocalStorage, not module state — Next.js serves concurrent
 *    requests on one process; a module-level variable would leak one
 *    user's org into another's queries.
 *  - Fail closed — when no context is set, nothing is injected and the
 *    RLS policies (current_setting('app.current_org_id', true) IS NULL →
 *    no row matches) return zero rows / reject writes on tenant tables.
 *  - No coupling to Prisma — this file must stay importable from anywhere
 *    (including tests) without touching the database client.
 */

interface OrgContext {
  organizationId: string;
}

const storage = new AsyncLocalStorage<OrgContext>();

/**
 * Runs `fn` with the given organisation id active for every awaited
 * operation inside it. Typical use in a server action / route handler:
 *
 *   const resolved = await resolveActiveContext();
 *   if (!resolved.ok) return ...;
 *   return runWithOrgContext(resolved.context.organizationId, async () => {
 *     ...queries here are RLS-scoped to the caller's organisation...
 *   });
 */
export function runWithOrgContext<T>(organizationId: string, fn: () => T): T {
  if (!organizationId) {
    // An empty org id must not silently produce an unscoped context —
    // callers only reach here after resolveActiveContext succeeded, so an
    // empty string is a programming error, not a request-shape issue.
    throw new Error('runWithOrgContext requires a non-empty organizationId.');
  }
  return storage.run({ organizationId }, fn);
}

/**
 * The organisation id of the active request context, or undefined when no
 * runWithOrgContext scope is open (build-time page collection, seed
 * scripts, unauthenticated bootstrap queries). Undefined means: do not set
 * `app.current_org_id`; the database fails closed on tenant tables.
 */
export function getActiveOrgId(): string | undefined {
  return storage.getStore()?.organizationId;
}
