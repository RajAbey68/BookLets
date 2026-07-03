/**
 * RAJ-281 — Composite indexes for hot query paths.
 *
 * Schema-assertion gate: composite indexes must match the real query shapes
 * verified in the 2026-07-03 database review:
 *
 * - JournalEntry (organizationId, status, date)   — metrics.service.ts and
 *   trial-balance-report.ts filter org + status ('POSTED') + date range.
 * - JournalLine (accountId, journalEntryId)       — getAccountBalance joins
 *   lines by accountId to their POSTED journal entries.
 * - Booking (propertyId, status, checkOut)        — recognizeRevenue finds
 *   CONFIRMED bookings whose checkOut has passed, scoped by property.
 * - EvidenceLog (tenantId, createdAt DESC)        — hash-chain head lookup
 *   (latest row per tenant) runs inside EVERY ledger-post transaction.
 * - ActionIntentQueue (status, createdAt)         — queue worker pattern:
 *   oldest PENDING first.
 *
 * Mirrors the account-hierarchy.test.ts pattern: read schema.prisma text and
 * assert the @@index declarations exist, plus the hand-written migration file
 * carries the matching CREATE INDEX statements. INTENTIONALLY FAILING until
 * the migration lands.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const schemaPath = path.resolve(__dirname, '../../prisma/schema.prisma');
const schema = fs.readFileSync(schemaPath, 'utf-8');

const migrationPath = path.resolve(
  __dirname,
  '../../prisma/migrations/20260703_composite_query_indexes/migration.sql'
);

function getModel(name: string): string {
  const regex = new RegExp(`model\\s+${name}\\s*\\{([^}]+)\\}`, 's');
  const match = schema.match(regex);
  if (!match) throw new Error(`Model "${name}" not found in schema.prisma`);
  return match[1];
}

describe('RAJ-281 — composite indexes in schema.prisma', () => {
  it('JournalEntry carries (organizationId, status, date) for org+status+date-range reads', () => {
    expect(getModel('JournalEntry')).toMatch(/@@index\(\[organizationId,\s*status,\s*date\]\)/);
  });

  it('JournalLine carries (accountId, journalEntryId) for the getAccountBalance join', () => {
    expect(getModel('JournalLine')).toMatch(/@@index\(\[accountId,\s*journalEntryId\]\)/);
  });

  it('Booking carries (propertyId, status, checkOut) for revenue recognition sweeps', () => {
    expect(getModel('Booking')).toMatch(/@@index\(\[propertyId,\s*status,\s*checkOut\]\)/);
  });

  it('EvidenceLog carries (tenantId, createdAt DESC) for the hash-chain head lookup', () => {
    expect(getModel('EvidenceLog')).toMatch(
      /@@index\(\[tenantId,\s*createdAt\(sort:\s*Desc\)\]\)/
    );
  });

  it('ActionIntentQueue carries (status, createdAt) for the queue worker scan', () => {
    expect(getModel('ActionIntentQueue')).toMatch(/@@index\(\[status,\s*createdAt\]\)/);
  });

  it('keeps existing single-column indexes that the composites do not subsume', () => {
    // JournalEntry (status) is NOT subsumed — the composite leads with
    // organizationId, so a status-only scan cannot use it.
    expect(getModel('JournalEntry')).toMatch(/@@index\(\[status\]\)/);
    // JournalLine (journalEntryId) is NOT subsumed — the composite leads with
    // accountId; entry→lines expansion needs the standalone index.
    expect(getModel('JournalLine')).toMatch(/@@index\(\[journalEntryId\]\)/);
    // EvidenceLog (createdAt) and (eventType) stay for time-window/type scans.
    expect(getModel('EvidenceLog')).toMatch(/@@index\(\[createdAt\]\)/);
    expect(getModel('EvidenceLog')).toMatch(/@@index\(\[eventType\]\)/);
  });
});

describe('RAJ-281 — hand-written migration', () => {
  it('migration file exists', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('creates every composite index idempotently (IF NOT EXISTS)', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "JournalEntry_organizationId_status_date_idx"\s+ON "JournalEntry"\("organizationId",\s*"status",\s*"date"\)/
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "JournalLine_accountId_journalEntryId_idx"\s+ON "JournalLine"\("accountId",\s*"journalEntryId"\)/
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "Booking_propertyId_status_checkOut_idx"\s+ON "Booking"\("propertyId",\s*"status",\s*"checkOut"\)/
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "EvidenceLog_tenantId_createdAt_idx"\s+ON "EvidenceLog"\("tenantId",\s*"createdAt" DESC\)/
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "ActionIntentQueue_status_createdAt_idx"\s+ON "ActionIntentQueue"\("status",\s*"createdAt"\)/
    );
  });
});
