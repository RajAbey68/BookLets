'use server';

import { MetricsService } from '../../lib/metrics.service';
import { RevenueService } from '../../lib/revenue.service';
import { resolveActiveContext } from '@/lib/auth-context';
import { revalidatePath } from 'next/cache';

export async function getDashboardMetrics() {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) {
    return { success: false, error: resolved.error };
  }

  try {
    const metrics = await MetricsService.getPortfolioMetrics(resolved.context.organizationId);
    return { success: true, data: metrics };
  } catch (error) {
    console.error('[PortfolioActions] Failed to fetch metrics:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function syncHostawayData() {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) {
    return { success: false, error: resolved.error };
  }
  const { organizationId, userId } = resolved.context;

  try {
    console.log('[PortfolioActions] Triggering Hostaway Sync...');
    await RevenueService.syncAndProcess(organizationId, userId);

    revalidatePath('/');
    return { success: true, message: 'Sync completed. Ledger updated.' };
  } catch (error) {
    console.error('[PortfolioActions] Sync Failed:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
