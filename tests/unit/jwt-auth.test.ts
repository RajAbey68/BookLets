// JWT auth middleware — tests (RAJ-163 / SEC-7)
//
// Org comes from the signed JWT claim, never from the x-org-id header.
// All tests run in-process with no DB or network.

import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyJwt, withJwtAuth } from '../../src/lib/jwt-auth';

const TEST_SECRET = 'test-secret-at-least-32-bytes-long!!';

async function mintToken(payload: Record<string, unknown>, secret = TEST_SECRET): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

// ── verifyJwt ─────────────────────────────────────────────────────

describe('verifyJwt', () => {
  it('returns orgId and userId for a valid token', async () => {
    const token = await mintToken({ orgId: 'org-123', userId: 'user-abc' });
    const claims = await verifyJwt(token, TEST_SECRET);
    expect(claims.orgId).toBe('org-123');
    expect(claims.userId).toBe('user-abc');
  });

  it('throws when token is expired', async () => {
    const key = new TextEncoder().encode(TEST_SECRET);
    const token = await new SignJWT({ orgId: 'org-123', userId: 'user-abc' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200) // 2h ago
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600) // expired 1h ago
      .sign(key);
    await expect(verifyJwt(token, TEST_SECRET)).rejects.toThrow();
  });

  it('throws for a token signed with a different secret', async () => {
    const token = await mintToken({ orgId: 'org-123', userId: 'user-abc' }, 'wrong-secret-at-least-32-bytes!!');
    await expect(verifyJwt(token, TEST_SECRET)).rejects.toThrow();
  });

  it('throws when orgId claim is missing', async () => {
    const token = await mintToken({ userId: 'user-abc' });
    await expect(verifyJwt(token, TEST_SECRET)).rejects.toThrow(/orgId/);
  });

  it('throws when userId claim is missing', async () => {
    const token = await mintToken({ orgId: 'org-123' });
    await expect(verifyJwt(token, TEST_SECRET)).rejects.toThrow(/userId/);
  });

  it('ignores x-org-id even if present in context — orgId always from JWT', async () => {
    const token = await mintToken({ orgId: 'real-org', userId: 'user-abc' });
    const claims = await verifyJwt(token, TEST_SECRET);
    // The important thing: orgId is from the token, not from any header
    expect(claims.orgId).toBe('real-org');
  });
});

// ── withJwtAuth ────────────────────────────────────────────────────

describe('withJwtAuth', () => {
  function makeRequest(headers: Record<string, string>): Request {
    return new Request('https://example.com/api/pms/test', { headers });
  }

  it('calls handler with claims when Authorization header is valid', async () => {
    const token = await mintToken({ orgId: 'org-123', userId: 'user-abc' });
    const handler = withJwtAuth(
      async (_req, claims) => new Response(JSON.stringify(claims), { status: 200 }),
      TEST_SECRET,
    );
    const req = makeRequest({ Authorization: `Bearer ${token}` });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgId).toBe('org-123');
  });

  it('returns 401 when Authorization header is missing', async () => {
    const handler = withJwtAuth(
      async () => new Response('ok', { status: 200 }),
      TEST_SECRET,
    );
    const req = makeRequest({});
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is invalid', async () => {
    const handler = withJwtAuth(
      async () => new Response('ok', { status: 200 }),
      TEST_SECRET,
    );
    const req = makeRequest({ Authorization: 'Bearer not-a-real-token' });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-org-id header present but no Authorization — no header-only bypass', async () => {
    const handler = withJwtAuth(
      async () => new Response('ok', { status: 200 }),
      TEST_SECRET,
    );
    const req = makeRequest({ 'x-org-id': 'spoofed-org' });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it('does NOT pass x-org-id to the handler — org comes from JWT only', async () => {
    const token = await mintToken({ orgId: 'real-org', userId: 'user-abc' });
    let capturedClaims: { orgId: string; userId: string } | null = null;
    const handler = withJwtAuth(
      async (_req, claims) => {
        capturedClaims = claims;
        return new Response('ok', { status: 200 });
      },
      TEST_SECRET,
    );
    const req = makeRequest({ Authorization: `Bearer ${token}`, 'x-org-id': 'spoofed-org' });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(capturedClaims?.orgId).toBe('real-org');
  });
});
