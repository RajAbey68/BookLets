/**
 * The ways an archive can get from a phone into the books.
 *
 * There are two, and which one exists depends on which branch you are on:
 *
 *   "zip"       POST /api/ingest/zip — the whole archive in one request.
 *               This is what main does today. It is also what Vercel's edge
 *               rejects for any real archive, which is why nothing has ever
 *               been imported.
 *   "per-item"  The browser expands the archive and POSTs one entry per
 *               request to /api/ingest/item, then closes the run with
 *               /api/ingest/batch. This is PR #133, and it is what the
 *               operator will actually use.
 *
 * The harness DETECTS which of these the running build exposes rather than
 * assuming, and every scenario is written against the user-visible outcome
 * ("N receipts became N drafts"), not against one route's internals. That is
 * what lets this survive #133 landing.
 *
 * The per-item client here deliberately mirrors the real browser client
 * (src/lib/whatsapp-import-client.ts on that branch): same default
 * concurrency of 3, same 429 retry behaviour. If it diverged, the harness
 * would be testing a transport the operator never uses.
 */
import AdmZip from 'adm-zip';

export const TRANSPORT_ZIP = 'zip';
export const TRANSPORT_ITEM = 'per-item';

/** Mirrors DEFAULT_ITEM_CONCURRENCY in the real browser client. */
export const DEFAULT_ITEM_CONCURRENCY = 3;
/**
 * Mirrors MAX_ITEM_BYTES in src/lib/ingest-limits.ts. The real browser client
 * plans the run first and drops entries over this cap locally, so they never
 * become a request. The harness does the same — otherwise it would post a file
 * the real UI never posts, and measure a code path the operator never reaches.
 */
const MAX_ITEM_BYTES = 4 * 1024 * 1024;
/** Mirrors RATE_LIMIT_ATTEMPTS / RATE_LIMIT_BACKOFF_MS in the real client. */
const RATE_LIMIT_ATTEMPTS = 3;
const RATE_LIMIT_BACKOFF_MS = 4000;
const RATE_LIMIT_MAX_WAIT_MS = 30_000;

/**
 * Which transports this build actually serves.
 *
 * Probed WITH a session, deliberately: the auth proxy answers 401 for every
 * /api/* path whether or not the route exists, so an unauthenticated probe
 * would report that every endpoint is present — including ones that are not
 * on this branch at all. Signed in, a missing route 404s and a real one
 * answers 400 (malformed body), which is a true signal.
 */
export async function detectTransports(baseUrl, cookie) {
  const probe = async (path) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: cookie ? { cookie } : {},
      body: '{}',
    });
    return res.status !== 404;
  };
  const [zip, item, batch] = await Promise.all([
    probe('/api/ingest/zip'),
    probe('/api/ingest/item'),
    probe('/api/ingest/batch'),
  ]);
  const available = [];
  if (zip) available.push(TRANSPORT_ZIP);
  if (item && batch) available.push(TRANSPORT_ITEM);
  return { available, zip, item, batch };
}

/** Expand an archive the way the browser does, in archive order. */
export function expandArchive(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  return zip
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => ({ name: entry.entryName, data: entry.getData() }));
}

function uuid() {
  return crypto.randomUUID();
}

/** Upload the whole archive in one request (the main-branch transport). */
export async function uploadWholeZip({ baseUrl, cookie, zipBuffer, signal }) {
  const started = Date.now();
  const res = await fetch(`${baseUrl}/api/ingest/zip`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', cookie },
    body: zipBuffer,
    signal,
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  const report = body?.report ?? null;
  return {
    transport: TRANSPORT_ZIP,
    ok: res.ok,
    status: res.status,
    body,
    elapsedMs: Date.now() - started,
    // Normalised outcome, so scenarios never branch on transport.
    reported: report
      ? {
          created: report.created,
          deduped: report.deduped,
          failed: report.failures?.length ?? 0,
          skipped: report.skipped?.length ?? 0,
          chatFiles: report.chatFiles?.length ?? 0,
        }
      : null,
    perItem: [],
  };
}

/**
 * Upload one entry per request, then close the batch — PR #133's transport,
 * driven exactly as the browser drives it.
 *
 * @param {object} options
 * @param {number} [options.stopAfter]  abandon the run after N successful item
 *                                      posts, WITHOUT closing the batch. This
 *                                      is the "operator closed the laptop"
 *                                      case: it must leave real, resumable work.
 */
export async function uploadPerItem({
  baseUrl,
  cookie,
  zipBuffer,
  concurrency = DEFAULT_ITEM_CONCURRENCY,
  stopAfter = 0,
  batchId = uuid(),
  archiveName = 'export.zip',
  signal,
  onItem,
  cookieForItem,
}) {
  const started = Date.now();
  const allEntries = expandArchive(zipBuffer);
  // Client-side plan, as the browser does it: anything over the per-file cap is
  // never uploaded at all. Tracked separately because the operator IS shown
  // these, while the server-side batch summary can never know about them.
  const clientSkipped = allEntries
    .filter((entry) => entry.data.length > MAX_ITEM_BYTES)
    .map((entry) => ({ name: entry.name, reason: 'over the per-file limit; not uploaded' }));
  const entries = allEntries.filter((entry) => entry.data.length <= MAX_ITEM_BYTES);
  const results = [];
  const transportErrors = [];
  let posted = 0;
  let aborted = false;
  /**
   * Every 429 the server returned, including ones the client recovered from.
   * Counting only the uploads that ran out of retries would hide the real cost:
   * a legitimate import that survives only because it waited out the limiter is
   * still an import the operator watched crawl.
   */
  let rateLimitHits = 0;

  const postOne = async (entry, sequence) => {
    const form = new FormData();
    form.set('file', new File([entry.data], entry.name, { type: 'application/octet-stream' }));
    form.set('batchId', batchId);

    for (let attempt = 1; attempt <= RATE_LIMIT_ATTEMPTS; attempt += 1) {
      const headerCookie = cookieForItem ? cookieForItem(sequence) : cookie;
      let res;
      try {
        res = await fetch(`${baseUrl}/api/ingest/item`, {
          method: 'POST',
          headers: { cookie: headerCookie },
          body: form,
          signal,
        });
      } catch (err) {
        transportErrors.push({ name: entry.name, error: String(err?.message ?? err) });
        return null;
      }
      if (res.status === 429) rateLimitHits += 1;
      if (res.status === 429 && attempt < RATE_LIMIT_ATTEMPTS) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, RATE_LIMIT_MAX_WAIT_MS)
          : RATE_LIMIT_BACKOFF_MS * attempt;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 400) };
      }
      return { name: entry.name, status: res.status, ok: res.ok, body };
    }
    // Unreachable by construction: the final attempt cannot `continue`, because
    // the retry branch requires `attempt < RATE_LIMIT_ATTEMPTS`. Throwing rather
    // than returning a plausible-looking result means that if the loop is ever
    // restructured, the harness stops instead of inventing an outcome.
    throw new Error(`transport bug: postOne fell out of the retry loop for ${entry.name}`);
  };

  const queue = entries.slice();
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, entries.length)) }, async () => {
    for (;;) {
      if (aborted) return;
      const entry = queue.shift();
      if (!entry) return;
      // `posted` is read BEFORE the request (for cookieForItem) and incremented
      // after, so it is claimed here rather than after the await — otherwise
      // concurrent workers all see the same value and the session-expiry
      // scenario switches cookies at the wrong point.
      const sequence = posted;
      posted += 1;
      const result = await postOne(entry, sequence);
      if (result) {
        results.push(result);
        onItem?.(result, results.length);
        if (stopAfter && results.length >= stopAfter) {
          aborted = true;
          return;
        }
      }
    }
  });
  await Promise.all(workers);

  const tally = { created: 0, deduped: 0, failed: 0, skipped: clientSkipped.length, chatFiles: 0 };
  for (const r of results) {
    const item = r.body?.item;
    if (!item) {
      tally.failed += 1;
      continue;
    }
    if (item.kind === 'text') tally.chatFiles += 1;
    else if (item.outcome === 'created') tally.created += 1;
    else if (item.outcome === 'duplicate') tally.deduped += 1;
    else if (item.outcome === 'failed') tally.failed += 1;
    else if (item.outcome === 'skipped') tally.skipped += 1;
  }

  let batchResult = null;
  if (!aborted) {
    const res = await fetch(`${baseUrl}/api/ingest/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ batchId, archiveName }),
      signal,
    }).catch((err) => ({ ok: false, status: 0, text: async () => String(err) }));
    const text = await res.text();
    try {
      batchResult = JSON.parse(text);
    } catch {
      batchResult = { raw: text.slice(0, 400) };
    }
  }

  /**
   * `ok` must mean "the whole archive really went up", not "nothing I chose to
   * look at said otherwise".
   *
   * The previous version was `!aborted && results.every(r => r.ok)`, and
   * `[].every()` is TRUE — so a run in which every single upload died at the
   * transport layer (connection refused, DNS gone, server never started)
   * produced an empty `results`, reported ok:true and status 200, and read as a
   * clean pass having uploaded nothing at all. Same false-pass family as the
   * browser leg: absence of evidence presented as evidence of absence.
   *
   * So being ok now requires positive proof: entries existed, every one of them
   * produced a result, no request failed at the transport layer, and every
   * result was itself ok.
   */
  const expectedUploads = entries.length;
  const completedEveryUpload = !aborted && expectedUploads > 0 && results.length === expectedUploads;
  const ok = completedEveryUpload && transportErrors.length === 0 && results.every((r) => r.ok);

  return {
    transport: TRANSPORT_ITEM,
    ok,
    // Never claim 200 for a run that did not finish: report the first failing
    // status if there is one, else 0.
    status: ok ? 200 : (results.find((r) => !r.ok)?.status ?? 0),
    batchId,
    aborted,
    expectedUploads,
    attemptedUploads: results.length,
    elapsedMs: Date.now() - started,
    transportErrors,
    clientSkipped,
    rateLimitHits,
    /**
     * What the OPERATOR is shown: the browser's own running tally, which
     * includes entries it never uploaded. Deliberately not the server's batch
     * summary — that is the AUDIT record and is reported separately, precisely
     * so the harness can tell the two apart when they disagree.
     */
    reported: tally,
    liveTally: tally,
    /** The permanent audit summary the server recomputed for itself. */
    auditTally: batchResult?.tally ?? null,
    batchResult,
    perItem: results,
  };
}

/**
 * Import an archive over whichever transport is asked for, returning one
 * normalised shape. Scenarios use this and never care which route ran.
 */
export async function importArchive(transport, options) {
  return transport === TRANSPORT_ITEM ? uploadPerItem(options) : uploadWholeZip(options);
}
