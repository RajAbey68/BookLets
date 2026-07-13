'use server';

import { Decimal } from 'decimal.js';
import { resolveActiveContext } from '@/lib/auth-context';
import { createManualJournalEntry } from '@/app/actions/ledger.actions';
import { prisma } from '@/lib/prisma';
import { parseQuickEntry, type QuickEntryKind, type RawQuickEntry } from '@/lib/quick-entry';

/**
 * RAJ-481 — server boundary for the mobile /quick page.
 *
 * Thin IO wrappers only: parseQuickEntry owns validation and the
 * double-entry mapping; createManualJournalEntry (the existing, governed
 * path) owns posting — quick entries get the same idempotency, balance and
 * org-isolation guarantees as the full ledger form.
 */

export interface QuickEntryContext {
  properties: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; name: string; type: string }>;
  counts: { propertyCount: number; accountCount: number; entryCount: number };
  summaryEntries: Array<{ dateIso: string; kind: QuickEntryKind; amount: string; propertyId: string }>;
}

export async function fetchQuickEntryContext(): Promise<QuickEntryContext | null> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return null;
  const { organizationId } = resolved.context;

  try {
    const [properties, accounts, entries] = await Promise.all([
      prisma.property.findMany({ where: { organizationId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.account.findMany({ where: { organizationId }, select: { id: true, name: true, type: true }, orderBy: { name: 'asc' } }),
      prisma.journalEntry.findMany({
        where: { organizationId },
        include: { lines: { include: { account: { select: { type: true } } } } },
        orderBy: { date: 'desc' },
        take: 500,
      }),
    ]);

    // Derive income/expense rows for the monthly summary from journal shape:
    // a credit against REVENUE = income; a debit against EXPENSE = expense.
    // (JournalEntry has no propertyId — the summary is portfolio-level.)
    const summaryEntries: QuickEntryContext['summaryEntries'] = [];
    for (const entry of entries) {
      for (const line of entry.lines) {
        if (line.account.type === 'REVENUE' && !line.isDebit) {
          summaryEntries.push({ dateIso: entry.date.toISOString(), kind: 'income', amount: line.amount.toString(), propertyId: '' });
        } else if (line.account.type === 'EXPENSE' && line.isDebit) {
          summaryEntries.push({ dateIso: entry.date.toISOString(), kind: 'expense', amount: line.amount.toString(), propertyId: '' });
        }
      }
    }

    return {
      properties,
      accounts,
      counts: { propertyCount: properties.length, accountCount: accounts.length, entryCount: entries.length },
      summaryEntries,
    };
  } catch (error) {
    console.error('[quick-entry.actions] fetchQuickEntryContext: DB unreachable:', error);
    return null;
  }
}

export async function submitQuickEntry(
  raw: RawQuickEntry,
): Promise<{ success: true; entryId: string } | { success: false; error: string }> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { success: false, error: resolved.error };
  const { organizationId } = resolved.context;

  let accounts: Array<{ id: string; name: string; type: string }>;
  try {
    accounts = await prisma.account.findMany({
      where: { organizationId },
      select: { id: true, name: true, type: true },
    });
  } catch (error) {
    console.error('[quick-entry.actions] submitQuickEntry: DB unreachable:', error);
    return { success: false, error: 'Could not reach the database. Try again.' };
  }

  const parsed = parseQuickEntry(raw, accounts);
  if (!parsed.ok) return { success: false, error: parsed.error };

  // Delegate posting to the existing governed manual-entry path.
  return createManualJournalEntry({
    date: raw.date,
    memo: parsed.value.memo,
    lines: parsed.value.lines.map(l => ({
      accountId: l.accountId,
      amount: new Decimal(l.amount as never).toString(),
      isDebit: l.isDebit,
    })),
  });
}

