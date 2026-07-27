/**
 * Statement upload card — pure render model for a StatementIngestReport.
 *
 * The upload card (src/components/StatementUploadCard.tsx) is deliberately
 * dumb rendering: no component test harness exists in this repo, so every
 * decision — tone, headline wording, the reconciliation-mismatch sentence,
 * detail ordering and capping — lives here where it is unit-testable
 * (tests/unit/statement-report-summary.test.ts).
 *
 * Type-only import of the report shape: statement-ingest pulls node:crypto,
 * which must not reach the client bundle. Types erase at compile time.
 */
import type { StatementIngestReport } from './statement-ingest';
import { parkReasonLabel } from './park-reason-labels';

export type SummaryTone = 'success' | 'warning' | 'error';
export type DetailTone = 'info' | 'warning' | 'error';

export interface SummaryDetail {
  tone: DetailTone;
  text: string;
}

export interface StatementReportSummary {
  tone: SummaryTone;
  headline: string;
  details: SummaryDetail[];
}

/** How many detail lines to show before collapsing to an "…and N more". */
export const SUMMARY_DETAIL_CAP = 8;

/**
 * ZERO_AMOUNT is statement-specific; the known park reasons reuse the shared
 * wording so Raj reads identical language across the sandbox. The summary is
 * user-facing, so an UNKNOWN reason must never surface as its raw code
 * (parkReasonLabel echoes unknown codes back) — it gets a plain-English
 * fallback instead.
 */
const STATEMENT_SKIP_REASONS = new Set(['FX_UNSUPPORTED', 'NO_FISCAL_PERIOD']);

function skipReasonLabel(reason: string): string {
  if (reason === 'ZERO_AMOUNT') return 'zero amount, nothing to book';
  if (STATEMENT_SKIP_REASONS.has(reason)) return parkReasonLabel(reason);
  return 'could not be imported for an unrecognised reason';
}

export function summarizeStatementReport(report: StatementIngestReport): StatementReportSummary {
  const reconciliationFailed =
    report.reconciliation !== null &&
    report.reconciliation.available &&
    !report.reconciliation.matches;

  // Tone precedence: hard failures beat warnings beat success. An
  // UNAVAILABLE reconciliation is not a warning — there was nothing to check.
  let tone: SummaryTone = 'success';
  if (report.failures.length > 0) tone = 'error';
  else if (report.collisionWarnings.length > 0 || reconciliationFailed) tone = 'warning';

  const headline =
    `${report.created} imported, ${report.deduped} already in books, ` +
    `${report.skipped.length} skipped` +
    (report.failures.length > 0 ? `, ${report.failures.length} failed` : '');

  // Most-severe-first, and the balance-check line always leads: it is the
  // one line that must never be scrolled past or capped away.
  const details: SummaryDetail[] = [];
  if (reconciliationFailed && report.reconciliation) {
    details.push({
      tone: 'warning',
      text:
        `Balance check failed: statement's own balances imply ` +
        `${report.reconciliation.expectedDelta} but parsed rows sum to ` +
        `${report.reconciliation.parsedSum} — do not trust this import until investigated.`,
    });
  }
  for (const failure of report.failures) {
    details.push({ tone: 'error', text: `Row ${failure.row} failed: ${failure.error}` });
  }
  for (const warning of report.collisionWarnings) {
    details.push({ tone: 'warning', text: warning.reason });
  }
  for (const skip of report.skipped) {
    details.push({ tone: 'info', text: `Row ${skip.row} skipped — ${skipReasonLabel(skip.reason)}.` });
  }

  if (details.length > SUMMARY_DETAIL_CAP) {
    const hidden = details.length - SUMMARY_DETAIL_CAP;
    details.length = SUMMARY_DETAIL_CAP;
    details.push({ tone: 'info', text: `…and ${hidden} more not shown.` });
  }

  return { tone, headline, details };
}
