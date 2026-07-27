/**
 * Bank-statement CSV importer (pure core, no prisma/network imports).
 *
 * Turns a bank-statement CSV export (Wise format auto-detected; generic
 * Date/Amount/Description mapping otherwise) into DRAFT journal entries with
 * PER-TRANSACTION deduplication. Before this module, statement rows had no
 * line-level dedup: re-uploading a statement (or two overlapping exports)
 * double-counted every shared transaction silently — the exact failure mode
 * that produced the Ko Lake sandbox duplicates.
 *
 * Dedup rides three layers (mirroring zip-ingest):
 *   (a) duplicate natural keys within THIS file are collapsed,
 *   (b) findExistingIdempotencyKeys pre-checks the ledger before creating,
 *   (c) the EXISTING JournalEntry (organizationId, idempotencyKey) unique
 *       index backstops concurrent races — no new migration is needed.
 *
 * Rows never silently vanish: every data row lands in exactly one of
 * created / deduped / skipped(reason) / failures, and the summary reconciles.
 * Dates are NEVER clamped or fabricated (ocr-bridge contract §7): rows outside
 * any open FiscalPeriod skip as NO_FISCAL_PERIOD until a human opens one.
 *
 * All IO (ledger writes, key pre-check, account/period lookup, evidence log)
 * is injected via StatementIngestDeps so unit tests run with zero DB calls.
 * Production wiring lives in ./statement-ingest.deps.ts.
 */
import { Decimal } from 'decimal.js';
import { createHash } from 'node:crypto';
import { AUTOMATION_MAKER_IDENTITY } from './maker-identity';
import { JournalStatus, type JournalEntryInput } from './types';
import type { EvidenceInput } from './zip-ingest';

// ─── contract constants ───────────────────────────────────────────────────────

/** Hard cap on the uploaded CSV: 5 MB (a decade of statements fits well under). */
export const MAX_STATEMENT_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Hard cap on data rows in one statement. */
export const MAX_STATEMENT_ROWS = 10_000;

/** Provenance marker persisted on JournalEntry.source. */
export const STATEMENT_INGEST_SOURCE = 'STATEMENT_INGEST';

/**
 * Status for every journal entry this module creates. Statement rows carry no
 * category or counterparty account — they are born DRAFT unconditionally (no
 * parameter can force POSTED) and only the four-eyes approval flow promotes.
 */
export const STATEMENT_INGEST_JOURNAL_STATUS = JournalStatus.DRAFT;

/** Domain prefix folded into every idempotency key (see key construction). */
const STATEMENT_KEY_DOMAIN = 'stmt-ingest';

// ─── errors ───────────────────────────────────────────────────────────────────

export type StatementIngestGuardCode =
  | 'INVALID_CSV'
  | 'MISSING_COLUMNS'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_ROWS';

export class StatementIngestError extends Error {
  readonly code: StatementIngestGuardCode;

  constructor(code: StatementIngestGuardCode, message: string) {
    super(message);
    this.name = 'StatementIngestError';
    this.code = code;
  }
}

// ─── types ────────────────────────────────────────────────────────────────────

export interface StatementIngestLimits {
  maxUploadBytes: number;
  maxRows: number;
}

const DEFAULT_LIMITS: StatementIngestLimits = {
  maxUploadBytes: MAX_STATEMENT_UPLOAD_BYTES,
  maxRows: MAX_STATEMENT_ROWS,
};

export interface StatementColumnMap {
  format: 'wise' | 'generic';
  /** Column indexes into each parsed record; null = column absent. */
  id: number | null;
  date: number;
  amount: number;
  currency: number | null;
  description: number;
  runningBalance: number | null;
}

export type StatementSkipReason = 'ZERO_AMOUNT' | 'FX_UNSUPPORTED' | 'NO_FISCAL_PERIOD';

export interface StatementIngestReport {
  /** sha256 hex of the uploaded file bytes. */
  statementHash: string;
  /** Data rows (header excluded). */
  totalRows: number;
  created: number;
  /** In-file duplicates + rows whose key already exists in the ledger. */
  deduped: number;
  /** Row numbers are spreadsheet-style: the header is row 1. */
  skipped: { row: number; reason: StatementSkipReason }[];
  failures: { row: number; error: string }[];
  /** Sums over CREATED entries only, as 2dp strings (Decimal, never Number). */
  inflowTotal: string;
  outflowTotal: string;
}

export interface StatementIngestContext {
  organizationId: string;
  userId: string;
}

export interface ResolvedStatementAccounts {
  bankAccountId: string;
  suspenseAccountId: string;
}

/**
 * Injectable IO surface. Unit tests supply in-memory fakes; production uses
 * buildDefaultStatementIngestDeps() (prisma + LedgerService backed).
 */
export interface StatementIngestDeps {
  postEntry: (input: JournalEntryInput) => Promise<{ id: string }>;
  /** Application-level idempotency pre-check: which keys already exist? */
  findExistingIdempotencyKeys: (organizationId: string, keys: string[]) => Promise<Set<string>>;
  resolveStatementAccounts: (organizationId: string) => Promise<ResolvedStatementAccounts>;
  /**
   * True when an OPEN (not closed, not locked) FiscalPeriod of the org covers
   * the date — the same test LedgerService.checkFiscalPeriod applies. Rows
   * failing it skip as NO_FISCAL_PERIOD instead of failing postEntry.
   */
  hasOpenFiscalPeriod: (organizationId: string, date: Date) => Promise<boolean>;
  recordEvidence: (input: EvidenceInput) => Promise<void>;
}

// ─── CSV parsing ──────────────────────────────────────────────────────────────

/**
 * Minimal RFC-4180 parser (no npm dependency): quoted fields may contain
 * commas, newlines and doubled quotes; CRLF and LF records both accepted.
 * Fully-empty records are dropped (trailing newline, blank separator lines).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // CRLF: the following \n terminates the record; a stray \r is dropped.
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (inQuotes) {
    throw new StatementIngestError(
      'INVALID_CSV',
      'Unterminated quoted field — the CSV is truncated or malformed.',
    );
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

// ─── header detection ─────────────────────────────────────────────────────────

/** Header names accepted for the bank-transaction-ID column (normalized). */
const ID_HEADER_NAMES = ['transferwise id', 'id', 'transaction id', 'reference'];

/**
 * Map header cells to columns. The Wise export format (ID + Date + Amount +
 * Currency + Description + Running Balance) is auto-detected; anything else
 * falls back to the generic mapping, which requires at least Date, Amount and
 * Description (case-insensitive) with Currency / Running Balance / ID optional.
 */
export function detectColumns(header: readonly string[]): StatementColumnMap {
  // BOM-strip the first cell: exports from Excel/Wise routinely carry one.
  const normalized = header.map((cell) => cell.replace(/^﻿/, '').trim().toLowerCase());
  const indexOf = (...names: string[]): number | null => {
    for (const name of names) {
      const index = normalized.indexOf(name);
      if (index !== -1) return index;
    }
    return null;
  };

  const id = indexOf(...ID_HEADER_NAMES);
  const date = indexOf('date');
  const amount = indexOf('amount');
  const currency = indexOf('currency');
  const description = indexOf('description');
  const runningBalance = indexOf('running balance');

  if (date === null || amount === null || description === null) {
    throw new StatementIngestError(
      'MISSING_COLUMNS',
      'Statement header must contain at least Date, Amount and Description columns.',
    );
  }

  const isWise =
    id !== null && currency !== null && runningBalance !== null;

  return {
    format: isWise ? 'wise' : 'generic',
    id,
    date,
    amount,
    currency,
    description,
    runningBalance,
  };
}

// ─── row parsing helpers ──────────────────────────────────────────────────────

/** Trim, collapse internal whitespace, lowercase — the hash-key normal form. */
export function normalizeDescription(description: string): string {
  return description.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Statement dates: ISO (yyyy-mm-dd, optional time suffix) or day-first
 * dd-mm-yyyy / dd/mm/yyyy (Wise + Sri Lanka locale). Month-first formats are
 * NOT guessed — an ambiguous export must fail loudly, never mis-date entries.
 * Returns a UTC-midnight Date, or null when unparseable/impossible.
 */
export function parseStatementDate(raw: string): Date | null {
  const value = raw.trim();
  let year: number;
  let month: number;
  let day: number;

  let match = /^(\d{4})-(\d{2})-(\d{2})([ T].*)?$/.exec(value);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else if ((match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(value))) {
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  } else {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  // Round-trip check rejects impossible dates (31-02-2026 etc.).
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return valid ? date : null;
}

/**
 * Statement amounts: optional sign, thousands separators tolerated, decimal
 * point. Parsed with decimal.js — money NEVER touches Number (float) here.
 * Returns null when unparseable.
 */
export function parseStatementAmount(raw: string): Decimal | null {
  const value = raw.trim().replace(/,/g, '');
  if (!/^[+-]?\d+(\.\d+)?$/.test(value)) return null;
  try {
    const amount = new Decimal(value);
    return amount.isFinite() ? amount : null;
  } catch {
    return null;
  }
}

// ─── keys ─────────────────────────────────────────────────────────────────────

export interface StatementRowKeyParts {
  bankTransactionId: string | null;
  /** Canonical yyyy-mm-dd. */
  dateIso: string;
  /** Canonical Decimal.toString() — "45.00" and "45.0" collapse to "45". */
  amount: string;
  currency: string;
  /** Raw description; normalized inside. */
  description: string;
  /** Trimmed raw running-balance cell, '' when the column is absent. */
  runningBalance: string;
}

/**
 * Natural key for one statement row: the bank's own transaction ID when the
 * export carries one (authoritative — survives description/format changes
 * between exports), else a sha256 over the canonicalized row fields
 * date|amount|currency|normalizedDescription|runningBalance. The running
 * balance disambiguates genuinely repeated transactions (same amount, same
 * day, same description) in ID-less exports.
 */
export function computeNaturalKey(parts: StatementRowKeyParts): string {
  const bankId = parts.bankTransactionId?.trim();
  if (bankId) return bankId;
  const material = [
    parts.dateIso,
    parts.amount,
    parts.currency,
    normalizeDescription(parts.description),
    parts.runningBalance,
  ].join('|');
  return createHash('sha256').update(material).digest('hex');
}

/**
 * Deterministic idempotency key for one statement row:
 *
 *   key = sha256("stmt-ingest" ‖ NUL ‖ organizationId ‖ NUL ‖ naturalKey)
 *
 * Same construction style as computeEntryIdempotencyKey in zip-ingest —
 * domain-prefixed and NUL-delimited so keys can never collide across ingest
 * sources or organizations. Written to JournalEntry.idempotencyKey, whose
 * EXISTING (organizationId, idempotencyKey) unique index is the enforcement
 * backstop — no new migration is needed or allowed for this feature.
 */
export function computeStatementIdempotencyKey(
  organizationId: string,
  naturalKey: string,
): string {
  const material = [STATEMENT_KEY_DOMAIN, organizationId, naturalKey].join('\u0000');
  return createHash('sha256').update(material).digest('hex');
}

export function computeStatementHash(csvBuffer: Buffer): string {
  return createHash('sha256').update(csvBuffer).digest('hex');
}

// ─── ingestion orchestration ──────────────────────────────────────────────────

interface RowCandidate {
  rowNumber: number;
  date: Date;
  amount: Decimal;
  description: string;
  naturalKey: string;
  idempotencyKey: string;
}

/**
 * Full pipeline: guards → parse → per-row classify → dedupe (in-file, then
 * ledger pre-check) → fiscal-period gate → DRAFT entries → summary evidence.
 * Per-row failures (unparseable cells, postEntry errors) are reported in
 * `failures`, never fatal for the rest of the file.
 */
export async function ingestStatement(
  csvBuffer: Buffer,
  ctx: StatementIngestContext,
  deps: StatementIngestDeps,
  limits: Partial<StatementIngestLimits> = {},
): Promise<StatementIngestReport> {
  const cfg: StatementIngestLimits = { ...DEFAULT_LIMITS, ...limits };

  if (csvBuffer.length > cfg.maxUploadBytes) {
    throw new StatementIngestError(
      'FILE_TOO_LARGE',
      `Statement exceeds the ${Math.floor(cfg.maxUploadBytes / (1024 * 1024))} MB upload limit.`,
    );
  }

  const statementHash = computeStatementHash(csvBuffer);
  const records = parseCsv(csvBuffer.toString('utf8'));
  if (records.length === 0) {
    throw new StatementIngestError('INVALID_CSV', 'The file contains no CSV records.');
  }

  const columns = detectColumns(records[0]);
  const dataRows = records.slice(1);
  if (dataRows.length > cfg.maxRows) {
    throw new StatementIngestError(
      'TOO_MANY_ROWS',
      `Statement has ${dataRows.length} data rows; the limit is ${cfg.maxRows}.`,
    );
  }

  const skipped: StatementIngestReport['skipped'] = [];
  const failures: StatementIngestReport['failures'] = [];

  // Pass 1 — parse + classify each row, collapsing in-file duplicate keys
  // (layer a): the same transaction listed twice in one export must not
  // survive the ledger pre-check and then collide on the unique constraint.
  const candidatesByKey = new Map<string, RowCandidate>();
  let inFileDuplicates = 0;

  for (const [index, cells] of dataRows.entries()) {
    // Spreadsheet-style numbering (header = row 1) so users can locate rows.
    const rowNumber = index + 2;
    const cell = (column: number | null): string =>
      column !== null && column < cells.length ? cells[column] : '';

    const date = parseStatementDate(cell(columns.date));
    if (!date) {
      failures.push({ row: rowNumber, error: `Unparseable date "${cell(columns.date)}".` });
      continue;
    }

    const amount = parseStatementAmount(cell(columns.amount));
    if (!amount) {
      failures.push({ row: rowNumber, error: `Unparseable amount "${cell(columns.amount)}".` });
      continue;
    }
    if (amount.isZero()) {
      // Zero-value rows (card notifications, FX quotes) book nothing.
      skipped.push({ row: rowNumber, reason: 'ZERO_AMOUNT' });
      continue;
    }

    // LKR-only books (same policy as ocr-bridge FX_UNSUPPORTED): a missing
    // Currency column means a local-bank export and is taken as LKR; a
    // present column must literally say LKR.
    const currency =
      columns.currency === null ? 'LKR' : cell(columns.currency).trim().toUpperCase();
    if (currency !== 'LKR') {
      skipped.push({ row: rowNumber, reason: 'FX_UNSUPPORTED' });
      continue;
    }

    const naturalKey = computeNaturalKey({
      bankTransactionId: columns.id === null ? null : cell(columns.id),
      dateIso: date.toISOString().slice(0, 10),
      amount: amount.toString(),
      currency,
      description: cell(columns.description),
      runningBalance: columns.runningBalance === null ? '' : cell(columns.runningBalance).trim(),
    });
    const idempotencyKey = computeStatementIdempotencyKey(ctx.organizationId, naturalKey);

    if (candidatesByKey.has(idempotencyKey)) {
      inFileDuplicates += 1;
      continue;
    }
    candidatesByKey.set(idempotencyKey, {
      rowNumber,
      date,
      amount,
      description: cell(columns.description),
      naturalKey,
      idempotencyKey,
    });
  }

  // Layer (b) — ledger pre-check before creating anything. Layer (c), the DB
  // unique constraint, backstops any race that slips past this read.
  const candidates = [...candidatesByKey.values()];
  const existingKeys = await deps.findExistingIdempotencyKeys(
    ctx.organizationId,
    candidates.map((candidate) => candidate.idempotencyKey),
  );
  const fresh = candidates.filter((candidate) => !existingKeys.has(candidate.idempotencyKey));
  // Deduped counts BOTH in-file duplicates and already-ingested keys.
  const deduped = inFileDuplicates + (candidates.length - fresh.length);

  // Fiscal-period gate on fresh rows only (deduped rows already booked once).
  // Memoized per UTC day; dates are NEVER clamped into a period — the row
  // skips until a human opens a covering period (ocr-bridge contract §7).
  const periodKnownByDay = new Map<string, Promise<boolean>>();
  const postable: RowCandidate[] = [];
  for (const candidate of fresh) {
    const day = candidate.date.toISOString().slice(0, 10);
    let known = periodKnownByDay.get(day);
    if (!known) {
      known = deps.hasOpenFiscalPeriod(ctx.organizationId, candidate.date);
      periodKnownByDay.set(day, known);
    }
    if (await known) {
      postable.push(candidate);
    } else {
      skipped.push({ row: candidate.rowNumber, reason: 'NO_FISCAL_PERIOD' });
    }
  }

  const accounts =
    postable.length > 0 ? await deps.resolveStatementAccounts(ctx.organizationId) : null;

  let created = 0;
  let inflowTotal = new Decimal(0);
  let outflowTotal = new Decimal(0);

  for (const candidate of postable) {
    // Statements carry no expense category — both directions book against
    // Suspense (9999) and the entry is born DRAFT so a human recategorizes
    // the Suspense leg during draft review:
    //   outflow (negative) → debit Suspense, credit Bank
    //   inflow  (positive) → debit Bank,     credit Suspense
    const magnitude = candidate.amount.abs();
    const isOutflow = candidate.amount.isNegative();
    const debitAccountId = isOutflow ? accounts!.suspenseAccountId : accounts!.bankAccountId;
    const creditAccountId = isOutflow ? accounts!.bankAccountId : accounts!.suspenseAccountId;

    try {
      await deps.postEntry({
        organizationId: ctx.organizationId,
        date: candidate.date,
        memo: `STATEMENT-INGEST: ${candidate.description.trim() || '(no description)'}`,
        // DRAFT unconditionally — only four-eyes approval promotes to POSTED.
        status: STATEMENT_INGEST_JOURNAL_STATUS,
        makerIdentity: AUTOMATION_MAKER_IDENTITY,
        tenantId: ctx.organizationId,
        // No extraction confidence exists for a statement row — explicit NULL.
        agentConfidence: null,
        idempotencyKey: candidate.idempotencyKey,
        source: STATEMENT_INGEST_SOURCE,
        sourceId: candidate.naturalKey,
        lines: [
          { accountId: debitAccountId, amount: magnitude, isDebit: true, currency: 'LKR' },
          { accountId: creditAccountId, amount: magnitude, isDebit: false, currency: 'LKR' },
        ],
      });
      created += 1;
      if (isOutflow) outflowTotal = outflowTotal.plus(magnitude);
      else inflowTotal = inflowTotal.plus(magnitude);
    } catch (err) {
      failures.push({
        row: candidate.rowNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Skips/failures accumulate across two phases — restore file order.
  skipped.sort((a, b) => a.row - b.row);
  failures.sort((a, b) => a.row - b.row);

  const report: StatementIngestReport = {
    statementHash,
    totalRows: dataRows.length,
    created,
    deduped,
    skipped,
    failures,
    inflowTotal: inflowTotal.toFixed(2),
    outflowTotal: outflowTotal.toFixed(2),
  };

  await deps.recordEvidence({
    eventType: 'STATEMENT_INGEST_COMPLETED',
    tenantId: ctx.organizationId,
    makerIdentity: AUTOMATION_MAKER_IDENTITY,
    description: `Statement ingest ${statementHash.slice(0, 12)}: ${created} draft entries created, ${deduped} deduped, ${skipped.length} skipped, ${failures.length} failures.`,
    payload: {
      statementHash: report.statementHash,
      totalRows: report.totalRows,
      created: report.created,
      deduped: report.deduped,
      skipped: report.skipped,
      failures: report.failures,
      inflowTotal: report.inflowTotal,
      outflowTotal: report.outflowTotal,
    },
  });

  return report;
}
