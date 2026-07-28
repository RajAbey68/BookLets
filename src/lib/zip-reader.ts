/**
 * Isomorphic ZIP reader — the browser half of the per-item upload transport.
 *
 * WHY THIS EXISTS
 * `POST /api/ingest/zip` can never receive a real WhatsApp export: Vercel's
 * edge rejects bodies over ~4.5 MB with 413 FUNCTION_PAYLOAD_TOO_LARGE before
 * the function runs, and an "Export Chat → Attach Media" archive is tens of MB.
 * So the archive is expanded HERE, in the browser, and each entry is uploaded
 * on its own sub-4 MB request (see whatsapp-import-client.ts).
 *
 * WHY NO DEPENDENCY
 * Reading a zip needs two things: a central-directory parser (~200 lines of
 * fixed-offset field reads) and raw-deflate. The platform already ships the
 * second as `DecompressionStream('deflate-raw')` (Chrome 80+, Safari 16.4+,
 * Firefox 113+, Node 18+). Adding jszip/fflate to the client bundle for the
 * remainder is not worth the supply-chain surface.
 *
 * WHY THE CENTRAL DIRECTORY, NOT THE LOCAL HEADERS
 * Local file headers may carry zeroed sizes with a trailing data descriptor
 * (general-purpose bit 3), which cannot be read without scanning. The central
 * directory always carries authoritative sizes and offsets, so we read that
 * and seek. It also means we only ever pull ONE entry into memory at a time —
 * `Blob.slice()` reads a byte range off disk — so a 90 MB archive never has to
 * be buffered whole. That is strictly better than the server's old
 * whole-buffer AdmZip path.
 *
 * WHERE THE SECURITY GUARDS LIVE NOW
 * inspectZip's guards ran server-side on an archive the server had received.
 * The server no longer receives an archive, so each guard is re-homed:
 *
 *   entry count           → here (client protection) + a per-org rate limit on
 *                           the item endpoint (server protection)
 *   total uncompressed    → here (client protection) + MAX_ITEM_BYTES enforced
 *                           on every received item (server protection)
 *   path traversal        → here, AND re-checked server-side in
 *                           ingest-item.sanitizeEntryName — filenames are now
 *                           client-supplied text, so the server copy is the
 *                           real control
 *   zip-bomb ratio        → here ONLY, and that is correct: the guard defends
 *                           a decompressor against amplification, and after
 *                           this change the SERVER decompresses nothing. The
 *                           remaining decompressor is the user's own browser,
 *                           which this guard still protects. Server-side the
 *                           protection is now structural, not a check.
 *   type allowlist        → here, AND re-checked server-side by extension and
 *                           by real magic bytes before any OCR spend.
 *
 * Nothing this module decides is trusted by the server. It exists so the user
 * gets a fast, specific rejection instead of uploading 90 MB to find out.
 */
import {
  MAX_ITEM_BYTES,
  classifyEntryName,
  disallowedTypeReason,
  isUnsafeEntryPath,
} from './ingest-limits';

// ─── limits (mirrors of the server-side archive contract in zip-ingest.ts) ────
// zip-ingest.ts cannot be imported here (adm-zip / node:crypto must not enter
// the client bundle). tests/unit/zip-reader.test.ts asserts these stay equal to
// the server's constants, so drift fails CI rather than shipping.

/** Hard cap on the number of entries in one archive. */
export const READER_MAX_ENTRIES = 1000;

/** Hard cap on the total uncompressed payload we are prepared to expand. */
export const READER_MAX_TOTAL_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

/** Per-entry zip-bomb guard: inflate-to-compressed ratio ceiling. */
export const READER_MAX_ENTRY_COMPRESSION_RATIO = 100;

/** Ratio-guard noise floor — tiny highly-compressible files are legitimate. */
export const READER_RATIO_GUARD_MIN_BYTES = 64 * 1024;

/** Re-exported so callers get one import for the per-item ceiling. */
export { MAX_ITEM_BYTES };

export interface ZipReaderLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxEntryCompressionRatio: number;
  ratioGuardMinBytes: number;
}

const DEFAULT_LIMITS: ZipReaderLimits = {
  maxEntries: READER_MAX_ENTRIES,
  maxTotalUncompressedBytes: READER_MAX_TOTAL_UNCOMPRESSED_BYTES,
  maxEntryCompressionRatio: READER_MAX_ENTRY_COMPRESSION_RATIO,
  ratioGuardMinBytes: READER_RATIO_GUARD_MIN_BYTES,
};

// ─── errors ───────────────────────────────────────────────────────────────────

export type ZipReaderCode =
  | 'INVALID_ZIP'
  | 'TOO_MANY_ENTRIES'
  | 'TOTAL_SIZE_EXCEEDED'
  | 'PATH_TRAVERSAL'
  | 'ZIP_BOMB'
  | 'UNSUPPORTED_ZIP'
  | 'UNSUPPORTED_BROWSER';

export class ZipReaderError extends Error {
  readonly code: ZipReaderCode;

  constructor(code: ZipReaderCode, message: string) {
    super(message);
    this.name = 'ZipReaderError';
    this.code = code;
  }
}

// ─── zip format constants ─────────────────────────────────────────────────────

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** EOCD is at most 22 bytes + a 64 KB comment. */
const EOCD_SEARCH_WINDOW = EOCD_MIN_SIZE + 0xffff;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
/** Sentinel meaning "the real value is in a Zip64 extra field". */
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;

// ─── types ────────────────────────────────────────────────────────────────────

export interface ZipEntryMeta {
  /** Entry name exactly as stored, including any directory prefix. */
  name: string;
  /** Compression method: 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

export interface SkippedZipEntry {
  name: string;
  reason: string;
}

export interface WhatsappImportPlan {
  images: ZipEntryMeta[];
  texts: ZipEntryMeta[];
  skipped: SkippedZipEntry[];
}

// ─── byte helpers ─────────────────────────────────────────────────────────────

async function readRange(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  const clampedStart = Math.max(0, Math.min(start, blob.size));
  const clampedEnd = Math.max(clampedStart, Math.min(end, blob.size));
  const buffer = await blob.slice(clampedStart, clampedEnd).arrayBuffer();
  return new Uint8Array(buffer);
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const utf8 = new TextDecoder('utf-8');

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function assertDecompressionAvailable(): void {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipReaderError(
      'UNSUPPORTED_BROWSER',
      'This browser cannot expand zip archives (no DecompressionStream).',
    );
  }
}

/**
 * Inflate raw-deflate bytes, aborting the moment the output passes `cap`.
 * The cap is what stops a central directory that under-declares an entry's
 * size from smuggling a much larger payload into memory — the check runs
 * DURING inflation, not after it.
 */
async function inflateRawCapped(data: Uint8Array, cap: number): Promise<Uint8Array> {
  assertDecompressionAvailable();
  const source = new Blob([data as unknown as BlobPart]).stream();
  const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        throw new ZipReaderError(
          'INVALID_ZIP',
          'An entry inflated to more than its archive index declared — the archive is malformed or tampered with.',
        );
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ZipReaderError) throw err;
    throw new ZipReaderError(
      'INVALID_ZIP',
      `An entry could not be decompressed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return concat(chunks, total);
}

// ─── central directory ────────────────────────────────────────────────────────

function findEocdOffset(tail: Uint8Array): number {
  const view = viewOf(tail);
  for (let i = tail.byteLength - EOCD_MIN_SIZE; i >= 0; i -= 1) {
    if (view.getUint32(i, true) !== SIG_EOCD) continue;
    const commentLength = view.getUint16(i + 20, true);
    // Prefer the record whose comment length accounts for the remaining bytes;
    // that disambiguates an EOCD signature appearing inside archive data.
    if (i + EOCD_MIN_SIZE + commentLength === tail.byteLength) return i;
  }
  // Fall back to the last signature found, for writers that mis-set the length.
  for (let i = tail.byteLength - EOCD_MIN_SIZE; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Parse the archive index and apply every archive-level guard.
 * Nothing is decompressed here — only fixed-offset header fields are read.
 */
export async function readZipDirectory(
  blob: Blob,
  limits: Partial<ZipReaderLimits> = {},
): Promise<ZipEntryMeta[]> {
  const cfg: ZipReaderLimits = { ...DEFAULT_LIMITS, ...limits };
  assertDecompressionAvailable();

  if (blob.size < EOCD_MIN_SIZE) {
    throw new ZipReaderError('INVALID_ZIP', 'That file is too small to be a zip archive.');
  }

  const tailLength = Math.min(blob.size, EOCD_SEARCH_WINDOW);
  const tail = await readRange(blob, blob.size - tailLength, blob.size);
  const eocdAt = findEocdOffset(tail);
  if (eocdAt < 0) {
    throw new ZipReaderError(
      'INVALID_ZIP',
      'That file is not a zip archive (no end-of-archive record found).',
    );
  }

  const eocd = viewOf(tail);
  const entryCount = eocd.getUint16(eocdAt + 10, true);
  const centralSize = eocd.getUint32(eocdAt + 12, true);
  const centralOffset = eocd.getUint32(eocdAt + 16, true);

  if (
    entryCount === ZIP64_SENTINEL_16 ||
    centralSize === ZIP64_SENTINEL_32 ||
    centralOffset === ZIP64_SENTINEL_32
  ) {
    throw new ZipReaderError(
      'UNSUPPORTED_ZIP',
      'This archive uses the Zip64 format, which this importer cannot read. Export a smaller date range.',
    );
  }

  if (entryCount > cfg.maxEntries) {
    throw new ZipReaderError(
      'TOO_MANY_ENTRIES',
      `Archive has ${entryCount} entries; the limit is ${cfg.maxEntries}.`,
    );
  }

  const central = await readRange(blob, centralOffset, centralOffset + centralSize);
  const cd = viewOf(central);

  const entries: ZipEntryMeta[] = [];
  let cursor = 0;
  let declaredTotal = 0;

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + CENTRAL_HEADER_SIZE > central.byteLength) {
      throw new ZipReaderError('INVALID_ZIP', 'The archive index is truncated or corrupt.');
    }
    if (cd.getUint32(cursor, true) !== SIG_CENTRAL) {
      throw new ZipReaderError('INVALID_ZIP', 'The archive index is corrupt.');
    }

    const flags = cd.getUint16(cursor + 8, true);
    const method = cd.getUint16(cursor + 10, true);
    const compressedSize = cd.getUint32(cursor + 20, true);
    const uncompressedSize = cd.getUint32(cursor + 24, true);
    const nameLength = cd.getUint16(cursor + 28, true);
    const extraLength = cd.getUint16(cursor + 30, true);
    const commentLength = cd.getUint16(cursor + 32, true);
    const localHeaderOffset = cd.getUint32(cursor + 42, true);

    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipReaderError(
        'UNSUPPORTED_ZIP',
        'This archive is password protected, so its receipts cannot be read.',
      );
    }
    if (
      compressedSize === ZIP64_SENTINEL_32 ||
      uncompressedSize === ZIP64_SENTINEL_32 ||
      localHeaderOffset === ZIP64_SENTINEL_32
    ) {
      throw new ZipReaderError(
        'UNSUPPORTED_ZIP',
        'This archive uses the Zip64 format, which this importer cannot read. Export a smaller date range.',
      );
    }

    const nameStart = cursor + CENTRAL_HEADER_SIZE;
    const name = utf8.decode(central.subarray(nameStart, nameStart + nameLength));

    // Traversal is checked for EVERY entry, allowlisted or not: a hostile name
    // is a clear signal the file is not a WhatsApp export at all.
    if (isUnsafeEntryPath(name)) {
      throw new ZipReaderError(
        'PATH_TRAVERSAL',
        `Entry "${name}" uses a path-traversal or absolute name.`,
      );
    }

    const isDirectory = name.endsWith('/') || name.endsWith('\\');
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory,
    });

    // Size and ratio budgets are spent only on entries the allowlist will
    // actually expand — a WhatsApp export full of .opus voice notes must not
    // exhaust a budget it never consumes (mirrors inspectZip pass 1).
    if (!isDirectory && classifyEntryName(name) !== null) {
      declaredTotal += uncompressedSize;
      if (declaredTotal > cfg.maxTotalUncompressedBytes) {
        throw new ZipReaderError(
          'TOTAL_SIZE_EXCEEDED',
          `Declared uncompressed payload exceeds the ${Math.floor(cfg.maxTotalUncompressedBytes / (1024 * 1024))} MB limit.`,
        );
      }
      const ratioBase = Math.max(1, compressedSize);
      if (
        uncompressedSize > cfg.ratioGuardMinBytes &&
        uncompressedSize / ratioBase > cfg.maxEntryCompressionRatio
      ) {
        throw new ZipReaderError(
          'ZIP_BOMB',
          `Entry "${name}" inflates ${Math.round(uncompressedSize / ratioBase)}x — above the ${cfg.maxEntryCompressionRatio}x limit.`,
        );
      }
    }

    cursor = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Pull ONE entry's bytes out of the archive. Only this entry's byte range is
 * read, so memory stays flat regardless of archive size.
 */
export async function readZipEntry(
  blob: Blob,
  entry: ZipEntryMeta,
  limits: Partial<ZipReaderLimits> = {},
): Promise<Uint8Array> {
  const cfg: ZipReaderLimits = { ...DEFAULT_LIMITS, ...limits };

  const header = await readRange(
    blob,
    entry.localHeaderOffset,
    entry.localHeaderOffset + LOCAL_HEADER_SIZE,
  );
  if (header.byteLength < LOCAL_HEADER_SIZE) {
    throw new ZipReaderError('INVALID_ZIP', `Entry "${entry.name}" points outside the archive.`);
  }
  const lh = viewOf(header);
  if (lh.getUint32(0, true) !== SIG_LOCAL) {
    throw new ZipReaderError('INVALID_ZIP', `Entry "${entry.name}" has a corrupt local header.`);
  }
  // Local name/extra lengths may legitimately differ from the central copy —
  // always use the local ones to locate the data.
  const nameLength = lh.getUint16(26, true);
  const extraLength = lh.getUint16(28, true);
  const dataStart = entry.localHeaderOffset + LOCAL_HEADER_SIZE + nameLength + extraLength;
  const raw = await readRange(blob, dataStart, dataStart + entry.compressedSize);
  if (raw.byteLength !== entry.compressedSize) {
    throw new ZipReaderError('INVALID_ZIP', `Entry "${entry.name}" is truncated.`);
  }

  let data: Uint8Array;
  if (entry.method === METHOD_STORE) {
    if (raw.byteLength > entry.uncompressedSize) {
      throw new ZipReaderError('INVALID_ZIP', `Entry "${entry.name}" has inconsistent sizes.`);
    }
    data = raw;
  } else if (entry.method === METHOD_DEFLATE) {
    data = await inflateRawCapped(raw, entry.uncompressedSize);
  } else {
    throw new ZipReaderError(
      'UNSUPPORTED_ZIP',
      `Entry "${entry.name}" uses an unsupported compression method (${entry.method}).`,
    );
  }

  if (data.byteLength !== entry.uncompressedSize) {
    throw new ZipReaderError(
      'INVALID_ZIP',
      `Entry "${entry.name}" does not match the size recorded in the archive index.`,
    );
  }

  // Re-run the ratio guard against ACTUAL inflated bytes: the index can lie.
  const ratioBase = Math.max(1, entry.compressedSize);
  if (
    data.byteLength > cfg.ratioGuardMinBytes &&
    data.byteLength / ratioBase > cfg.maxEntryCompressionRatio
  ) {
    throw new ZipReaderError(
      'ZIP_BOMB',
      `Entry "${entry.name}" inflates ${Math.round(data.byteLength / ratioBase)}x — above the ${cfg.maxEntryCompressionRatio}x limit.`,
    );
  }

  return data;
}

export interface WhatsappPlanOptions {
  /** Per-request byte ceiling; entries above it cannot be uploaded at all. */
  maxItemBytes?: number;
}

/**
 * Split an archive index into "receipt images", "chat transcripts" and
 * "skipped, and here is exactly why". Directory entries vanish silently; every
 * other rejection is reported by name so the operator can see what was left
 * behind rather than wondering why a count looks short.
 */
export function planWhatsappImport(
  entries: readonly ZipEntryMeta[],
  options: WhatsappPlanOptions = {},
): WhatsappImportPlan {
  const maxItemBytes = options.maxItemBytes ?? MAX_ITEM_BYTES;
  const images: ZipEntryMeta[] = [];
  const texts: ZipEntryMeta[] = [];
  const skipped: SkippedZipEntry[] = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const kind = classifyEntryName(entry.name);
    if (kind === null) {
      skipped.push({ name: entry.name, reason: disallowedTypeReason(entry.name) });
      continue;
    }
    if (entry.uncompressedSize === 0) {
      skipped.push({ name: entry.name, reason: 'File is empty.' });
      continue;
    }
    if (entry.uncompressedSize > maxItemBytes) {
      // The per-file ceiling is the hosting platform's request-body limit, not
      // a policy choice, so the advice has to be about the FILE. In practice
      // WhatsApp re-compresses photos sent in a chat to well under a megabyte;
      // a receipt only lands here if it was sent as a *document* at full
      // camera resolution.
      const sizeMb = (entry.uncompressedSize / (1024 * 1024)).toFixed(1);
      const limitMb = (maxItemBytes / (1024 * 1024)).toFixed(0);
      skipped.push({
        name: entry.name,
        reason:
          kind === 'image'
            ? `Photo is too large to upload (${sizeMb} MB, limit ${limitMb} MB). It was probably sent as a document — re-send it in the chat as a photo, or add this receipt by hand.`
            : `Chat transcript is too large to upload (${sizeMb} MB, limit ${limitMb} MB). Export a shorter date range; the receipts themselves are unaffected.`,
      });
      continue;
    }
    if (kind === 'image') images.push(entry);
    else texts.push(entry);
  }

  return { images, texts, skipped };
}
