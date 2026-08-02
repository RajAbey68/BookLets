/**
 * S1b — staging→ledger bridge, production wiring (contract:
 * docs/runs/S1B-BRIDGE-CONTRACT.md §3, Option A).
 *
 * Staging (`raj_fin_track.ocr_receipts`) and the ledger live in the SAME
 * Postgres instance, so the bridge is a cross-schema READ via
 * `prisma.$queryRaw` followed by normal LedgerService.postEntry writes.
 *
 * The staging schema is READ-ONLY territory for this app: SELECT only —
 * never INSERT/UPDATE/DELETE against `raj_fin_track`, and the table is
 * deliberately NOT added to schema.prisma (it is foreign territory owned by
 * the OCR pipeline).
 *
 * PREREQUISITES before this can run in prod (contract §5):
 *   HR-5  MIGRATION-BASELINE-DDL.sql applied — the bridge writes
 *         JournalEntry.idempotencyKey/source/sourceId, which do not exist in
 *         prod until the baseline lands.
 *   HR-6  The app role needs read access to the staging schema:
 *         GRANT USAGE ON SCHEMA raj_fin_track TO <app_role>;
 *         GRANT SELECT ON raj_fin_track.ocr_receipts TO <app_role>;
 *
 * TENANCY MODEL for an org-less staging source: `raj_fin_track.ocr_receipts`
 * has NO organization column (single-tenant staging owned by the OCR
 * pipeline, and we cannot alter it), so row→org attribution cannot come from
 * the data. Instead the pool is bound to exactly ONE organization by
 * configuration: the route requires env `OCR_BRIDGE_ORG_ID` and refuses to
 * run (503) when it is unset, and rejects (403) any caller whose
 * organizationId differs from it. This fails closed — the staging pool can
 * only ever be imported into the one configured org.
 */

import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { LedgerService } from './ledger.service';
import {
  DEFAULT_BATCH_SIZE,
  OCR_BRIDGE_KEY_PREFIX,
  importOcrReceipts,
  type OcrBridgeDeps,
  type OcrBridgeSummary,
  type OcrStagingRow,
  type ParkReason,
} from './ocr-bridge';
import type { JournalEntryInput } from './types';

/**
 * Row-shape eligibility predicate (contract §2) as SQL. Must stay in
 * lockstep with classifyStagingRow in ocr-bridge.ts.
 */
const ELIGIBLE_PREDICATE = Prisma.sql`
  r.ocr_status = 'success'
  AND r.total_amount > 0
  AND r.doc_date IS NOT NULL
  AND r.currency = 'LKR'
`;

/**
 * doc_date is covered by an OPEN (not closed, not locked) FiscalPeriod of
 * the org — the same test LedgerService.checkFiscalPeriod applies. Must stay
 * in lockstep with checkFiscalPeriod AND with hasOpenFiscalPeriod below.
 */
function inOpenFiscalPeriod(organizationId: string) {
  return Prisma.sql`
    EXISTS (
      SELECT 1
      FROM public."FiscalPeriod" fp
      WHERE fp."organizationId" = ${organizationId}
        AND fp."startDate" <= r.doc_date
        AND fp."endDate" >= r.doc_date
        AND fp."isClosed" = false
        AND fp."locked" = false
    )
  `;
}

/**
 * Importable-in-principle: eligible row shape AND an open fiscal period
 * covering doc_date. This drives BOTH the batch ordering and `remaining`, so
 * deterministically parked rows (incl. NO_FISCAL_PERIOD) neither starve the
 * batch window nor hold `remaining` above 0 — the "re-invoke until
 * remaining: 0" loop is guaranteed to terminate.
 */
function importablePredicate(organizationId: string) {
  return Prisma.sql`${ELIGIBLE_PREDICATE} AND ${inOpenFiscalPeriod(organizationId)}`;
}

/** NOT EXISTS guard: the row has no JournalEntry with its idempotency key yet. */
function notYetImported(organizationId: string) {
  return Prisma.sql`
    NOT EXISTS (
      SELECT 1
      FROM public."JournalEntry" je
      WHERE je."organizationId" = ${organizationId}
        AND je."idempotencyKey" = ${OCR_BRIDGE_KEY_PREFIX} || r.source_file
    )
  `;
}

/**
 * Fetch the next batch of unimported staging rows.
 *
 * NOTE (HR-5/HR-6): this query requires the HR-5 baseline (the
 * `idempotencyKey` column on public."JournalEntry") AND a SELECT grant on
 * `raj_fin_track.ocr_receipts` for the app role (HR-6) before it can run in
 * prod. SELECT only — the staging schema is read-only to this app.
 *
 * Importable rows are ordered FIRST so parked rows (which are never imported
 * and therefore never leave the NOT EXISTS set — including NO_FISCAL_PERIOD
 * rows) cannot permanently occupy the batch window and starve postable rows
 * behind them. `total_amount` is cast to text so numeric(19,4) survives the
 * driver without float loss.
 */
async function fetchStagingBatch(
  organizationId: string,
  batchSize: number,
): Promise<OcrStagingRow[]> {
  return prisma.$queryRaw<OcrStagingRow[]>`
    SELECT
      r.id,
      r.source_file,
      r.doc_date,
      r.vendor_or_entity,
      r.total_amount::text AS total_amount,
      r.currency,
      r.category,
      r.raw_response,
      r.ocr_status
    FROM raj_fin_track.ocr_receipts r
    WHERE ${notYetImported(organizationId)}
    ORDER BY (CASE WHEN ${importablePredicate(organizationId)} THEN 0 ELSE 1 END), r.id
    LIMIT ${batchSize}
  `;
}

/**
 * Importable rows still lacking a JournalEntry — the route's `remaining`.
 * Deterministically parked rows (bad shape OR no open fiscal period) are NOT
 * counted, so `remaining` reaches 0 once every importable row has landed.
 */
async function countRemainingEligible(organizationId: string): Promise<number> {
  const result = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM raj_fin_track.ocr_receipts r
    WHERE ${importablePredicate(organizationId)}
      AND ${notYetImported(organizationId)}
  `;
  return result[0]?.n ?? 0;
}

// ─── S11 sandbox — read-only staging-pile summary ────────────────────────────

/** One park-reason bucket of the staging summary (counts only, no row ids). */
export interface OcrStagingParkedCount {
  reason: ParkReason;
  count: number;
}

/**
 * WHY a staging summary could not be produced. `available: false` on its own
 * conflates two completely different situations, and callers that raise an
 * alarm must be able to tell them apart:
 *
 *  - `unauthenticated` / `not_configured` / `org_mismatch` — the staging pile
 *    does not APPLY to this caller. Nothing is broken. `OCR_BRIDGE_ORG_ID` is
 *    optional and is unset in this deployment, so `not_configured` is the
 *    everyday state; treating it as a fault would put a permanent false alarm
 *    on every screen that shows it.
 *  - `query_failed` — the staging query itself broke (table, SELECT grant, or
 *    database missing/unreachable). This IS a fault and must stay visible.
 *
 * Use `isStagingOutage()` rather than testing reasons ad hoc, so a reason
 * added later cannot silently be read as "calm".
 */
export type OcrStagingUnavailableReason =
  | 'unauthenticated'
  | 'not_configured'
  | 'org_mismatch'
  | 'query_failed';

export interface OcrStagingSummary {
  /**
   * False when the counts below could not be produced — because the pile does
   * not apply to this caller, or because the staging table / grant / database
   * is absent (e.g. local dev without raj_fin_track). The sandbox page renders
   * a "staging unavailable" note instead of crashing. When false, the counts
   * are all zero and MUST NOT be rendered as real figures.
   */
  available: boolean;
  /**
   * Null when `available`; otherwise which of the two kinds of unavailability
   * this is (see OcrStagingUnavailableReason). Required, not optional, so no
   * construction site can forget to say which one it means.
   */
  unavailableReason: OcrStagingUnavailableReason | null;
  /** Rows importable right now: well-shaped, open fiscal period, unimported. */
  importable: number;
  /** Unimported rows parked by deterministic reason (nonzero buckets only). */
  parked: OcrStagingParkedCount[];
  /** Rows that already have a JournalEntry (idempotency key present). */
  alreadyImported: number;
  /** All rows in the staging pool. */
  total: number;
}

/**
 * The one degraded summary shape, tagged with why. Every "cannot read the
 * pile" path builds its result here so the zeroed counts and the reason can
 * never drift apart.
 */
export function unavailableStagingSummary(
  reason: OcrStagingUnavailableReason,
): OcrStagingSummary {
  return {
    available: false,
    unavailableReason: reason,
    importable: 0,
    parked: [],
    alreadyImported: 0,
    total: 0,
  };
}

/** Unavailability reasons that mean "not applicable here", i.e. NOT a fault. */
const BENIGN_STAGING_REASONS: ReadonlySet<OcrStagingUnavailableReason> = new Set([
  'unauthenticated',
  'not_configured',
  'org_mismatch',
]);

/**
 * True only when a summary is unavailable because something BROKE.
 *
 * Fails loud on purpose: an unavailable summary carrying no reason, or a
 * reason nobody has classified as benign, counts as an outage. A silent
 * failure that looks like a healthy, calm screen is exactly the accident this
 * whole discriminator exists to prevent — the opposite mistake (one honest
 * warning too many) is recoverable.
 */
export function isStagingOutage(
  summary: Pick<OcrStagingSummary, 'available' | 'unavailableReason'>,
): boolean {
  if (summary.available) return false;
  const reason = summary.unavailableReason;
  return reason === null || !BENIGN_STAGING_REASONS.has(reason);
}

/** Raw counts row of the summary query (every column is `::int`). */
interface StagingSummaryCounts {
  total: number;
  already_imported: number;
  importable: number;
  ocr_failed: number;
  bad_amount: number;
  no_doc_date: number;
  fx_unsupported: number;
  no_fiscal_period: number;
}

/**
 * S11 — read-only counts over the staging pool for the /sandbox pile card.
 *
 * Cross-schema SELECT ONLY — the staging schema stays read-only territory
 * (never INSERT/UPDATE/DELETE against raj_fin_track). The park-reason buckets
 * apply classifyStagingRow's exact precedence (OCR failure first, then
 * amount, date, currency; fiscal period last because it needs the ledger's
 * FiscalPeriod table), so the summary always reconciles with what a bridge
 * run would actually do: total = alreadyImported + importable + Σparked.
 *
 * Degrades to `available: false` instead of throwing when the staging table,
 * the SELECT grant (HR-6), or the database itself is missing — a summary
 * card must never take down the page it renders on. Every such degradation is
 * tagged `query_failed`: reaching this function means the caller already
 * passed the org gate, so anything that goes wrong from here really is broken
 * and callers are expected to surface it.
 */
export async function summarizeOcrStaging(organizationId: string): Promise<OcrStagingSummary> {
  let counts: StagingSummaryCounts | undefined;
  try {
    const rows = await prisma.$queryRaw<StagingSummaryCounts[]>`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE NOT ${notYetImported(organizationId)})::int AS already_imported,
        count(*) FILTER (WHERE ${notYetImported(organizationId)}
          AND ${importablePredicate(organizationId)})::int AS importable,
        count(*) FILTER (WHERE ${notYetImported(organizationId)}
          AND r.ocr_status IS DISTINCT FROM 'success')::int AS ocr_failed,
        count(*) FILTER (WHERE ${notYetImported(organizationId)}
          AND r.ocr_status = 'success'
          AND (r.total_amount IS NULL OR r.total_amount <= 0))::int AS bad_amount,
        count(*) FILTER (WHERE ${notYetImported(organizationId)}
          AND r.ocr_status = 'success'
          AND r.total_amount > 0
          AND r.doc_date IS NULL)::int AS no_doc_date,
        count(*) FILTER (WHERE ${notYetImported(organizationId)}
          AND r.ocr_status = 'success'
          AND r.total_amount > 0
          AND r.doc_date IS NOT NULL
          AND r.currency IS DISTINCT FROM 'LKR')::int AS fx_unsupported,
        count(*) FILTER (WHERE ${notYetImported(organizationId)}
          AND ${ELIGIBLE_PREDICATE}
          AND NOT ${inOpenFiscalPeriod(organizationId)})::int AS no_fiscal_period
      FROM raj_fin_track.ocr_receipts r
    `;
    counts = rows[0];
  } catch (error) {
    console.error('[ocr-bridge] summarizeOcrStaging: staging unavailable:', error);
    return unavailableStagingSummary('query_failed');
  }
  // A `count(*)` query always yields exactly one row; no row means the query
  // did not really run, which is a fault, not an empty pile.
  if (!counts) return unavailableStagingSummary('query_failed');

  // classifyStagingRow precedence order; zero buckets are omitted so the UI
  // only lists reasons that actually occur.
  const parked: OcrStagingParkedCount[] = (
    [
      ['OCR_FAILED', counts.ocr_failed],
      ['BAD_AMOUNT', counts.bad_amount],
      ['NO_DOC_DATE', counts.no_doc_date],
      ['FX_UNSUPPORTED', counts.fx_unsupported],
      ['NO_FISCAL_PERIOD', counts.no_fiscal_period],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, count }));

  return {
    available: true,
    unavailableReason: null,
    importable: counts.importable,
    parked,
    alreadyImported: counts.already_imported,
    total: counts.total,
  };
}

/**
 * Build the IO deps for one import run. Account/category lookups are
 * memoized per run — a batch of 50 rows must not issue 100+ identical
 * account queries.
 */
export function createOcrBridgeDeps(organizationId: string): OcrBridgeDeps {
  let suspenseAccountIdPromise: Promise<string> | undefined;
  let bankAccountIdPromise: Promise<string> | undefined;
  const categoryAccountIds = new Map<string, Promise<string>>();
  const fiscalPeriodByDay = new Map<string, Promise<boolean>>();

  // Suspense (code 9999) must be seeded — it is the fallback for both legs.
  function suspenseAccountId(): Promise<string> {
    suspenseAccountIdPromise ??= prisma.account
      .findFirst({ where: { organizationId, code: '9999' }, select: { id: true } })
      .then((account) => {
        if (!account) {
          throw new Error(
            'S1b Setup Error: Suspense account (code 9999) is not seeded for this organization.',
          );
        }
        return account.id;
      });
    return suspenseAccountIdPromise;
  }

  return {
    async ensureVendor(name: string): Promise<void> {
      // Resolve-or-create, mirroring AutomationService.processReceipt.
      const vendor = await prisma.vendor.findFirst({ where: { name: { contains: name } } });
      if (!vendor) {
        await prisma.vendor.create({ data: { name } });
      }
    },

    async resolveExpenseAccountId(category: string | null): Promise<string> {
      if (!category) return suspenseAccountId();

      let resolved = categoryAccountIds.get(category);
      if (!resolved) {
        resolved = (async () => {
          const suspenseId = await suspenseAccountId();
          // ExpenseCategory has no organization column, so tenancy is scoped
          // THROUGH the mapped account: a name match is only usable when its
          // accountId belongs to an Account of THIS organization. Unmapped
          // (accountId null) and foreign-org mappings are ignored — an
          // accountId from another org must never end up on our lines.
          const candidates = await prisma.expenseCategory.findMany({
            where: { name: { contains: category }, accountId: { not: null } },
            select: { accountId: true },
          });
          const candidateIds = [...new Set(candidates.map((c) => c.accountId as string))];
          if (candidateIds.length > 0) {
            const orgAccount = await prisma.account.findFirst({
              where: { id: { in: candidateIds }, organizationId },
              select: { id: true },
            });
            if (orgAccount) return orgAccount.id;
          }
          // No org-valid mapping — create the category bound to this org's
          // Suspense account, so it is org-safe by construction.
          const created = await prisma.expenseCategory.create({
            data: { name: category, accountId: suspenseId },
          });
          return created.accountId ?? suspenseId;
        })();
        categoryAccountIds.set(category, resolved);
      }
      return resolved;
    },

    resolveBankAccountId(): Promise<string> {
      bankAccountIdPromise ??= (async () => {
        // Primary bank by code, name-match fallback, then Suspense.
        const bank =
          (await prisma.account.findFirst({ where: { organizationId, code: '1000' } })) ??
          (await prisma.account.findFirst({
            where: { organizationId, name: { contains: 'Cash' } },
          }));
        return bank?.id ?? (await suspenseAccountId());
      })();
      return bankAccountIdPromise;
    },

    async postEntry(input: JournalEntryInput): Promise<{ entryId: string; created: boolean }> {
      // postEntryWithOutcome reports the REAL outcome: `created` is false
      // both when the key was already visible up front and when this call
      // lost a concurrent race (P2002 recovery) — so replayed batches and
      // race losers are counted as skipped_existing, never as posted.
      // postEntry runs each entry in its OWN transaction, giving the bridge
      // per-row atomicity — one bad row never aborts the batch.
      const { entry, created } = await LedgerService.postEntryWithOutcome(input);
      return { entryId: entry.id, created };
    },

    hasOpenFiscalPeriod(date: Date): Promise<boolean> {
      // The exact lookup LedgerService.checkFiscalPeriod performs, minus the
      // throw — the bridge PARKS uncovered rows (NO_FISCAL_PERIOD) instead of
      // failing them. Memoized per UTC day so a batch clustered in one month
      // does not issue a lookup per row. Must stay in lockstep with the
      // inOpenFiscalPeriod SQL fragment above.
      const day = date.toISOString().slice(0, 10);
      let known = fiscalPeriodByDay.get(day);
      if (!known) {
        known = prisma.fiscalPeriod
          .findFirst({
            where: {
              organizationId,
              startDate: { lte: date },
              endDate: { gte: date },
              isClosed: false,
              locked: false,
            },
            select: { id: true },
          })
          .then((period) => period !== null);
        fiscalPeriodByDay.set(day, known);
      }
      return known;
    },

    countRemainingEligible: () => countRemainingEligible(organizationId),
  };
}

/**
 * Run one batched bridge import for the organization. Idempotent — invoke
 * repeatedly until the summary reports `remaining: 0`. `remaining` counts
 * only rows importable in principle (unimported AND inside an open fiscal
 * period AND well-shaped), so deterministically parked rows can never keep
 * the loop alive.
 */
export async function runOcrBridgeImport(
  organizationId: string,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<OcrBridgeSummary> {
  const rows = await fetchStagingBatch(organizationId, batchSize);
  return importOcrReceipts(rows, createOcrBridgeDeps(organizationId), {
    organizationId,
    batchSize,
  });
}
