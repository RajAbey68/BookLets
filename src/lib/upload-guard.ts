/**
 * RAJ-456 — Receipt upload guard (pure, no framework imports).
 *
 * Three defences applied by processReceiptAction BEFORE AutomationService
 * spends memory or SymbiOS/Gemini budget on a payload:
 *
 *   1. assertPayloadSize      — size cap estimated from base64 string length
 *                               (no full decode of oversize payloads).
 *   2. assertImageMagicBytes  — decode only a small prefix and check real
 *                               image signatures; client accept="image/*"
 *                               is a UI hint, not a control.
 *   3. RateLimiter            — in-memory token bucket per organizationId.
 *
 * LIMITATION (documented, accepted per RAJ-456): the rate limiter is
 * per-process only. Under multi-instance or serverless deployment each
 * lambda/replica holds its own bucket, so the effective global limit is
 * N × capacity. That is acceptable defence-in-depth for this issue; a
 * shared store (Redis/Postgres) would be needed for a hard global cap.
 */

export type UploadGuardCode = 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'RATE_LIMITED';

export class UploadGuardError extends Error {
  readonly code: UploadGuardCode;

  constructor(code: UploadGuardCode, message: string) {
    super(message);
    this.name = 'UploadGuardError';
    this.code = code;
  }
}

/** Default cap on the DECODED receipt image size: 5 MB. */
export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

/**
 * Estimate the decoded byte size of a base64 string from its length alone:
 * every 4 chars encode 3 bytes, minus 1 byte per trailing '=' pad.
 */
export function estimateDecodedBytes(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Reject oversize (or empty) payloads with a typed error BEFORE any full
 * decode. Only string length is inspected — O(1) memory.
 */
export function assertPayloadSize(base64: string, maxBytes: number = MAX_RECEIPT_BYTES): void {
  if (!base64 || base64.length === 0) {
    throw new UploadGuardError('UNSUPPORTED_TYPE', 'No image data received.');
  }
  const estimated = estimateDecodedBytes(base64);
  if (estimated > maxBytes) {
    const mb = (maxBytes / (1024 * 1024)).toFixed(0);
    throw new UploadGuardError(
      'PAYLOAD_TOO_LARGE',
      `Image is too large (~${(estimated / (1024 * 1024)).toFixed(1)} MB). Maximum size is ${mb} MB.`,
    );
  }
}

/** How many decoded bytes we need to identify every supported format. */
const MAGIC_PREFIX_BYTES = 16;

function decodePrefix(base64: string, bytes: number): Buffer {
  // 4 base64 chars → 3 bytes; take enough chars (rounded to a 4-char
  // boundary) to yield `bytes` decoded bytes. Never decodes the full payload.
  const chars = Math.ceil(bytes / 3) * 4;
  return Buffer.from(base64.slice(0, chars), 'base64');
}

/**
 * Validate real image magic bytes on a decoded prefix only.
 * Accepts JPEG, PNG, HEIC/HEIF and WebP; anything else is rejected.
 */
export function assertImageMagicBytes(base64: string): void {
  if (!base64 || base64.length === 0) {
    throw new UploadGuardError('UNSUPPORTED_TYPE', 'No image data received.');
  }

  const head = decodePrefix(base64, MAGIC_PREFIX_BYTES);
  if (head.length < 12) {
    throw new UploadGuardError('UNSUPPORTED_TYPE', 'File is not a recognisable image.');
  }

  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return;

  // PNG: 89 50 4E 47
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return;

  // HEIC/HEIF: ISO-BMFF 'ftyp' box at offset 4 with a known image brand.
  const ftyp = head.subarray(4, 12).toString('latin1');
  if (ftyp === 'ftypheic' || ftyp === 'ftypheix' || ftyp === 'ftypmif1') return;

  // WebP: 'RIFF' at 0 and 'WEBP' at 8.
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return;
  }

  throw new UploadGuardError(
    'UNSUPPORTED_TYPE',
    'Unsupported file type. Please upload a JPEG, PNG, HEIC or WebP image.',
  );
}

export interface RateLimiterOptions {
  /** Maximum burst size (bucket capacity). */
  capacity: number;
  /** Continuous refill rate, tokens per minute. */
  refillPerMinute: number;
  /** Injectable clock returning milliseconds; defaults to Date.now at CALL time. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Simple in-memory token bucket keyed by an arbitrary string (here:
 * organizationId). Continuous refill, no timers. Per-process only — see
 * module header for the multi-instance limitation.
 */
export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: RateLimiterOptions) {
    if (options.capacity <= 0 || options.refillPerMinute <= 0) {
      throw new Error('RateLimiter: capacity and refillPerMinute must be positive.');
    }
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerMinute / 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Consume one token for `key`. Returns false when the bucket is empty. */
  tryConsume(key: string): boolean {
    const nowMs = this.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillMs: nowMs };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
      bucket.lastRefillMs = nowMs;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Shared limiter for receipt processing: 10 receipts/min per organisation,
 * refilling continuously. Module-level so all requests in this process
 * share the same buckets.
 */
export const receiptRateLimiter = new RateLimiter({ capacity: 10, refillPerMinute: 10 });
