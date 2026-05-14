import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "@/auth.config";

// Middleware runs in the Edge runtime. Build a NextAuth instance from the
// Edge-safe config ONLY — importing `@/auth` here would pull in Prisma and
// crash with "The edge runtime does not support Node.js 'crypto' module".
// JWT sessions are self-contained, so this instance can still verify the
// session token without any database access.
const { auth } = NextAuth(authConfig);

/**
 * Gate every route except /login, /api/auth/*, and Next's own static assets
 * behind a valid session. Unauthenticated users are bounced to /login with
 * a callbackUrl so they land back where they were trying to go.
 */
export default auth((req) => {
  const { pathname, search } = req.nextUrl;

  const isPublic =
    pathname === "/login" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico";

  if (isPublic) return NextResponse.next();

  if (!req.auth) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  // Match everything except Next internals and image optimisation.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
