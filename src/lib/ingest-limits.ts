/**
 * Per-ITEM ingest limits, shared verbatim by the browser and the server.
 *
 * This module is deliberately dependency-free so it is safe in the client
 * bundle: zip-ingest.ts (the archive-level contract) pulls in adm-zip and
 * node:crypto and can never be imported by a component. Anything both sides
 * must agree on byte-for-byte belongs here rather than in two mirrored copies
 * that can silently drift apart.
 *
 * WHY A PER-ITEM CAP EXISTS AT ALL
 * Vercel's edge rejects a request body over ~4.5 MB with
 * 413 FUNCTION_PAYLOAD_TOO_LARGE *before* the function runs — measured on
 * production: a 4 MB body reaches the handler (401), a 5 MB body does not
 * (413). A whole WhatsApp "Export Chat → Attach Media" archive is tens of MB,
 * so it can never be POSTed in one piece. The browser expands the archive and
 * uploads one entry per request instead; MAX_ITEM_BYTES is the ceiling for a
 * single entry, set below the edge limit with headroom for multipart framing.
 */

/**
 * Largest single archive entry the transport will carry: 4 MB.
 *
 * Headroom note: multipart/form-data adds a boundary, headers and CRLFs around
 * the file part (a few hundred bytes), so a 4 MB file produces a body still
 * comfortably under the ~4.5 MB edge ceiling. Phone camera receipt photos are
 * 1–3 MB, so this rejects essentially nothing real.
 */
export const MAX_ITEM_BYTES = 4 * 1024 * 1024;

/**
 * Longest filename retained after sanitisation. Names arrive from the client
 * now (the server no longer reads them out of a zip central directory), so
 * they are attacker-controlled text that ends up in journal memos, evidence
 * payloads and logs. Cap the length, strip the path and strip control bytes.
 */
export const MAX_ITEM_NAME_LENGTH = 200;

/** Receipt image extensions accepted for OCR. Mirrors zip-ingest.ts. */
export const ITEM_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'heic',
]);

/** Chat transcript extensions accepted as evidence. Mirrors zip-ingest.ts. */
export const ITEM_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['txt']);

/** Lowercased extension of a path, or '' when it has none. */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * True for names that could escape an extraction root: any ".." segment
 * (slash or backslash separated), absolute paths, or Windows drive prefixes.
 * Same predicate as zip-ingest.isPathTraversal — kept here as the
 * client-bundle-safe copy so both transports reject identical names.
 */
export function isUnsafeEntryPath(name: string): boolean {
  if (name.startsWith('/') || name.startsWith('\\')) return true;
  if (/^[A-Za-z]:[\\/]/.test(name)) return true;
  return name.split(/[\\/]/).some((segment) => segment === '..');
}

/** 'image' | 'text' for allowlisted extensions, null for everything else. */
export function classifyEntryName(name: string): 'image' | 'text' | null {
  const ext = extensionOf(name);
  if (ITEM_IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ITEM_TEXT_EXTENSIONS.has(ext)) return 'text';
  return null;
}

/** Human-readable reason used identically by the browser plan and the server. */
export function disallowedTypeReason(name: string): string {
  const ext = extensionOf(name);
  return `Disallowed type ".${ext || '(none)'}" — only jpg/jpeg/png/webp/heic images and .txt chat files are ingested.`;
}
