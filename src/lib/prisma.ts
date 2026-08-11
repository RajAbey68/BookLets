import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { Decimal } from 'decimal.js';
import crypto from 'crypto';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

let basePrisma: PrismaClient;

if (!globalForPrisma.prisma) {
  const databaseUrl = process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/booklets';
  const pool = new Pool({
    connectionString: databaseUrl,
  });

  basePrisma = new PrismaClient({
    adapter: new PrismaPg(pool),
    log: ['query'],
  });
} else {
  basePrisma = globalForPrisma.prisma;
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = basePrisma;

/**
 * SymbiOS Financial Integrity Extension
 * Intercepts writes to the ledger to enforce double-entry rules.
 */
export const prisma = basePrisma.$extends({
  query: {
    journalEntry: {
      async create({ args, query }: { args: Prisma.JournalEntryCreateArgs, query: (args: Prisma.JournalEntryCreateArgs) => Promise<any> }) {
        const { data } = args;

        // 1. Idempotency Check: if sourceHash exists, return existing entry (don't re-post)
        if (data.sourceHash) {
          const existing = await basePrisma.journalEntry.findUnique({
            where: { sourceHash: data.sourceHash },
          });
          if (existing) {
            console.warn(`[JournalEntry] Idempotent re-post detected: sourceHash ${data.sourceHash} already exists. Returning existing entry.`);
            return existing;
          }
        }

        // 2. Fiscal Period Validation (Locking) — database trigger is primary enforcement
        if (data.date) {
          const entryDate = new Date(data.date as string | Date);
          const closedPeriod = await basePrisma.fiscalPeriod.findFirst({
            where: {
              organizationId: data.organizationId as string,
              startDate: { lte: entryDate },
              endDate: { gte: entryDate },
              isClosed: true,
            },
          });

          if (closedPeriod) {
            throw new Error(`Fiscal Integrity Violation: Cannot post to ${entryDate.toLocaleDateString()} — it falls within closed fiscal period "${closedPeriod.name}".`);
          }
        }

        // 3. Trial Balance Validation for immediate POSTED entries
        if (data.status === 'POSTED' && data.lines && typeof data.lines === 'object') {
          const lines = (data.lines as any).create;
          if (Array.isArray(lines)) {
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
              throw new Error(`Trial Balance Violation: Entry is unbalanced by ${balance.toFixed(2)} LKR. Debits must equal Credits.`);
            }
            if (lines.length < 2) {
              throw new Error('Trial Balance Violation: A journal entry must have at least 2 lines to enforce double-entry bookkeeping.');
            }
          }
        }
        return query(args);
      },

      async update({ args, query }: { args: Prisma.JournalEntryUpdateArgs, query: (args: Prisma.JournalEntryUpdateArgs) => Promise<any> }) {
        const { data } = args;
        
        // 1. Fiscal Period Validation (Locking)
        if (data.date) {
            const entryDate = new Date(data.date as string | Date);
            const closedPeriod = await basePrisma.fiscalPeriod.findFirst({
                where: {
                    startDate: { lte: entryDate },
                    endDate: { gte: entryDate },
                    isClosed: true,
                },
            });

            if (closedPeriod) {
                throw new Error(`Fiscal Integrity Violation: Cannot update entry to ${entryDate.toLocaleDateString()} because it falls within the closed fiscal period "${closedPeriod.name}".`);
            }
        }

        return query(args);
      },

      async delete({ args, query }: { args: Prisma.JournalEntryDeleteArgs, query: (args: Prisma.JournalEntryDeleteArgs) => Promise<any> }) {
        // 2. Immutable Audit Log: Prevent deletion of POSTED entries
        const entry = await basePrisma.journalEntry.findUnique({
          where: args.where,
          select: { status: true },
        });

        if (entry?.status === 'POSTED') {
          throw new Error('Audit Integrity Violation: Posted journal entries cannot be deleted. You must "Void" or "Reverse" entries to maintain the audit trail.');
        }

        return query(args);
      },

      async deleteMany() {
        // Block bulk deletion on ledger records for safety
        throw new Error('Audit Integrity Violation: Bulk deletion of Journal Entries is disabled to prevent accidental data loss.');
      }
    }
  }
});
