import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// Always evaluated at request time — never cached.
export const dynamic = 'force-dynamic';

/**
 * Liveness + DB readiness probe for the host platform.
 *
 * Returns 200 when the app can reach Postgres, 503 when it can't, so
 * Vercel / uptime monitors can distinguish "process up" from "process up
 * but database unreachable". This route is allowlisted in middleware so
 * the probe is not bounced to /login.
 */
export async function GET() {
  const timestamp = new Date().toISOString();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: 'ok', db: 'reachable', timestamp });
  } catch (error) {
    console.error('[health] database check failed:', error);
    return NextResponse.json(
      { status: 'degraded', db: 'unreachable', timestamp },
      { status: 503 },
    );
  }
}
