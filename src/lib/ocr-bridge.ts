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
 *   POST            ocr_status='success' AND total_amount>0 AND doc_date
 *                   present AND currency='LKR' → DRAFT journal entry.
 *   OCR_FAILED      ocr_status <> 'success' (re-OCR is devserver work, not ours).
 *   BAD_AMOUNT      total_amount NULL / non-numeric / <= 0.
 *   NO_DOC_DATE     doc_date missing — dates are NEVER fabricated from
 *                   processed_at; a human assigns them.
 *   FX_UNSUPPORTED  non-LKR currency — LKR books; no FX policy until S8.
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

export type ParkReason = 'OCR_FAILED' | 'NO_DOC_DATE' | 'BAD_AMOUNT' | 'FX_UNSUPPORTED';

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
  /** Eligible staging rows still lacking a JournalEntry — drives `remaining`. */
  countRemainingEligible(): Promise<number>;
}

export interface OcrBridgeSummary {
  posted: number;
  skipped_existing: number;
  failed: { id: number; error: string }[];
  parked: { reason: ParkReason; count: number; ids: number[] }[];
  /** Eligible rows still unimported after this batch; re-invoke until 0. */
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
 * then date, then currency.
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

  for (const row of batch) {
    const classification = classifyStagingRow(row);

    if (classification.kind === 'PARK') {
      const ids = parkedByReason.get(classification.reason) ?? [];
      ids.push(row.id);
      parkedByReason.set(classification.reason, ids);
      continue;
    }

    try {
      // Gate first (throws on out-of-contract confidence) so a broken
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
    remaining: await deps.countRemainingEligible(),
  };
}
