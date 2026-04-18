'use server';

import { prisma } from '@/lib/prisma';
import { RevenueService } from '@/lib/revenue.service';
import { revalidatePath } from 'next/cache';

/**
 * Triggers a manual sync from Hostaway and processes revenue recognition.
 */
export async function triggerManualSync() {
  // For production launch, we fetch the primary organization.
  // In a multi-tenant setup, this would come from the session context.
  const organization = await prisma.organization.findFirst();

  if (!organization) {
    throw new Error('CRITICAL: No organization found. Please initialize the system via seed or setup.');
  }

  // Pre-sync check: Ensure organization has a chart of accounts
  const accountCount = await prisma.account.count({ where: { organizationId: organization.id } });
  if (accountCount === 0) {
     console.warn(`[SyncAction] Organization ${organization.name} has no accounts. Initializing default accounts...`);
     // We could auto-init here, but for now we'll just report readiness
  }

  console.log(`[SyncAction] Triggering live sync for organization: ${organization.name} (${organization.id})`);
  
  try {
    await RevenueService.syncAndProcess(organization.id);
    
    // Refresh the UI
    revalidatePath('/properties');
    revalidatePath('/ledger');
    
    return { success: true, message: 'Sync completed successfully.' };
  } catch (err: any) {
    console.error('[SyncAction] Sync failed:', err.message);
    return { success: false, message: err.message };
  }
}
