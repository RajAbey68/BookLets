/**
 * RAJ-456 — SEC: receipt upload hardening.
 *
 * Security review H2 (2026-07-03): processReceiptAction accepted an
 * arbitrary-size `imageBase64` with no server-side size check, no
 * magic-byte/MIME validation (the client's accept="image/*" is a UI hint
 * only) and no rate limiting — memory-pressure DoS plus uncontrolled
 * downstream SymbiOS/Gemini spend per call.
 *
 * These tests drive a pure guard module (src/lib/upload-guard.ts):
 *   - assertPayloadSize: rejects oversize payloads from the base64 string
 *     LENGTH (estimated decoded size) — before any full decode.
 *   - assertImageMagicBytes: decodes only a small prefix and accepts
 *     JPEG / PNG / HEIC-HEIF / WebP; everything else is rejected.
 *   - RateLimiter: in-memory token bucket keyed by organizationId with an
 *     injectable clock (per-process defence-in-depth only).
 */
import { describe, it, expect } from 'vitest';
import {
  assertPayloadSize,
  assertImageMagicBytes,
  RateLimiter,
  UploadGuardError,
  MAX_RECEIPT_BYTES,
} from '../../src/lib/upload-guard';

/** Build a base64 string whose DECODED size is exactly `bytes`. */
function base64OfSize(bytes: number, fill = 0x41): string {
  return Buffer.alloc(bytes, fill).toString('base64');
}

/** Base64 with a specific binary prefix, padded with zeros to `total` bytes. */
function base64WithPrefix(prefix: number[] | string, total = 64): string {
  const head = typeof prefix === 'string' ? Buffer.from(prefix, 'latin1') : Buffer.from(prefix);
  const buf = Buffer.concat([head, Buffer.alloc(Math.max(0, total - head.length))]);
  return buf.toString('base64');
}

describe('RAJ-456 — assertPayloadSize', () => {
  it('exports a 5 MB decoded-size default limit', () => {
    expect(MAX_RECEIPT_BYTES).toBe(5 * 1024 * 1024);
  });

  it('accepts a payload just under the limit', () => {
    expect(() => assertPayloadSize(base64OfSize(MAX_RECEIPT_BYTES - 1))).not.toThrow();
  });

  it('accepts a payload exactly at the limit', () => {
    expect(() => assertPayloadSize(base64OfSize(MAX_RECEIPT_BYTES))).not.toThrow();
  });

  it('rejects a payload just over the limit with a typed error', () => {
    expect(() => assertPayloadSize(base64OfSize(MAX_RECEIPT_BYTES + 3))).toThrow(UploadGuardError);
  });

  it('reports code PAYLOAD_TOO_LARGE on oversize', () => {
    try {
      assertPayloadSize(base64OfSize(MAX_RECEIPT_BYTES + 3));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UploadGuardError);
      expect((err as UploadGuardError).code).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  it('rejects an empty payload', () => {
    expect(() => assertPayloadSize('')).toThrow(UploadGuardError);
  });

  it('honours a custom maxBytes', () => {
    expect(() => assertPayloadSize(base64OfSize(11), 10)).toThrow(UploadGuardError);
    expect(() => assertPayloadSize(base64OfSize(10), 10)).not.toThrow();
  });

  it('estimates from string length without decoding (padding accounted for)', () => {
    // 4 base64 chars with one '=' pad → 2 decoded bytes.
    const twoBytes = Buffer.alloc(2).toString('base64'); // "AAA=" → 2 bytes
    expect(() => assertPayloadSize(twoBytes, 2)).not.toThrow();
    expect(() => assertPayloadSize(twoBytes, 1)).toThrow(UploadGuardError);
  });
});

describe('RAJ-456 — assertImageMagicBytes', () => {
  it('accepts JPEG (FF D8 FF)', () => {
    expect(() => assertImageMagicBytes(base64WithPrefix([0xff, 0xd8, 0xff, 0xe0]))).not.toThrow();
  });

  it('accepts PNG (89 50 4E 47)', () => {
    expect(() =>
      assertImageMagicBytes(base64WithPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).not.toThrow();
  });

  it('accepts HEIC (ftypheic at offset 4)', () => {
    expect(() => assertImageMagicBytes(base64WithPrefix('\x00\x00\x00\x18ftypheic'))).not.toThrow();
  });

  it('accepts HEIX (ftypheix at offset 4)', () => {
    expect(() => assertImageMagicBytes(base64WithPrefix('\x00\x00\x00\x18ftypheix'))).not.toThrow();
  });

  it('accepts HEIF (ftypmif1 at offset 4)', () => {
    expect(() => assertImageMagicBytes(base64WithPrefix('\x00\x00\x00\x18ftypmif1'))).not.toThrow();
  });

  it('accepts WebP (RIFF....WEBP)', () => {
    expect(() => assertImageMagicBytes(base64WithPrefix('RIFF\x10\x00\x00\x00WEBP'))).not.toThrow();
  });

  it('rejects junk bytes with code UNSUPPORTED_TYPE', () => {
    try {
      assertImageMagicBytes(base64WithPrefix('this is not an image at all'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UploadGuardError);
      expect((err as UploadGuardError).code).toBe('UNSUPPORTED_TYPE');
    }
  });

  it('rejects a PDF (25 50 44 46) — not an image', () => {
    expect(() => assertImageMagicBytes(base64WithPrefix('%PDF-1.7'))).toThrow(UploadGuardError);
  });

  it('rejects RIFF that is not WEBP (e.g. WAVE audio)', () => {
    expect(() => assertImageMagicBytes(base64WithPrefix('RIFF\x10\x00\x00\x00WAVE'))).toThrow(
      UploadGuardError,
    );
  });

  it('rejects an empty payload', () => {
    expect(() => assertImageMagicBytes('')).toThrow(UploadGuardError);
  });

  it('rejects a payload too short to identify', () => {
    expect(() => assertImageMagicBytes(Buffer.from([0xff]).toString('base64'))).toThrow(
      UploadGuardError,
    );
  });
});

describe('RAJ-456 — RateLimiter (token bucket, injectable clock)', () => {
  it('allows up to the burst capacity within one minute', () => {
    const now = 0;
    const limiter = new RateLimiter({ capacity: 10, refillPerMinute: 10, now: () => now });
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryConsume('org-1')).toBe(true);
    }
  });

  it('rejects the 11th call inside the same minute', () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 10, refillPerMinute: 10, now: () => now });
    for (let i = 0; i < 10; i++) limiter.tryConsume('org-1');
    now += 1_000; // 1 s later — refilled only ~0.17 tokens
    expect(limiter.tryConsume('org-1')).toBe(false);
  });

  it('refills continuously — one token back after 6 s at 10/min', () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 10, refillPerMinute: 10, now: () => now });
    for (let i = 0; i < 10; i++) limiter.tryConsume('org-1');
    expect(limiter.tryConsume('org-1')).toBe(false);
    now += 6_000; // 6 s at 10 tokens/min → exactly 1 token refilled
    expect(limiter.tryConsume('org-1')).toBe(true);
    expect(limiter.tryConsume('org-1')).toBe(false);
  });

  it('fully refills after a minute of quiet', () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 10, refillPerMinute: 10, now: () => now });
    for (let i = 0; i < 10; i++) limiter.tryConsume('org-1');
    now += 60_000;
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryConsume('org-1')).toBe(true);
    }
    expect(limiter.tryConsume('org-1')).toBe(false);
  });

  it('buckets are independent per organizationId', () => {
    const now = 0;
    const limiter = new RateLimiter({ capacity: 10, refillPerMinute: 10, now: () => now });
    for (let i = 0; i < 10; i++) limiter.tryConsume('org-1');
    expect(limiter.tryConsume('org-1')).toBe(false);
    expect(limiter.tryConsume('org-2')).toBe(true);
  });

  it('never exceeds capacity regardless of idle time', () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 10, refillPerMinute: 10, now: () => now });
    now += 3_600_000; // idle an hour
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryConsume('org-1')).toBe(true);
    }
    expect(limiter.tryConsume('org-1')).toBe(false);
  });
});
