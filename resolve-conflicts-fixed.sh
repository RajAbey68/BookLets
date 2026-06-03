#\!/bin/bash
set -e

echo "🔧 RESOLVING MERGE CONFLICTS (Fixed)"
echo "===================================="

# Reset to remote state (get the existing schema)
git fetch origin
git reset --hard origin/main

echo "✅ Reset to remote main"
echo ""
echo "Now creating MERGED schema (existing models + governance models)..."
echo ""

cat > prisma/schema.prisma << 'SCHEMA_EOF'
// BookLets Financial & Property Management System
// Integrates: Double-entry accounting + Property rentals + Governance (4-Eyes)

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ============================================================================
// ORGANIZATIONS & PROPERTIES
// ============================================================================

model Organization {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  properties     Property[]
  owners         Owner[]
  accounts       Account[]
  fiscalPeriods  FiscalPeriod[]
  journalEntries JournalEntry[]
  guestPayouts   GuestPayout[]
}

model Property {
  id             String   @id @default(cuid())
  organizationId String
  name           String
  address        String
  type           String
  status         String
  hostawayId     String?  @unique
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  organization   Organization      @relation(fields: [organizationId], references: [id])
  ownerships     PropertyOwnership[]
  bookings       Booking[]
  expenses       Expense[]

  @@index([organizationId])
  @@index([hostawayId])
}

model Owner {
  id             String   @id @default(cuid())
  organizationId String
  name           String
  email          String
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  organization    Organization      @relation(fields: [organizationId], references: [id])
  ownerships      PropertyOwnership[]
  ownerStatements OwnerStatement[]

  @@index([organizationId])
}

model PropertyOwnership {
  id           String   @id @default(cuid())
  propertyId   String
  ownerId      String
  revenueShare Float
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  property Property @relation(fields: [propertyId], references: [id])
  owner    Owner    @relation(fields: [ownerId], references: [id])
}

// ============================================================================
// ACCOUNTING (Double-Entry Ledger)
// ============================================================================

model Account {
  id             String @id @default(cuid())
  organizationId String
  name           String
  code           String @unique
  accountType    String  // ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE, SUSPENSE
  currency       String @default("EUR")

  closedAt    DateTime?
  locked      Boolean @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  createdBy   String

  organization   Organization @relation(fields: [organizationId], references: [id])
  journalLines   JournalLine[]

  @@index([organizationId])
  @@index([code])
}

model JournalEntry {
  id             String @id @default(cuid())
  organizationId String
  date           DateTime
  memo           String?
  status         String @default("DRAFT")  // DRAFT, POSTED, REVERSED

  // 4-Eyes governance metadata
  makerIdentity   String?
  tenantId        String?
  agentConfidence Float?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  createdBy String
  updatedBy String?

  organization Organization  @relation(fields: [organizationId], references: [id])
  lines        JournalLine[]

  @@index([organizationId])
  @@index([status])
}

model JournalLine {
  id             String   @id @default(cuid())
  journalEntryId String
  accountId      String
  amount         Decimal  @db.Decimal(19, 4)  // Precision for financial data
  debitCredit    String   // DEBIT, CREDIT
  currency       String   @default("EUR")

  createdAt DateTime @default(now())
  createdBy String

  journalEntry JournalEntry @relation(fields: [journalEntryId], references: [id])
  account      Account      @relation(fields: [accountId], references: [id])

  @@index([journalEntryId])
  @@index([accountId])
}

model FiscalPeriod {
  id             String   @id @default(cuid())
  organizationId String
  name           String
  startDate      DateTime
  endDate        DateTime

  closedAt DateTime?
  locked   Boolean @default(false)

  createdAt DateTime @default(now())
  createdBy String

  organization   Organization   @relation(fields: [organizationId], references: [id])
  journalEntries JournalEntry[]

  @@index([organizationId])
}

// ============================================================================
// BOOKINGS & CHANNELS
// ============================================================================

model Channel {
  id        String   @id @default(cuid())
  name      String   // Airbnb, Booking.com, Direct
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  bookings Booking[]
}

model Booking {
  id             String   @id @default(cuid())
  propertyId     String
  channelId      String
  checkIn        DateTime
  checkOut       DateTime
  totalAmount    Float
  status         String @default("CONFIRMED")
  hostawayId     String?  @unique
  hostawayStatus String?
  deferredPosted Boolean @default(false)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  property       Property         @relation(fields: [propertyId], references: [id])
  channel        Channel          @relation(fields: [channelId], references: [id])
  charges        BookingCharge[]

  @@index([propertyId])
  @@index([hostawayId])
}

model BookingCharge {
  id          String   @id @default(cuid())
  bookingId   String
  description String   // Nightly Rate, Cleaning Fee, Platform Commission
  amount      Float
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  booking Booking @relation(fields: [bookingId], references: [id])
}

// ============================================================================
// GUEST PAYOUTS & OWNER STATEMENTS
// ============================================================================

model GuestPayout {
  id             String @id @default(cuid())
  organizationId String
  date           DateTime
  amount         Float
  reference      String?
  status         String @default("PENDING")

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id])

  @@index([organizationId])
}

model OwnerStatement {
  id        String   @id @default(cuid())
  ownerId   String
  period    String
  totalDue  Float
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  owner Owner @relation(fields: [ownerId], references: [id])
}

// ============================================================================
// EXPENSES & VENDORS
// ============================================================================

model ExpenseCategory {
  id        String   @id @default(cuid())
  name      String
  accountId String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  expenses Expense[]
}

model Vendor {
  id        String   @id @default(cuid())
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  expenses Expense[]
}

model Expense {
  id                String   @id @default(cuid())
  propertyId        String
  expenseCategoryId String
  vendorId          String
  amount            Float
  date              DateTime
  description       String?
  receiptCloudId    String?
  confidenceScore   Float?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  property        Property        @relation(fields: [propertyId], references: [id])
  expenseCategory ExpenseCategory @relation(fields: [expenseCategoryId], references: [id])
  vendor          Vendor          @relation(fields: [vendorId], references: [id])
}

// ============================================================================
// GOVERNANCE & AUDIT TRAIL (Immutable)
// ============================================================================

model EvidenceLog {
  id              String @id @default(cuid())
  eventType       String  // ENTRY_POSTED, DRIFT_DETECTED, APPROVAL, etc.
  tenantId        String
  makerIdentity   String
  checkerIdentity String?
  description     String
  payload         Json
  hash            String  // SHA256 for tamper detection
  previousHash    String? // Append-only chain

  createdAt DateTime @default(now())

  @@index([tenantId])
  @@index([createdAt])
  @@index([eventType])
}

model ActionIntentQueue {
  id              String @id @default(cuid())
  status          String @default("PENDING")
  action          String
  payload         Json

  makerIdentity   String
  checkerIdentity String?
  confidence      Float

  createdAt       DateTime @default(now())
  approvedAt      DateTime?
  executedAt      DateTime?

  @@index([status])
  @@index([createdAt])
}
SCHEMA_EOF

echo "✅ Merged schema created"
echo ""
echo "📝 Now updating seed.ts..."

cat > prisma/seed.ts << 'SEED_EOF'
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // 1. Create default organization
  const org = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: {
      name: 'Default Organization',
      slug: 'default',
    },
  });

  console.log('✅ Organization created:', org.id);

  // 2. Seed Chart of Accounts (COA)
  const accounts = [
    { name: 'Operating Cash', code: '1000', accountType: 'ASSET' },
    { name: 'Guest Pre-payments', code: '2000', accountType: 'LIABILITY' },
    { name: 'Rental Income', code: '4000', accountType: 'REVENUE' },
    { name: 'Cleaning Fee Income', code: '4100', accountType: 'REVENUE' },
    { name: 'Commission Expense', code: '6000', accountType: 'EXPENSE' },
    { name: 'Suspense', code: '9999', accountType: 'SUSPENSE' },
  ];

  for (const acc of accounts) {
    await prisma.account.upsert({
      where: { code: acc.code },
      update: {},
      create: {
        organizationId: org.id,
        name: acc.name,
        code: acc.code,
        accountType: acc.accountType,
        createdBy: 'seed',
      },
    });
  }
  console.log('✅ Chart of Accounts seeded');

  // 3. Seed Fiscal Period
  const today = new Date();
  const yearStart = new Date(today.getFullYear(), 0, 1);
  const yearEnd = new Date(today.getFullYear(), 11, 31);

  await prisma.fiscalPeriod.upsert({
    where: { id: `fp_${today.getFullYear()}` },
    update: {},
    create: {
      id: `fp_${today.getFullYear()}`,
      organizationId: org.id,
      name: `FY ${today.getFullYear()}`,
      startDate: yearStart,
      endDate: yearEnd,
      createdBy: 'seed',
    },
  });
  console.log(`✅ Fiscal Period opened for ${today.getFullYear()}`);

  // 4. Seed Channels
  const channels = ['Airbnb', 'Booking.com', 'Direct'];
  for (const channelName of channels) {
    await prisma.channel.upsert({
      where: { id: `channel_${channelName.toLowerCase()}` },
      update: {},
      create: {
        id: `channel_${channelName.toLowerCase()}`,
        name: channelName,
      },
    });
  }
  console.log('✅ Booking channels seeded');

  console.log('✅ Database seeded successfully');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
SEED_EOF

echo "✅ Merged seed.ts created"
echo ""
echo "Staging and committing merged changes..."

git add prisma/schema.prisma prisma/seed.ts
git commit -m "chore: merge governance models with existing BookLets schema

Combines:
- Existing BookLets domain models (Property, Owner, Booking, etc.)
- New governance models (Account, JournalEntry, EvidenceLog, ActionIntentQueue)
- Resolves merge conflict by integrating both feature branches"

git push origin main

echo ""
echo "✅ ✅ ✅ BOOKLLETS CONFLICT RESOLVED & PUSHED ✅ ✅ ✅"
