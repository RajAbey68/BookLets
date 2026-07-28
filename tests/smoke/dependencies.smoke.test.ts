import { describe, it, expect } from 'vitest';

/**
 * Live dependency smoke. Targets production endpoints by default; override with
 * SMOKE_APP_URL / OCR_MICROSERVICE_URL. Fails loudly with the real service error
 * so a broken key/URL is obvious at a glance.
 */
const APP_URL = process.env.SMOKE_APP_URL ?? 'https://booklets-one.vercel.app';
const OCR_URL = process.env.OCR_MICROSERVICE_URL ?? 'https://ocr-microservice-gamma.vercel.app';

// A tiny valid 48x48 JPEG (synthetic — no real data). A working OCR returns
// 200 + { text, confidence }; a mis-configured one (e.g. no GEMINI_API_KEY) 5xx's.
//
// WIRE CONTRACT (verified against the live service 2026-07-27 — this test previously
// asserted the WRONG shape and failed hourly for ~24h after the outage was already
// fixed, which is worse than no test: it trains the operator to ignore the alarm):
//   { "text": "<a JSON string>", "confidence": number }
// `{ extraction }` is the INTERNAL shape produced by src/lib/gemini-ocr.ts AFTER it
// does JSON.parse(data.text) — it is never on the wire. Assert what the client
// actually consumes, and parse it the same way the client does.
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAwADADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD0KiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP//Z';

describe('live smoke — OCR (the dependency that was silently broken)', () => {
  it('OCR service extracts from a real image — not a 500 / missing-key error', async () => {
    const res = await fetch(`${OCR_URL}/ocr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: TINY_JPEG_B64, mode: 'receipt' }),
    });
    const text = await res.text();
    expect(res.status, `OCR ${OCR_URL}/ocr -> ${res.status}: ${text.slice(0, 200)}`).toBe(200);
    expect(text, 'OCR returned a config/key error — the service has no API key set').not.toMatch(
      /GEMINI_API_KEY|api key .*not set|not set in environment/i,
    );
    const body = JSON.parse(text);
    expect(typeof body.text, `OCR 200 but no { text } on the wire: ${text.slice(0, 200)}`).toBe(
      'string',
    );
    // Parse it exactly as src/lib/gemini-ocr.ts does — this is what actually has to work.
    const extraction = JSON.parse(body.text);
    for (const field of ['vendorName', 'totalAmount', 'categorySuggestion'] as const) {
      expect(extraction, `extraction missing ${field}: ${body.text.slice(0, 200)}`).toHaveProperty(
        field,
      );
    }
  });
});

describe('live smoke — app + auth config', () => {
  it('app health endpoint is up', async () => {
    const res = await fetch(`${APP_URL}/api/health`);
    expect(res.status, `${APP_URL}/api/health -> ${res.status}`).toBe(200);
  });

  it('Google OAuth callback points at the app domain (guards NEXTAUTH_URL regressions)', async () => {
    const res = await fetch(`${APP_URL}/api/auth/providers`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const host = new URL(APP_URL).host;
    expect(body.google?.callbackUrl, `Google callback not on ${host}: ${body.google?.callbackUrl}`).toContain(host);
  });
});
