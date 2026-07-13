import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

/**
 * Edge-safe Auth.js configuration.
 *
 * This file MUST NOT import Prisma (or anything that transitively pulls in
 * Node's `crypto`). It is consumed by `proxy.ts` (this Next version's
 * renamed middleware convention), which runs in the Edge runtime —
 * importing the Prisma client there crashes every route with "The edge
 * runtime does not support Node.js 'crypto' module".
 *
 * Providers, the session strategy, and the sign-in page live here because
 * the proxy needs them to verify the JWT and redirect. The
 * DB-touching callbacks (signIn upsert, jwt user lookup) live in `auth.ts`,
 * which only runs in the Node runtime.
 */
export default {
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
} satisfies NextAuthConfig;
