'use server';

import { prisma } from '@/lib/prisma';
import { JournalStatus } from '@/lib/types';
import { AutomationService } from '@/lib/automation.service';

export async function fetchLedgerEntries(organizationId?: string) {
  try {
    const entries = await prisma.journalEntry.findMany({
      where: organizationId ? {
        lines: {
          some: {
            account: {
              organizationId
            }
          }
        }
      } : {},
      include: {
        lines: {
          include: {
            account: true
          }
        }
      },
      orderBy: {
        date: 'desc'
      }
    });

    return entries;
  } catch (error) {
    console.error('Error fetching ledger entries:', error);
    throw new Error('Failed to fetch ledger entries');
  }
}

export async function fetchAccounts(organizationId?: string) {
  try {
    const accounts = await prisma.account.findMany({
      where: organizationId ? { organizationId } : {},
      orderBy: {
        name: 'asc'
      }
    });
    return accounts;
  } catch (error) {
    console.error('Error fetching accounts:', error);
    throw new Error('Failed to fetch accounts');
  }
}

export async function processReceiptAction(
  organizationId: string,
  propertyId: string,
  imageBase64: string
) {
  try {
    const result = await AutomationService.processReceipt(
      organizationId,
      propertyId,
      imageBase64,
      { source: 'WEB' }
    );
    return result;
  } catch (error) {
    console.error('Error processing receipt:', error);
    throw error;
  }
}
