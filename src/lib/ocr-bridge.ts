/**
 * S1b — staging→ledger bridge, pure core (contract:
 * docs/runs/S1B-BRIDGE-CONTRACT.md).
 *
 * Classifies `raj_fin_track.ocr_receipts` staging rows and turns eligible
 * ones into DRAFT JournalEntry inputs. This module is deliberately free of
 * Prisma / network imports — all IO is injected through {@link OcrBridgeDeps}
 * (production wiring lives in ocr-bridge.deps.ts), so the logic is unit
 * testable without a database.
 *
 * Dispositions (computed at run time — never hardcoded counts):
 *   POST              ocr_status='success' AND total_amount>0 AND doc_date
 *                     present AND currency='LKR' AND an open FiscalPeriod
 *                     covers doc_date → DRAFT journal entry.
 *   OCR_FAILED        ocr_status <> 'success' (re-OCR is devserver work, not ours).
 *   BAD_AMOUNT        total_amount NULL / non-numeric / <= 0.
 *   NO_DOC_DATE       doc_date missing — dates are NEVER fabricated from
 *                     processed_at; a human assigns them.
 *   FX_UNSUPPORTED    non-LKR currency — LKR books; no FX policy until S8.
 *   NO_FISCAL_PERIOD  doc_date is not covered by an OPEN FiscalPeriod — the
 *                     ledger's checkFiscalPeriod would reject it. Dates are
 *                     NEVER clamped into a period (contract §7); the row
 *                     parks until a human opens a covering period.
 *
 * Parked rows are only ever REPORTED in the summary; nothing is written back
 * to the staging schema (read-only territory) and nothing is invented into
 * the ledger.
 */

import { Decimal } from 'decimal.js';
import { gateAutomatedJournalEntry } from './approval.service';
import type { JournalEntryInput, JournalStatus } from './types';

/** Shape of a `raj_fin_track.ocr_receipts` row as read via $queryRaw. */
export interface OcrStagingRow {
  id: number;
  source_file: string;
  /** pg `date` arrives as Date; keep string tolerated for test/transport ease. */
  doc_date: Date | string | null;
  vendor_or_entity: string | null;
  /** pg numeric(19,4) is read as text to avoid float precision loss. */
  total_amount: string | number | null;
  currency: string | null;
  category: string | null;
  raw_response: unknown;
  ocr_status: string | null;
}

export type ParkReason =
  | 'OCR_FAILED'
  | 'NO_DOC_DATE'
  | 'BAD_AMOUNT'
  | 'FX_UNSUPPORTED'
  | 'NO_FISCAL_PERIOD';

export type RowClassification = { kind: 'POST' } | { kind: 'PARK'; reason: ParkReason };

/** IO surface the importer needs — implemented by ocr-bridge.deps.ts. */
export interface OcrBridgeDeps {
  /** Resolve-or-create the vendor by name (audit/master-data upkeep only). */
  ensureVendor(name: string): Promise<void>;
  /** category → ExpenseCategory → mapped GL account; Suspense (9999) fallback. */
  resolveExpenseAccountId(category: string | null): Promise<string>;
  /** Bank account (code 1000); Suspense fallback. */
  resolveBankAccountId(): Promise<string>;
  /**
   * Persist one DRAFT entry. `created: false` means the idempotency key was
   * already present (replayed batch / concurrent run) — a skip, not an error.
   */
  postEntry(input: JournalEntryInput): Promise<{ entryId: string; created: boolean }>;
  /**
   * True when an OPEN (not closed, not locked) FiscalPeriod of the org covers
   * the date — the same test LedgerService.checkFiscalPeriod applies before a
   * post. Rows failing it park as NO_FISCAL_PERIOD instead of failing postEntry.
   */
  hasOpenFiscalPeriod(date: Date): Promise<boolean>;
  /** Importable staging rows still lacking a JournalEntry — drives `remaining`. */
  countRemainingEligible(): Promise<number>;
}

export interface OcrBridgeSummary {
  posted: number;
  skipped_existing: number;
  failed: { id: number; error: string }[];
  parked: { reason: ParkReason; count: number; ids: number[] }[];
  /**
   * Total rows parked this run. Every ParkReason is deterministic (the row
   * cannot import until a human intervenes), so these rows are also excluded
   * from `remaining` — they never strand the re-invoke loop.
   */
  parkedPermanently: number;
  /**
   * Rows still importable in principle after this batch: not yet imported AND
   * not excluded by a deterministic park reason (OCR_FAILED / BAD_AMOUNT /
   * NO_DOC_DATE / FX_UNSUPPORTED / NO_FISCAL_PERIOD). Re-invoke until 0 —
   * parked rows can never hold this above 0, so the loop terminates.
   */
  remaining: number;
}

/** Contract §3: batched to fit the serverless time budget. */
export const DEFAULT_BATCH_SIZE = 50;

export const OCR_BRIDGE_SOURCE = 'OCR_RECEIPT';
export const OCR_BRIDGE_MAKER = 'booklets-automation-service';
export const OCR_BRIDGE_KEY_PREFIX = 'ocr-receipt:';

function parseAmount(value: OcrStagingRow['total_amount']): Decimal | null {
  if (value === null || value === undefined) return null;
  try {
    const d = new Decimal(String(value));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function parseDocDate(value: OcrStagingRow['doc_date']): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Eligibility per contract §2. Precedence mirrors the bucket table: OCR
 * failure first (the extraction is untrustworthy wholesale), then amount,
 * then date, then currency. NO_FISCAL_PERIOD is NOT decided here — it needs
 * IO (the FiscalPeriod table), so importOcrReceipts checks it via deps after
 * all pure reasons.
 */
export function classifyStagingRow(row: OcrStagingRow): RowClassification {
  if (row.ocr_status !== 'success') return { kind: 'PARK', reason: 'OCR_FAILED' };

  const amount = parseAmount(row.total_amount);
  if (!amount || amount.lessThanOrEqualTo(0)) return { kind: 'PARK', reason: 'BAD_AMOUNT' };

  if (!parseDocDate(row.doc_date)) return { kind: 'PARK', reason: 'NO_DOC_DATE' };

  if (row.currency !== 'LKR') return { kind: 'PARK', reason: 'FX_UNSUPPORTED' };

  return { kind: 'POST' };
}

/**
 * Extraction confidence from the staging row's raw OCR payload (top-level
 * `confidence` number), or null when absent. Range validation is NOT done
 * here — gateAutomatedJournalEntry rejects out-of-contract values loudly.
 */
export function extractConfidence(rawResponse: unknown): number | null {
  if (typeof rawResponse !== 'object' || rawResponse === null) return null;
  const confidence = (rawResponse as { confidence?: unknown }).confidence;
  return typeof confidence === 'number' ? confidence : null;
}

export interface BridgeAccountContext {
  organizationId: string;
  expenseAccountId: string;
  bankAccountId: string;
}

/**
 * Map one eligible staging row to a JournalEntryInput (contract §4).
 *
 * Status comes from gateAutomatedJournalEntry — ALWAYS DRAFT; there is no
 * parameter (and no gate branch) through which a caller or a confidence
 * score can force POSTED. Amounts stay Decimal end-to-end (numeric(19,4)),
 * never float.
 */
export function buildJournalInput(
  row: OcrStagingRow,
  ctx: BridgeAccountContext,
): JournalEntryInput & { date: Date; status: JournalStatus.DRAFT } {
  const date = parseDocDate(row.doc_date);
  if (!date) {
    // classifyStagingRow parks these before we get here; guard anyway.
    throw new Error(`Staging row ${row.id}: doc_date is missing or unparseable.`);
  }

  const amount = parseAmount(row.total_amount);
  if (!amount || amount.lessThanOrEqualTo(0)) {
    throw new Error(`Staging row ${row.id}: total_amount is not a positive number.`);
  }

  const confidence = extractConfidence(row.raw_response);
  // D3 gate: automated extraction ALWAYS lands as DRAFT. A missing confidence
  // is gated as 0 (grants nothing anyway); an out-of-range one throws here,
  // BEFORE any writes for the row.
  const gate = gateAutomatedJournalEntry(confidence ?? 0);

  return {
    organizationId: ctx.organizationId,
    date,
    memo: `AUTOMATED S1b: Receipt ${row.source_file} — ${row.vendor_or_entity ?? 'unknown vendor'}`,
    status: gate.status,
    makerIdentity: OCR_BRIDGE_MAKER,
    tenantId: ctx.organizationId,
    // Recorded for the audit trail only — grants no posting authority (D3).
    agentConfidence: confidence,
    idempotencyKey: `${OCR_BRIDGE_KEY_PREFIX}${row.source_file}`,
    source: OCR_BRIDGE_SOURCE,
    sourceId: String(row.id),
    lines: [
      { accountId: ctx.expenseAccountId, amount, isDebit: true, currency: 'LKR' },
      { accountId: ctx.bankAccountId, amount, isDebit: false, currency: 'LKR' },
    ],
  };
}

/**
 * Import one batch of staging rows into the ledger.
 *
 * Per-row failure isolation: each POST row is attempted independently (the
 * underlying LedgerService.postEntry already runs each entry in its own
 * transaction), so one bad row lands in `failed` without aborting the batch.
 * Idempotency conflicts count as `skipped_existing`. The returned summary
 * always reconciles: posted + skipped_existing + failed + Σparked = rows
 * processed (≤ batchSize).
 *
 * Rows whose doc_date no open FiscalPeriod covers park as NO_FISCAL_PERIOD
 * BEFORE any vendor/account/post IO — they must not reach postEntry (where
 * checkFiscalPeriod would throw and strand them in `failed` forever) and
 * their dates are never clamped into a period (contract §7).
 */
export async function importOcrReceipts(
  rows: readonly OcrStagingRow[],
  deps: OcrBridgeDeps,
  opts: { organizationId: string; batchSize?: number },
): Promise<OcrBridgeSummary> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const batch = rows.slice(0, batchSize);

  let posted = 0;
  let skippedExisting = 0;
  const failed: OcrBridgeSummary['failed'] = [];
  const parkedByReason = new Map<ParkReason, number[]>();
  const park = (reason: ParkReason, id: number) => {
    const ids = parkedByReason.get(reason) ?? [];
    ids.push(id);
    parkedByReason.set(reason, ids);
  };

  for (const row of batch) {
    const classification = classifyStagingRow(row);

    if (classification.kind === 'PARK') {
      park(classification.reason, row.id);
      continue;
    }

    try {
      // Fiscal-period gate: LedgerService.checkFiscalPeriod rejects any date
      // outside an open period, so detect that here and PARK — never let the
      // row reach postEntry (a permanent `failed` on every run) and never
      // shift its date into a period (contract §7 forbids date fabrication).
      const docDate = parseDocDate(row.doc_date);
      if (docDate && !(await deps.hasOpenFiscalPeriod(docDate))) {
        park('NO_FISCAL_PERIOD', row.id);
        continue;
      }

      // Confidence gate (throws on out-of-contract values) so a broken
      // extraction fails BEFORE any vendor/category rows are created.
      gateAutomatedJournalEntry(extractConfidence(row.raw_response) ?? 0);

      if (row.vendor_or_entity) {
        await deps.ensureVendor(row.vendor_or_entity);
      }

      const expenseAccountId = await deps.resolveExpenseAccountId(row.category);
      const bankAccountId = await deps.resolveBankAccountId();

      const input = buildJournalInput(row, {
        organizationId: opts.organizationId,
        expenseAccountId,
        bankAccountId,
      });

      const result = await deps.postEntry(input);
      if (result.created) {
        posted += 1;
      } else {
        skippedExisting += 1;
      }
    } catch (err) {
      failed.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const parked = [...parkedByReason.entries()].map(([reason, ids]) => ({
    reason,
    count: ids.length,
    ids,
  }));

  return {
    posted,
    skipped_existing: skippedExisting,
    failed,
    parked,
    parkedPermanently: parked.reduce((acc, p) => acc + p.count, 0),
    remaining: await deps.countRemainingEligible(),
  };
}
