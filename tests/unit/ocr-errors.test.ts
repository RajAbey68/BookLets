import { describe, it, expect } from 'vitest';
import {
  OcrError,
  classifyOcrFailure,
  classifyOcrTransportError,
  isOcrErrorOfKind,
  parseRetryAfterMs,
} from '@/lib/ocr-errors';

/**
 * The body below is the REAL response captured from the OCR microservice
 * during the 225-receipt import that reported every receipt as unreadable.
 *
 * Two properties of it are load-bearing and are why status-only
 * classification failed: the microservice answers with its OWN HTTP 500, and
 * the only evidence of a rate limit is inside the body text.
 */
const REAL_QUOTA_BODY = JSON.stringify({
  error:
    'Gemini OCR API Error: 429 Too Many Requests — {\n  "error": {\n    "code": 429,\n' +
    '    "message": "You exceeded your current quota, please check your plan and billing details. ' +
    'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
    'limit: 20, model: gemini-3.5-flash\\nPlease retry in 3.485022129s. ",\n' +
    '    "status": "RESOURCE_EXHAUSTED"\n  }\n}',
});

describe('classifyOcrFailure', () => {
  it('reads the production quota body as a rate limit despite the wrapping HTTP 500', () => {
    const error = classifyOcrFailure(500, REAL_QUOTA_BODY);

    expect(error.kind).toBe('rate-limit');
    expect(error.retryable).toBe(true);
  });

  it('never blames the photo when the provider is throttling', () => {
    const error = classifyOcrFailure(500, REAL_QUOTA_BODY);

    // The operator-facing sentence must not send someone hunting for a bad
    // photograph — that is the exact failure this whole change exists to fix.
    expect(error.message).toMatch(/rate limited/i);
    expect(error.message).toMatch(/nothing is wrong with the photo/i);
    expect(error.message).not.toMatch(/could not be read|unreadable/i);
  });

  it('carries the provider’s own retry hint through', () => {
    const error = classifyOcrFailure(500, REAL_QUOTA_BODY);

    // "Please retry in 3.485022129s" → rounded up to whole milliseconds.
    expect(error.retryAfterMs).toBe(3486);
  });

  it.each([
    ['RESOURCE_EXHAUSTED marker', 500, '{"error":"RESOURCE_EXHAUSTED"}'],
    ['a bare 429 status', 429, ''],
    ['prose rate-limit wording', 500, 'Rate limit exceeded for this project'],
    ['too many requests', 502, 'Too Many Requests'],
  ])('classifies %s as rate-limit', (_label, status, body) => {
    expect(classifyOcrFailure(status, body).kind).toBe('rate-limit');
  });

  it('separates credential rejection from throttling, and marks it non-retryable', () => {
    const error = classifyOcrFailure(500, '{"error":"PERMISSION_DENIED: API key not valid"}');

    expect(error.kind).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/administrator/i);
  });

  it('treats a plain 5xx with no useful body as transient unavailability', () => {
    const error = classifyOcrFailure(503, 'Bad Gateway');

    expect(error.kind).toBe('unavailable');
    expect(error.retryable).toBe(true);
  });

  it('classifies timeouts as retryable', () => {
    expect(classifyOcrFailure(504, 'upstream timed out').kind).toBe('timeout');
    expect(classifyOcrFailure(504, 'upstream timed out').retryable).toBe(true);
  });

  it.each([
    ['a request id that merely contains the digits', 'req_8f429ab3 failed to process'],
    ['a byte count', 'image was 429 kilobytes and could not be decoded'],
    ['a model name', 'model gemini-429-vision is not available'],
  ])('does not read %s as a rate limit', (_label, body) => {
    // A false positive here is expensive: the item route turns kind
    // 'rate-limit' into a real HTTP 429 and the browser halts the whole
    // import. Numeric markers must be anchored to a status/code context.
    expect(classifyOcrFailure(400, body).kind).not.toBe('rate-limit');
  });

  it('still reads the digits when they ARE the status code', () => {
    expect(classifyOcrFailure(500, '{"code": 429}').kind).toBe('rate-limit');
    expect(classifyOcrFailure(500, 'HTTP 429 Too Many Requests').kind).toBe('rate-limit');
  });

  it('does not read an incidental 401 as a credential failure', () => {
    expect(classifyOcrFailure(400, 'processed 401 receipts').kind).not.toBe('auth');
  });

  it('falls back to a non-retryable unknown rather than guessing', () => {
    const error = classifyOcrFailure(418, 'something entirely new');

    expect(error.kind).toBe('unknown');
    expect(error.retryable).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses the prose form', () => {
    expect(parseRetryAfterMs('Please retry in 3.485022129s. ')).toBe(3486);
  });

  it('parses the structured retryDelay form', () => {
    expect(parseRetryAfterMs('"retryDelay": "5s"')).toBe(5000);
  });

  it('takes the LARGER hint when both are present, so we never retry too soon', () => {
    expect(parseRetryAfterMs('Please retry in 2s. "retryDelay": "9s"')).toBe(9000);
  });

  it('returns undefined when there is no hint', () => {
    expect(parseRetryAfterMs('no hint here')).toBeUndefined();
  });

  it('ignores a zero or malformed delay rather than busy-looping', () => {
    expect(parseRetryAfterMs('Please retry in 0s')).toBeUndefined();
  });
});

describe('classifyOcrTransportError', () => {
  it('maps an aborted request to a retryable timeout', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';

    const error = classifyOcrTransportError(abort);
    expect(error.kind).toBe('timeout');
    expect(error.retryable).toBe(true);
  });

  it('maps a connection failure to retryable unavailability', () => {
    const error = classifyOcrTransportError(new Error('fetch failed: ECONNREFUSED'));
    expect(error.kind).toBe('unavailable');
    expect(error.retryable).toBe(true);
  });

  it('passes an already-classified error through unchanged', () => {
    const original = new OcrError('rate-limit', 'throttled');
    expect(classifyOcrTransportError(original)).toBe(original);
  });
});

describe('isOcrErrorOfKind', () => {
  it('is true only for a matching OcrError', () => {
    expect(isOcrErrorOfKind(new OcrError('rate-limit', 'x'), 'rate-limit')).toBe(true);
    expect(isOcrErrorOfKind(new OcrError('auth', 'x'), 'rate-limit')).toBe(false);
    expect(isOcrErrorOfKind(new Error('rate-limit'), 'rate-limit')).toBe(false);
  });
});
