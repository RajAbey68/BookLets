import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// Always evaluated at request time — never cached.
export const dynamic = 'force-dynamic';

/**
 * Liveness + DB readiness probe for the host platform.
 *
 * Returns 200 when the app can reach Postgres, 503 when it can't, so
 * Vercel / uptime monitors can distinguish "process up" from "process up
 * but database unreachable". This route is excluded from the proxy matcher
 * (proxy.ts) so the probe never depends on auth config and is not bounced
 * to /login.
 */
export async function GET() {
  const timestamp = new Date().toISOString();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: 'ok', db: 'reachable', timestamp });
  } catch (error) {
    // Degrade gracefully: a DB outage or missing DATABASE_URL must surface
    // as a structured 503 (with the reason class), never an unhandled 500.
    const reason =
      error instanceof Error && /DATABASE_URL/.test(error.message)
        ? 'DATABASE_URL is not set'
        : 'database unreachable';
    console.error('[health] database check failed:', error);
    return NextResponse.json(
      { status: 'degraded', db: 'unreachable', reason, timestamp },
      { status: 503 },
    );
  }
}
