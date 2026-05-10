'use server';

import { prisma } from '@/lib/prisma';
import { RevenueService, SyncReport } from '@/lib/revenue.service';
import { revalidatePath } from 'next/cache';

export interface ManualSyncResult {
  success: boolean;
  partial: boolean;
  message: string;
  report?: SyncReport;
}

const MAX_REASONS_IN_MESSAGE = 3;

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Triggers a manual sync from Hostaway and processes revenue recognition.
 * Returns success only when every reservation and recognition succeeded;
 * a run with any per-record failure is reported as partial so callers can
 * surface the failure count instead of silently treating it as success.
 *
 * Pre-flight failures (no organization, no chart of accounts) return a
 * non-partial failure result instead of letting the run proceed and
 * surface cryptic ledger errors per booking.
 */
export async function triggerManualSync(): Promise<ManualSyncResult> {
  // For production launch, we fetch the primary organization.
  // In a multi-tenant setup, this would come from the session context.
  const organization = await prisma.organization.findFirst();

  if (!organization) {
    return {
      success: false,
      partial: false,
      message: 'No organization found. Initialize the system via seed or setup before syncing.',
    };
  }

  // A sync with no chart of accounts cannot post any ledger entries;
  // every booking would fail with a confusing per-record error.
  const accountCount = await prisma.account.count({ where: { organizationId: organization.id } });
  if (accountCount === 0) {
    return {
      success: false,
      partial: false,
      message: `Organization "${organization.name}" has no chart of accounts. Run the seed before syncing.`,
    };
  }

  console.log(`[SyncAction] Triggering live sync for organization: ${organization.name} (${organization.id})`);

  try {
    const report = await RevenueService.syncAndProcess(organization.id);

    // Refresh the UI
    revalidatePath('/properties');
    revalidatePath('/ledger');

    if (report.failures.length === 0) {
      return {
        success: true,
        partial: false,
        message: `Sync completed: ${report.bookingsProcessed} processed, ${report.bookingsRecognized} recognized.`,
        report,
      };
    }

    const reasons = report.failures
      .slice(0, MAX_REASONS_IN_MESSAGE)
      .map(f => `${f.stage}/${f.bookingRef}: ${f.reason}`)
      .join('; ');
    const more = report.failures.length > MAX_REASONS_IN_MESSAGE
      ? ` (+${report.failures.length - MAX_REASONS_IN_MESSAGE} more)`
      : '';

    return {
      success: false,
      partial: true,
      message: `Sync completed with ${report.failures.length} failure(s): ${reasons}${more}`,
      report,
    };
  } catch (err) {
    const message = describeError(err);
    console.error('[SyncAction] Sync failed:', message);
    return { success: false, partial: false, message };
  }
}
