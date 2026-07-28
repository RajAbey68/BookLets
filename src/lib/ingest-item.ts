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
  type EvidenceInput,
  type ResolvedLedgerAccounts,
} from './zip-ingest';
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

export type ItemIngestCode = 'INVALID_NAME' | 'INVALID_BATCH_ID';

export class ItemIngestError extends Error {
  readonly code: ItemIngestCode;

  constructor(code: ItemIngestCode, message: string) {
    super(message);
    this.name = 'ItemIngestError';
    this.code = code;
  }
}

// ─── types ────────────────────────────────────────────────────────────────────

export type ItemOutcome = 'created' | 'duplicate' | 'skipped' | 'failed';

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

export interface ItemIngestContext {
  organizationId: string;
  userId: string;
}

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
}

// ─── name handling ────────────────────────────────────────────────────────────

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
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
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

export function assertBatchId(raw: unknown): string {
  if (typeof raw !== 'string' || !BATCH_ID_PATTERN.test(raw)) {
    throw new ItemIngestError('INVALID_BATCH_ID', 'The import batch id is missing or malformed.');
  }
  return raw;
}

export function isValidBatchId(raw: unknown): raw is string {
  return typeof raw === 'string' && BATCH_ID_PATTERN.test(raw);
}

// ─── ingestion ────────────────────────────────────────────────────────────────

function ocrDateOrNow(isoDate: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    const parsed = new Date(`${isoDate}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

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

  let ocrResult: GeminiOcrResult;
  try {
    ocrResult = await deps.ocr(data.toString('base64'));
  } catch (err) {
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
      date: ocrDateOrNow(extraction.date),
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
        { accountId: accounts.expenseAccountId, amount: extraction.totalAmount, isDebit: true },
        { accountId: accounts.cashAccountId, amount: extraction.totalAmount, isDebit: false },
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

/** Count outcomes the SERVER recorded. Never derived from a client report. */
export function tallyBatch(items: readonly BatchItemEvidence[]): BatchTally {
  const tally: BatchTally = { total: 0, created: 0, deduped: 0, failed: 0, skipped: 0, chatFiles: 0 };
  for (const item of items) {
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
  /** Per-item evidence rows recorded for this batch, this organisation. */
  loadBatchItemEvidence: (organizationId: string, batchId: string) => Promise<BatchItemEvidence[]>;
  recordEvidence: (input: EvidenceInput) => Promise<void>;
}

export interface BatchSummaryResult {
  batchId: string;
  summaryRecorded: boolean;
  tally: BatchTally | null;
}

/**
 * Close one import run with a completion row equivalent to the old
 * ZIP_INGEST_COMPLETED. The counts are recomputed from the server's own
 * per-item evidence rows, so a client cannot talk the audit trail into a
 * number that never happened.
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
    return { batchId, summaryRecorded: true, tally };
  } catch (err) {
    console.error('[ingest/batch] summary could not be recorded:', err);
    return { batchId, summaryRecorded: false, tally: null };
  }
}
