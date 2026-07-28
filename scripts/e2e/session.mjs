/**
 * Establish a real signed-in session against a LOCAL harness instance.
 *
 * WHY THIS IS NOT A SECURITY HOLE, and why it is the honest choice:
 *
 * BookLets signs in with Google OAuth. There is no way to complete a real
 * Google consent screen from an automated harness without a live Google
 * account and a browser-automation flow Google actively blocks. The options
 * were (a) drive Google's login — not reliably automatable; (b) insert a
 * session row — impossible here, because contrary to the usual Auth.js setup
 * this app uses the JWT session strategy (src/auth.config.ts:
 * `session: { strategy: "jwt" }`) and deliberately does NOT persist Session
 * rows (see the comment in src/auth.ts); or (c) mint the same session cookie
 * the app itself mints, using the app's own AUTH_SECRET.
 *
 * (c) is what this does. It uses Auth.js's own `encode()` with the harness
 * instance's own throwaway AUTH_SECRET, so the cookie is verified by exactly
 * the same code path a real sign-in produces — the proxy's JWT verification,
 * `auth()`, `resolveActiveContext()` and the Membership lookup all run for
 * real. NO guard is weakened, nothing is mocked, and the secret is a local
 * test value that exists only for the life of the harness run.
 *
 * WHAT THIS DOES NOT COVER, said plainly: the Google OAuth handshake itself
 * and the AUTH_ALLOWED_EMAILS allow-list check inside the `signIn` callback.
 * Those run only during sign-in, not on subsequent requests, so no import
 * scenario exercises them. If sign-in breaks, this harness will not tell you.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Auth.js v5 cookie name over plain HTTP (the __Secure- prefix is HTTPS-only). */
export const SESSION_COOKIE_NAME = 'authjs.session-token';

/**
 * Mint a session cookie for `user` that this app will accept.
 *
 * The token shape mirrors what src/auth.ts's `jwt` callback stores: `userId`
 * (read back by the `session` callback into session.user.id, which
 * resolveActiveContext uses) and `email`.
 */
export async function mintSessionCookie({ secret, userId, email, name = 'E2E Harness', maxAgeSeconds = 3600 }) {
  const { encode } = require('next-auth/jwt');
  const now = Math.floor(Date.now() / 1000);
  const value = await encode({
    secret,
    salt: SESSION_COOKIE_NAME,
    maxAge: maxAgeSeconds,
    token: {
      name,
      email,
      sub: userId,
      userId,
      iat: now,
      exp: now + maxAgeSeconds,
      jti: `e2e-${now}-${Math.random().toString(36).slice(2)}`,
    },
  });
  return { name: SESSION_COOKIE_NAME, value, header: `${SESSION_COOKIE_NAME}=${value}` };
}

/**
 * Mint a cookie that has ALREADY expired, for the "expired session mid-run"
 * scenario. Auth.js rejects it exactly as it rejects a real stale session.
 *
 * The expiry MUST come from a negative `maxAge`, not from an `exp` claim in
 * the token object: Auth.js's encode() calls jose's setExpirationTime(now +
 * maxAge) after the payload is built, so any `exp` written into the token is
 * overwritten. (The first version of this helper set `exp` in the payload and
 * produced a cookie that was still valid — the harness duly reported "expired
 * sessions are accepted", which would have been a false alarm. Auth.js also
 * allows 15 seconds of clock tolerance, so the expiry has to be comfortably
 * in the past.)
 */
export async function mintExpiredSessionCookie({ secret, userId, email }) {
  const { encode } = require('next-auth/jwt');
  const value = await encode({
    secret,
    salt: SESSION_COOKIE_NAME,
    maxAge: -3600,
    token: { email, sub: userId, userId },
  });
  return { name: SESSION_COOKIE_NAME, value, header: `${SESSION_COOKIE_NAME}=${value}` };
}
