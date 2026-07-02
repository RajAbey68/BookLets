'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { resolveActiveContext } from '@/lib/auth-context';
import { LedgerService } from '@/lib/ledger.service';
import { JournalStatus } from '@/lib/types';
import { parseManualJournalEntry, type RawManualJournalEntry } from '@/lib/manual-journal-entry';

export async function fetchLedgerEntries() {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return [];

  const { organizationId } = resolved.context;

  try {
    return await prisma.journalEntry.findMany({
      where: {
        organizationId,
      },
      include: {
        lines: {
          include: { account: true },
        },
      },
      orderBy: { date: 'desc' },
    });
  } catch (error) {
    console.error('Error fetching ledger entries:', error);
    return [];
  }
}

export async function fetchAccounts() {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return [];

  const { organizationId } = resolved.context;

  try {
    return await prisma.account.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
    });
  } catch (error) {
    console.error('Error fetching accounts:', error);
    return [];
  }
}

/**
 * RAJ-286 — Post a manual journal entry from the /ledger/new form.
 *
 * Thin IO wrapper: resolve the caller's org + identity, load the org's
 * account ids, delegate validation to parseManualJournalEntry (which also
 * checks every line's account belongs to the org — never trust the client),
 * then post via LedgerService (the balance/fiscal-period authority).
 */
export async function createManualJournalEntry(
  input: RawManualJournalEntry,
): Promise<{ success: true; entryId: string } | { success: false; error: string }> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { success: false, error: resolved.error };

  const { organizationId, userId } = resolved.context;

  let accountIds: Set<string>;
  try {
    const accounts = await prisma.account.findMany({
      where: { organizationId },
      select: { id: true },
    });
    accountIds = new Set(accounts.map((a) => a.id));
  } catch (error) {
    console.error('[ledger.actions] createManualJournalEntry: account lookup failed:', error);
    return { success: false, error: 'Could not load your chart of accounts. Try again shortly.' };
  }

  const parsed = parseManualJournalEntry(input, accountIds);
  if (!parsed.ok) return { success: false, error: parsed.error };

  try {
    const entry = await LedgerService.postEntry({
      organizationId,
      date: parsed.value.date,
      memo: parsed.value.memo,
      status: JournalStatus.POSTED,
      lines: parsed.value.lines,
      makerIdentity: userId,
    });
    revalidatePath('/ledger');
    revalidatePath('/');
    return { success: true, entryId: entry.id };
  } catch (error) {
    console.error('[ledger.actions] createManualJournalEntry: post failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to post journal entry.',
    };
  }
}
