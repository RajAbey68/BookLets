import { Decimal } from 'decimal.js';
import { prisma } from './prisma';
import { EvidenceLogService } from './evidence-log.service';
import {
  JournalEntryInput,
  JournalStatus,
  LedgerValidationResult,
} from './types';

export class LedgerService {
  /**
   * Validates that the sum of debits equals the sum of credits.
   * Debits are treated as positive and credits as negative for the zero-sum check.
   */
  static validateTrialBalance(lines: JournalEntryInput['lines']): LedgerValidationResult {
    if (lines.length < 2) {
      return { isValid: false, balance: new Decimal(0), error: 'A journal entry must have at least two lines.' };
    }

    let balance = new Decimal(0);
    for (const line of lines) {
      const amount = new Decimal(line.amount.toString());
      if (line.isDebit) {
        balance = balance.plus(amount);
      } else {
        balance = balance.minus(amount);
      }
    }

    if (!balance.isZero()) {
      return { 
        isValid: false, 
        balance, 
        error: `Journal entry is unbalanced. Trial balance difference: ${balance.toFixed(2)}` 
      };
    }

    return { isValid: true, balance };
  }

  /**
   * Checks if the given date falls within an open fiscal period for the organization.
   */
  static async checkFiscalPeriod(organizationId: string, date: Date): Promise<boolean> {
    const period = await prisma.fiscalPeriod.findFirst({
      where: {
        organizationId,
        startDate: { lte: date },
        endDate: { gte: date },
      },
    });

    if (!period) {
      throw new Error(`No fiscal period defined for the date ${date.toLocaleDateString()}.`);
    }

    if (period.isClosed) {
      throw new Error(`The fiscal period "${period.name}" is closed. No new entries allowed.`);
    }

    return true;
  }

  /**
   * Posts a new Journal Entry atomically after validating the balance and fiscal period.
   */
  static async postEntry(input: JournalEntryInput) {
    const {
      organizationId,
      date,
      memo,
      status = JournalStatus.POSTED,
      lines,
      makerIdentity,
      tenantId,
      agentConfidence,
    } = input;

    // 1. Strict Validation for POSTED entries
    if (status === JournalStatus.POSTED) {
      const validation = this.validateTrialBalance(lines);
      if (!validation.isValid) {
        throw new Error(`CRITICAL LEDGER ERROR: ${validation.error}`);
      }

      // Check for zero-amount lines (compliance)
      if (lines.some(l => new Decimal(l.amount.toString()).isZero())) {
        throw new Error('CRITICAL LEDGER ERROR: Journal entries cannot contain zero-amount lines.');
      }
    }

    // 2. Fiscal Period Check (Strict for all)
    await this.checkFiscalPeriod(organizationId, date);

    // 3. Atomic Transaction — entry + evidence row succeed or fail together.
    return await prisma.$transaction(async (tx) => {
      const entry = await tx.journalEntry.create({
        data: {
          organizationId,
          date,
          memo,
          status,
          makerIdentity,
          tenantId,
          agentConfidence,
          lines: {
            create: lines.map(line => ({
              accountId: line.accountId,
              amount: new Decimal(line.amount.toString()), // keep as Decimal — do NOT call .toNumber() (loses precision)
              isDebit: line.isDebit,
            }))
          }
        },
        include: {
          lines: true,
        }
      });

      await EvidenceLogService.record(tx, {
        eventType: 'JOURNAL_POSTED',
        tenantId: tenantId ?? organizationId,
        makerIdentity: makerIdentity ?? 'system',
        description: `Journal entry posted${memo ? `: ${memo}` : ''}`,
        payload: {
          entryId: entry.id,
          organizationId,
          date: date.toISOString(),
          status,
          memo,
          agentConfidence,
          lines: entry.lines.map((l) => ({
            accountId: l.accountId,
            amount: l.amount.toString(),
            isDebit: l.isDebit,
          })),
        },
      });

      return entry;
    });
  }

  /**
   * Reverses an existing Journal Entry by creating a new one with inverse debits/credits.
   */
  static async reverseEntry(entryId: string, reason: string): Promise<{ id: string }> {
    const originalEntry = await prisma.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: true }
    });

    if (!originalEntry) {
      throw new Error('Journal Entry not found.');
    }

    if (originalEntry.status !== 'POSTED') {
      throw new Error(`Cannot reverse an entry with status "${originalEntry.status}". Only POSTED entries can be reversed.`);
    }

    // 1. Prepare reversed lines
    const reversedLines = originalEntry.lines.map(line => ({
      accountId: line.accountId,
      amount: new Decimal(line.amount),
      isDebit: !line.isDebit, // Flip Debit/Credit
      memo: `Reversal of Entry #${entryId}: ${reason}`
    }));

    // 2. Create the reversal entry
    return await prisma.$transaction(async (tx) => {
      const reversal = await tx.journalEntry.create({
        data: {
          organizationId: originalEntry.organizationId,
          date: new Date(),
          memo: `AUTO-REVERSAL: [Original Entry ID: ${entryId}] - Reason: ${reason}`,
          status: 'POSTED',
          lines: {
            create: reversedLines.map(line => ({
              accountId: line.accountId,
              amount: line.amount, // Decimal — do NOT call .toNumber() (loses precision)
              isDebit: line.isDebit,
            }))
          }
        },
        include: { lines: true }
      });

      // 3. Mark the original as VOIDED (or similar, but I'll update it to VOIDED here)
      // Note: My extension blocks delete, but update is allowed.
      await tx.journalEntry.update({
        where: { id: entryId },
        data: { status: 'VOIDED', memo: (originalEntry.memo || '') + ` | Reversed by ${reversal.id}` }
      });

      await EvidenceLogService.record(tx, {
        eventType: 'JOURNAL_REVERSED',
        tenantId: originalEntry.organizationId,
        makerIdentity: originalEntry.makerIdentity ?? 'system',
        description: `Reversed entry ${entryId}: ${reason}`,
        payload: {
          reversalId: reversal.id,
          originalEntryId: entryId,
          reason,
        },
      });

      return reversal;
    });
  }

  /**
   * Utility to compute account balances for an organization.
   */
  static async getAccountBalance(accountId: string): Promise<Decimal> {
    const lines = await prisma.journalLine.findMany({
      where: { 
        accountId,
        journalEntry: { status: 'POSTED' } 
      }
    });

    return lines.reduce(
      (acc, curr) => curr.isDebit 
        ? acc.plus(new Decimal(curr.amount)) 
        : acc.minus(new Decimal(curr.amount)), 
      new Decimal(0)
    );
  }
}
