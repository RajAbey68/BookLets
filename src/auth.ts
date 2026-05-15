import NextAuth from "next-auth";
import { prisma } from "@/lib/prisma";
import authConfig from "./auth.config";

/**
 * Auth.js v5 — Node runtime configuration.
 *
 * Spreads the Edge-safe base config (`auth.config.ts`) and adds the
 * callbacks that touch the database. This module imports Prisma, so it
 * must only be used from the Node runtime (server components, server
 * actions, the /api/auth route handler) — never from middleware. The
 * middleware builds its own NextAuth instance from `auth.config.ts` alone.
 *
 * Strategy: JWT sessions. We don't persist Account/Session tables in
 * Postgres — only User and Membership — because BookLets already has an
 * Account model for chart-of-accounts entries and the naming collision is
 * not worth resolving for a single-tenant deployment.
 *
 * User rows are upserted by email on every sign-in. The first user to log
 * in is NOT automatically given a Membership; an operator must attach
 * them to an organisation (via the admin UI when it lands, or by direct
 * SQL in the meantime — see DEPLOY.md "Invite team members").
 */
export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    async signIn({ user, profile }) {
      if (!user.email) return false;

      // Allow-list gate: only emails listed in AUTH_ALLOWED_EMAILS may
      // sign in. The value is a comma-separated list, matched
      // case-insensitively. If the var is unset OR empty, sign-in is
      // open — suitable only for local development. Production
      // deployments MUST set this; without it any Google account in the
      // world can access the app once they hit the URL.
      const allowlistRaw = process.env.AUTH_ALLOWED_EMAILS ?? "";
      const allowlist = allowlistRaw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (allowlist.length > 0) {
        if (!allowlist.includes(user.email.toLowerCase())) {
          console.warn(
            `[auth] Rejected sign-in for ${user.email} — not in AUTH_ALLOWED_EMAILS.`,
          );
          return false;
        }
      } else if (process.env.NODE_ENV === "production") {
        // Fail closed in production if the operator forgot the allow-list.
        console.error(
          "[auth] AUTH_ALLOWED_EMAILS is empty in production; refusing sign-in to avoid an open-door deployment.",
        );
        return false;
      }

      // Upsert the User row so we always have a canonical identity to
      // attach memberships to. We don't fail the sign-in if this throws
      // — the JWT still has the email — but we do log it so deploys can
      // catch DB-level problems.
      try {
        await prisma.user.upsert({
          where: { email: user.email },
          update: {
            name: user.name ?? undefined,
            image: user.image ?? undefined,
          },
          create: {
            email: user.email,
            name: user.name ?? undefined,
            image: user.image ?? undefined,
            emailVerified: profile?.email_verified ? new Date() : null,
          },
        });
      } catch (err) {
        console.error("[auth] Failed to upsert User on sign-in:", err);
      }
      return true;
    },
    async jwt({ token, user }) {
      // On first sign-in, persist the canonical user id and email in the
      // JWT so server-side code can resolve memberships without an extra
      // round-trip to Google.
      if (user?.email) {
        const dbUser = await prisma.user.findUnique({
          where: { email: user.email },
          select: { id: true, email: true },
        });
        if (dbUser) {
          token.userId = dbUser.id;
          token.email = dbUser.email;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token?.userId && session.user) {
        session.user.id = token.userId as string;
      }
      return session;
    },
  },
});
