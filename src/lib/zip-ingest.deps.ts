/**
 * S5 — production wiring for zip ingestion.
 *
 * Kept out of zip-ingest.ts so the core stays free of prisma/OCR imports
 * and unit tests never touch a live database or the OCR microservice.
 * Everything here REUSES the existing service layer:
 *   - gemini-ocr.ts        → OCR microservice with SymbiOS fallback
 *   - ledger.service.ts    → postEntry (idempotent, evidence-logged, DRAFT)
 *   - evidence-log.service → hash-chained audit rows
 */
import { prisma } from './prisma';
import { extractReceipt } from './gemini-ocr';
import { LedgerService } from './ledger.service';
import { EvidenceLogService } from './evidence-log.service';
import type { ResolvedLedgerAccounts, ZipIngestDeps } from './zip-ingest';

export function buildDefaultZipIngestDeps(): ZipIngestDeps {
  return {
    ocr: (imageBase64) => extractReceipt(imageBase64),

    postEntry: (input) => LedgerService.postEntry(input),

    async findExistingIdempotencyKeys(organizationId, keys) {
      if (keys.length === 0) return new Set<string>();
      const rows = await prisma.journalEntry.findMany({
        where: { organizationId, idempotencyKey: { in: keys } },
        select: { idempotencyKey: true },
      });
      return new Set(
        rows.map((r) => r.idempotencyKey).filter((k): k is string => k !== null),
      );
    },

    async resolveLedgerAccounts(organizationId): Promise<ResolvedLedgerAccounts> {
      // Same account conventions as AutomationService.processReceipt:
      // Suspense (9999) and Primary Bank (1000) are seeded per organisation.
      // Drafts debit Suspense — a human reclassifies during four-eyes review.
      const suspense = await prisma.account.findFirst({
        where: { organizationId, code: '9999' },
        select: { id: true },
      });
      if (!suspense) {
        throw new Error(
          'Zip ingest setup error: Suspense account (code 9999) is not seeded for this organization.',
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
        // Falling back to the suspense account would produce a degenerate
        // draft that debits and credits the SAME account (nets to zero) —
        // a silent misbooking. Fail loudly, symmetric with the guard above.
        throw new Error(
          'Zip ingest setup error: no bank/cash account (code 1000 or name containing "Cash") is seeded for this organization.',
        );
      }
      return {
        expenseAccountId: suspense.id,
        cashAccountId: bank.id,
      };
    },

    async recordEvidence(input) {
      await EvidenceLogService.record(prisma, input);
    },
  };
}
