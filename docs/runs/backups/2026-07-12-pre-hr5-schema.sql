-- Faithful reconstruction of live prod public schema (Supabase euqdfxekrxnoibeahogq)
-- Introspected read-only on 2026-07-12 via pg_catalog (columns, pg_constraint, pg_indexes).
-- Prisma-managed tables only. Foreign objects (raj_fin_track schema, trg_prevent_auction_delete)
-- deliberately excluded — prisma migrate diff does not manage them.

CREATE TABLE "Organization" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

CREATE TABLE "User" (
  "id" text NOT NULL,
  "email" text NOT NULL,
  "name" text,
  "image" text,
  "emailVerified" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE TABLE "Membership" (
  "id" text NOT NULL,
  "userId" text NOT NULL,
  "organizationId" text NOT NULL,
  "role" text NOT NULL DEFAULT 'VIEWER',
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Membership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE UNIQUE INDEX "Membership_userId_organizationId_key" ON "Membership"("userId", "organizationId");
CREATE INDEX "Membership_organizationId_idx" ON "Membership"("organizationId");

CREATE TABLE "Property" (
  "id" text NOT NULL,
  "organizationId" text NOT NULL,
  "name" text NOT NULL,
  "address" text NOT NULL,
  "type" text NOT NULL,
  "status" text NOT NULL,
  "hostawayId" text,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "Property_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Property_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "Property_hostawayId_key" ON "Property"("hostawayId");
CREATE INDEX "Property_hostawayId_idx" ON "Property"("hostawayId");
CREATE INDEX "Property_organizationId_idx" ON "Property"("organizationId");

CREATE TABLE "Owner" (
  "id" text NOT NULL,
  "organizationId" text NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "Owner_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Owner_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX "Owner_organizationId_idx" ON "Owner"("organizationId");

CREATE TABLE "PropertyOwnership" (
  "id" text NOT NULL,
  "propertyId" text NOT NULL,
  "ownerId" text NOT NULL,
  "revenueShare" numeric(5,4) NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "PropertyOwnership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PropertyOwnership_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "PropertyOwnership_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX "PropertyOwnership_ownerId_idx" ON "PropertyOwnership"("ownerId");
CREATE INDEX "PropertyOwnership_propertyId_idx" ON "PropertyOwnership"("propertyId");

CREATE TABLE "OwnerStatement" (
  "id" text NOT NULL,
  "ownerId" text NOT NULL,
  "period" text NOT NULL,
  "totalDue" numeric(19,4) NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "OwnerStatement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OwnerStatement_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE "Account" (
  "id" text NOT NULL,
  "organizationId" text NOT NULL,
  "name" text NOT NULL,
  "code" text,
  "type" text NOT NULL,
  "currency" text NOT NULL DEFAULT 'EUR',
  "closedAt" timestamp(3),
  "locked" boolean NOT NULL DEFAULT false,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  "createdBy" text,
  CONSTRAINT "Account_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Account_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "Account_code_key" ON "Account"("code");
CREATE INDEX "Account_code_idx" ON "Account"("code");
CREATE INDEX "Account_organizationId_idx" ON "Account"("organizationId");

CREATE TABLE "FiscalPeriod" (
  "id" text NOT NULL,
  "organizationId" text NOT NULL,
  "name" text NOT NULL,
  "startDate" timestamp(3) NOT NULL,
  "endDate" timestamp(3) NOT NULL,
  "isClosed" boolean NOT NULL DEFAULT false,
  "closedAt" timestamp(3),
  "locked" boolean NOT NULL DEFAULT false,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" text,
  CONSTRAINT "FiscalPeriod_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FiscalPeriod_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX "FiscalPeriod_organizationId_idx" ON "FiscalPeriod"("organizationId");

CREATE TABLE "GuestPayout" (
  "id" text NOT NULL,
  "organizationId" text NOT NULL,
  "date" timestamp(3) NOT NULL,
  "amount" numeric(19,4) NOT NULL,
  "reference" text,
  "status" text NOT NULL DEFAULT 'PENDING',
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "GuestPayout_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GuestPayout_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX "GuestPayout_organizationId_idx" ON "GuestPayout"("organizationId");

CREATE TABLE "JournalEntry" (
  "id" text NOT NULL,
  "organizationId" text NOT NULL,
  "date" timestamp(3) NOT NULL,
  "memo" text,
  "status" text NOT NULL DEFAULT 'DRAFT',
  "makerIdentity" text,
  "tenantId" text,
  "agentConfidence" double precision,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  "createdBy" text,
  "updatedBy" text,
  CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JournalEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX "JournalEntry_organizationId_idx" ON "JournalEntry"("organizationId");
CREATE INDEX "JournalEntry_status_idx" ON "JournalEntry"("status");

CREATE TABLE "JournalLine" (
  "id" text NOT NULL,
  "journalEntryId" text NOT NULL,
  "accountId" text NOT NULL,
  "amount" numeric(19,4) NOT NULL,
  "isDebit" boolean NOT NULL,
  "currency" text NOT NULL DEFAULT 'EUR',
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" text,
  CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JournalLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");
CREATE INDEX "JournalLine_journalEntryId_idx" ON "JournalLine"("journalEntryId");

CREATE TABLE "Channel" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Booking" (
  "id" text NOT NULL,
  "propertyId" text NOT NULL,
  "channelId" text NOT NULL,
  "checkIn" timestamp(3) NOT NULL,
  "checkOut" timestamp(3) NOT NULL,
  "totalAmount" numeric(19,4) NOT NULL,
  "status" text NOT NULL DEFAULT 'CONFIRMED',
  "hostawayId" text,
  "hostawayStatus" text,
  "deferredPosted" boolean NOT NULL DEFAULT false,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "Booking_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Booking_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "Booking_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "Booking_hostawayId_key" ON "Booking"("hostawayId");
CREATE INDEX "Booking_hostawayId_idx" ON "Booking"("hostawayId");
CREATE INDEX "Booking_propertyId_idx" ON "Booking"("propertyId");

CREATE TABLE "BookingCharge" (
  "id" text NOT NULL,
  "bookingId" text NOT NULL,
  "description" text NOT NULL,
  "amount" numeric(19,4) NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "BookingCharge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingCharge_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE "Vendor" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExpenseCategory" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "accountId" text,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Expense" (
  "id" text NOT NULL,
  "propertyId" text NOT NULL,
  "expenseCategoryId" text NOT NULL,
  "vendorId" text NOT NULL,
  "amount" numeric(19,4) NOT NULL,
  "date" timestamp(3) NOT NULL,
  "description" text,
  "receiptCloudId" text,
  "confidenceScore" double precision,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  CONSTRAINT "Expense_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Expense_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "Expense_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "ExpenseCategory"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "Expense_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE "ActionIntentQueue" (
  "id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "action" text NOT NULL,
  "payload" jsonb NOT NULL,
  "makerIdentity" text NOT NULL,
  "checkerIdentity" text,
  "confidence" double precision NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedAt" timestamp(3),
  "executedAt" timestamp(3),
  CONSTRAINT "ActionIntentQueue_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ActionIntentQueue_createdAt_idx" ON "ActionIntentQueue"("createdAt");
CREATE INDEX "ActionIntentQueue_status_idx" ON "ActionIntentQueue"("status");

CREATE TABLE "EvidenceLog" (
  "id" text NOT NULL,
  "eventType" text NOT NULL,
  "tenantId" text NOT NULL,
  "makerIdentity" text NOT NULL,
  "checkerIdentity" text,
  "description" text NOT NULL,
  "payload" jsonb NOT NULL,
  "hash" text NOT NULL,
  "previousHash" text,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvidenceLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EvidenceLog_createdAt_idx" ON "EvidenceLog"("createdAt");
CREATE INDEX "EvidenceLog_eventType_idx" ON "EvidenceLog"("eventType");
CREATE INDEX "EvidenceLog_tenantId_idx" ON "EvidenceLog"("tenantId");
