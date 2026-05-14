import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Decimal } from 'decimal.js';

// Prisma 7 requires either a driver adapter or accelerateUrl on the
// PrismaClient constructor — there is no engineType: "library" escape.
// Construct the pg adapter the first time the extended client is used.
//
// All BookLets tables live in the `booklets` Postgres schema (shared
// Supabase project, schema-level isolation from sibling apps). The
// connection's search_path is set via the `-c` startup option so Prisma's
// generated SQL — which references tables unqualified ("Organization"
// rather than booklets."Organization") — resolves into the right schema.
//
// The client is built lazily via a Proxy so module import has no side
// effects. Next.js's build-time page analysis imports server modules to
// collect configuration; eager construction here previously threw on
// missing DATABASE_URL even for routes marked `dynamic = 'force-dynamic'`.

function buildExtendedClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set; cannot construct PrismaClient.');
  }
  const adapter = new PrismaPg({
    connectionString,
    options: '-c search_path=booklets,public',
  });
  const base = new PrismaClient({
    adapter,
    log: ['query'],
  });

  /**
   * SymbiOS Financial Integrity Extension
   * Intercepts writes to the ledger to enforce double-entry rules.
   */
  return base.$extends({
    query: {
      journalEntry: {
        async create({ args, query }: { args: Prisma.JournalEntryCreateArgs, query: (args: Prisma.JournalEntryCreateArgs) => Promise<unknown> }) {
          const { data } = args;

          // 1. Fiscal Period Validation (Locking)
          if (data.date) {
              const entryDate = new Date(data.date as string | Date);
              const closedPeriod = await base.fiscalPeriod.findFirst({
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
            const lines = (data.lines as Prisma.JournalLineCreateNestedManyWithoutJournalEntryInput).create;
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

        async update({ args, query }: { args: Prisma.JournalEntryUpdateArgs, query: (args: Prisma.JournalEntryUpdateArgs) => Promise<unknown> }) {
          const { data } = args;

          // 1. Fiscal Period Validation (Locking)
          if (data.date) {
              const entryDate = new Date(data.date as string | Date);
              const closedPeriod = await base.fiscalPeriod.findFirst({
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

        async delete({ args, query }: { args: Prisma.JournalEntryDeleteArgs, query: (args: Prisma.JournalEntryDeleteArgs) => Promise<unknown> }) {
          // 2. Immutable Audit Log: Prevent deletion of POSTED entries
          const entry = await base.journalEntry.findUnique({
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
}

type ExtendedPrisma = ReturnType<typeof buildExtendedClient>;

const globalForPrisma = global as unknown as { prisma?: ExtendedPrisma };

let cached: ExtendedPrisma | null = null;

function getClient(): ExtendedPrisma {
  if (!cached) {
    cached = globalForPrisma.prisma ?? buildExtendedClient();
    if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = cached;
  }
  return cached;
}

// Lazy proxy: import-time has zero side effects; the underlying client is
// constructed on first property access. This keeps Next.js's build-time
// page-config collection happy on routes that touch the database.
export const prisma = new Proxy({} as ExtendedPrisma, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient(), prop, receiver);
  },
});
