import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

export interface ActiveContext {
  organizationId: string;
  organizationName: string;
  userId: string;
  role: string;
}

export type ResolveResult =
  | { ok: true; context: ActiveContext }
  | { ok: false; error: string };

/**
 * Resolves the {organization, user} context for the authenticated request
 * from the session and the user's Membership row.
 *
 * Replaces the previous `prisma.organization.findFirst()` / hardcoded
 * `'primary_org'` shortcuts: those silently picked an arbitrary (or
 * non-existent) organisation regardless of who was signed in. Server
 * actions that write to the ledger must scope to the caller's org and
 * record the caller as the maker.
 *
 * If a user belongs to more than one organisation, the most recently
 * created membership wins until an explicit org-switcher UI exists.
 */
export async function resolveActiveContext(): Promise<ResolveResult> {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    return { ok: false, error: 'Not authenticated. Sign in to continue.' };
  }

  let membership;
  try {
    membership = await prisma.membership.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { organization: true },
    });
  } catch (error) {
    console.error('[auth-context] Membership lookup failed:', error);
    return { ok: false, error: 'Could not resolve your organisation. Try again shortly.' };
  }

  if (!membership) {
    return {
      ok: false,
      error: 'Your account is not attached to any organisation yet. Ask an owner to invite you.',
    };
  }

  return {
    ok: true,
    context: {
      organizationId: membership.organizationId,
      organizationName: membership.organization.name,
      userId,
      role: membership.role,
    },
  };
}
