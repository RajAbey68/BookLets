/**
 * RAJ-674 Tier 1 — real-Postgres proof of the DB-level integrity controls.
 *
 * tests/unit/db-integrity-triggers.test.ts only regex-matches the migration
 * SQL TEXT for these object names — it would pass even if a trigger body had
 * a typo, a wrong ERRCODE, or silently no-op'd. This file executes the
 * actual SQL against a real Postgres (provisioned by
 * scripts/test-integration-setup.sh) to prove the constraints work.
 *
 * Run: npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Run `npm run test:integration` (which provisions the ' +
      'ephemeral Postgres via scripts/test-integration-setup.sh) rather than vitest directly.',
  );
}

let client: Client;
let orgId: string;
let bankAccountId: string;
let expenseAccountId: string;

async function insertJournalEntry(opts: {
  status: 'DRAFT' | 'POSTED' | 'VOIDED';
  date: string;
}): Promise<string> {
  const res = await client.query(
    `INSERT INTO "JournalEntry" (id, "organizationId", date, memo, status, "makerIdentity", "createdBy", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, 'integration test entry', $3, 'test', 'test', now())
     RETURNING id`,
    [orgId, opts.date, opts.status],
  );
  return res.rows[0].id;
}

async function insertBalancedLines(entryId: string, amount = '100.0000'): Promise<true> {
  await client.query(
    `INSERT INTO "JournalLine" (id, "journalEntryId", "accountId", amount, "isDebit", currency, "createdBy")
     VALUES
       (gen_random_uuid()::text, $1, $2, $3, true, 'EUR', 'test'),
       (gen_random_uuid()::text, $1, $4, $3, false, 'EUR', 'test')`,
    [entryId, expenseAccountId, amount, bankAccountId],
  );
  return true;
}

beforeAll(async () => {
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const org = await client.query(
    `INSERT INTO "Organization" (id, name, slug, "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, 'Integration Test Org', 'integration-test-org', now(), now())
     RETURNING id`,
  );
  orgId = org.rows[0].id;

  const bank = await client.query(
    `INSERT INTO "Account" (id, "organizationId", name, code, type, "createdBy", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, 'Operating Cash', '1000', 'ASSET', 'test', now(), now())
     RETURNING id`,
    [orgId],
  );
  bankAccountId = bank.rows[0].id;

  const expense = await client.query(
    `INSERT INTO "Account" (id, "organizationId", name, code, type, "createdBy", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, 'Test Expense', '6000', 'EXPENSE', 'test', now(), now())
     RETURNING id`,
    [orgId],
  );
  expenseAccountId = expense.rows[0].id;

  await client.query(
    `INSERT INTO "FiscalPeriod" (id, "organizationId", name, "startDate", "endDate", "isClosed", locked, "createdBy", "createdAt")
     VALUES (gen_random_uuid()::text, $1, 'FY-OPEN', '2026-01-01', '2026-12-31', false, false, 'test', now())`,
    [orgId],
  );

  await client.query(
    `INSERT INTO "FiscalPeriod" (id, "organizationId", name, "startDate", "endDate", "isClosed", locked, "createdBy", "createdAt")
     VALUES (gen_random_uuid()::text, $1, 'FY-CLOSED', '2024-01-01', '2024-12-31', true, false, 'test', now())`,
    [orgId],
  );
});

afterAll(async () => {
  await client.end();
});

describe('fiscal-period lock trigger (journal_entry_fiscal_lock) — real Postgres', () => {
  it('allows a POSTED entry dated inside an OPEN fiscal period', async () => {
    await expect(insertJournalEntry({ status: 'POSTED', date: '2026-06-15' })).resolves.toBeTruthy();
  });

  it('REJECTS a POSTED entry dated inside a CLOSED fiscal period', async () => {
    await expect(insertJournalEntry({ status: 'POSTED', date: '2024-06-15' })).rejects.toThrow();
  });

  it(
    'REJECTS a DRAFT entry dated inside a closed period too — the trigger body has no ' +
      'status check at all (confirmed by reading enforce_fiscal_period_lock directly); it ' +
      'gates every insert/date-changing update regardless of status. This is why ' +
      'src/lib/ocr-bridge.ts parks rows as NO_FISCAL_PERIOD before calling postEntry — the ' +
      'bridge author already knew a DRAFT insert would hit this same wall.',
    async () => {
      await expect(insertJournalEntry({ status: 'DRAFT', date: '2024-06-15' })).rejects.toThrow();
    },
  );
});

describe('posted-entry immutability trigger (journal_entry_no_posted_delete) — real Postgres', () => {
  it('REJECTS deleting a POSTED journal entry', async () => {
    const id = await insertJournalEntry({ status: 'POSTED', date: '2026-06-20' });
    await expect(client.query(`DELETE FROM "JournalEntry" WHERE id = $1`, [id])).rejects.toThrow();
  });

  it('allows deleting a DRAFT journal entry', async () => {
    const id = await insertJournalEntry({ status: 'DRAFT', date: '2026-06-20' });
    await expect(client.query(`DELETE FROM "JournalEntry" WHERE id = $1`, [id])).resolves.toBeTruthy();
  });
});

describe('JournalLine_amount_positive CHECK constraint — real Postgres', () => {
  it('REJECTS a zero-amount journal line', async () => {
    const id = await insertJournalEntry({ status: 'DRAFT', date: '2026-06-21' });
    await expect(insertBalancedLines(id, '0.0000')).rejects.toThrow();
  });

  it('REJECTS a negative-amount journal line', async () => {
    const id = await insertJournalEntry({ status: 'DRAFT', date: '2026-06-21' });
    await expect(insertBalancedLines(id, '-50.0000')).rejects.toThrow();
  });

  it('allows a positive-amount journal line', async () => {
    const id = await insertJournalEntry({ status: 'DRAFT', date: '2026-06-21' });
    await expect(insertBalancedLines(id, '50.0000')).resolves.toBeTruthy();
  });
});

describe('RLS org-isolation policy — real Postgres (documents the CURRENT state, not the aspiration)', () => {
  it('the org_isolation policy exists and is enabled on JournalEntry', async () => {
    const res = await client.query(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'JournalEntry'`,
    );
    expect(res.rows[0].relrowsecurity).toBe(true);
  });

  it(
    'DOCUMENTS A REAL, LIVE GAP: RLS is NOT forced, so the table-owning connection ' +
      '(the one the app uses today) bypasses every policy regardless of org context. ' +
      'This is not a hypothetical — FORCE ROW LEVEL SECURITY is deliberately deferred ' +
      'to a separate reviewed runbook (see the migration file header). This test will ' +
      'start FAILING (in a good way) the day FORCE is applied — update it then, do not ' +
      'delete it before that day.',
    async () => {
      const forced = await client.query(
        `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'JournalEntry'`,
      );
      expect(forced.rows[0].relforcerowsecurity).toBe(false);

      // Prove the bypass is real: query as the table owner (postgres, same as
      // this whole suite's connection) WITHOUT ever setting app.current_org_id,
      // and still see the org's rows — RLS does not gate this connection at all.
      const rows = await client.query(
        `SELECT id FROM "JournalEntry" WHERE "organizationId" = $1`,
        [orgId],
      );
      expect(rows.rows.length).toBeGreaterThan(0);
    },
  );
});
