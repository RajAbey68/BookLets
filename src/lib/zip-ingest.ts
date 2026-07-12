/**
 * S5 — WhatsApp export zip ingestion (pure core, no prisma import).
 *
 * Turns a WhatsApp finance/petty-cash export zip (chat text + receipt
 * images) into DRAFT journal entries plus chat evidence metadata.
 *
 * Security guards run FIRST, before a single byte is sent to OCR:
 *   1. entry-count cap (MAX_ZIP_ENTRIES)
 *   2. total uncompressed cap (MAX_TOTAL_UNCOMPRESSED_BYTES) — checked on
 *      both the declared header sizes and the actual inflated bytes, so a
 *      lying local header cannot smuggle a larger payload
 *   3. path traversal — entry names containing ".." segments, absolute
 *      paths, or drive-letter prefixes are rejected outright
 *   4. zip-bomb ratio guard — any entry whose actual inflated size exceeds
 *      MAX_ENTRY_COMPRESSION_RATIO × its compressed size (above a noise
 *      floor) rejects the whole archive
 *   5. extension allowlist — jpg/jpeg/png/webp/heic images and .txt chat
 *      transcripts; every other entry is skipped with a per-entry reason
 *      (never fatal), and image entries must additionally pass real
 *      magic-byte validation (reused from upload-guard) before OCR.
 *
 * All IO (OCR, ledger writes, evidence log, account lookup) is injected via
 * ZipIngestDeps so unit tests run with zero live DB/OCR calls. Production
 * wiring lives in ./zip-ingest.deps.ts.
 */
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { assertImageMagicBytes, UploadGuardError } from './upload-guard';
import { JournalStatus, type JournalEntryInput } from './types';
import type { GeminiOcrResult } from './gemini-ocr';

// ─── contract constants ───────────────────────────────────────────────────────

/** Hard cap on the number of entries in one archive. */
export const MAX_ZIP_ENTRIES = 1000;

/** Hard cap on the total uncompressed payload of one archive: 200 MB. */
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

/**
 * Per-entry zip-bomb guard: an entry inflating to more than this multiple of
 * its compressed size (and past RATIO_GUARD_MIN_BYTES) rejects the archive.
 * Real receipt photos sit near ratio 1; chat text rarely exceeds ~10.
 */
export const MAX_ENTRY_COMPRESSION_RATIO = 100;

/** Ratio guard noise floor — tiny highly-compressible files are legitimate. */
export const RATIO_GUARD_MIN_BYTES = 64 * 1024;

/** Cap on the COMPRESSED upload itself (checked by the route handler). */
export const MAX_ZIP_UPLOAD_BYTES = 100 * 1024 * 1024;

/** OCR fan-out cap: at most this many in-flight OCR calls per ingest. */
export const OCR_CONCURRENCY_LIMIT = 5;

/** Provenance marker persisted on JournalEntry.source. */
export const ZIP_INGEST_SOURCE = 'zip-ingest';

/**
 * Status for every journal entry this module creates. S4's
 * gateAutomatedJournalEntry has not landed on main, so the DRAFT-only rule
 * for automated/OCR entries is enforced directly here: OCR'd entries are
 * born DRAFT regardless of extraction confidence, and only the four-eyes
 * approval flow (approval.service.ts) may promote them to POSTED.
 */
export const ZIP_INGEST_JOURNAL_STATUS = JournalStatus.DRAFT;

/** Cap on how much raw chat text is retained inside one evidence payload. */
export const CHAT_EVIDENCE_TEXT_CAP = 50_000;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic']);
const TEXT_EXTENSIONS = new Set(['txt']);

// ─── errors ───────────────────────────────────────────────────────────────────

export type ZipIngestGuardCode =
  | 'INVALID_ZIP'
  | 'TOO_MANY_ENTRIES'
  | 'TOTAL_SIZE_EXCEEDED'
  | 'PATH_TRAVERSAL'
  | 'ZIP_BOMB';

export class ZipIngestError extends Error {
  readonly code: ZipIngestGuardCode;

  constructor(code: ZipIngestGuardCode, message: string) {
    super(message);
    this.name = 'ZipIngestError';
    this.code = code;
  }
}

// ─── types ────────────────────────────────────────────────────────────────────

export interface ZipIngestLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxEntryCompressionRatio: number;
  ratioGuardMinBytes: number;
}

const DEFAULT_LIMITS: ZipIngestLimits = {
  maxEntries: MAX_ZIP_ENTRIES,
  maxTotalUncompressedBytes: MAX_TOTAL_UNCOMPRESSED_BYTES,
  maxEntryCompressionRatio: MAX_ENTRY_COMPRESSION_RATIO,
  ratioGuardMinBytes: RATIO_GUARD_MIN_BYTES,
};

export interface ZipFileEntry {
  name: string;
  data: Buffer;
  /** sha256 hex of the entry's uncompressed bytes. */
  sha256: string;
}

export interface SkippedEntry {
  name: string;
  reason: string;
}

export interface InspectedZip {
  /** sha256 hex of the whole (compressed) archive. */
  zipHash: string;
  totalEntries: number;
  images: ZipFileEntry[];
  texts: ZipFileEntry[];
  skipped: SkippedEntry[];
}

export interface ZipIngestContext {
  organizationId: string;
  userId: string;
}

export interface IngestFailure {
  name: string;
  stage: 'ocr' | 'ledger';
  error: string;
}

export interface ChatFileSummary {
  name: string;
  sha256: string;
  messageCount: number;
  participants: string[];
}

export interface ZipIngestReport {
  zipHash: string;
  totalEntries: number;
  imageCount: number;
  textCount: number;
  skipped: SkippedEntry[];
  created: number;
  deduped: number;
  failures: IngestFailure[];
  chatFiles: ChatFileSummary[];
  journalEntryIds: string[];
}

export interface EvidenceInput {
  eventType: string;
  tenantId: string;
  makerIdentity: string;
  description: string;
  payload: Record<string, unknown>;
}

export interface ResolvedLedgerAccounts {
  expenseAccountId: string;
  cashAccountId: string;
}

/**
 * Injectable IO surface. Unit tests supply in-memory fakes; production uses
 * buildDefaultZipIngestDeps() (prisma + gemini-ocr + LedgerService backed).
 */
export interface ZipIngestDeps {
  ocr: (imageBase64: string) => Promise<GeminiOcrResult>;
  postEntry: (input: JournalEntryInput) => Promise<{ id: string }>;
  /** Application-level idempotency pre-check: which keys already exist? */
  findExistingIdempotencyKeys: (organizationId: string, keys: string[]) => Promise<Set<string>>;
  resolveLedgerAccounts: (organizationId: string) => Promise<ResolvedLedgerAccounts>;
  recordEvidence: (input: EvidenceInput) => Promise<void>;
}

// ─── pure helpers ─────────────────────────────────────────────────────────────

/**
 * True for entry names that could escape an extraction root: any ".."
 * segment (slash or backslash separated), absolute paths, or Windows drive
 * prefixes. We never extract to disk, but hostile names are rejected anyway
 * — defence-in-depth and a clear signal the archive is not a WhatsApp export.
 */
export function isPathTraversal(name: string): boolean {
  if (name.startsWith('/') || name.startsWith('\\')) return true;
  if (/^[A-Za-z]:[\\/]/.test(name)) return true;
  return name.split(/[\\/]/).some((segment) => segment === '..');
}

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function computeZipHash(zipBuffer: Buffer): string {
  return createHash('sha256').update(zipBuffer).digest('hex');
}

/**
 * Deterministic, content-addressed idempotency key for one zip entry:
 *
 *   key = sha256("zip-ingest" ‖ NUL ‖ organizationId ‖ NUL ‖ sha256(entryBytes))
 *
 * Deliberately date-independent (unlike LedgerService.computeIdempotencyKey):
 * re-uploading the same export next week must still dedupe. Keyed by entry
 * CONTENT, not by zip, so the same receipt appearing in two overlapping
 * exports is also deduped. The value is written to JournalEntry.idempotencyKey
 * — the same column S11's idempotencyKey work enforces at the DB level — so
 * S11 can adopt these keys unchanged.
 */
export function computeEntryIdempotencyKey(organizationId: string, entrySha256: string): string {
  const material = [ZIP_INGEST_SOURCE, organizationId, entrySha256].join('\u0000');
  return createHash('sha256').update(material).digest('hex');
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface ChatParseResult {
  messageCount: number;
  participants: string[];
}

/**
 * Light-touch WhatsApp transcript parse — counts message lines and collects
 * sender names. Handles both Android ("12/07/2026, 10:15 - Name: text") and
 * iOS ("[12/07/2026, 10:15:00] Name: text") export formats. Continuation
 * lines (multi-line messages) are not counted. No NLP — the transcript is
 * retained as evidence metadata only.
 */
export function parseChatText(text: string): ChatParseResult {
  const line =
    /^\[?\d{1,2}[/.]\d{1,2}[/.]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\]?\s*[-–]?\s*([^:\n]+):/;
  let messageCount = 0;
  const participants = new Set<string>();
  for (const raw of text.split('\n')) {
    const match = line.exec(raw);
    if (match) {
      messageCount += 1;
      participants.add(match[1].trim());
    }
  }
  return { messageCount, participants: [...participants] };
}

// ─── inspection: guards + text/image split ────────────────────────────────────

/**
 * Open the archive, enforce every security guard, and split entries into
 * images / chat texts / skipped-with-reason. Throws ZipIngestError on any
 * guard violation; disallowed types alone are never fatal.
 */
export function inspectZip(zipBuffer: Buffer, limits: Partial<ZipIngestLimits> = {}): InspectedZip {
  const cfg: ZipIngestLimits = { ...DEFAULT_LIMITS, ...limits };

  let zip: AdmZip;
  let entries: AdmZip.IZipEntry[];
  try {
    zip = new AdmZip(zipBuffer);
    entries = zip.getEntries();
  } catch (err) {
    throw new ZipIngestError(
      'INVALID_ZIP',
      `Payload is not a readable zip archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (entries.length > cfg.maxEntries) {
    throw new ZipIngestError(
      'TOO_MANY_ENTRIES',
      `Archive has ${entries.length} entries; the limit is ${cfg.maxEntries}.`,
    );
  }

  // Pass 1 — header-level guards, before inflating anything.
  let declaredTotal = 0;
  for (const entry of entries) {
    if (isPathTraversal(entry.entryName)) {
      throw new ZipIngestError(
        'PATH_TRAVERSAL',
        `Entry "${entry.entryName}" uses a path-traversal or absolute name.`,
      );
    }
    declaredTotal += entry.header.size;
    if (declaredTotal > cfg.maxTotalUncompressedBytes) {
      throw new ZipIngestError(
        'TOTAL_SIZE_EXCEEDED',
        `Declared uncompressed payload exceeds the ${Math.floor(cfg.maxTotalUncompressedBytes / (1024 * 1024))} MB limit.`,
      );
    }
  }

  // Pass 2 — classify, and re-verify sizes/ratios against ACTUAL inflated
  // bytes (headers can lie). Only allowlisted entries are ever inflated.
  const images: ZipFileEntry[] = [];
  const texts: ZipFileEntry[] = [];
  const skipped: SkippedEntry[] = [];
  let actualTotal = 0;

  for (const entry of entries) {
    if (entry.isDirectory) {
      continue;
    }

    const ext = extensionOf(entry.entryName);
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const isText = TEXT_EXTENSIONS.has(ext);

    if (!isImage && !isText) {
      skipped.push({
        name: entry.entryName,
        reason: `Disallowed type ".${ext || '(none)'}" — only jpg/jpeg/png/webp/heic images and .txt chat files are ingested.`,
      });
      continue;
    }

    let data: Buffer;
    try {
      data = entry.getData();
    } catch (err) {
      throw new ZipIngestError(
        'INVALID_ZIP',
        `Entry "${entry.entryName}" could not be decompressed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const compressedSize = Math.max(1, entry.header.compressedSize);
    if (
      data.length > cfg.ratioGuardMinBytes &&
      data.length / compressedSize > cfg.maxEntryCompressionRatio
    ) {
      throw new ZipIngestError(
        'ZIP_BOMB',
        `Entry "${entry.entryName}" inflates ${Math.round(data.length / compressedSize)}x — above the ${cfg.maxEntryCompressionRatio}x zip-bomb guard.`,
      );
    }

    actualTotal += data.length;
    if (actualTotal > cfg.maxTotalUncompressedBytes) {
      throw new ZipIngestError(
        'TOTAL_SIZE_EXCEEDED',
        `Actual uncompressed payload exceeds the ${Math.floor(cfg.maxTotalUncompressedBytes / (1024 * 1024))} MB limit.`,
      );
    }

    const fileEntry: ZipFileEntry = {
      name: entry.entryName,
      data,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
    if (isImage) images.push(fileEntry);
    else texts.push(fileEntry);
  }

  return {
    zipHash: computeZipHash(zipBuffer),
    totalEntries: entries.length,
    images,
    texts,
    skipped,
  };
}

// ─── ingestion orchestration ──────────────────────────────────────────────────

function ocrDateOrNow(isoDate: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    const parsed = new Date(`${isoDate}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/**
 * Full pipeline: inspect (guards + split) → dedupe by content-hash key →
 * magic-byte check → OCR fan-out (capped) → DRAFT journal entries →
 * chat + summary evidence. Per-image OCR/ledger failures are reported in
 * `failures`, never fatal for the rest of the archive.
 */
export async function ingestZip(
  zipBuffer: Buffer,
  ctx: ZipIngestContext,
  deps: ZipIngestDeps,
  limits: Partial<ZipIngestLimits> = {},
): Promise<ZipIngestReport> {
  const inspected = inspectZip(zipBuffer, limits);
  const makerIdentity = `${ZIP_INGEST_SOURCE}:${ctx.userId}`;

  const skipped = [...inspected.skipped];
  const failures: IngestFailure[] = [];
  const journalEntryIds: string[] = [];

  // Magic-byte validation (reused from upload-guard): an image EXTENSION is a
  // hint, not a control. Only the first 18 bytes are re-encoded for the check.
  const validImages: ZipFileEntry[] = [];
  for (const image of inspected.images) {
    try {
      assertImageMagicBytes(image.data.subarray(0, 18).toString('base64'));
      validImages.push(image);
    } catch (err) {
      skipped.push({
        name: image.name,
        reason:
          err instanceof UploadGuardError
            ? `Image extension but unrecognisable content: ${err.message}`
            : `Image validation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Application-level idempotency: resolve which content-hash keys already
  // have a journal entry BEFORE any OCR spend. postEntry re-checks the same
  // key (and the DB unique constraint backstops it), so a race still cannot
  // double-create.
  // Collapse duplicate content within THIS archive first (the same receipt
  // forwarded twice shares a sha256 → same key; without this, the second
  // copy would survive the DB filter, burn OCR, then collide on the unique
  // constraint at postEntry).
  const keyedByKey = new Map<string, { image: (typeof validImages)[number]; idempotencyKey: string }>();
  for (const image of validImages) {
    const idempotencyKey = computeEntryIdempotencyKey(ctx.organizationId, image.sha256);
    if (!keyedByKey.has(idempotencyKey)) keyedByKey.set(idempotencyKey, { image, idempotencyKey });
  }
  const keyed = [...keyedByKey.values()];
  const existingKeys = await deps.findExistingIdempotencyKeys(
    ctx.organizationId,
    keyed.map((k) => k.idempotencyKey),
  );
  const fresh = keyed.filter((k) => !existingKeys.has(k.idempotencyKey));
  // Deduped counts BOTH intra-archive duplicates and already-ingested keys.
  const deduped = validImages.length - fresh.length;

  const accounts = fresh.length > 0 ? await deps.resolveLedgerAccounts(ctx.organizationId) : null;

  await mapWithConcurrency(fresh, OCR_CONCURRENCY_LIMIT, async ({ image, idempotencyKey }) => {
    let ocrResult: GeminiOcrResult;
    try {
      ocrResult = await deps.ocr(image.data.toString('base64'));
    } catch (err) {
      failures.push({
        name: image.name,
        stage: 'ocr',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const { extraction } = ocrResult;
    try {
      const entry = await deps.postEntry({
        organizationId: ctx.organizationId,
        date: ocrDateOrNow(extraction.date),
        memo: `ZIP-INGEST: ${extraction.vendorName} [${extraction.categorySuggestion}] — ${image.name}`,
        // DRAFT regardless of confidence — four-eyes promotes, never this module.
        status: ZIP_INGEST_JOURNAL_STATUS,
        makerIdentity,
        tenantId: ctx.organizationId,
        agentConfidence: extraction.confidence,
        idempotencyKey,
        source: ZIP_INGEST_SOURCE,
        sourceId: image.sha256,
        lines: [
          { accountId: accounts!.expenseAccountId, amount: extraction.totalAmount, isDebit: true },
          { accountId: accounts!.cashAccountId, amount: extraction.totalAmount, isDebit: false },
        ],
      });
      journalEntryIds.push(entry.id);
    } catch (err) {
      failures.push({
        name: image.name,
        stage: 'ledger',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Chat transcripts: parse lightly and retain as evidence metadata.
  const chatFiles: ChatFileSummary[] = [];
  for (const text of inspected.texts) {
    const raw = text.data.toString('utf8');
    const parsed = parseChatText(raw);
    chatFiles.push({
      name: text.name,
      sha256: text.sha256,
      messageCount: parsed.messageCount,
      participants: parsed.participants,
    });
    await deps.recordEvidence({
      eventType: 'ZIP_CHAT_INGESTED',
      tenantId: ctx.organizationId,
      makerIdentity,
      description: `Chat transcript "${text.name}" ingested from zip ${inspected.zipHash.slice(0, 12)}.`,
      payload: {
        zipHash: inspected.zipHash,
        entryName: text.name,
        entrySha256: text.sha256,
        messageCount: parsed.messageCount,
        participants: parsed.participants,
        byteLength: text.data.length,
        text: raw.length > CHAT_EVIDENCE_TEXT_CAP ? raw.slice(0, CHAT_EVIDENCE_TEXT_CAP) : raw,
        textTruncated: raw.length > CHAT_EVIDENCE_TEXT_CAP,
      },
    });
  }

  const report: ZipIngestReport = {
    zipHash: inspected.zipHash,
    totalEntries: inspected.totalEntries,
    imageCount: inspected.images.length,
    textCount: inspected.texts.length,
    skipped,
    created: journalEntryIds.length,
    deduped,
    failures,
    chatFiles,
    journalEntryIds,
  };

  await deps.recordEvidence({
    eventType: 'ZIP_INGEST_COMPLETED',
    tenantId: ctx.organizationId,
    makerIdentity,
    description: `Zip ingest ${inspected.zipHash.slice(0, 12)}: ${report.created} draft entries created, ${report.deduped} deduped, ${report.failures.length} failures.`,
    payload: {
      zipHash: report.zipHash,
      totalEntries: report.totalEntries,
      imageCount: report.imageCount,
      textCount: report.textCount,
      skipped: report.skipped,
      created: report.created,
      deduped: report.deduped,
      failures: report.failures,
      journalEntryIds: report.journalEntryIds,
    },
  });

  return report;
}
