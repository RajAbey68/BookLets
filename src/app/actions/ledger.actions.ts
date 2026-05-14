'use server';

import { prisma } from '@/lib/prisma';
import { resolveActiveContext } from '@/lib/auth-context';

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
