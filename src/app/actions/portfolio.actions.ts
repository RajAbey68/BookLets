'use server';

import { MetricsService } from '../../lib/metrics.service';
import { RevenueService } from '../../lib/revenue.service';
import { revalidatePath } from 'next/cache';

const DEFAULT_ORG_ID = 'primary_org';

export async function getDashboardMetrics() {
  try {
    const metrics = await MetricsService.getPortfolioMetrics(DEFAULT_ORG_ID);
    return { success: true, data: metrics };
  } catch (error: any) {
    console.error('[PortfolioActions] Failed to fetch metrics:', error);
    return { success: false, error: error.message };
  }
}

export async function syncHostawayData() {
  try {
    console.log('[PortfolioActions] Triggering Hostaway Sync...');
    await RevenueService.syncAndProcess(DEFAULT_ORG_ID);
    
    revalidatePath('/');
    return { success: true, message: 'Sync completed. Ledger updated.' };
  } catch (error: any) {
    console.error('[PortfolioActions] Sync Failed:', error);
    return { success: false, error: error.message };
  }
}
