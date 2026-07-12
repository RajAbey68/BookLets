# ADVERSARIAL REVIEW BRIEF — Checkpoint 2-partial (S2 deploy-fix) — PR #74

## Your role
You are an independent, non-Anthropic adversarial reviewer (Layer 1) for the BookLets
Next.js 16 app (App Router, NextAuth v5 beta, Prisma 7, Vercel). The maker was a
Claude agent. Try to BLOCK this change — it touches the AUTH GATE for the whole app,
so a mistake here is a security incident, not a bug.

## Claimed contract (attack these claims)
1. middleware.ts was migrated to src/proxy.ts because (a) this Next version deprecates
   `middleware` in favour of `proxy`, and (b) a root-level proxy.ts is SILENTLY IGNORED
   when the app lives under src/. Claim: the new file IS picked up (build output shows
   "ƒ Proxy (Middleware)").
2. Public routes (/login, /api/health, /api/auth/*, assets) short-circuit BEFORE any
   NextAuth code executes, so broken auth env can no longer 500 login/monitoring.
3. Auth gate tightened from `!req.auth` to `!req.auth?.user` — this closes a locally
   reproduced FAIL-OPEN (missing AUTH_SECRET made NextAuth return an error body which
   was truthy, so `!req.auth` let unauthenticated users through).
4. Protected routes still FAIL CLOSED on any auth error (structured 500, never allow).
5. Root-cause analysis of prod 500: malformed AUTH_URL/NEXTAUTH_URL (bare domain)
   throws ERR_INVALID_URL inside NextAuth's env handling on every request. Claimed to
   be the only candidate that 500s literally every route including /api/health.

## Specific attack vectors
- Matcher regex `"/((?!_next/static|_next/image|favicon.ico|api/health).*)"`:
  does excluding api/health leak any OTHER path (prefix-matching quirks, e.g.
  /api/healthy-secrets or path traversal via encoded slashes)?
- `!req.auth?.user`: is there ANY valid NextAuth v5 session shape where .user is
  absent but the session is legitimate? Conversely, can an attacker craft a truthy
  req.auth WITH a user field via the error path?
- The public-route short-circuit: can /api/auth/* being public before any check be
  abused (open redirect via callbackUrl, CSRF on signout, etc.)?
- middleware→proxy rename on Next 16: any behavioural differences in cookie
  forwarding, redirect status codes, or edge-runtime constraints the maker missed?
- The module-load env diagnostics: do they leak secret values (not just names) into
  logs? Do they run in edge runtime where console goes to public places?
- .env.example change: is the claim "schema= param is ignored by the pg adapter" true,
  and can removing it mislead an operator into a wrong search_path?

## Verdict format (reply exactly)
VERDICT: PASS | BLOCK
checkerIdentity: <your model name/version>
FINDINGS: <numbered list; for BLOCK, each finding must cite file:line from the diff>

## Full diff (origin/main...claude/s2-deploy-fix)
```diff
diff --git a/.env.example b/.env.example
index 4613066..5b5af5e 100644
--- a/.env.example
+++ b/.env.example
@@ -1,13 +1,23 @@
 # ── Database ────────────────────────────────────────────────────────────────
 # Supabase connection string (Transaction mode via PgBouncer on port 6543).
 # Add ?pgbouncer=true&connection_limit=1 so Prisma works in serverless.
-# The schema=booklets parameter sets the search_path; omit if using public.
-DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&schema=booklets"
+# NOTE: the runtime uses the pg driver adapter (src/lib/prisma.ts), which
+# IGNORES a `schema=` query param — the booklets search_path is set there
+# via the `options=-c search_path=booklets,public` startup parameter.
+# Needed at RUNTIME only; `next build` and `prisma generate` do not connect.
+DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"
 
 # ── Auth.js ──────────────────────────────────────────────────────────────────
 # Generate with: openssl rand -base64 32
 AUTH_SECRET=""
 
+# AUTH_URL is OPTIONAL on Vercel (the host is inferred). If you do set it
+# (or the legacy NEXTAUTH_URL), it MUST be an absolute URL including the
+# scheme, e.g. "https://booklets.vercel.app". A value without "https://"
+# throws `TypeError: Invalid URL` inside NextAuth on every request and
+# 500s the whole site (MIDDLEWARE_INVOCATION_FAILED).
+# AUTH_URL=""
+
 # Google OAuth — create at https://console.cloud.google.com/apis/credentials
 # Redirect URI to add: https://<your-vercel-url>/api/auth/callback/google
 AUTH_GOOGLE_ID=""
diff --git a/AGENTS_LOG.md b/AGENTS_LOG.md
index 3b53ec1..76fba52 100644
--- a/AGENTS_LOG.md
+++ b/AGENTS_LOG.md
@@ -25,6 +25,37 @@ joining this repo should read it before claiming scope here.
 
 ## Active work
 
+### fable5-builder-s2 (claude/s2-deploy-fix) — repo-side diagnosis + hardening for the production blanket-500 (S2 "deploy-fix" / M2, defect D1)
+- **Started:** 2026-07-12
+- **Goal:** Diagnose `booklets.vercel.app` returning 500 on every request
+  from the repo side (no live-infra access) and land only env-independent
+  hardening. Root-cause candidate #1 (locally reproduced): a malformed
+  `AUTH_URL`/`NEXTAUTH_URL` (missing `https://`) throws
+  `TypeError: Invalid URL` inside next-auth's `reqWithEnvURL` on every
+  middleware invocation → MIDDLEWARE_INVOCATION_FAILED → blanket 500,
+  including `/api/health` and `/login`. Also fixed: the auth gate failed
+  OPEN when NextAuth's session fetch errored (`req.auth` was set to the
+  truthy error body `{ message: ... }`).
+- **Touching:**
+  - `middleware.ts` → `src/proxy.ts` (migrated to this Next version's
+    non-deprecated `proxy` convention; root-level `proxy.ts` is NOT
+    detected when the app lives in `src/`): public routes short-circuit
+    before NextAuth runs, `req.auth?.user` check (fail-closed), fail-fast
+    env diagnostics naming the broken var, try/catch with structured 500,
+    `/api/health` excluded from the matcher.
+  - `src/app/api/health/route.ts` (structured 503 `reason`, comment)
+  - `src/auth.config.ts` (comment only)
+  - `.env.example` (AUTH_URL format warning; DATABASE_URL runtime-only +
+    `schema=` param note — the pg adapter ignores it; search_path is set
+    in `src/lib/prisma.ts`)
+- **NOT touching:** auth semantics for valid sessions, `src/auth.ts`,
+  Prisma client/schema, Vercel/Supabase config (Hermes owns live-env
+  verification).
+- **Out of scope (followups):** Hermes to confirm the live Vercel env
+  values (AUTH_URL/NEXTAUTH_URL/AUTH_SECRET/DATABASE_URL) and runtime
+  logs; PgBouncer `options` startup-parameter support for the
+  `search_path` (only verifiable against the live pooler).
+
 ### Claude — prime process-handling agent (claude/auth-google-oauth) — auth scaffold (Google OAuth + Vercel target)
 - **Started:** 2026-05-13
 - **Goal:** Scaffold Auth.js v5 with Google OAuth so the operator can let
diff --git a/middleware.ts b/middleware.ts
deleted file mode 100644
index 8641448..0000000
--- a/middleware.ts
+++ /dev/null
@@ -1,41 +0,0 @@
-import NextAuth from "next-auth";
-import { NextResponse } from "next/server";
-import authConfig from "@/auth.config";
-
-// Middleware runs in the Edge runtime. Build a NextAuth instance from the
-// Edge-safe config ONLY — importing `@/auth` here would pull in Prisma and
-// crash with "The edge runtime does not support Node.js 'crypto' module".
-// JWT sessions are self-contained, so this instance can still verify the
-// session token without any database access.
-const { auth } = NextAuth(authConfig);
-
-/**
- * Gate every route except /login, /api/auth/*, and Next's own static assets
- * behind a valid session. Unauthenticated users are bounced to /login with
- * a callbackUrl so they land back where they were trying to go.
- */
-export default auth((req) => {
-  const { pathname, search } = req.nextUrl;
-
-  const isPublic =
-    pathname === "/login" ||
-    pathname === "/api/health" ||
-    pathname.startsWith("/api/auth") ||
-    pathname.startsWith("/_next") ||
-    pathname === "/favicon.ico";
-
-  if (isPublic) return NextResponse.next();
-
-  if (!req.auth) {
-    const loginUrl = new URL("/login", req.nextUrl.origin);
-    loginUrl.searchParams.set("callbackUrl", pathname + search);
-    return NextResponse.redirect(loginUrl);
-  }
-
-  return NextResponse.next();
-});
-
-export const config = {
-  // Match everything except Next internals and image optimisation.
-  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
-};
diff --git a/src/app/api/health/route.ts b/src/app/api/health/route.ts
index 1a27bd8..dade227 100644
--- a/src/app/api/health/route.ts
+++ b/src/app/api/health/route.ts
@@ -9,8 +9,9 @@ export const dynamic = 'force-dynamic';
  *
  * Returns 200 when the app can reach Postgres, 503 when it can't, so
  * Vercel / uptime monitors can distinguish "process up" from "process up
- * but database unreachable". This route is allowlisted in middleware so
- * the probe is not bounced to /login.
+ * but database unreachable". This route is excluded from the proxy matcher
+ * (proxy.ts) so the probe never depends on auth config and is not bounced
+ * to /login.
  */
 export async function GET() {
   const timestamp = new Date().toISOString();
@@ -18,9 +19,15 @@ export async function GET() {
     await prisma.$queryRaw`SELECT 1`;
     return NextResponse.json({ status: 'ok', db: 'reachable', timestamp });
   } catch (error) {
+    // Degrade gracefully: a DB outage or missing DATABASE_URL must surface
+    // as a structured 503 (with the reason class), never an unhandled 500.
+    const reason =
+      error instanceof Error && /DATABASE_URL/.test(error.message)
+        ? 'DATABASE_URL is not set'
+        : 'database unreachable';
     console.error('[health] database check failed:', error);
     return NextResponse.json(
-      { status: 'degraded', db: 'unreachable', timestamp },
+      { status: 'degraded', db: 'unreachable', reason, timestamp },
       { status: 503 },
     );
   }
diff --git a/src/auth.config.ts b/src/auth.config.ts
index 51e6000..4ee5f06 100644
--- a/src/auth.config.ts
+++ b/src/auth.config.ts
@@ -5,12 +5,13 @@ import Google from "next-auth/providers/google";
  * Edge-safe Auth.js configuration.
  *
  * This file MUST NOT import Prisma (or anything that transitively pulls in
- * Node's `crypto`). It is consumed by `middleware.ts`, which runs in the
- * Edge runtime — importing the Prisma client there crashes every route
- * with "The edge runtime does not support Node.js 'crypto' module".
+ * Node's `crypto`). It is consumed by `proxy.ts` (this Next version's
+ * renamed middleware convention), which runs in the Edge runtime —
+ * importing the Prisma client there crashes every route with "The edge
+ * runtime does not support Node.js 'crypto' module".
  *
  * Providers, the session strategy, and the sign-in page live here because
- * the middleware needs them to verify the JWT and redirect. The
+ * the proxy needs them to verify the JWT and redirect. The
  * DB-touching callbacks (signIn upsert, jwt user lookup) live in `auth.ts`,
  * which only runs in the Node runtime.
  */
diff --git a/src/proxy.ts b/src/proxy.ts
new file mode 100644
index 0000000..84a2bdc
--- /dev/null
+++ b/src/proxy.ts
@@ -0,0 +1,126 @@
+import NextAuth from "next-auth";
+import { NextResponse } from "next/server";
+import type { NextFetchEvent, NextRequest } from "next/server";
+import authConfig from "@/auth.config";
+
+// Proxy (the renamed Middleware file convention in this Next.js version —
+// `middleware.ts` is deprecated) runs in the Edge runtime. Build a NextAuth
+// instance from the Edge-safe config ONLY — importing `@/auth` here would
+// pull in Prisma and crash with "The edge runtime does not support Node.js
+// 'crypto' module".
+// JWT sessions are self-contained, so this instance can still verify the
+// session token without any database access.
+const { auth } = NextAuth(authConfig);
+
+// ── Fail-fast env diagnostics ────────────────────────────────────────────────
+// NextAuth dereferences AUTH_URL / NEXTAUTH_URL with `new URL(...)` on every
+// middleware invocation (next-auth/lib/env.js `reqWithEnvURL`). A value
+// without a scheme (e.g. "booklets.vercel.app" instead of
+// "https://booklets.vercel.app") throws `TypeError: Invalid URL` before any
+// of our code runs, turning EVERY matched route into a 500
+// (MIDDLEWARE_INVOCATION_FAILED on Vercel). Surface that misconfiguration by
+// name at module load so the deploy logs say exactly which var is broken.
+for (const key of ["AUTH_URL", "NEXTAUTH_URL"] as const) {
+  const value = process.env[key];
+  if (!value) continue;
+  try {
+    new URL(value);
+  } catch {
+    console.error(
+      `[proxy] ${key} is set but is not a valid absolute URL ` +
+        `(got ${JSON.stringify(value)}). It must include the scheme, e.g. ` +
+        `"https://booklets.vercel.app". NextAuth will fail on every request ` +
+        `until this is fixed — either correct it or remove it (it is ` +
+        `optional on Vercel).`,
+    );
+  }
+}
+if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET) {
+  console.error(
+    "[proxy] AUTH_SECRET is not set — session tokens cannot be " +
+      "verified, so every request will be treated as unauthenticated and " +
+      "redirected to /login. Set AUTH_SECRET in the deployment env.",
+  );
+}
+
+/**
+ * Routes that must never depend on auth being configured or reachable:
+ * the sign-in page, the NextAuth handlers themselves, the health probe,
+ * and Next's own assets. These short-circuit BEFORE NextAuth executes so
+ * a broken auth env (bad AUTH_URL, missing AUTH_SECRET) cannot take down
+ * the login page or external monitoring.
+ */
+function isPublic(pathname: string): boolean {
+  return (
+    pathname === "/login" ||
+    pathname === "/api/health" ||
+    pathname.startsWith("/api/auth") ||
+    pathname.startsWith("/_next") ||
+    pathname === "/favicon.ico"
+  );
+}
+
+/**
+ * Gate every non-public route behind a valid session. Unauthenticated users
+ * are bounced to /login with a callbackUrl so they land back where they
+ * were trying to go.
+ *
+ * Note the `req.auth?.user` check (not just `req.auth`): when NextAuth's
+ * internal session fetch errors (e.g. missing AUTH_SECRET → MissingSecret),
+ * next-auth's `handleAuth` assigns the error JSON body — a truthy
+ * `{ message: "There was a problem with the server configuration..." }`
+ * object — to `req.auth`. A plain truthiness check therefore FAILS OPEN and
+ * lets unauthenticated traffic through whenever auth is misconfigured. A
+ * real session always carries `user`; the error object never does.
+ */
+const authGate = auth((req) => {
+  const { pathname, search } = req.nextUrl;
+
+  if (!req.auth?.user) {
+    const loginUrl = new URL("/login", req.nextUrl.origin);
+    loginUrl.searchParams.set("callbackUrl", pathname + search);
+    return NextResponse.redirect(loginUrl);
+  }
+
+  return NextResponse.next();
+});
+
+export default async function proxy(
+  req: NextRequest,
+  event: NextFetchEvent,
+) {
+  // Public routes bypass NextAuth entirely — see isPublic() docstring.
+  if (isPublic(req.nextUrl.pathname)) return NextResponse.next();
+
+  try {
+    // The auth() wrapper's parameter types are looser than NextMiddleware's;
+    // the runtime contract (NextRequest, NextFetchEvent) is identical for
+    // the proxy convention (proxy is the renamed middleware).
+    return await (
+      authGate as unknown as (
+        req: NextRequest,
+        event: NextFetchEvent,
+      ) => Promise<Response>
+    )(req, event);
+  } catch (err) {
+    // Without this, a NextAuth config crash surfaces as an opaque
+    // MIDDLEWARE_INVOCATION_FAILED 500 with no hint. Keep the 500 status
+    // (protected routes must NOT fail open) but log the actionable cause.
+    console.error(
+      "[proxy] auth gate threw — check AUTH_URL / NEXTAUTH_URL " +
+        "(must be absolute URLs incl. https://) and AUTH_SECRET:",
+      err,
+    );
+    return NextResponse.json(
+      { error: "Server auth configuration error. Check server logs." },
+      { status: 500 },
+    );
+  }
+}
+
+export const config = {
+  // Match everything except Next internals, image optimisation, and the
+  // health probe. /api/health is also excluded here (belt and braces with
+  // isPublic) so external monitoring never even invokes the proxy.
+  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
+};
```
