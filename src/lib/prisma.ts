import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Decimal } from 'decimal.js';

// Prisma 7 requires either a driver adapter or accelerateUrl on the
// PrismaClient constructor — there is no engineType: "library" escape.
// Construct the pg adapter once at module load using DATABASE_URL.
//
// All BookLets tables live in the `booklets` Postgres schema (shared
// Supabase project, schema-level isolation from sibling apps). We set
// the connection's search_path via the `-c` startup option so Prisma's
// generated SQL — which references tables unqualified ("Organization"
// rather than booklets."Organization") — resolves into the right schema.
function buildPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set; cannot construct PrismaClient.');
  }
  const adapter = new PrismaPg({
    connectionString,
    options: '-c search_path=booklets,public',
  });
  return new PrismaClient({
    adapter,
    log: ['query'],
  });
}

const globalForPrisma = global as unknown as { prisma: PrismaClient };

const basePrisma = globalForPrisma.prisma || buildPrismaClient();

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
                throw new Error(`Fiscal Integrity Violation: The date ${entryDate.toLocaleDateString()} falls within the closed fiscal period "${closedPeriod.name}".`);
            }
        }

        // 2. Trial Balance Validation for immediate POSTED entries
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
              throw new Error(`Trial Balance Violation: Current entry is unbalanced by ${balance.toFixed(2)}. Debits must equal Credits.`);
            }
            if (lines.length < 2) {
              throw new Error('Trial Balance Violation: A journal entry must have at least two balancing lines.');
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
