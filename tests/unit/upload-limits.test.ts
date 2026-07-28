import { describe, it, expect } from 'vitest';
import {
  MAX_DIRECT_UPLOAD_BYTES,
  DIRECT_UPLOAD_TIMEOUT_MS,
  formatMb,
  describeOversizeUpload,
  describeElapsed,
  OVERSIZE_UPLOAD_HELP,
} from '@/lib/upload-limits';

/**
 * RAJ — "silent failure" incident, July close.
 *
 * The dashboard uploader advertised a 100 MB cap. The hosting platform
 * (Vercel serverless) rejects any request body over ~4.5 MB at the EDGE with
 * `413 FUNCTION_PAYLOAD_TOO_LARGE`, in a PLAIN-TEXT body, before the function
 * is ever invoked — so nothing reached the route, nothing reached the runtime
 * logs, and `JournalEntry` stayed at 0 rows while the UI sat on
 * "Importing… / Reading the archive…" indefinitely.
 *
 * Measured against https://booklets-one.vercel.app:
 *   3 MB → 401 (reached the function)
 *   4 MB → 401 (reached the function)
 *   5 MB → 413 FUNCTION_PAYLOAD_TOO_LARGE (never reached the function)
 *
 * These tests pin the honest number and the plain-language copy that goes
 * with it. This module is the SINGLE source of truth for both uploaders.
 */
describe('MAX_DIRECT_UPLOAD_BYTES — the real platform ceiling', () => {
  it('is 4 MB, leaving multipart-encoding headroom below the measured 4.5 MB edge limit', () => {
    expect(MAX_DIRECT_UPLOAD_BYTES).toBe(4 * 1024 * 1024);
  });

  it('sits strictly below the measured 5 MB rejection point and at/above the measured 4 MB pass', () => {
    expect(MAX_DIRECT_UPLOAD_BYTES).toBeLessThan(4.5 * 1024 * 1024);
    expect(MAX_DIRECT_UPLOAD_BYTES).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  });
});

describe('formatMb', () => {
  it('renders whole and fractional megabytes to one decimal place', () => {
    expect(formatMb(4 * 1024 * 1024)).toBe('4.0 MB');
    expect(formatMb(62_411_000)).toBe('59.5 MB');
  });

  it('never renders "0.0 MB" for a non-empty file — a sub-100 KB file reads in KB', () => {
    expect(formatMb(12_000)).toBe('12 KB');
  });
});

describe('describeOversizeUpload — what a non-developer is told', () => {
  const message = describeOversizeUpload(62_411_000);

  it('states the actual file size and the actual limit', () => {
    expect(message).toContain('59.5 MB');
    expect(message).toContain('4 MB');
  });

  it('never claims a 100 MB limit (the fiction that caused the incident)', () => {
    expect(message).not.toContain('100 MB');
  });

  it('says it is a platform limit, not a BookLets business rule', () => {
    expect(message.toLowerCase()).toMatch(/hosting|platform/);
  });

  it('gives the actionable WhatsApp workaround: a shorter date range with media attached', () => {
    expect(message).toContain('Export Chat');
    expect(message).toContain('Attach Media');
    expect(message.toLowerCase()).toContain('date range');
  });

  it('is honest that "Without Media" produces no entries — it is small, but it has no receipts', () => {
    expect(message).toContain('Without Media');
    expect(message.toLowerCase()).toMatch(/no receipt|no entries|creates no/);
  });

  it('never tells the user to split the zip — not a thing a normal person can do', () => {
    expect(message.toLowerCase()).not.toContain('split');
  });

  it('reuses the shared help block so both uploaders say exactly the same thing', () => {
    expect(message).toContain(OVERSIZE_UPLOAD_HELP);
  });
});

describe('DIRECT_UPLOAD_TIMEOUT_MS — no UI may wait forever', () => {
  it('is well under the 10 minutes of silence that made the failure look like progress', () => {
    expect(DIRECT_UPLOAD_TIMEOUT_MS).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('still comfortably exceeds the route maxDuration (60s) so a live import is never killed', () => {
    expect(DIRECT_UPLOAD_TIMEOUT_MS).toBeGreaterThan(90 * 1000);
  });
});

describe('describeElapsed — the "still alive" cue', () => {
  it('counts seconds under a minute', () => {
    expect(describeElapsed(0)).toBe('0s elapsed');
    expect(describeElapsed(9_400)).toBe('9s elapsed');
  });

  it('switches to minutes and seconds past a minute', () => {
    expect(describeElapsed(72_000)).toBe('1m 12s elapsed');
    expect(describeElapsed(605_000)).toBe('10m 5s elapsed');
  });

  it('clamps negative clock drift to zero rather than rendering nonsense', () => {
    expect(describeElapsed(-5_000)).toBe('0s elapsed');
  });
});
