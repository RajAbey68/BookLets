/**
 * Production wiring for the per-item ingest transport.
 *
 * Kept out of ingest-item.ts so the core stays free of prisma/OCR imports and
 * unit tests never touch a live database or the OCR microservice. Everything
 * here REUSES the existing service layer — the same OCR client, the same
 * LedgerService and the same hash-chained evidence log the single-shot zip
 * path used, so nothing about how money is recorded changes with the
 * transport.
 */
import { prisma } from './prisma';
import { extractReceipt } from './gemini-ocr';
import { LedgerService } from './ledger.service';
import { EvidenceLogService } from './evidence-log.service';
import { RateLimiter } from './upload-guard';
import { MAX_ZIP_ENTRIES, type ResolvedLedgerAccounts } from './zip-ingest';
import {
  ITEM_EVIDENCE_EVENT,
  type BatchItemEvidence,
  type BatchSummaryDeps,
  type ItemIngestDeps,
} from './ingest-item';

/**
 * Per-organisation fan-out bound for POST /api/ingest/item.
 *
 * The archive-wide MAX_ZIP_ENTRIES cap used to bound how much work one request
 * could ask for. One entry per request removes that lever, so the bound moves
 * here: a burst of 60 items, refilling at 3/second. A real import is far slower
 * than that (each item waits on an OCR round-trip, and the browser uploads at
 * concurrency 3), so this never throttles legitimate use — it only stops a
 * runaway loop or a hostile script from spending unbounded OCR budget.
 *
 * LIMITATION, inherited and unchanged: the bucket is per-process. Under
 * serverless each instance holds its own, so the effective global limit is
 * N × capacity. A hard global cap needs a shared store (Redis/Postgres); this
 * is defence-in-depth, not a billing control.
 */
export const itemRateLimiter = new RateLimiter({ capacity: 60, refillPerMinute: 180 });

export function buildDefaultItemIngestDeps(): ItemIngestDeps {
  return {
    ocr: (imageBase64) => extractReceipt(imageBase64),

    /**
     * postEntryWithOutcome (not postEntry) so a race-lost duplicate is
     * reported as a duplicate rather than counted as a fresh import. The
     * operator's "34 imported" has to be literally true.
     */
    async postEntry(input) {
      const { entry, created } = await LedgerService.postEntryWithOutcome(input);
      return { id: entry.id, created };
    },

    async findExistingIdempotencyKeys(organizationId, keys) {
      if (keys.length === 0) return new Set<string>();
      const rows = await prisma.journalEntry.findMany({
        where: { organizationId, idempotencyKey: { in: keys } },
        select: { idempotencyKey: true },
      });
      return new Set(rows.map((r) => r.idempotencyKey).filter((k): k is string => k !== null));
    },

    async resolveLedgerAccounts(organizationId): Promise<ResolvedLedgerAccounts> {
      // Identical conventions to zip-ingest.deps.ts: Suspense (9999) is
      // debited and a human reclassifies during four-eyes review; the credit
      // goes to Primary Bank (1000) or a "Cash" account.
      const suspense = await prisma.account.findFirst({
        where: { organizationId, code: '9999' },
        select: { id: true },
      });
      if (!suspense) {
        throw new Error(
          'Receipt import setup error: Suspense account (code 9999) is not seeded for this organization.',
        );
      }
      const bank =
        (await prisma.account.findFirst({
          where: { organizationId, code: '1000' },
          select: { id: true },
        })) ??
        (await prisma.account.findFirst({
          where: { organizationId, name: { contains: 'Cash', mode: 'insensitive' } },
          select: { id: true },
        }));
      if (!bank) {
        // Falling back to Suspense would debit and credit the SAME account —
        // a draft that nets to zero and looks balanced. Fail loudly instead.
        throw new Error(
          'Receipt import setup error: no bank/cash account (code 1000 or name containing "Cash") is seeded for this organization.',
        );
      }
      return { expenseAccountId: suspense.id, cashAccountId: bank.id };
    },

    async recordEvidence(input) {
      await EvidenceLogService.record(prisma, input);
    },
  };
}

export function buildDefaultBatchSummaryDeps(): BatchSummaryDeps {
  return {
    /**
     * Read back the server's own per-item evidence rows for this batch. The
     * completion summary is computed from these — never from a client tally —
     * so the audit trail records what the server did, not what a browser said
     * it did. Scoped by tenantId, so one org can never summarise another's.
     */
    async loadBatchItemEvidence(organizationId, batchId): Promise<BatchItemEvidence[]> {
      const rows = await prisma.evidenceLog.findMany({
        where: {
          tenantId: organizationId,
          eventType: ITEM_EVIDENCE_EVENT,
          payload: { path: ['batchId'], equals: batchId },
        },
        orderBy: { createdAt: 'asc' },
        // One archive can hold at most MAX_ZIP_ENTRIES items; the slack keeps
        // a retried item from silently truncating the summary.
        take: MAX_ZIP_ENTRIES + 50,
        select: { payload: true },
      });
      return rows.map((row) => {
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        return {
          name: typeof payload.entryName === 'string' ? payload.entryName : '(unnamed)',
          kind: typeof payload.kind === 'string' ? payload.kind : 'unknown',
          outcome: typeof payload.outcome === 'string' ? payload.outcome : 'unknown',
          ...(typeof payload.stage === 'string' ? { stage: payload.stage } : {}),
        };
      });
    },

    async recordEvidence(input) {
      await EvidenceLogService.record(prisma, input);
    },
  };
}
