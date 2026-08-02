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
import { assertSameCurrency } from './zip-ingest';
import type { ResolvedLedgerAccounts, ZipIngestDeps } from './zip-ingest';

/**
 * The FiscalPeriod lookups the import cores use to fail BEFORE OCR spend.
 *
 * Both run exactly the query LedgerService.checkFiscalPeriod runs (an open
 * period is one that is neither closed nor locked) — they must stay in
 * lockstep with it, or a receipt passes the pre-flight and is then rejected at
 * the post, which is the failure mode this whole change exists to remove.
 *
 * `hasOpenFiscalPeriodFor` is memoized per UTC day for the lifetime of the
 * deps object (one request), so an archive whose receipts cluster in one month
 * does not issue a lookup per photo. Nothing is cached ACROSS requests: a
 * period opened in another tab must take effect on the very next import.
 */
export function buildFiscalPeriodChecks() {
  const byDay = new Map<string, Promise<boolean>>();

  const coversDate = (organizationId: string, date: Date): Promise<boolean> => {
    const key = `${organizationId}|${date.toISOString().slice(0, 10)}`;
    let known = byDay.get(key);
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
      byDay.set(key, known);
    }
    return known;
  };

  return {
    async hasAnyOpenFiscalPeriod(organizationId: string): Promise<boolean> {
      const period = await prisma.fiscalPeriod.findFirst({
        where: { organizationId, isClosed: false, locked: false },
        select: { id: true },
      });
      return period !== null;
    },
    hasOpenFiscalPeriodFor: coversDate,
  };
}

export function buildDefaultZipIngestDeps(): ZipIngestDeps {
  return {
    ...buildFiscalPeriodChecks(),

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
        select: { id: true, currency: true },
      });
      if (!suspense) {
        throw new Error(
          'Zip ingest setup error: Suspense account (code 9999) is not seeded for this organization.',
        );
      }
      const bank =
        (await prisma.account.findFirst({
          where: { organizationId, code: '1000' },
          select: { id: true, currency: true },
        })) ??
        (await prisma.account.findFirst({
          where: { organizationId, name: { contains: 'Cash', mode: 'insensitive' } },
          select: { id: true, currency: true },
        }));
      if (!bank) {
        // Falling back to the suspense account would produce a degenerate
        // draft that debits and credits the SAME account (nets to zero) —
        // a silent misbooking. Fail loudly, symmetric with the guard above.
        throw new Error(
          'Zip ingest setup error: no bank/cash account (code 1000 or name containing "Cash") is seeded for this organization.',
        );
      }
      assertSameCurrency(suspense.currency, bank.currency);
      return {
        expenseAccountId: suspense.id,
        cashAccountId: bank.id,
        // The line currency is a fact about the account, not a database
        // default. JournalLine.currency defaults to "EUR" at the schema level,
        // so an omitted value silently stamped EUR onto an all-LKR chart of
        // accounts — 270 lines before anyone noticed.
        //
        // Both accounts are verified to agree above, so one value is the
        // truthful currency of both lines.
        currency: suspense.currency,
      };
    },

    async recordEvidence(input) {
      await EvidenceLogService.record(prisma, input);
    },
  };
}
