import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Decimal } from 'decimal.js';
import { getActiveOrgId } from './org-context';

// Prisma 7 requires either a driver adapter or accelerateUrl on the
// PrismaClient constructor — there is no engineType: "library" escape.
// Construct the pg adapter the first time the extended client is used.
//
// All BookLets tables live in the `booklets` Postgres schema (shared
// Supabase project, schema-level isolation from sibling apps). The
// connection's search_path is set via the `-c` startup option so Prisma's
// generated SQL — which references tables unqualified ("Organization"
// rather than booklets."Organization") — resolves into the right schema.
//
// The client is built lazily via a Proxy so module import has no side
// effects. Next.js's build-time page analysis imports server modules to
// collect configuration; eager construction here previously threw on
// missing DATABASE_URL even for routes marked `dynamic = 'force-dynamic'`.

/**
 * S3 (rls-lock) review finding #4 — transaction detection for the
 * rls-org-context extension, isolated so it can be unit-tested and pinned.
 *
 * CONSTRAINT (documented, not silently relied upon): Prisma 7 exposes no
 * supported signal telling a query extension whether the operation is
 * already running inside a transaction. The only signal is the PRIVATE
 * `__internalParams.transaction` field on the extension params. Because it
 * is private it can vanish in a minor Prisma upgrade, so detection is
 * validated explicitly and fails SAFE:
 *
 *  - 'wrap'                        → `__internalParams` is present and shows
 *    no transaction: batch the op with set_config in base.$transaction.
 *  - 'passthrough-in-transaction'  → a transaction marker is present: never
 *    nest $transaction (that would break the caller's atomicity); the
 *    interactive-transaction opener is responsible for setRlsOrgContext.
 *  - 'passthrough-undetectable'    → `__internalParams` is missing/not an
 *    object (private API changed): we CANNOT tell. Do NOT wrap blindly —
 *    wrapping an op that is secretly inside a transaction corrupts
 *    atomicity, whereas passing through unwrapped merely leaves the GUC
 *    unset for that op, which under FORCE RLS fails CLOSED (zero rows /
 *    rejected writes) and never leaks cross-tenant data. A loud warning is
 *    emitted (once) so the breakage is observable and fixable.
 */
export type RlsWrapMode =
  | 'wrap'
  | 'passthrough-in-transaction'
  | 'passthrough-undetectable';

export function resolveRlsWrapMode(params: unknown): RlsWrapMode {
  const internal = (
    params as { __internalParams?: unknown } | null | undefined
  )?.__internalParams;
  if (internal === undefined || internal === null || typeof internal !== 'object') {
    // Private field gone — Prisma internals changed under us. Fail safe.
    return 'passthrough-undetectable';
  }
  return (internal as { transaction?: unknown }).transaction
    ? 'passthrough-in-transaction'
    : 'wrap';
}

let warnedRlsDetectionUndetectable = false;
function warnRlsDetectionUndetectableOnce(): void {
  if (warnedRlsDetectionUndetectable) return;
  warnedRlsDetectionUndetectable = true;
  console.error(
    '[rls-org-context] Prisma private __internalParams is no longer exposed to ' +
      'query extensions — transaction detection is broken (likely a Prisma ' +
      'upgrade). Operations are passed through WITHOUT the app.current_org_id ' +
      'GUC: under FORCE RLS they fail closed (zero rows / rejected writes). ' +
      'Fix resolveRlsWrapMode in src/lib/prisma.ts for the new Prisma version.',
  );
}

function buildExtendedClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set; cannot construct PrismaClient.');
  }
  const adapter = new PrismaPg({
    connectionString,
    options: '-c search_path=booklets,public',
  });
  const base = new PrismaClient({
    adapter,
    log: ['query'],
  });

  /**
   * S3 (rls-lock) — RLS org-context extension.
   *
   * The migration prisma/migrations/20260712_rls_org_isolation adds
   * row-level-security policies keyed off the transaction-local Postgres
   * setting `app.current_org_id`. This extension injects that setting for
   * every model operation while a runWithOrgContext() scope is active
   * (see src/lib/org-context.ts), using the official Prisma RLS pattern:
   * batch the op with `set_config(..., true)` in one implicit transaction
   * so both statements share a connection and the setting dies at COMMIT.
   *
   * Why transaction-local (`set_config(..., TRUE)`) and not SET SESSION:
   * Supabase's pooler (pgBouncer/Supavisor) in transaction mode hands the
   * physical connection to a different client after every transaction. A
   * session-level GUC would leak one request's org onto another request's
   * connection. A transaction-local GUC set inside the same transaction as
   * the query is pool-safe by construction.
   *
   * Defensive rules (fail closed, never widen):
   *  - No active org context → pass through untouched. Under the RLS
   *    policies that means tenant tables return zero rows / reject writes;
   *    it never grants access.
   *  - Already inside a transaction (interactive or batch) → pass through;
   *    nesting $transaction would break atomicity. Interactive-transaction
   *    openers set the GUC themselves via setRlsOrgContext(tx) below.
   *
   * This extension is applied FIRST (innermost) so that the `query`
   * callback the SymbiOS extension below receives still resolves through
   * it, and the `query(args)` promise this hook batches into $transaction
   * is the genuine terminal operation — the shape the official Prisma
   * row-level-security extension example relies on.
   */
  const rlsScoped = base.$extends({
    name: 'rls-org-context',
    query: {
      $allModels: {
        async $allOperations(params) {
          const { args, query } = params;
          const orgId = getActiveOrgId();
          if (!orgId) {
            return query(args);
          }
          const mode = resolveRlsWrapMode(params);
          if (mode !== 'wrap') {
            if (mode === 'passthrough-undetectable') {
              warnRlsDetectionUndetectableOnce();
            }
            return query(args);
          }
          const [, result] = await base.$transaction([
            base.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, TRUE)`,
            query(args) as unknown as Prisma.PrismaPromise<unknown>,
          ]);
          return result;
        },
      },
    },
  });

  /**
   * SymbiOS Financial Integrity Extension
   * Intercepts writes to the ledger to enforce double-entry rules.
   *
   * Pre-check reads go through `rlsScoped` (not `base`) so they carry the
   * caller's org context once RLS is enforced; when an org context is
   * active they are additionally org-filtered in the WHERE clause, which
   * matches the DB trigger semantics (enforce_fiscal_period_lock is
   * org-scoped) and keeps the checks meaningful under FORCE ROW LEVEL
   * SECURITY. With no org context the behaviour is unchanged from before.
   */
  return rlsScoped.$extends({
    query: {
      journalEntry: {
        async create({ args, query }: { args: Prisma.JournalEntryCreateArgs, query: (args: Prisma.JournalEntryCreateArgs) => Promise<unknown> }) {
          const { data } = args;

          // 1. Fiscal Period Validation (Locking)
          if (data.date) {
              const entryDate = new Date(data.date as string | Date);
              const activeOrgId = getActiveOrgId();
              const closedPeriod = await rlsScoped.fiscalPeriod.findFirst({
                  where: {
                      startDate: { lte: entryDate },
                      endDate: { gte: entryDate },
                      isClosed: true,
                      ...(activeOrgId ? { organizationId: activeOrgId } : {}),
                  },
              });

              if (closedPeriod) {
                  throw new Error(`Fiscal Integrity Violation: The date ${entryDate.toLocaleDateString()} falls within the closed fiscal period "${closedPeriod.name}".`);
              }
          }

          // 2. Trial Balance Validation for immediate POSTED entries
          if (data.status === 'POSTED' && data.lines && typeof data.lines === 'object') {
            const lines = (data.lines as Prisma.JournalLineCreateNestedManyWithoutJournalEntryInput).create;
            if (Array.isArray(lines)) {
              let balance = new Decimal(0);
              for (const line of lines) {
                const amount = new Decimal(line.amount.toString());
                if (line.isDebit) {
                  balance = balance.plus(amount);
                } else {
                  balance = balance.minus(amount);
                }
              }
              if (!balance.isZero()) {
                throw new Error(`Trial Balance Violation: Current entry is unbalanced by ${balance.toFixed(2)}. Debits must equal Credits.`);
              }
              if (lines.length < 2) {
                throw new Error('Trial Balance Violation: A journal entry must have at least two balancing lines.');
              }
            }
          }
          return query(args);
        },

        async update({ args, query }: { args: Prisma.JournalEntryUpdateArgs, query: (args: Prisma.JournalEntryUpdateArgs) => Promise<unknown> }) {
          const { data } = args;

          // 1. Fiscal Period Validation (Locking)
          if (data.date) {
              const entryDate = new Date(data.date as string | Date);
              const activeOrgId = getActiveOrgId();
              const closedPeriod = await rlsScoped.fiscalPeriod.findFirst({
                  where: {
                      startDate: { lte: entryDate },
                      endDate: { gte: entryDate },
                      isClosed: true,
                      ...(activeOrgId ? { organizationId: activeOrgId } : {}),
                  },
              });

              if (closedPeriod) {
                  throw new Error(`Fiscal Integrity Violation: Cannot update entry to ${entryDate.toLocaleDateString()} because it falls within the closed fiscal period "${closedPeriod.name}".`);
              }
          }

          return query(args);
        },

        async delete({ args, query }: { args: Prisma.JournalEntryDeleteArgs, query: (args: Prisma.JournalEntryDeleteArgs) => Promise<unknown> }) {
          // 2. Immutable Audit Log: Prevent deletion of POSTED entries
          const entry = await rlsScoped.journalEntry.findUnique({
            where: args.where,
            select: { status: true },
          });

          if (entry?.status === 'POSTED') {
            throw new Error('Audit Integrity Violation: Posted journal entries cannot be deleted. You must "Void" or "Reverse" entries to maintain the audit trail.');
          }

          return query(args);
        },

        async deleteMany() {
          // Block bulk deletion on ledger records for safety
          throw new Error('Audit Integrity Violation: Bulk deletion of Journal Entries is disabled to prevent accidental data loss.');
        }
      }
    }
  });
}

type ExtendedPrisma = ReturnType<typeof buildExtendedClient>;

const globalForPrisma = global as unknown as { prisma?: ExtendedPrisma };

let cached: ExtendedPrisma | null = null;

function getClient(): ExtendedPrisma {
  if (!cached) {
    cached = globalForPrisma.prisma ?? buildExtendedClient();
    if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = cached;
  }
  return cached;
}

// Lazy proxy: import-time has zero side effects; the underlying client is
// constructed on first property access. This keeps Next.js's build-time
// page-config collection happy on routes that touch the database.
export const prisma = new Proxy({} as ExtendedPrisma, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient(), prop, receiver);
  },
});

/** Minimal structural view of a Prisma transaction client — just what the
 * RLS context helper needs, so it accepts both interactive-transaction
 * clients and the full client. */
export interface RlsContextCapable {
  $executeRaw(
    query: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ): Prisma.PrismaPromise<number>;
}

/**
 * S3 (rls-lock) — sets the RLS org context inside an OPEN interactive
 * transaction. The rls-org-context extension above deliberately does not
 * wrap operations that already run inside a transaction (nesting
 * $transaction would break atomicity), so every prisma.$transaction(async
 * (tx) => { ... }) that touches tenant tables must call this first:
 *
 *   await prisma.$transaction(async (tx) => {
 *     await setRlsOrgContext(tx, organizationId);
 *     ...tenant-table reads/writes...
 *   });
 *
 * Pass the resolved `organizationId` EXPLICITLY (review finding: every
 * interactive-transaction opener already has it in hand). The ambient
 * AsyncLocalStorage scope (runWithOrgContext) is only a FALLBACK for
 * callers that genuinely run inside a request-scoped context — most server
 * actions do not open one, and relying on it made this call a silent no-op
 * that fails closed under FORCE RLS.
 *
 * `set_config(..., TRUE)` is transaction-local: it lives exactly as long
 * as the surrounding transaction, so it is safe under pgBouncer/Supavisor
 * transaction-mode pooling (the setting can never leak onto a connection
 * another client receives after COMMIT).
 *
 * Fail closed: with neither an explicit organizationId nor an active
 * runWithOrgContext scope this is a no-op — the GUC stays unset and the
 * RLS policies match zero rows on tenant tables. It never invents or
 * widens access.
 */
export async function setRlsOrgContext(
  tx: RlsContextCapable,
  organizationId?: string,
): Promise<void> {
  // `||` (not `??`): an EMPTY explicit id means "not resolved" — fall back to
  // the ambient scope, and with neither present the guard below fails closed.
  const orgId = organizationId || getActiveOrgId();
  if (!orgId) return;
  await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, TRUE)`;
}
