/**
 * RAJ-282 / RAJ-295 — Database-level integrity triggers.
 *
 * Fiscal-period locking and POSTED-entry immutability are enforced today only
 * in the Prisma client extension (src/lib/prisma.ts) — bypassable by raw SQL,
 * the Supabase SQL editor, or any direct Postgres client. These issues demand
 * DB-level enforcement:
 *
 *   RAJ-282 — BEFORE INSERT OR UPDATE trigger on "JournalEntry" rejecting a
 *             date that falls within a CLOSED FiscalPeriod of the SAME
 *             organization (mirrors LedgerService.checkFiscalPeriod: the
 *             "closed" decision is isClosed = true, org-scoped, inclusive
 *             startDate/endDate bounds).
 *   RAJ-295 — BEFORE DELETE trigger on "JournalEntry" raising an exception
 *             when the row's status = 'POSTED' (void/reverse instead).
 *   Bonus  — CHECK constraint on "JournalLine": amount > 0 (sign lives in
 *            isDebit; every write path uses positive amounts).
 *
 * Schema-assertion gate in the account-hierarchy.test.ts style: read the
 * migration SQL text and assert the DDL exists. INTENTIONALLY FAILING until
 * the migration lands.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const migrationPath = path.resolve(
  __dirname,
  '../../prisma/migrations/20260703_fiscal_lock_and_posted_delete_triggers/migration.sql'
);

function readMigration(): string {
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Migration not found: ${migrationPath}`);
  }
  return fs.readFileSync(migrationPath, 'utf-8');
}

describe('RAJ-282 — fiscal-period lock enforced at the database level', () => {
  it('migration file exists', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('defines an idempotent plpgsql function checking closed fiscal periods', () => {
    const sql = readMigration();
    // CREATE OR REPLACE so re-runs are idempotent.
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION\s+enforce_fiscal_period_lock\s*\(\)/i);
    // Mirrors checkFiscalPeriod: same org, inclusive date bounds, isClosed.
    expect(sql).toMatch(/"organizationId"\s*=\s*NEW\."organizationId"/);
    expect(sql).toMatch(/"startDate"\s*<=/);
    expect(sql).toMatch(/"endDate"\s*>=/);
    expect(sql).toMatch(/"isClosed"\s*=\s*true/i);
    // Independent review (DeepSeek 2026-07-03): also treat locked = true as
    // closed — behaviour-identical today (nothing sets locked) but closes the
    // direct-DB hole where isClosed is flipped back while locked stays true.
    expect(sql).toMatch(/"locked"\s*=\s*true/i);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    // Custom SQLSTATE so callers can catch fiscal-lock violations precisely.
    expect(sql).toMatch(/ERRCODE\s*=\s*'BL282'/);
  });

  it('binds the function to a BEFORE INSERT OR UPDATE trigger on "JournalEntry"', () => {
    const sql = readMigration();
    // Dropped-if-exists first so the migration re-runs cleanly.
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS\s+journal_entry_fiscal_lock\s+ON\s+"JournalEntry"/i);
    expect(sql).toMatch(
      /CREATE TRIGGER\s+journal_entry_fiscal_lock\s+BEFORE INSERT OR UPDATE\s+ON\s+"JournalEntry"[\s\S]*?FOR EACH ROW[\s\S]*?EXECUTE FUNCTION\s+enforce_fiscal_period_lock\(\)/i
    );
  });
});

describe('RAJ-295 — POSTED journal entries cannot be deleted at the database level', () => {
  it('defines an idempotent plpgsql function blocking DELETE of POSTED entries', () => {
    const sql = readMigration();
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION\s+prevent_posted_entry_delete\s*\(\)/i);
    expect(sql).toMatch(/OLD\."status"\s*=\s*'POSTED'/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/ERRCODE\s*=\s*'BL295'/);
  });

  it('binds the function to a BEFORE DELETE trigger on "JournalEntry"', () => {
    const sql = readMigration();
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS\s+journal_entry_no_posted_delete\s+ON\s+"JournalEntry"/i);
    expect(sql).toMatch(
      /CREATE TRIGGER\s+journal_entry_no_posted_delete\s+BEFORE DELETE\s+ON\s+"JournalEntry"[\s\S]*?FOR EACH ROW[\s\S]*?EXECUTE FUNCTION\s+prevent_posted_entry_delete\(\)/i
    );
  });
});

describe('Hardening — JournalLine amounts are strictly positive at the database level', () => {
  it('adds a CHECK constraint amount > 0 on "JournalLine"', () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /ALTER TABLE\s+"JournalLine"[\s\S]*?ADD CONSTRAINT\s+"JournalLine_amount_positive"\s+CHECK\s*\(\s*"amount"\s*>\s*0\s*\)/i
    );
  });
});
