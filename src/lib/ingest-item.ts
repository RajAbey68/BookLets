/**
 * Per-ITEM ingest core — the server half of the per-entry upload transport.
 *
 * The browser now expands the WhatsApp archive (zip-reader.ts) and POSTs one
 * entry per request, because Vercel's edge rejects bodies over ~4.5 MB before
 * the function runs and a real "Export Chat → Attach Media" archive is tens of
 * MB. That moves the EXPANSION to the client. It does not move the trust
 * boundary — this module re-applies, to bytes the server actually received,
 * every guard inspectZip used to apply to an entry:
 *
 *   uncompressed size cap  → MAX_ITEM_BYTES, checked on the received bytes
 *                            (the route ALSO aborts the body stream at the cap
 *                            so an oversize upload never finishes buffering)
 *   path traversal         → sanitizeEntryName. This is now the REAL control:
 *                            filenames arrive as client-supplied text, not out
 *                            of a zip central directory the server parsed.
 *   type allowlist         → classifyEntryName on the extension, then
 *                            assertImageMagicBytes on the real leading bytes.
 *                            Extension is a hint; magic bytes are the control.
 *   entry-count cap        → one item per request, plus a per-organisation
 *                            token bucket on the route (ingest-item.deps.ts).
 *   zip-bomb ratio         → structurally not applicable: this server inflates
 *                            nothing. The guard protected a decompressor from
 *                            amplification; the only decompressor left is the
 *                            user's own browser, where zip-reader still runs it.
 *
 * MONEY CORRECTNESS
 * The idempotency key is produced by the SAME function the single-shot zip
 * path uses — computeEntryIdempotencyKey(organizationId, sha256(entryBytes)) —
 * imported rather than reimplemented so the two transports cannot drift. The
 * key is content-addressed and date-independent, so:
 *   • re-uploading the same export is a no-op (every receipt is a duplicate);
 *   • a receipt imported by the old zip route dedupes against the new one;
 *   • a partially finished run resumes exactly where it stopped.
 * The hash is always computed HERE from the received bytes; a client-supplied
 * hash is never accepted, or a client could suppress or forge dedup.
 *
 * Everything lands as DRAFT. Nothing in this file can post to the ledger.
 */
import { createHash } from 'node:crypto';
import { assertImageMagicBytes, UploadGuardError } from './upload-guard';
import {
  MAX_ITEM_BYTES,
  MAX_ITEM_NAME_LENGTH,
  classifyEntryName,
  disallowedTypeReason,
  isUnsafeEntryPath,
} from './ingest-limits';
import {
  CHAT_EVIDENCE_TEXT_CAP,
  ZIP_INGEST_JOURNAL_STATUS,
  ZIP_INGEST_SOURCE,
  computeEntryIdempotencyKey,
  parseChatText,
  ocrDateOrNull,
  NO_DOC_DATE_MESSAGE,
  type EvidenceInput,
  type ResolvedLedgerAccounts,
} from './zip-ingest';
import { NO_OPEN_PERIOD_MESSAGE, dateOutsidePeriodsMessage } from './fiscal-period';
import { OcrError } from './ocr-errors';
import type { JournalEntryInput } from './types';
import type { GeminiOcrResult } from './gemini-ocr';

export { MAX_ITEM_BYTES, MAX_ITEM_NAME_LENGTH, classifyEntryName };

/** Evidence event written once per uploaded item, whatever the outcome. */
export const ITEM_EVIDENCE_EVENT = 'WHATSAPP_ITEM_INGESTED';
/** Evidence event replacing the old per-archive ZIP_INGEST_COMPLETED row. */
export const BATCH_EVIDENCE_EVENT = 'WHATSAPP_BATCH_COMPLETED';
/** Chat-transcript evidence event — unchanged from the single-shot zip path. */
export const CHAT_EVIDENCE_EVENT = 'ZIP_CHAT_INGESTED';

// ─── errors ───────────────────────────────────────────────────────────────────

/**
 * Reasons an item is refused outright (as opposed to being reported as a
 * per-item skip). Both mean the REQUEST was malformed, not the receipt.
 */
export type ItemIngestCode = 'INVALID_NAME' | 'INVALID_BATCH_ID';

/**
 * Thrown only when a request cannot be processed at all. Anything wrong with
 * the receipt itself comes back as an ItemIngestResult so one bad photo
 * never aborts an import run.
 */
export class ItemIngestError extends Error {
  readonly code: ItemIngestCode;

  constructor(code: ItemIngestCode, message: string) {
    super(message);
    this.name = 'ItemIngestError';
    this.code = code;
  }
}

// ─── types ────────────────────────────────────────────────────────────────────

/**
 * What happened to one entry.
 *   created   — a new DRAFT journal entry exists
 *   duplicate — already in the books (dedup by content hash); a no-op
 *   skipped   — refused by a guard (type, size, magic bytes); no spend
 *   failed    — OCR or the ledger rejected it; needs a human
 */
export type ItemOutcome = 'created' | 'duplicate' | 'skipped' | 'failed';

/** The server’s verdict on one uploaded entry. */
export interface ItemIngestResult {
  /** Sanitised filename — safe to render, log and store. */
  name: string;
  kind: 'image' | 'text' | 'unknown';
  outcome: ItemOutcome;
  /** sha256 of the received bytes; the dedup key is derived from it. */
  sha256: string;
  journalEntryId?: string;
  /** Which step failed, for `outcome: 'failed'`. */
  stage?: 'ocr' | 'ledger';
  /** Plain-language explanation for a skip or a failure. */
  reason?: string;
  /** Chat transcripts only. */
  messageCount?: number;
  participants?: string[];
}

/**
 * Who is importing. ALWAYS derived from the signed-in session by the route
 * — never from request input, or one org could write into another’s books.
 */
export interface ItemIngestContext {
  organizationId: string;
  userId: string;
}

/** Per-request extras that are not part of the entry itself. */
export interface ItemIngestOptions {
  /** Correlation id for one archive import run; recorded in the audit trail. */
  batchId?: string;
}

/**
 * Injectable IO surface. Mirrors ZipIngestDeps but takes the ledger's
 * created/replayed outcome so a race-lost duplicate is counted as a duplicate
 * instead of being reported to the operator as a fresh import.
 */
export interface ItemIngestDeps {
  ocr: (imageBase64: string) => Promise<GeminiOcrResult>;
  postEntry: (input: JournalEntryInput) => Promise<{ id: string; created: boolean }>;
  findExistingIdempotencyKeys: (organizationId: string, keys: string[]) => Promise<Set<string>>;
  resolveLedgerAccounts: (organizationId: string) => Promise<ResolvedLedgerAccounts>;
  recordEvidence: (input: EvidenceInput) => Promise<void>;
  /**
   * True when the organisation has ANY open (not closed, not locked)
   * FiscalPeriod. Checked BEFORE OCR, because a receipt's date is not known
   * until OCR has run, whereas "this organisation cannot record anything at
   * all" is knowable for free — and that is the state a fresh deployment is in.
   */
  hasAnyOpenFiscalPeriod: (organizationId: string) => Promise<boolean>;
  /**
   * True when an open FiscalPeriod covers `date` — the same test
   * LedgerService.checkFiscalPeriod applies. Checked once the receipt's date
   * is known, so the refusal names the date instead of surfacing the ledger's
   * raw "No fiscal period defined for the date 7/12/2026".
   */
  hasOpenFiscalPeriodFor: (organizationId: string, date: Date) => Promise<boolean>;
}

// ─── name handling ────────────────────────────────────────────────────────────

/**
 * Longest trailing ".xxx" still treated as an extension worth preserving when
 * a name has to be truncated. The longest allowlisted extension is "jpeg"; the
 * slack covers unusual-but-real ones without letting a 300-character tail
 * masquerade as a file type and defeat MAX_ITEM_NAME_LENGTH.
 */
const MAX_PRESERVED_EXTENSION = 12;

/**
 * Control characters (NUL, CR, LF and friends) are stripped: a filename now
 * arrives as client text and lands in logs, journal memos and the evidence log,
 * where an embedded newline could forge a log line or break the UI.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * Reduce a client-supplied entry name to a safe bare filename, or throw.
 *
 * Rejects (rather than repairs) traversal, absolute and drive-letter names:
 * a repaired hostile name would be silently accepted, and an operator should
 * find out that the file they sent was not a WhatsApp export.
 */
export function sanitizeEntryName(raw: string): string {
  if (typeof raw !== 'string') {
    throw new ItemIngestError('INVALID_NAME', 'The upload has no usable filename.');
  }
  const cleaned = raw.replace(CONTROL_CHARS, '');
  if (isUnsafeEntryPath(cleaned)) {
    throw new ItemIngestError(
      'INVALID_NAME',
      `"${cleaned}" uses a path-traversal or absolute name and was rejected.`,
    );
  }
  const base = (cleaned.split(/[\\/]/).pop() ?? '').trim();
  if (base.length === 0 || base === '.' || base === '..') {
    throw new ItemIngestError('INVALID_NAME', 'The upload has no usable filename.');
  }
  if (base.length <= MAX_ITEM_NAME_LENGTH) return base;

  // Preserve the extension: the type allowlist reads it, and so does a human.
  // A "extension" longer than MAX_PRESERVED_EXTENSION is not one — keeping it
  // would push the result back over the very cap this branch enforces, so it
  // is dropped and the name is simply truncated. The truncated name then fails
  // the allowlist, which is the right outcome for `a.` + 300 characters.
  const dot = base.lastIndexOf('.');
  const candidate = dot > 0 ? base.slice(dot) : '';
  const ext = candidate.length <= MAX_PRESERVED_EXTENSION ? candidate : '';
  const keep = Math.max(1, MAX_ITEM_NAME_LENGTH - ext.length);
  return base.slice(0, keep) + ext;
}

/**
 * Strict sanitiser for free-text labels that reach the audit trail (the
 * archive filename). Unlike an entry name this is never used to classify
 * anything, so it can be reduced to a conservative character set.
 */
export function sanitizeLabel(raw: unknown, maxLength = MAX_ITEM_NAME_LENGTH): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(CONTROL_CHARS, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, maxLength);
}

/** Batch ids are server-shaped (UUID v4); anything else is refused outright. */
const BATCH_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Return `raw` if it is a well-formed batch id, else throw. Use where a
 * batch id is required; isValidBatchId is the non-throwing form.
 */
export function assertBatchId(raw: unknown): string {
  if (typeof raw !== 'string' || !BATCH_ID_PATTERN.test(raw)) {
    throw new ItemIngestError('INVALID_BATCH_ID', 'The import batch id is missing or malformed.');
  }
  return raw;
}

/**
 * True for a well-formed batch id. The id reaches the audit trail, so its
 * shape is checked before it is ever stored.
 */
export function isValidBatchId(raw: unknown): raw is string {
  return typeof raw === 'string' && BATCH_ID_PATTERN.test(raw);
}

// ─── ingestion ────────────────────────────────────────────────────────────────



/**
 * Ingest exactly one archive entry.
 *
 * Throws ONLY for an unusable filename (the caller maps that to 422). Every
 * other rejection is returned as a result with `outcome: 'skipped' | 'failed'`
 * and a plain-language reason, so one bad photo never aborts an import run —
 * the operator sees which file needs attention and the rest still lands.
 */
export async function ingestItem(
  bytes: Buffer | Uint8Array,
  rawName: string,
  ctx: ItemIngestContext,
  deps: ItemIngestDeps,
  options: ItemIngestOptions = {},
): Promise<ItemIngestResult> {
  const name = sanitizeEntryName(rawName);
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const makerIdentity = `${ZIP_INGEST_SOURCE}:${ctx.userId}`;
  const batchId = options.batchId;

  const finish = async (result: ItemIngestResult): Promise<ItemIngestResult> => {
    // One evidence row per item, whatever happened. This is what the batch
    // summary is recomputed from — the server's own record, not a client tally.
    await deps.recordEvidence({
      eventType: ITEM_EVIDENCE_EVENT,
      tenantId: ctx.organizationId,
      makerIdentity,
      description: `WhatsApp import item "${result.name}": ${result.outcome}.`,
      payload: {
        batchId: batchId ?? null,
        entryName: result.name,
        entrySha256: result.sha256,
        kind: result.kind,
        outcome: result.outcome,
        byteLength: data.length,
        ...(result.stage ? { stage: result.stage } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.journalEntryId ? { journalEntryId: result.journalEntryId } : {}),
      },
    });
    return result;
  };

  const base = { name, sha256 };

  if (data.length === 0) {
    return finish({ ...base, kind: 'unknown', outcome: 'skipped', reason: 'File is empty.' });
  }
  if (data.length > MAX_ITEM_BYTES) {
    return finish({
      ...base,
      kind: 'unknown',
      outcome: 'skipped',
      reason: `File is too large (${(data.length / (1024 * 1024)).toFixed(1)} MB); the per-file limit is ${(MAX_ITEM_BYTES / (1024 * 1024)).toFixed(0)} MB.`,
    });
  }

  const kind = classifyEntryName(name);
  if (kind === null) {
    return finish({
      ...base,
      kind: 'unknown',
      outcome: 'skipped',
      reason: disallowedTypeReason(name),
    });
  }

  if (kind === 'text') {
    return finish(await ingestChatText(data, base, ctx, deps, makerIdentity, batchId));
  }
  return finish(await ingestImage(data, base, ctx, deps, makerIdentity));
}

async function ingestImage(
  data: Buffer,
  base: { name: string; sha256: string },
  ctx: ItemIngestContext,
  deps: ItemIngestDeps,
  makerIdentity: string,
): Promise<ItemIngestResult> {
  // An image EXTENSION is a hint; the leading bytes are the control. Only the
  // first 18 bytes are re-encoded for the check — never the whole payload.
  try {
    assertImageMagicBytes(data.subarray(0, 18).toString('base64'));
  } catch (err) {
    return {
      ...base,
      kind: 'image',
      outcome: 'skipped',
      reason:
        err instanceof UploadGuardError
          ? `Image extension but unrecognisable content: ${err.message}`
          : `Image validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const idempotencyKey = computeEntryIdempotencyKey(ctx.organizationId, base.sha256);

  // Dedup BEFORE any OCR spend. postEntry re-checks the same key and the DB
  // unique constraint backstops both, so a race still cannot double-create.
  const existing = await deps.findExistingIdempotencyKeys(ctx.organizationId, [idempotencyKey]);
  if (existing.has(idempotencyKey)) {
    return {
      ...base,
      kind: 'image',
      outcome: 'duplicate',
      reason: 'This receipt is already in your books.',
    };
  }

  // Fiscal-period pre-flight, mirroring what ocr-bridge.ts already does: an
  // organisation with NO open accounting period cannot record ANY receipt, so
  // finding that out here — before the OCR call — is the difference between
  // "0 imported, nothing spent, here is the one thing to fix" and paying for
  // 120 extractions to be told the same thing 120 times.
  //
  // Reported as `skipped` rather than `failed` deliberately: nothing about the
  // photo is wrong, no work was done on it, and the operator will re-run the
  // same import once a period is open.
  if (!(await deps.hasAnyOpenFiscalPeriod(ctx.organizationId))) {
    return {
      ...base,
      kind: 'image',
      outcome: 'skipped',
      reason: NO_OPEN_PERIOD_MESSAGE,
    };
  }

  let ocrResult: GeminiOcrResult;
  try {
    ocrResult = await deps.ocr(data.toString('base64'));
  } catch (err) {
    // A SERVICE failure is not a verdict on this receipt — the service never
    // looked at it. Recording it as `failed` was the bug behind "225 couldn't
    // be read": it wrote 225 evidence rows blaming photographs that were
    // perfectly legible, and consumed the whole run in one doomed pass instead
    // of pausing and resuming.
    //
    // The condition is EVERY OcrError, not a list of kinds. That is the
    // contract ocr-errors.ts states outright: there is deliberately no
    // 'unreadable' kind, because a receipt the service genuinely could not
    // read comes back as a SUCCESSFUL response with a zero amount and is
    // rejected a few lines below, by name. So an OcrError reaching here always
    // means the service is the problem — throttled, out of quota, down,
    // rejecting our credentials, or answering something we cannot parse.
    //
    // An earlier version enumerated kinds (`retryable || auth`), and adding
    // 'quota-exhausted' — which is neither — silently reinstated the original
    // bug for the single most likely failure in the system. Any new kind is
    // now covered by construction.
    //
    // Raising means: no evidence row (nothing happened to this receipt), the
    // route answers 429 or 503, and the browser stops the run. Re-running
    // resumes exactly here, because dedup is keyed on content and this entry
    // never got a key.
    if (err instanceof OcrError) {
      throw err;
    }
    return {
      ...base,
      kind: 'image',
      outcome: 'failed',
      stage: 'ocr',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const { extraction } = ocrResult;
  // A zero/negative/NaN amount balances trivially (0 debit = 0 credit) and
  // would slip past a naive balance check as a garbage entry. Refuse it and
  // name the receipt so the operator can key it in by hand.
  if (!Number.isFinite(extraction.totalAmount) || extraction.totalAmount <= 0) {
    return {
      ...base,
      kind: 'image',
      outcome: 'failed',
      stage: 'ocr',
      reason: `OCR returned an unusable amount (${String(extraction.totalAmount)}). Enter this receipt manually.`,
    };
  }

  // The date is only knowable now. Ask the same question the ledger will ask,
  // so the operator is told WHICH date is uncovered instead of receiving
  // checkFiscalPeriod's "No fiscal period defined for the date 7/12/2026" —
  // which names no action and, read outside the US, names the wrong month.
  // DATES ARE NEVER FABRICATED — see ocrDateOrNull. A receipt with no legible
  // date is held back by name, not stamped with today's.
  const entryDate = ocrDateOrNull(extraction.date);
  if (entryDate === null) {
    return {
      ...base,
      kind: 'image',
      outcome: 'failed',
      stage: 'ocr',
      reason: NO_DOC_DATE_MESSAGE,
    };
  }
  if (!(await deps.hasOpenFiscalPeriodFor(ctx.organizationId, entryDate))) {
    return {
      ...base,
      kind: 'image',
      outcome: 'failed',
      stage: 'ledger',
      reason: dateOutsidePeriodsMessage(entryDate),
    };
  }

  let accounts: ResolvedLedgerAccounts;
  try {
    accounts = await deps.resolveLedgerAccounts(ctx.organizationId);
  } catch (err) {
    return {
      ...base,
      kind: 'image',
      outcome: 'failed',
      stage: 'ledger',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const entry = await deps.postEntry({
      organizationId: ctx.organizationId,
      date: entryDate,
      memo: `ZIP-INGEST: ${extraction.vendorName} [${extraction.categorySuggestion}] — ${base.name}`,
      // DRAFT regardless of confidence — four-eyes promotes, never this module.
      status: ZIP_INGEST_JOURNAL_STATUS,
      makerIdentity,
      tenantId: ctx.organizationId,
      agentConfidence: extraction.confidence,
      idempotencyKey,
      source: ZIP_INGEST_SOURCE,
      sourceId: base.sha256,
      lines: [
        // currency comes from the ACCOUNT, never JournalLine's "EUR" schema
        // default — see ResolvedLedgerAccounts.currency.
        {
          accountId: accounts.expenseAccountId,
          amount: extraction.totalAmount,
          isDebit: true,
          currency: accounts.currency,
        },
        {
          accountId: accounts.cashAccountId,
          amount: extraction.totalAmount,
          isDebit: false,
          currency: accounts.currency,
        },
      ],
    });
    return {
      ...base,
      kind: 'image',
      outcome: entry.created ? 'created' : 'duplicate',
      journalEntryId: entry.id,
    };
  } catch (err) {
    return {
      ...base,
      kind: 'image',
      outcome: 'failed',
      stage: 'ledger',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function ingestChatText(
  data: Buffer,
  base: { name: string; sha256: string },
  ctx: ItemIngestContext,
  deps: ItemIngestDeps,
  makerIdentity: string,
  batchId: string | undefined,
): Promise<ItemIngestResult> {
  const raw = data.toString('utf8');
  const parsed = parseChatText(raw);

  // Same event type and payload shape the single-shot zip path wrote, so
  // existing evidence readers keep working; `zipHash` (which no longer exists)
  // is replaced by the batch correlation id.
  await deps.recordEvidence({
    eventType: CHAT_EVIDENCE_EVENT,
    tenantId: ctx.organizationId,
    makerIdentity,
    description: `Chat transcript "${base.name}" ingested${batchId ? ` in import ${batchId.slice(0, 8)}` : ''}.`,
    payload: {
      batchId: batchId ?? null,
      entryName: base.name,
      entrySha256: base.sha256,
      messageCount: parsed.messageCount,
      participants: parsed.participants,
      byteLength: data.length,
      text: raw.length > CHAT_EVIDENCE_TEXT_CAP ? raw.slice(0, CHAT_EVIDENCE_TEXT_CAP) : raw,
      textTruncated: raw.length > CHAT_EVIDENCE_TEXT_CAP,
    },
  });

  return {
    ...base,
    kind: 'text',
    outcome: 'created',
    messageCount: parsed.messageCount,
    participants: parsed.participants,
  };
}

// ─── batch summary ────────────────────────────────────────────────────────────

/** One per-item evidence row, as read back for the completion summary. */
export interface BatchItemEvidence {
  name: string;
  kind: string;
  outcome: string;
  stage?: string;
  /**
   * sha256 of the entry's bytes. This is the ENTRY's identity — evidence rows
   * are written per REQUEST, so one entry can have several (a retried upload,
   * a replayed request). tallyBatch collapses on this so a receipt is counted
   * once no matter how many attempts it took.
   */
  entrySha256?: string;
}

export interface BatchTally {
  total: number;
  /**
   * DRAFT journal entries created. Chat transcripts are deliberately excluded:
   * they are evidence rows, not entries, and counting them here would inflate
   * "N receipts imported" by one on every single import.
   */
  created: number;
  deduped: number;
  failed: number;
  skipped: number;
  /** Chat transcripts seen — evidence, never journal entries. */
  chatFiles: number;
}

/**
 * Count outcomes the SERVER recorded. Never derived from a client report.
 *
 * `items` MUST arrive newest-first (`createdAt desc`). Evidence rows are
 * per-REQUEST, not per-entry: a retried upload writes a second row for the
 * same bytes, so counting rows would report "2 receipts, 1 failed" for one
 * receipt that eventually succeeded. Rows are therefore collapsed by
 * `entrySha256` with the newest winning — which is also why the caller's row
 * cap must truncate the OLDEST rows, never the final outcome.
 *
 * A row without `entrySha256` is malformed; those are kept distinct rather
 * than merged, because merging on weak identity under-reports (and two
 * genuinely different entries can sanitise to the same filename).
 */
export function tallyBatch(items: readonly BatchItemEvidence[]): BatchTally {
  const latestByEntry = new Map<string, BatchItemEvidence>();
  items.forEach((item, index) => {
    const key =
      typeof item.entrySha256 === 'string' && item.entrySha256.length > 0
        ? `sha:${item.entrySha256}`
        : `row:${index}:${item.name}`;
    if (!latestByEntry.has(key)) latestByEntry.set(key, item);
  });

  const tally: BatchTally = { total: 0, created: 0, deduped: 0, failed: 0, skipped: 0, chatFiles: 0 };
  for (const item of latestByEntry.values()) {
    tally.total += 1;
    if (item.kind === 'text') {
      tally.chatFiles += 1;
      continue;
    }
    if (item.outcome === 'created') tally.created += 1;
    else if (item.outcome === 'duplicate') tally.deduped += 1;
    else if (item.outcome === 'failed') tally.failed += 1;
    else if (item.outcome === 'skipped') tally.skipped += 1;
  }
  return tally;
}

export interface BatchSummaryDeps {
  /**
   * Per-item evidence rows recorded for this batch, this organisation,
   * ordered NEWEST FIRST (see tallyBatch).
   */
  loadBatchItemEvidence: (organizationId: string, batchId: string) => Promise<BatchItemEvidence[]>;
  /**
   * The tally from an already-written completion row for this batch, or null.
   * Makes closing a batch idempotent — see completeBatch.
   */
  findExistingBatchCompletion: (
    organizationId: string,
    batchId: string,
  ) => Promise<BatchTally | null>;
  recordEvidence: (input: EvidenceInput) => Promise<void>;
}

/** Outcome of closing one import run. */
export interface BatchSummaryResult {
  batchId: string;
  summaryRecorded: boolean;
  tally: BatchTally | null;
  /** True when this call found a completion already on record and wrote nothing. */
  alreadyRecorded: boolean;
}

/**
 * Close one import run with a completion row equivalent to the old
 * ZIP_INGEST_COMPLETED. The counts are recomputed from the server's own
 * per-item evidence rows, so a client cannot talk the audit trail into a
 * number that never happened.
 *
 * IDEMPOTENT: a browser retry or a double-POST must not append a second
 * WHATSAPP_BATCH_COMPLETED row — an auditor summing completion rows would then
 * double-count an import that happened once. (The journal entries themselves
 * are protected by the idempotency key, so this is an audit-trail and
 * reported-counts problem, not a double-booking one.) When a completion is
 * already on record this returns it unchanged.
 *
 * RESIDUAL RACE, stated plainly: the check-then-write is at application level,
 * so two *simultaneous* closes could both see "none" and both write. That
 * window is milliseconds and the client sends exactly one close per run. A
 * hard guarantee would need a unique index on the evidence log, which is a
 * migration this change deliberately does not carry — see the PR notes.
 *
 * Failure here is deliberately NOT fatal: the drafts are already safely in the
 * ledger, and telling a non-developer his import failed because a summary row
 * could not be written would be a lie that sends him re-uploading.
 */
export async function completeBatch(
  ctx: ItemIngestContext,
  batchId: string,
  archiveName: string,
  deps: BatchSummaryDeps,
): Promise<BatchSummaryResult> {
  const makerIdentity = `${ZIP_INGEST_SOURCE}:${ctx.userId}`;
  try {
    const existing = await deps.findExistingBatchCompletion(ctx.organizationId, batchId);
    if (existing) {
      return { batchId, summaryRecorded: true, tally: existing, alreadyRecorded: true };
    }

    const items = await deps.loadBatchItemEvidence(ctx.organizationId, batchId);
    const tally = tallyBatch(items);
    await deps.recordEvidence({
      eventType: BATCH_EVIDENCE_EVENT,
      tenantId: ctx.organizationId,
      makerIdentity,
      description:
        `WhatsApp import ${batchId.slice(0, 8)}: ${tally.created} draft entries created, ` +
        `${tally.deduped} already in the books, ${tally.failed} failed, ${tally.skipped} skipped.`,
      payload: {
        batchId,
        archiveName,
        transport: 'per-item',
        ...tally,
        entries: items.map((i) => ({ name: i.name, kind: i.kind, outcome: i.outcome })),
      },
    });
    return { batchId, summaryRecorded: true, tally, alreadyRecorded: false };
  } catch (err) {
    console.error('[ingest/batch] summary could not be recorded:', err);
    return { batchId, summaryRecorded: false, tally: null, alreadyRecorded: false };
  }
}
