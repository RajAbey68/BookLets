import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import authConfig from "@/auth.config";

// Proxy (the renamed Middleware file convention in this Next.js version —
// `middleware.ts` is deprecated) runs in the Edge runtime. Build a NextAuth
// instance from the Edge-safe config ONLY — importing `@/auth` here would
// pull in Prisma and crash with "The edge runtime does not support Node.js
// 'crypto' module".
// JWT sessions are self-contained, so this instance can still verify the
// session token without any database access.
const { auth } = NextAuth(authConfig);

// ── Fail-fast env diagnostics ────────────────────────────────────────────────
// NextAuth dereferences AUTH_URL / NEXTAUTH_URL with `new URL(...)` on every
// middleware invocation (next-auth/lib/env.js `reqWithEnvURL`). A value
// without a scheme (e.g. "booklets.vercel.app" instead of
// "https://booklets.vercel.app") throws `TypeError: Invalid URL` before any
// of our code runs, turning EVERY matched route into a 500
// (MIDDLEWARE_INVOCATION_FAILED on Vercel). Surface that misconfiguration by
// name at module load so the deploy logs say exactly which var is broken.
for (const key of ["AUTH_URL", "NEXTAUTH_URL"] as const) {
  const value = process.env[key];
  if (!value) continue;
  try {
    new URL(value);
  } catch {
    console.error(
      `[proxy] ${key} is set but is not a valid absolute URL ` +
        `(got ${JSON.stringify(value)}). It must include the scheme, e.g. ` +
        `"https://booklets.vercel.app". NextAuth will fail on every request ` +
        `until this is fixed — either correct it or remove it (it is ` +
        `optional on Vercel).`,
    );
  }
}
if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET) {
  console.error(
    "[proxy] AUTH_SECRET is not set — session tokens cannot be " +
      "verified, so every request will be treated as unauthenticated and " +
      "redirected to /login. Set AUTH_SECRET in the deployment env.",
  );
}

/**
 * Routes that must never depend on auth being configured or reachable:
 * the sign-in page, the NextAuth handlers themselves, the health probe,
 * and Next's own assets. These short-circuit BEFORE NextAuth executes so
 * a broken auth env (bad AUTH_URL, missing AUTH_SECRET) cannot take down
 * the login page or external monitoring.
 */
function isPublic(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/api/health" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  );
}

/**
 * Gate every non-public route behind a valid session. Unauthenticated users
 * are bounced to /login with a callbackUrl so they land back where they
 * were trying to go.
 *
 * Note the `req.auth?.user` check (not just `req.auth`): when NextAuth's
 * internal session fetch errors (e.g. missing AUTH_SECRET → MissingSecret),
 * next-auth's `handleAuth` assigns the error JSON body — a truthy
 * `{ message: "There was a problem with the server configuration..." }`
 * object — to `req.auth`. A plain truthiness check therefore FAILS OPEN and
 * lets unauthenticated traffic through whenever auth is misconfigured. A
 * real session always carries `user`; the error object never does.
 */
const authGate = auth((req) => {
  const { pathname, search } = req.nextUrl;

  if (!req.auth?.user) {
    // API clients (e.g. fetch against /api/export/*) need a structured 401,
    // not a 307 to an HTML login page. Public API paths never reach here
    // (isPublic short-circuits /api/auth/* and /api/health).
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export default async function proxy(
  req: NextRequest,
  event: NextFetchEvent,
) {
  // Public routes bypass NextAuth entirely — see isPublic() docstring.
  if (isPublic(req.nextUrl.pathname)) return NextResponse.next();

  try {
    // The auth() wrapper's parameter types are looser than NextMiddleware's;
    // the runtime contract (NextRequest, NextFetchEvent) is identical for
    // the proxy convention (proxy is the renamed middleware).
    return await (
      authGate as unknown as (
        req: NextRequest,
        event: NextFetchEvent,
      ) => Promise<Response>
    )(req, event);
  } catch (err) {
    // Without this, a NextAuth config crash surfaces as an opaque
    // MIDDLEWARE_INVOCATION_FAILED 500 with no hint. Keep the 500 status
    // (protected routes must NOT fail open) but log the actionable cause.
    console.error(
      "[proxy] auth gate threw — check AUTH_URL / NEXTAUTH_URL " +
        "(must be absolute URLs incl. https://) and AUTH_SECRET:",
      err,
    );
    return NextResponse.json(
      { error: "Server auth configuration error. Check server logs." },
      { status: 500 },
    );
  }
}

export const config = {
  // Match everything except Next internals, image optimisation, and the
  // health probe. /api/health is also excluded here (belt and braces with
  // isPublic) so external monitoring never even invokes the proxy.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
