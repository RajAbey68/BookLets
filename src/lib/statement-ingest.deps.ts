/**
 * Bank-statement CSV importer — production wiring.
 *
 * Kept out of statement-ingest.ts so the core stays free of prisma imports
 * and unit tests never touch a live database. Everything here REUSES the
 * existing service layer:
 *   - ledger.service.ts    → postEntry (idempotent, evidence-logged, DRAFT)
 *   - evidence-log.service → hash-chained audit rows
 */
import { prisma } from './prisma';
import { LedgerService } from './ledger.service';
import { EvidenceLogService } from './evidence-log.service';
import type { ResolvedStatementAccounts, StatementIngestDeps } from './statement-ingest';

export function buildDefaultStatementIngestDeps(): StatementIngestDeps {
  return {
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

    async resolveStatementAccounts(organizationId): Promise<ResolvedStatementAccounts> {
      // Same account conventions as zip-ingest / AutomationService: Suspense
      // (9999) and Primary Bank (1000) are seeded per organisation. The
      // counterparty leg always books to Suspense — a human recategorizes it
      // during four-eyes draft review (statements carry no category).
      const suspense = await prisma.account.findFirst({
        where: { organizationId, code: '9999' },
        select: { id: true },
      });
      if (!suspense) {
        throw new Error(
          'Statement ingest setup error: Suspense account (code 9999) is not seeded for this organization.',
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
          'Statement ingest setup error: no bank/cash account (code 1000 or name containing "Cash") is seeded for this organization.',
        );
      }
      return {
        bankAccountId: bank.id,
        suspenseAccountId: suspense.id,
      };
    },

    async hasOpenFiscalPeriod(organizationId, date) {
      // The exact lookup LedgerService.checkFiscalPeriod performs, minus the
      // throw — uncovered rows SKIP as NO_FISCAL_PERIOD instead of failing.
      // The core memoizes per UTC day, so no per-row query fan-out here.
      const period = await prisma.fiscalPeriod.findFirst({
        where: {
          organizationId,
          startDate: { lte: date },
          endDate: { gte: date },
          isClosed: false,
          locked: false,
        },
        select: { id: true },
      });
      return period !== null;
    },

    async recordEvidence(input) {
      await EvidenceLogService.record(prisma, input);
    },
  };
}
