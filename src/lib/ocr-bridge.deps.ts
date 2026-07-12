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
} from './ocr-bridge';
import type { JournalEntryInput } from './types';

/**
 * Eligibility predicate (contract §2) as SQL, used both to drain eligible
 * rows first and to compute `remaining`. Must stay in lockstep with
 * classifyStagingRow in ocr-bridge.ts.
 */
const ELIGIBLE_PREDICATE = Prisma.sql`
  r.ocr_status = 'success'
  AND r.total_amount > 0
  AND r.doc_date IS NOT NULL
  AND r.currency = 'LKR'
`;

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
 * Eligible rows are ordered FIRST so parked rows (which are never imported
 * and therefore never leave the NOT EXISTS set) cannot permanently occupy
 * the batch window and starve postable rows behind them. `total_amount` is
 * cast to text so numeric(19,4) survives the driver without float loss.
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
    ORDER BY (CASE WHEN ${ELIGIBLE_PREDICATE} THEN 0 ELSE 1 END), r.id
    LIMIT ${batchSize}
  `;
}

/** Eligible rows still lacking a JournalEntry — the route's `remaining`. */
async function countRemainingEligible(organizationId: string): Promise<number> {
  const result = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM raj_fin_track.ocr_receipts r
    WHERE ${ELIGIBLE_PREDICATE}
      AND ${notYetImported(organizationId)}
  `;
  return result[0]?.n ?? 0;
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
          let expenseCategory = await prisma.expenseCategory.findFirst({
            where: { name: { contains: category } },
          });
          if (!expenseCategory) {
            expenseCategory = await prisma.expenseCategory.create({
              // Default to Suspense when no GL mapping exists yet.
              data: { name: category, accountId: suspenseId },
            });
          }
          return expenseCategory.accountId || suspenseId;
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
      // Pre-check so a replayed key is reported as skipped_existing rather
      // than silently absorbed by postEntry's idempotent fast path. postEntry
      // itself runs each entry in its OWN transaction, giving the bridge
      // per-row atomicity — one bad row never aborts the batch.
      const existing = await prisma.journalEntry.findFirst({
        where: { organizationId, idempotencyKey: input.idempotencyKey },
        select: { id: true },
      });
      if (existing) return { entryId: existing.id, created: false };

      const entry = await LedgerService.postEntry(input);
      return { entryId: entry.id, created: true };
    },

    countRemainingEligible: () => countRemainingEligible(organizationId),
  };
}

/**
 * Run one batched bridge import for the organization. Idempotent — invoke
 * repeatedly until the summary reports `remaining: 0`.
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
