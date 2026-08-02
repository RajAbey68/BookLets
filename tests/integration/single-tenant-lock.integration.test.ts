/**
 * RAJ-674 — real-Postgres proof of the DB-level single-tenant lock.
 *
 * Two independent reviews (Qwen 3.7-max + Z.AI GLM 5.2) flagged an app-layer
 * `ALLOW_MULTI_TENANCY` env check as bypassable: Prisma connects as a
 * privileged role, so raw SQL / the Supabase editor / a future migration
 * could insert a second Organization and silently defeat the containment.
 * The lock therefore lives in the database (migration
 * 20260716_single_tenant_lock). This test proves it holds against a real
 * privileged connection — the exact bypass path the reviewers named.
 *
 * Non-destructive to the shared integration DB: every mutation runs inside a
 * transaction that is rolled back, and Postgres TRUNCATE is transactional, so
 * whatever other integration files seeded is restored on ROLLBACK.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL not set — run via `npm run test:integration`.');
}

let client: Client;

const insertOrg = (name: string, slug: string) =>
  client.query(
    `INSERT INTO "Organization" (id, name, slug, "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, now(), now())`,
    [name, slug],
  );

beforeAll(async () => {
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe('single-tenant lock trigger (organization_single_tenant_lock) — real Postgres', () => {
  it('the trigger exists on Organization', async () => {
    const res = await client.query(
      `SELECT 1 FROM pg_trigger
       WHERE tgname = 'organization_single_tenant_lock'
         AND tgrelid = '"Organization"'::regclass AND NOT tgisinternal`,
    );
    expect(res.rowCount).toBe(1);
  });

  it('allows the FIRST organization but hard-aborts the SECOND (as the privileged app role)', async () => {
    await client.query('BEGIN');
    try {
      // Clean slate inside the transaction (restored on ROLLBACK).
      await client.query('TRUNCATE "Organization" CASCADE');

      // First org — the owner's own books — is allowed.
      await expect(insertOrg('Owner Books', 'owner-books')).resolves.toBeTruthy();

      // Second org — from ANY path, including this raw privileged SQL — is refused.
      await expect(insertOrg('Second Tenant', 'second-tenant')).rejects.toThrow(
        /single-tenant lock/i,
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('raises the documented BL674 SQLSTATE on the blocked insert', async () => {
    await client.query('BEGIN');
    try {
      await client.query('TRUNCATE "Organization" CASCADE');
      await insertOrg('Owner Books', 'owner-books');
      await expect(insertOrg('Second Tenant', 'second-tenant')).rejects.toMatchObject({
        code: 'BL674',
      });
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
