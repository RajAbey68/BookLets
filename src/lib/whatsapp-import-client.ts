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
  type ZipReaderCode,
} from './zip-reader';
import type { ZipIngestReport } from './zip-ingest';

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

/**
 * Attempts per item when the server answers 429 (rate limited).
 *
 * A 429 now has two distinct causes, and both are legitimately survivable:
 * BookLets' own per-organisation token bucket (retry-after 10 s), and the OCR
 * provider throttling us upstream (retry-after from the provider's own hint).
 * Five attempts is enough to ride out a per-minute provider quota without
 * turning one slow photo into a stalled run.
 */
const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_BACKOFF_MS = 4000;
/** Ceiling on an honoured `retry-after`, so a bad header cannot park a run. */
const RATE_LIMIT_MAX_WAIT_MS = 30_000;

/** Server code accompanying a 429 caused by the OCR provider, not by us. */
const OCR_RATE_LIMITED_CODE = 'OCR_RATE_LIMITED';
/**
 * Server code (503) meaning the OCR account's API quota is SPENT.
 *
 * It arrives as a 503 rather than a 429 precisely so it never enters the
 * backoff ladder below: there is nothing to wait for, and each retry would be
 * another billable request against an allowance that has already run out. One
 * request, then the run stops.
 */
const OCR_QUOTA_EXHAUSTED_CODE = 'OCR_QUOTA_EXHAUSTED';
/** Server codes (503) meaning the OCR service itself is down or misconfigured. */
const OCR_SERVICE_DOWN_CODES = new Set(['OCR_UNAVAILABLE', 'OCR_AUTH_FAILED']);

/**
 * Raised when the OCR SERVICE — not this receipt — is the problem: throttled,
 * unreachable, or rejecting our credentials. Distinct from an ordinary upload
 * failure: it says nothing about the photo, it will not improve within this
 * run, and every remaining item would hit the same wall. The run stops and
 * says so instead of grinding through the rest producing false "couldn't be
 * read" verdicts.
 */
export class OcrServiceError extends Error {
  /**
   * The interrupt reason this maps to, carried explicitly rather than derived
   * from a boolean: "throttled" and "unreachable" are both transient, so a
   * transient/permanent flag cannot tell them apart and silently reported an
   * outage as a rate limit. The two need different advice, so they stay
   * distinct all the way to the operator.
   */
  readonly reason: OcrStopReason;

  constructor(message: string, reason: OcrStopReason) {
    super(message);
    this.name = 'OcrServiceError';
    this.reason = reason;
  }
}

/**
 * Inactivity watchdog. NOT a total-run budget: a 200-receipt import
 * legitimately runs for half an hour, and cancelling that at a fixed deadline
 * would throw away real work. What must never happen is silence — if no single
 * item finishes for this long, the run is stopped and said so, rather than
 * leaving a card spinning with no way back. Set to 0 to disable.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/** Why a run stopped before attempting every item. */
export type ImportInterruptedReason =
  | 'cancelled'
  | 'idle-timeout'
  /** OCR provider throttled us — waiting and re-uploading will work. */
  | 'ocr-rate-limited'
  /**
   * The OCR account's API quota is spent. Distinct from 'ocr-rate-limited'
   * because the advice is opposite: waiting a minute will NOT help, and the
   * fix (raising the quota / enabling billing on that key) is not the
   * operator's to perform. Telling him to "wait and try again" here would be a
   * second false statement on top of "225 couldn't be read".
   */
  | 'ocr-quota-exhausted'
  /** OCR service is down or its credentials are rejected — may need an admin. */
  | 'ocr-unavailable';

/** The subset of stop reasons that mean "the OCR service, not this receipt". */
export type OcrStopReason = Extract<
  ImportInterruptedReason,
  'ocr-rate-limited' | 'ocr-quota-exhausted' | 'ocr-unavailable'
>;

/**
 * The clock this module measures its two delays with: the inactivity watchdog
 * and the rate-limit backoff.
 *
 * Injectable for ONE reason. Both behaviours are statements about elapsed time,
 * and the archive around them is expanded through `DecompressionStream` — real
 * async IO that a fake-timer library cannot drive. A test that fakes
 * `setTimeout` must therefore keep pumping the real event loop to let the unzip
 * proceed, which couples virtual time to real IO latency: on a loaded machine a
 * slow unzip is indistinguishable from genuine silence, so the watchdog fires
 * when it should not, the run parks on a request that was aborted before it was
 * issued, and a wait for "the first request went out" expires while the
 * threadpool is still busy. Handing the clock in decouples them — the test says
 * exactly when time passes, and real IO takes as long as the machine needs.
 *
 * Production never passes this — {@link HOST_TIMERS} is the default and is a
 * straight pass-through to the host's own `setTimeout`/`clearTimeout`.
 */
export interface ImportTimers {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/**
 * The default clock: the host's timers, resolved at CALL time so that a test
 * which fakes the globals still sees its fakes through the default path.
 */
export const HOST_TIMERS: ImportTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One tick per FINISHED item. Emitted whatever the outcome, so the count
 * always moves — the point is to distinguish a slow import from a stuck one.
 */
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

/**
 * An entry that did not import, and how far it got. `stage` matters to the
 * operator: an OCR failure means the photo is unreadable, an upload failure
 * means the request never landed and a retry will probably work.
 */
export interface WhatsappImportFailure {
  name: string;
  /** 'upload' means the request itself failed — the server never judged it. */
  stage: 'ocr' | 'ledger' | 'upload';
  error: string;
}

/** A chat transcript accepted as evidence (never a journal entry). */
export interface WhatsappChatFile {
  name: string;
  messageCount: number;
  participants: string[];
}

/**
 * The outcome of one import run, as reported to the operator.
 *
 * Every count here is a tally of SERVER responses, not of attempts made:
 * "34 imported" has to be literally true, because it is what someone will
 * rely on when deciding whether his books are complete.
 */
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
  /**
   * Why it stopped, so the UI can distinguish "you cancelled" from "nothing
   * responded for three minutes" — those need different advice.
   */
  interruptedReason: ImportInterruptedReason | null;
  /**
   * The provider's own explanation, when there is one worth repeating
   * verbatim (currently only 'ocr-rate-limited'). Null otherwise.
   */
  interruptedDetail: string | null;
}

/**
 * Knobs for one import run. All optional: the defaults are what production
 * uses, and the injectable `fetchImpl` is what keeps this module testable
 * with no network.
 */
export interface WhatsappImportOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (progress: WhatsappImportProgress) => void;
  /**
   * Stop the run if no item finishes for this long. Defaults to
   * DEFAULT_IDLE_TIMEOUT_MS; 0 disables the watchdog. Every caller gets this
   * for free, so "never hang silently" is a property of the transport rather
   * than something each card has to remember to re-implement.
   */
  idleTimeoutMs?: number;
  /**
   * Clock for the inactivity watchdog and the rate-limit backoff. Defaults to
   * {@link HOST_TIMERS}, so production behaviour is exactly as before; tests
   * inject a clock they drive by hand. See {@link ImportTimers}.
   */
  timers?: ImportTimers;
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

/**
 * Wait `ms`, or until `signal` aborts — whichever comes first.
 *
 * Resolves (never rejects) on abort so the caller decides what to do; a plain
 * setTimeout would make a cancelled import sit through the whole backoff before
 * noticing, which is the same "unresponsive UI" failure in miniature.
 */
function sleep(ms: number, signal: AbortSignal | undefined, timers: ImportTimers): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      timers.clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = timers.setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Read an error response, returning the server's message and its
 * machine-readable `code` — the code is what tells the caller WHICH kind of
 * failure this was (our own token bucket, or the OCR provider), which decides
 * whether one item failed or the whole run should stop.
 */
async function readErrorBody(
  response: Response,
  fallback: string,
): Promise<{ message: string; code?: string }> {
  try {
    const body = (await response.json()) as { error?: unknown; code?: unknown };
    const message =
      typeof body?.error === 'string' && body.error.trim().length > 0 ? body.error : fallback;
    const code = typeof body?.code === 'string' ? body.code : undefined;
    return { message, code };
  } catch {
    /* non-JSON error page (a proxy/edge response) — use the fallback */
    return { message: fallback };
  }
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
  timers: ImportTimers,
  /**
   * Called immediately before each deliberate rate-limit wait.
   *
   * The inactivity watchdog measures SILENCE — "nothing has come back for
   * minutes, so the run is wedged". A backoff we chose to sit through is the
   * opposite of silence: we know exactly why we are waiting and for how long.
   * Without this signal, riding out a provider quota (up to 5 attempts against
   * a clamped 60 s retry-after) outlasts the 3-minute watchdog, which then
   * aborts the run and reports 'idle-timeout' — burying the one cause the
   * operator can actually act on.
   */
  onBackoff?: () => void,
): Promise<ItemResponse> {
  for (let attempt = 1; ; attempt += 1) {
    const form = new FormData();
    form.append('file', new File([bytes as unknown as BlobPart], name));
    form.append('batchId', batchId);

    const response = await fetchImpl(endpoint, { method: 'POST', body: form, signal });

    if (response.status === 429) {
      if (attempt < RATE_LIMIT_ATTEMPTS) {
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, RATE_LIMIT_MAX_WAIT_MS)
            : Math.min(RATE_LIMIT_BACKOFF_MS * attempt, RATE_LIMIT_MAX_WAIT_MS);
        // Deliberate wait, not silence — keep the watchdog off our back.
        onBackoff?.();
        await sleep(waitMs, signal, timers);
        if (signal?.aborted) {
          throw new DOMException('The import was cancelled.', 'AbortError');
        }
        continue;
      }

      // Retries exhausted. If the provider is the one throttling, this is a
      // run-level condition, not an item-level one — surface it as such so the
      // caller can stop rather than repeat it for every remaining receipt.
      const { message, code } = await readErrorBody(
        response,
        'The OCR service is rate limited right now.',
      );
      if (code === OCR_RATE_LIMITED_CODE) {
        throw new OcrServiceError(message, 'ocr-rate-limited');
      }
      throw new Error(message);
    }

    if (!response.ok) {
      const { message, code } = await readErrorBody(
        response,
        `The server rejected this file (HTTP ${response.status}).`,
      );
      // The account's OCR quota is spent. Reaching this line means exactly ONE
      // request was spent discovering it — no backoff ladder was entered,
      // because the server answered 503 rather than 429. Every remaining
      // receipt would buy the same answer, so the run stops here.
      if (code === OCR_QUOTA_EXHAUSTED_CODE) {
        throw new OcrServiceError(message, 'ocr-quota-exhausted');
      }
      // The OCR service is down or misconfigured. Not this receipt's fault, and
      // not survivable by retrying the next one — stop the whole run.
      if (code && OCR_SERVICE_DOWN_CODES.has(code)) {
        throw new OcrServiceError(message, 'ocr-unavailable');
      }
      throw new Error(message);
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
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const timers = options.timers ?? HOST_TIMERS;

  // One controller drives the whole run: the caller's signal and the
  // inactivity watchdog both feed into it, and it is what every fetch is given.
  // Putting the watchdog HERE rather than in each component means no caller can
  // forget it — a stalled request can never strand a card on "Importing…".
  const controller = new AbortController();
  const { signal } = controller;
  let stalled = false;
  let ocrDownReason: OcrStopReason | null = null;
  let ocrDownMessage = '';
  let idleTimer: unknown;

  const armWatchdog = () => {
    if (idleTimeoutMs <= 0) return;
    if (idleTimer !== undefined) timers.clearTimeout(idleTimer);
    idleTimer = timers.setTimeout(() => {
      stalled = true;
      controller.abort();
    }, idleTimeoutMs);
  };
  const disarmWatchdog = () => {
    if (idleTimer !== undefined) timers.clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const cancelFromCaller = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', cancelFromCaller, { once: true });

  // Armed before the first request and reset by every completed item, so it
  // measures SILENCE rather than duration.
  armWatchdog();

  try {
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
    interruptedReason: null,
    interruptedDetail: null,
  };

  const total = plan.texts.length + plan.images.length;
  let done = 0;

  const tick = (name: string) => {
    done += 1;
    report.attempted = done;
    armWatchdog();
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
      // Expanding the entry is real work, and a cancel or an idle-timeout can
      // land while it happens. Re-check before going to the network: the run is
      // already over, so this request could only ever be thrown away, and
      // issuing it anyway would leave the outcome to however the host's fetch
      // treats a signal that is already aborted.
      if (signal.aborted) return;
      item = await uploadItem(
        bytes,
        entry.name,
        batchId,
        itemEndpoint,
        fetchImpl,
        signal,
        timers,
        armWatchdog,
      );
    } catch (err) {
      // The OCR provider is throttling. Every remaining receipt would hit the
      // same wall, and recording each one as a failure is precisely the lie
      // that made a rate-limited run look like 225 unreadable photographs.
      // Stop the run; the report says how far it got and that re-running
      // resumes. No failure is recorded — this item was never judged.
      if (err instanceof OcrServiceError) {
        ocrDownReason = err.reason;
        ocrDownMessage = err.message;
        controller.abort();
        return;
      }
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

  const aborted = () => signal.aborted;

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
  if (report.interrupted) {
    // An OCR service fault is checked first: it is the specific, actionable
    // cause, and it aborts the same controller a cancellation would.
    // 'ocr-rate-limited' means "wait, then re-upload"; 'ocr-unavailable' means
    // the service is down or its key is rejected — waiting may not be enough.
    report.interruptedReason = ocrDownReason ?? (stalled ? 'idle-timeout' : 'cancelled');
    report.interruptedDetail = ocrDownReason ? ocrDownMessage : null;
  }

  // Close the run with a summary the SERVER recounts from its own evidence
  // rows. Best-effort by design: the drafts are already saved, so a failed
  // summary must never be reported to the operator as a failed import. Skipped
  // entirely for an interrupted run — recording a completion for a partial
  // import would put a half-truth in the audit trail.
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
  } finally {
    disarmWatchdog();
    options.signal?.removeEventListener('abort', cancelFromCaller);
  }
}

/**
 * Adapter to the shape summarizeZipUploadResponse (zip-upload-result.ts)
 * already understands, so the existing plain-language summariser — and its
 * tests — keep working unchanged across the transport swap.
 *
 * The return type is pinned to ZipIngestReport so a change to that contract
 * breaks here at compile time instead of silently producing a summary with
 * missing fields.
 */
export function toUploadReport(report: WhatsappImportReport): ZipIngestReport {
  return {
    // There is no zip hash any more — the archive is never uploaded. The batch
    // id is the equivalent per-run correlation handle, and it is what the
    // server writes into every evidence row for this import, so it is the
    // right value for a field the summariser only ever passes through.
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

/**
 * Operator-facing copy for a failure: a short heading and a sentence that
 * says what to DO next. Never raw technical text.
 */
export interface ImportFailureCopy {
  ok: false;
  title: string;
  message: string;
}

/**
 * Typed as a TOTAL Record over ZipReaderCode on purpose: adding a new reader
 * error code becomes a compile error here, so a new failure mode can never
 * silently fall through to the generic "something went wrong" message.
 */
const ARCHIVE_FAILURE_COPY: Record<ZipReaderCode, ImportFailureCopy> = {
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
