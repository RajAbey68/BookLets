import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The client's upload deadline must stay ABOVE the route's own budget.
 *
 * If the server can answer — including when it fails — its specific message
 * should win over the client's generic "it took too long". Invert the two and
 * the browser aborts first, so a route that was about to return "quota
 * exhausted" or "413 too large" instead reports a timeout, and the operator is
 * told the wrong thing about their own data.
 *
 * The two values cannot share a constant: Next requires `maxDuration` to be a
 * statically analysable literal in the route file, so it cannot be imported.
 * That leaves them coupled by nothing but a comment — which is exactly the
 * kind of link that rots the first time someone raises the route's budget.
 * This test is the link.
 */
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('statement upload: client deadline vs route budget', () => {
  it('keeps the client abort deadline above the route maxDuration', () => {
    const client = read('src/components/StatementUploadCard.tsx');
    const route = read('src/app/api/ingest/statement/route.ts');

    const clientMs = Number(
      /UPLOAD_TIMEOUT_MS\s*=\s*([\d_]+)/.exec(client)?.[1].replace(/_/g, ''),
    );
    const routeSeconds = Number(
      /export const maxDuration\s*=\s*(\d+)/.exec(route)?.[1],
    );

    // Both must actually be found — a regex that quietly matched nothing would
    // make this test vacuously true, which is worse than not having it.
    expect(Number.isFinite(clientMs)).toBe(true);
    expect(Number.isFinite(routeSeconds)).toBe(true);

    expect(clientMs).toBeGreaterThan(routeSeconds * 1000);
  });
});
