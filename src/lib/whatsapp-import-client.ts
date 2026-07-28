/**
 * Browser-side WhatsApp import orchestrator.
 *
 * Expands the archive locally (zip-reader.ts) and uploads one entry per
 * request to POST /api/ingest/item, because Vercel's edge rejects any body
 * over ~4.5 MB before the function runs and a real "Export Chat → Attach
 * Media" archive is tens of megabytes.
 *
 * Three properties matter more than anything else here, because the person
 * driving this is closing his books, not debugging a web app:
 *
 *  1. PROGRESS IS REAL. Every tick is a finished server round-trip, not a
 *     spinner. A spinner cannot tell a slow import from a stuck one.
 *  2. PARTIAL RUNS TELL THE TRUTH. If the connection drops at item 34 of 120,
 *     the report says 34 — those 34 drafts really are in the ledger.
 *  3. RE-RUNNING RESUMES, IT DOES NOT DUPLICATE. The server keys every entry
 *     on sha256 of its own bytes, so a second run reports the first run's
 *     receipts as duplicates and imports only what is genuinely new.
 *
 * This module is deliberately free of React and of any Node-only import so it
 * can be unit-tested in the node environment with an injected `fetch`.
 */
import {
  MAX_ITEM_BYTES,
  ZipReaderError,
  planWhatsappImport,
  readZipDirectory,
  readZipEntry,
  type SkippedZipEntry,
  type ZipEntryMeta,
} from './zip-reader';

/** Endpoint that accepts one archive entry. */
export const ITEM_ENDPOINT = '/api/ingest/item';
/** Endpoint that closes an import run with a server-recounted summary. */
export const BATCH_ENDPOINT = '/api/ingest/batch';

/**
 * How many item uploads are in flight at once.
 *
 * Lower than the old server-side OCR_CONCURRENCY_LIMIT of 5 on purpose: each
 * upload is now its own transaction writing to the hash-chained evidence log,
 * whose head read/write can fork under concurrent writers for one tenant
 * (documented caveat in evidence-log.service.ts). Three keeps the import quick
 * without widening a known audit-integrity window.
 */
export const DEFAULT_ITEM_CONCURRENCY = 3;

/** Attempts per item when the server answers 429 (rate limited). */
const RATE_LIMIT_ATTEMPTS = 3;
const RATE_LIMIT_BACKOFF_MS = 4000;

export interface WhatsappImportProgress {
  /** Items finished so far (any outcome). */
  done: number;
  /** Items this run will attempt. */
  total: number;
  /** The file just finished. */
  name: string;
  created: number;
  deduped: number;
  failed: number;
}

export interface WhatsappImportFailure {
  name: string;
  /** 'upload' means the request itself failed — the server never judged it. */
  stage: 'ocr' | 'ledger' | 'upload';
  error: string;
}

export interface WhatsappChatFile {
  name: string;
  messageCount: number;
  participants: string[];
}

export interface WhatsappImportReport {
  batchId: string;
  archiveName: string;
  totalEntries: number;
  /** Receipt images the archive contained and this run intended to upload. */
  imageCount: number;
  textCount: number;
  skipped: SkippedZipEntry[];
  /** DRAFT journal entries created. Chat transcripts are never counted here. */
  created: number;
  deduped: number;
  failures: WhatsappImportFailure[];
  chatFiles: WhatsappChatFile[];
  journalEntryIds: string[];
  /** Items actually attempted — lower than the total when a run is cut short. */
  attempted: number;
  /** True when the run stopped before every planned item was attempted. */
  interrupted: boolean;
}

export interface WhatsappImportOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (progress: WhatsappImportProgress) => void;
  /** Overridable for tests; production always uses the module constants. */
  itemEndpoint?: string;
  batchEndpoint?: string;
  batchId?: string;
}

interface ItemResponse {
  name?: string;
  kind?: string;
  outcome?: string;
  journalEntryId?: string;
  stage?: 'ocr' | 'ledger';
  reason?: string;
  messageCount?: number;
  participants?: string[];
}

function newBatchId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback for a browser without randomUUID: shape-compatible, and the id is
  // only ever a correlation label the server re-validates.
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readErrorText(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body?.error === 'string' && body.error.trim().length > 0) return body.error;
  } catch {
    /* non-JSON error page (a proxy/edge response) — use the fallback */
  }
  return fallback;
}

/**
 * Upload ONE archive entry. Returns the server's verdict, or throws so the
 * caller can record an 'upload' stage failure and carry on with the rest.
 */
async function uploadItem(
  bytes: Uint8Array,
  name: string,
  batchId: string,
  endpoint: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<ItemResponse> {
  for (let attempt = 1; ; attempt += 1) {
    const form = new FormData();
    form.append('file', new File([bytes as unknown as BlobPart], name));
    form.append('batchId', batchId);

    const response = await fetchImpl(endpoint, { method: 'POST', body: form, signal });

    if (response.status === 429 && attempt < RATE_LIMIT_ATTEMPTS) {
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30_000)
        : RATE_LIMIT_BACKOFF_MS * attempt;
      await sleep(waitMs);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        await readErrorText(response, `The server rejected this file (HTTP ${response.status}).`),
      );
    }

    const body = (await response.json()) as { item?: ItemResponse };
    return body?.item ?? {};
  }
}

/**
 * Expand `file` in the browser and import every receipt it contains.
 *
 * Throws only for an archive-level rejection (not a zip, zip bomb, Zip64,
 * password protected, unsupported browser) — pass that to
 * {@link describeImportFailure} for operator-facing copy. Per-item problems
 * never throw: they land in `failures` or `skipped` and the run continues.
 */
export async function importWhatsappExport(
  file: Blob & { name?: string },
  options: WhatsappImportOptions = {},
): Promise<WhatsappImportReport> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const itemEndpoint = options.itemEndpoint ?? ITEM_ENDPOINT;
  const batchEndpoint = options.batchEndpoint ?? BATCH_ENDPOINT;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_ITEM_CONCURRENCY);
  const batchId = options.batchId ?? newBatchId();
  const archiveName = file.name ?? 'export.zip';
  const { signal } = options;

  // Archive-level guards run here, before a single byte leaves the machine.
  const entries = await readZipDirectory(file);
  const plan = planWhatsappImport(entries, { maxItemBytes: MAX_ITEM_BYTES });

  const report: WhatsappImportReport = {
    batchId,
    archiveName,
    totalEntries: entries.length,
    imageCount: plan.images.length,
    textCount: plan.texts.length,
    skipped: [...plan.skipped],
    created: 0,
    deduped: 0,
    failures: [],
    chatFiles: [],
    journalEntryIds: [],
    attempted: 0,
    interrupted: false,
  };

  const total = plan.texts.length + plan.images.length;
  let done = 0;

  const tick = (name: string) => {
    done += 1;
    report.attempted = done;
    options.onProgress?.({
      done,
      total,
      name,
      created: report.created,
      deduped: report.deduped,
      failed: report.failures.length,
    });
  };

  const runOne = async (entry: ZipEntryMeta, kind: 'image' | 'text') => {
    let item: ItemResponse;
    try {
      const bytes = await readZipEntry(file, entry);
      item = await uploadItem(bytes, entry.name, batchId, itemEndpoint, fetchImpl, signal);
    } catch (err) {
      // A cancelled run must not invent a failure for the request it cut off:
      // that item was never judged, so it is neither attempted nor failed. The
      // interrupted report already tells the operator where it stopped.
      if (signal?.aborted) return;
      report.failures.push({
        name: entry.name,
        stage: 'upload',
        error: err instanceof Error ? err.message : String(err),
      });
      tick(entry.name);
      return;
    }

    const name = item.name ?? entry.name;
    if (kind === 'text') {
      if (item.outcome === 'created') {
        report.chatFiles.push({
          name,
          messageCount: item.messageCount ?? 0,
          participants: item.participants ?? [],
        });
      } else if (item.outcome === 'failed') {
        report.failures.push({
          name,
          stage: item.stage ?? 'upload',
          error: item.reason ?? 'The chat transcript could not be read.',
        });
      } else {
        report.skipped.push({ name, reason: item.reason ?? 'The chat transcript was not stored.' });
      }
      tick(name);
      return;
    }

    switch (item.outcome) {
      case 'created':
        report.created += 1;
        if (item.journalEntryId) report.journalEntryIds.push(item.journalEntryId);
        break;
      case 'duplicate':
        report.deduped += 1;
        break;
      case 'failed':
        report.failures.push({
          name,
          stage: item.stage ?? 'ocr',
          error: item.reason ?? 'This receipt could not be read.',
        });
        break;
      default:
        report.skipped.push({ name, reason: item.reason ?? 'This file was not imported.' });
        break;
    }
    tick(name);
  };

  const aborted = () => signal?.aborted === true;

  // Chat transcripts first and sequentially: the transcript is the evidence
  // the receipts are read against, so it should be on record before any draft
  // referring to that conversation exists.
  for (const text of plan.texts) {
    if (aborted()) break;
    await runOne(text, 'text');
  }

  if (!aborted()) {
    let next = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, Math.max(1, plan.images.length)) },
      async () => {
        for (;;) {
          if (aborted()) return;
          const index = next;
          next += 1;
          if (index >= plan.images.length) return;
          await runOne(plan.images[index], 'image');
        }
      },
    );
    await Promise.all(workers);
  }

  report.interrupted = report.attempted < total;

  // Close the run with a summary the SERVER recounts from its own evidence
  // rows. Best-effort by design: the drafts are already saved, so a failed
  // summary must never be reported to the operator as a failed import.
  if (!report.interrupted) {
    try {
      await fetchImpl(batchEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batchId, archiveName }),
        signal,
      });
    } catch {
      /* summary is an audit convenience, never a gate on the import */
    }
  }

  return report;
}

/**
 * Adapter to the shape summarizeZipUploadResponse (zip-upload-result.ts)
 * already understands, so the existing plain-language summariser — and its
 * tests — keep working unchanged across the transport swap.
 */
export function toUploadReport(report: WhatsappImportReport) {
  return {
    zipHash: report.batchId,
    totalEntries: report.totalEntries,
    imageCount: report.imageCount,
    textCount: report.textCount,
    skipped: report.skipped,
    created: report.created,
    deduped: report.deduped,
    failures: report.failures,
    chatFiles: report.chatFiles.map((c) => ({
      name: c.name,
      sha256: '',
      messageCount: c.messageCount,
      participants: c.participants,
    })),
    journalEntryIds: report.journalEntryIds,
  };
}

// ─── operator-facing copy for archive-level rejections ───────────────────────

export interface ImportFailureCopy {
  ok: false;
  title: string;
  message: string;
}

const ARCHIVE_FAILURE_COPY: Record<string, ImportFailureCopy> = {
  INVALID_ZIP: {
    ok: false,
    title: 'Not a WhatsApp export',
    message:
      'That file could not be opened as a .zip archive. In WhatsApp, open the chat → Export Chat → Attach Media, and pick the .zip it saves.',
  },
  TOO_MANY_ENTRIES: {
    ok: false,
    title: 'Export is too big',
    message:
      'That archive holds more files than one import can handle. Export a shorter date range — a week or two at a time — and import those.',
  },
  TOTAL_SIZE_EXCEEDED: {
    ok: false,
    title: 'Export is too big',
    message:
      'The photos in that archive add up to more than one import can handle. Export a shorter date range and import those.',
  },
  PATH_TRAVERSAL: {
    ok: false,
    title: 'Archive rejected',
    message:
      'That archive contains file names that a WhatsApp export never produces, so it was not imported. Re-export the chat from WhatsApp and try that file.',
  },
  ZIP_BOMB: {
    ok: false,
    title: 'Archive rejected',
    message:
      'A file inside that archive expands to an unreasonable size, so it was not opened. Re-export the chat from WhatsApp and try that file.',
  },
  UNSUPPORTED_ZIP: {
    ok: false,
    title: 'Archive cannot be opened',
    message:
      'That archive uses a zip feature this importer cannot read (it may be password protected, or split across parts). Re-export the chat from WhatsApp and try that file.',
  },
  UNSUPPORTED_BROWSER: {
    ok: false,
    title: 'Browser too old',
    message:
      'This browser cannot open zip files. Update it, or use an up-to-date Chrome, Edge, Safari or Firefox, and try the import again.',
  },
};

/**
 * Plain-language copy for an archive-level failure. Never returns a bare
 * technical string: a non-developer must always be told what to DO next.
 */
export function describeImportFailure(err: unknown): ImportFailureCopy {
  if (err instanceof ZipReaderError) {
    const copy = ARCHIVE_FAILURE_COPY[err.code];
    if (copy) return copy;
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return {
      ok: false,
      title: 'Import stopped',
      message:
        'The import was cancelled. Re-upload the same export to carry on — receipts already imported are skipped automatically.',
    };
  }
  return {
    ok: false,
    title: 'Import failed',
    message:
      'The export could not be read. Check the file is the .zip WhatsApp saved, then try again — nothing was imported twice.',
  };
}
