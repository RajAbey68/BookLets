/**
 * The REAL ceiling on a direct browser → serverless upload, and the plain
 * language we use to explain it.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 * BookLets advertised a 100 MB zip limit in two places (`MAX_ZIP_UPLOAD_BYTES`
 * in zip-ingest.ts and a hardcoded `100` in ZipUploadCard). Both were fiction.
 * The hosting platform (Vercel serverless) rejects any request body over
 * ~4.5 MB at the EDGE, with `413 FUNCTION_PAYLOAD_TOO_LARGE` in a PLAIN-TEXT
 * body, BEFORE the serverless function is invoked.
 *
 * Measured against https://booklets-one.vercel.app (July 2026):
 *
 *     3 MB body → 401   (reached the function; auth answered)
 *     4 MB body → 401   (reached the function; auth answered)
 *     5 MB body → 413 FUNCTION_PAYLOAD_TOO_LARGE, plain text, no runtime log
 *
 * Because the function was never invoked, nothing appeared in the runtime
 * logs and `JournalEntry` stayed at 0 rows. The operator's dashboard uploader
 * sat on "Importing… / Reading the archive…" indefinitely — hours of false
 * confidence during a month-end close. Honest, instant failure is the fix.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────
 * This is a PLATFORM TRANSPORT LIMIT, not a business rule and not a security
 * control. It cannot be raised by configuration. The server-side guards in
 * zip-ingest.ts (entry count, uncompressed size, path traversal, zip-bomb
 * ratio, type allowlist) remain the authority for what is safe to ingest;
 * this constant only stops the browser from posting bytes that can never
 * arrive. The client pre-check is a courtesy — the server still enforces
 * everything itself.
 *
 * The permanent fix is to stop routing file bytes through the function at all
 * (direct-to-blob upload + a signed handle). Until that lands, this module is
 * the single source of truth for both uploaders.
 */

/** Whole megabytes, for copy. */
export const MAX_DIRECT_UPLOAD_MB = 4;

/**
 * 4 MB, not 4.5 MB: `multipart/form-data` adds boundary framing and per-part
 * headers on top of the file's own bytes, so a file at exactly 4.5 MB would
 * still post a >4.5 MB body. 4 MB is the largest round number that leaves
 * headroom under the measured edge cut-off.
 */
export const MAX_DIRECT_UPLOAD_BYTES = MAX_DIRECT_UPLOAD_MB * 1024 * 1024;

/**
 * Hard client-side deadline for one upload+import round-trip.
 *
 * Sized between two facts: the route declares `maxDuration = 60` (the server
 * cannot legally take longer than ~60s of processing), and a ≤4 MB body
 * uploads in seconds on any usable connection. 3 minutes is generous for both
 * while making it impossible to stare at a dead request for 10 minutes — the
 * previous timeout was so long that silence was indistinguishable from work.
 */
export const DIRECT_UPLOAD_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * The workaround, in words a non-developer can act on.
 *
 * Deliberately does NOT say "split the zip" — that is not something a normal
 * person can do to a WhatsApp export. It is also deliberately honest that
 * "Without Media" produces no entries: that export contains only `_chat.txt`,
 * and every draft in this pipeline comes from OCR of a receipt IMAGE (see the
 * "Without Media" suite in tests/unit/zip-ingest.test.ts). Sending someone
 * down that path as if it worked would repeat the original sin of this bug.
 */
export const OVERSIZE_UPLOAD_HELP =
  'In WhatsApp, open the chat → Export Chat → Attach Media, but choose a shorter ' +
  `date range (1–2 weeks at a time) so the file comes out under ${MAX_DIRECT_UPLOAD_MB} MB. ` +
  'Export Chat → Without Media does make a tiny file, but it contains no receipt ' +
  'photos, so it creates no entries.';

/** Human file size. Sub-100 KB reads in KB so nothing ever renders "0.0 MB". */
export function formatMb(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe < 1024 * 1024 / 10) return `${Math.round(safe / 1024)} KB`;
  return `${(safe / 1024 / 1024).toFixed(1)} MB`;
}

/** The full "your file is too big" message: what, why, and what to do instead. */
export function describeOversizeUpload(bytes: number): string {
  return (
    `That file is ${formatMb(bytes)} — uploads must be under ${MAX_DIRECT_UPLOAD_MB} MB. ` +
    'That is a hard limit of the hosting platform: anything bigger is rejected in ' +
    'transit and never reaches BookLets at all, so it cannot be raised here. ' +
    OVERSIZE_UPLOAD_HELP
  );
}

/**
 * "Still alive" cue for a long-running upload. A count that visibly moves is
 * the difference between a slow import and a dead one; a static spinner is
 * not.
 */
export function describeElapsed(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s elapsed`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s elapsed`;
}
