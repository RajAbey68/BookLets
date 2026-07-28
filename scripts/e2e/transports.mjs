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
  const entries = expandArchive(zipBuffer);
  const results = [];
  const transportErrors = [];
  let posted = 0;
  let aborted = false;

  const postOne = async (entry) => {
    const form = new FormData();
    form.set('file', new File([entry.data], entry.name, { type: 'application/octet-stream' }));
    form.set('batchId', batchId);

    for (let attempt = 1; attempt <= RATE_LIMIT_ATTEMPTS; attempt += 1) {
      const headerCookie = cookieForItem ? cookieForItem(posted) : cookie;
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
    return { name: entry.name, status: 429, ok: false, body: { error: 'rate limited after retries' } };
  };

  const queue = entries.slice();
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, entries.length)) }, async () => {
    for (;;) {
      if (aborted) return;
      const entry = queue.shift();
      if (!entry) return;
      const result = await postOne(entry);
      if (result) {
        results.push(result);
        posted += 1;
        onItem?.(result, posted);
        if (stopAfter && posted >= stopAfter) {
          aborted = true;
          return;
        }
      }
    }
  });
  await Promise.all(workers);

  const tally = { created: 0, deduped: 0, failed: 0, skipped: 0, chatFiles: 0 };
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

  return {
    transport: TRANSPORT_ITEM,
    ok: !aborted && results.every((r) => r.ok),
    status: aborted ? 0 : 200,
    batchId,
    aborted,
    elapsedMs: Date.now() - started,
    transportErrors,
    // The number the OPERATOR is shown comes from the batch summary when the
    // run completes; the per-item tally is what the browser accumulated live.
    reported: batchResult?.tally
      ? {
          created: batchResult.tally.created,
          deduped: batchResult.tally.deduped,
          failed: batchResult.tally.failed,
          skipped: batchResult.tally.skipped,
          chatFiles: batchResult.tally.chatFiles,
        }
      : tally,
    liveTally: tally,
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
