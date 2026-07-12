/**
 * S3 (rls-lock) — organisation-isolation RLS policies.
 *
 * Multi-tenant isolation is enforced by Postgres row-level security keyed
 * off the transaction-local setting `app.current_org_id`. Policy SQL cannot
 * be executed without a database, so this suite is a schema-assertion gate
 * in the db-integrity-triggers.test.ts style: read the migration SQL text
 * and assert the DDL exists with the exact fail-closed shape:
 *
 *  - RLS ENABLEd (idempotently) on every one of the 20 tables;
 *  - an org_isolation policy on every tenant table — direct org-column
 *    tables compare their own column, join-path tables prove lineage to an
 *    in-org parent via EXISTS;
 *  - WITH CHECK mirrors USING everywhere (no cross-org writes either);
 *  - global tables (User, Channel, ExpenseCategory, Vendor) get NO org
 *    policy — they have no tenant path; enabled-RLS-without-policy keeps
 *    non-owner roles fully locked out;
 *  - the public/booklets schema mismatch is detected, not guessed;
 *  - FORCE ROW LEVEL SECURITY is staged for Hermes (Phase 2), not executed
 *    blind by `prisma migrate deploy`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const migrationPath = path.resolve(
  __dirname,
  '../../prisma/migrations/20260712_rls_org_isolation/migration.sql'
);

function readMigration(): string {
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Migration not found: ${migrationPath}`);
  }
  return fs.readFileSync(migrationPath, 'utf-8');
}

const ALL_TABLES = [
  'Organization',
  'User',
  'Membership',
  'Property',
  'Owner',
  'PropertyOwnership',
  'Account',
  'JournalEntry',
  'JournalLine',
  'FiscalPeriod',
  'Channel',
  'Booking',
  'BookingCharge',
  'GuestPayout',
  'OwnerStatement',
  'ExpenseCategory',
  'Vendor',
  'Expense',
  'EvidenceLog',
  'ActionIntentQueue',
] as const;

/** Tenant tables carrying the org id directly: table → column compared. */
const DIRECT_ORG_TABLES: Record<string, string> = {
  Organization: 'id',
  Membership: 'organizationId',
  Property: 'organizationId',
  Owner: 'organizationId',
  Account: 'organizationId',
  JournalEntry: 'organizationId',
  FiscalPeriod: 'organizationId',
  GuestPayout: 'organizationId',
  EvidenceLog: 'tenantId',
  ActionIntentQueue: 'organizationId',
};

/** Tenant tables isolated via a join path: table → parent proven in-org. */
const JOIN_PATH_TABLES: Record<string, string> = {
  PropertyOwnership: 'Property',
  JournalLine: 'JournalEntry',
  Booking: 'Property',
  BookingCharge: 'Booking',
  OwnerStatement: 'Owner',
  Expense: 'Property',
};

/** No org path exists; must NOT get an org policy. */
const GLOBAL_TABLES = ['User', 'Channel', 'ExpenseCategory', 'Vendor'] as const;

/** Strip SQL line comments so "commented-out" DDL can't satisfy assertions. */
function uncommented(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('S3 rls-lock — migration file', () => {
  it('exists at prisma/migrations/20260712_rls_org_isolation/migration.sql', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('covers every Prisma model exactly once in the classification sets', () => {
    const classified = [
      ...Object.keys(DIRECT_ORG_TABLES),
      ...Object.keys(JOIN_PATH_TABLES),
      ...GLOBAL_TABLES,
    ].sort();
    expect(classified).toEqual([...ALL_TABLES].sort());
    expect(classified).toHaveLength(20);
  });
});

describe('S3 rls-lock — RLS enabled on every table (idempotent)', () => {
  it.each(ALL_TABLES)('enables row level security on "%s"', (table) => {
    const sql = uncommented(readMigration());
    expect(sql).toMatch(
      new RegExp(`ALTER TABLE\\s+"${table}"\\s+ENABLE ROW LEVEL SECURITY`, 'i')
    );
  });
});

describe('S3 rls-lock — fail-closed session-variable helper', () => {
  it('defines booklets_current_org_id() over current_setting(app.current_org_id, missing_ok)', () => {
    const sql = uncommented(readMigration());
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION\s+booklets_current_org_id\s*\(\)/i);
    // missing_ok = true → NULL (not an error) when unset; NULL matches no row.
    expect(sql).toMatch(/current_setting\('app\.current_org_id',\s*true\)/i);
    // Empty string must not become a matchable value either.
    expect(sql).toMatch(/nullif\(\s*current_setting\('app\.current_org_id',\s*true\)\s*,\s*''\s*\)/i);
    expect(sql).toMatch(/\bSTABLE\b/);
  });
});

describe('S3 rls-lock — direct org-column policies', () => {
  it.each(Object.entries(DIRECT_ORG_TABLES))(
    '"%s" is dropped-if-exists then policy-bound on its "%s" column with USING and WITH CHECK',
    (table, column) => {
      const sql = uncommented(readMigration());
      expect(sql).toMatch(
        new RegExp(`DROP POLICY IF EXISTS\\s+org_isolation\\s+ON\\s+"${table}"`, 'i')
      );
      expect(sql).toMatch(
        new RegExp(
          `CREATE POLICY\\s+org_isolation\\s+ON\\s+"${table}"\\s+FOR ALL\\s+` +
            `USING\\s*\\("${column}"\\s*=\\s*booklets_current_org_id\\(\\)\\)\\s*` +
            `WITH CHECK\\s*\\("${column}"\\s*=\\s*booklets_current_org_id\\(\\)\\)`,
          'i'
        )
      );
    }
  );
});

describe('S3 rls-lock — join-path policies', () => {
  it.each(Object.entries(JOIN_PATH_TABLES))(
    '"%s" proves lineage to an in-org "%s" via EXISTS, for USING and WITH CHECK',
    (table, parent) => {
      const sql = uncommented(readMigration());
      expect(sql).toMatch(
        new RegExp(`DROP POLICY IF EXISTS\\s+org_isolation\\s+ON\\s+"${table}"`, 'i')
      );
      const policyMatch = sql.match(
        new RegExp(
          `CREATE POLICY\\s+org_isolation\\s+ON\\s+"${table}"([\\s\\S]*?);`,
          'i'
        )
      );
      expect(policyMatch, `policy for ${table} missing`).not.toBeNull();
      const body = policyMatch![1];
      expect(body).toMatch(/FOR ALL/i);
      // Both the read fence and the write fence walk the same parent chain.
      const existsOverParent = new RegExp(
        `EXISTS\\s*\\(\\s*SELECT 1[\\s\\S]*?FROM\\s+"${parent}"[\\s\\S]*?booklets_current_org_id\\(\\)`,
        'gi'
      );
      const occurrences = body.match(existsOverParent) ?? [];
      expect(occurrences.length, `USING and WITH CHECK for ${table}`).toBeGreaterThanOrEqual(2);
      expect(body).toMatch(/WITH CHECK/i);
    }
  );

  it('"BookingCharge" walks the full chain Booking → Property', () => {
    const sql = uncommented(readMigration());
    const policyMatch = sql.match(
      /CREATE POLICY\s+org_isolation\s+ON\s+"BookingCharge"([\s\S]*?);/i
    );
    expect(policyMatch).not.toBeNull();
    expect(policyMatch![1]).toMatch(/JOIN\s+"Property"/i);
  });
});

describe('S3 rls-lock — global tables get no org policy', () => {
  it.each(GLOBAL_TABLES)('"%s" has RLS enabled but no org_isolation policy', (table) => {
    const sql = uncommented(readMigration());
    expect(sql).toMatch(
      new RegExp(`ALTER TABLE\\s+"${table}"\\s+ENABLE ROW LEVEL SECURITY`, 'i')
    );
    expect(sql).not.toMatch(
      new RegExp(`CREATE POLICY\\s+\\S+\\s+ON\\s+"${table}"`, 'i')
    );
  });
});

describe('S3 rls-lock — public/booklets schema mismatch is detected, never guessed', () => {
  it('resolves the hosting schema of "Organization" at apply time', () => {
    const sql = readMigration();
    expect(sql).toMatch(/pg_class/);
    expect(sql).toMatch(/pg_namespace/);
    expect(sql).toMatch(/IN \('booklets',\s*'public'\)/);
    expect(sql).toMatch(/set_config\('search_path'/);
  });

  it('aborts loudly when "Organization" is in neither or both schemas', () => {
    const sql = readMigration();
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]*?neither/i);
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]*?BOTH/);
  });
});

describe('S3 rls-lock — FORCE ROW LEVEL SECURITY is staged, not auto-applied', () => {
  it('does not execute FORCE in the migration itself (owner lockout is Phase 2)', () => {
    const sql = uncommented(readMigration());
    expect(sql).not.toMatch(/FORCE ROW LEVEL SECURITY/i);
  });

  it('documents the canonical Phase 2 FORCE list for Hermes', () => {
    const sql = readMigration();
    for (const table of [
      'Organization',
      'Property',
      'JournalEntry',
      'JournalLine',
      'EvidenceLog',
      'ActionIntentQueue',
    ]) {
      expect(sql).toMatch(
        new RegExp(`--\\s*ALTER TABLE\\s+"${table}"\\s+FORCE ROW LEVEL SECURITY`, 'i')
      );
    }
    // Bootstrap and global tables must never appear in the FORCE list.
    for (const table of ['User', 'Membership', 'Channel', 'ExpenseCategory', 'Vendor']) {
      expect(sql).not.toMatch(
        new RegExp(`ALTER TABLE\\s+"${table}"\\s+FORCE ROW LEVEL SECURITY`, 'i')
      );
    }
  });
});
