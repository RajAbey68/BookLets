'use server';

import { prisma } from '../../lib/prisma';
import { resolveActiveContext } from '@/lib/auth-context';

export interface UploadContext {
  organizationId: string;
  propertyId: string;
}

/**
 * Resolves the default {organization, property} context for client widgets
 * (currently the dashboard ReceiptUploader). Returns null when the caller's
 * organisation has no properties yet — or when there is no resolvable
 * organisation — so the caller can hide the widget instead of POSTing a
 * receipt that would fail FK validation.
 *
 * The organisation comes from the signed-in user's Membership, not a
 * hardcoded id. A user-scoped property picker is still a follow-up; for now
 * the oldest property in the org is used.
 */
export async function getDefaultUploadContext(): Promise<UploadContext | null> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) {
    return null;
  }

  try {
    const property = await prisma.property.findFirst({
      where: { organizationId: resolved.context.organizationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, organizationId: true },
    });

    if (!property) return null;

    return {
      organizationId: property.organizationId,
      propertyId: property.id,
    };
  } catch (error) {
    console.error('[context.actions] getDefaultUploadContext failed:', error);
    return null;
  }
}
