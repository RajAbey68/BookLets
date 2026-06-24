// JWT authentication for PMS API Route Handlers (RAJ-163 / SEC-7)
//
// Org identity comes from the SIGNED JWT claim — never from a spoofable header
// such as x-org-id.  Use withJwtAuth() to protect any Route Handler that
// touches multi-tenant data.

import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';

export interface JwtClaims {
  orgId: string;
  userId: string;
}

// ── Core verify ───────────────────────────────────────────────────

/**
 * Verify a HS256 JWT and return the typed claims.
 * Throws if the token is expired, has a bad signature, or is missing
 * required claims (orgId, userId).
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtClaims> {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });

  if (typeof payload.orgId !== 'string' || !payload.orgId) {
    throw new Error('JWT missing required claim: orgId');
  }
  if (typeof payload.userId !== 'string' || !payload.userId) {
    throw new Error('JWT missing required claim: userId');
  }

  return { orgId: payload.orgId, userId: payload.userId };
}

// ── Route Handler HOF ─────────────────────────────────────────────

type AuthedHandler = (req: Request, claims: JwtClaims) => Promise<Response>;

/**
 * Wraps a Next.js Route Handler with JWT auth.
 *
 * Usage:
 *   export const GET = withJwtAuth(async (req, claims) => { ... });
 *
 * The wrapped handler receives the verified claims; orgId is from the signed
 * token, not from any header.  Returns 401 JSON for missing or invalid tokens.
 */
export function withJwtAuth(handler: AuthedHandler, secret?: string): (req: Request) => Promise<Response> {
  const jwtSecret = secret ?? process.env.JWT_SECRET ?? '';

  return async (req: Request): Promise<Response> => {
    const authHeader = req.headers.get('authorization') ?? req.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return Response.json({ error: 'Missing Authorization header' }, { status: 401 });
    }

    let claims: JwtClaims;
    try {
      claims = await verifyJwt(token, jwtSecret);
    } catch {
      return Response.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    return handler(req, claims);
  };
}

// ── Token minting (server-side only — dev / test use) ─────────────

/**
 * Mint a signed HS256 JWT for testing or internal service calls.
 * Never call from browser code.
 */
export async function mintJwt(claims: JwtClaims, secret: string, expiresIn = '1h'): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}
