import { NextResponse } from "next/server";
import { auth } from "@/auth";

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
