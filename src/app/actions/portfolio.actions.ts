'use server';

import { MetricsService } from '../../lib/metrics.service';
import { RevenueService } from '../../lib/revenue.service';
import { revalidatePath } from 'next/cache';

const DEFAULT_ORG_ID = 'primary_org';

export async function getDashboardMetrics() {
  try {
    const metrics = await MetricsService.getPortfolioMetrics(DEFAULT_ORG_ID);
    return { success: true, data: metrics };
  } catch (error) {
    console.error('[PortfolioActions] Failed to fetch metrics:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function syncHostawayData() {
  try {
    console.log('[PortfolioActions] Triggering Hostaway Sync...');
    await RevenueService.syncAndProcess(DEFAULT_ORG_ID);
    
    revalidatePath('/');
    return { success: true, message: 'Sync completed. Ledger updated.' };
  } catch (error) {
    console.error('[PortfolioActions] Sync Failed:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
