'use server';

import { prisma } from '../../lib/prisma';

const DEFAULT_ORG_ID = 'primary_org';

export interface UploadContext {
  organizationId: string;
  propertyId: string;
}

/**
 * Resolves the default {organization, property} context for client widgets
 * (currently the dashboard ReceiptUploader). Returns null when the seeded
 * primary_org has no properties yet, so the caller can hide the widget
 * instead of POSTing a receipt that would fail FK validation.
 *
 * Replaces the page.tsx hardcoded "org_123" / "prop_abc" placeholders.
 * To be revisited once real auth/session resolves the active organization
 * and a user-scoped property picker exists.
 */
export async function getDefaultUploadContext(): Promise<UploadContext | null> {
  const property = await prisma.property.findFirst({
    where: { organizationId: DEFAULT_ORG_ID },
    orderBy: { createdAt: 'asc' },
    select: { id: true, organizationId: true },
  });

  if (!property) return null;

  return {
    organizationId: property.organizationId,
    propertyId: property.id,
  };
}
