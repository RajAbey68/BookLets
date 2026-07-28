/**
 * Ground truth. Everything the harness asserts is asserted HERE, against the
 * database, with plain SQL — never against what the API or the UI said
 * happened.
 *
 * That distinction is the whole point of the exercise. The application's own
 * report of "34 receipts imported" is a claim; the number of DRAFT rows in
 * public."JournalEntry" is the fact. The product's worst possible bug is those
 * two disagreeing, and a harness that trusts the API can never see it.
 */
import pg from 'pg';

const { Client } = pg;

export async function connect(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

/** Wipe every table the import path writes to. Test database only. */
export async function resetLedger(client, organizationId) {
  await client.query(
    'DELETE FROM "JournalLine" WHERE "journalEntryId" IN (SELECT id FROM "JournalEntry" WHERE "organizationId" = $1)',
    [organizationId],
  );
  await client.query('DELETE FROM "JournalEntry" WHERE "organizationId" = $1', [organizationId]);
  await client.query('DELETE FROM "EvidenceLog" WHERE "tenantId" = $1', [organizationId]);
}

/**
 * Provision the minimum an organisation needs for a receipt import to be
 * possible at all: the org, the signed-in user, their membership, and the two
 * accounts the ingest path resolves (Suspense 9999 debit, Bank 1000 credit).
 *
 * Note this is NOT `prisma db seed` — that seeds demo Dublin properties and
 * must never run outside a disposable database. This creates exactly the four
 * rows the import needs and no business data at all.
 */
export async function provisionOrg(client, { orgId, orgName, orgSlug, userId, email }) {
  // Existence is checked BEFORE inserting, not handled with ON CONFLICT: the
  // single-tenant lock (20260716_single_tenant_lock) is a BEFORE INSERT
  // trigger, and a BEFORE trigger fires ahead of conflict resolution — so an
  // idempotent upsert still aborts with BL674 on the second run.
  const existing = await client.query('SELECT id FROM "Organization" LIMIT 1');
  if (existing.rowCount === 0) {
    await client.query(
      `INSERT INTO "Organization" (id, name, slug, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, now(), now())`,
      [orgId, orgName, orgSlug],
    );
  } else if (existing.rows[0].id !== orgId) {
    throw new Error(
      `The test database already holds organisation "${existing.rows[0].id}" and the single-tenant ` +
        'lock forbids a second one. Drop the database and re-run.',
    );
  }
  await client.query(
    `INSERT INTO "User" (id, email, name, "createdAt", "updatedAt")
     VALUES ($1, $2, 'E2E Harness', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [userId, email],
  );
  await client.query(
    `INSERT INTO "Membership" (id, "userId", "organizationId", role, "createdAt")
     VALUES ($1, $2, $3, 'OWNER', now())
     ON CONFLICT (id) DO NOTHING`,
    [`${userId}-mem`, userId, orgId],
  );
  await client.query(
    `INSERT INTO "Account" (id, "organizationId", name, code, type, "createdAt", "updatedAt")
     VALUES ($1, $2, 'Suspense', '9999', 'SUSPENSE', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [`${orgId}-suspense`, orgId],
  );
  await client.query(
    `INSERT INTO "Account" (id, "organizationId", name, code, type, "createdAt", "updatedAt")
     VALUES ($1, $2, 'Primary Bank', '1000', 'ASSET', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [`${orgId}-bank`, orgId],
  );
}

/**
 * Give the organisation an open fiscal period covering the current year.
 *
 * Deliberately NOT part of provisionOrg: whether a production organisation has
 * one is itself under test (see the "cold organisation" scenario). Today the
 * only thing in the whole codebase that creates a FiscalPeriod is
 * prisma/seed.ts, which must never run against production.
 */
export async function ensureFiscalPeriod(client, organizationId, year = new Date().getUTCFullYear()) {
  await client.query(
    `INSERT INTO "FiscalPeriod" (id, "organizationId", name, "startDate", "endDate", "createdAt")
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO NOTHING`,
    [`${organizationId}-fp-${year}`, organizationId, `FY ${year}`, `${year}-01-01`, `${year}-12-31`],
  );
}

/** Remove every fiscal period, so the org looks like a fresh deployment. */
export async function clearFiscalPeriods(client, organizationId) {
  await client.query('DELETE FROM "FiscalPeriod" WHERE "organizationId" = $1', [organizationId]);
}

/** Every fact about what the import path actually left behind. */
export async function ledgerFacts(client, organizationId) {
  const entries = await client.query(
    `SELECT id, status, memo, "idempotencyKey", "sourceId", source, "agentConfidence"
       FROM "JournalEntry" WHERE "organizationId" = $1`,
    [organizationId],
  );
  const lines = await client.query(
    `SELECT jl."journalEntryId", jl.amount, jl."isDebit", a.code
       FROM "JournalLine" jl
       JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
       JOIN "Account" a ON a.id = jl."accountId"
      WHERE je."organizationId" = $1`,
    [organizationId],
  );
  const evidence = await client.query(
    `SELECT "eventType", payload FROM "EvidenceLog" WHERE "tenantId" = $1 ORDER BY "createdAt" ASC`,
    [organizationId],
  );

  const byStatus = {};
  for (const row of entries.rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;

  const linesByEntry = new Map();
  for (const line of lines.rows) {
    if (!linesByEntry.has(line.journalEntryId)) linesByEntry.set(line.journalEntryId, []);
    linesByEntry.get(line.journalEntryId).push(line);
  }

  return {
    entryCount: entries.rows.length,
    draftCount: byStatus.DRAFT ?? 0,
    postedCount: byStatus.POSTED ?? 0,
    byStatus,
    entries: entries.rows,
    sourceIds: new Set(entries.rows.map((r) => r.sourceId).filter(Boolean)),
    idempotencyKeys: entries.rows.map((r) => r.idempotencyKey),
    linesByEntry,
    evidence: evidence.rows,
  };
}

/**
 * Double-entry integrity, checked directly: every entry has at least two
 * lines and its debits equal its credits. An import that creates the right
 * NUMBER of unbalanced entries is still a broken import.
 */
export function findUnbalancedEntries(facts) {
  const bad = [];
  for (const entry of facts.entries) {
    const lines = facts.linesByEntry.get(entry.id) ?? [];
    if (lines.length < 2) {
      bad.push({ id: entry.id, reason: `only ${lines.length} line(s)` });
      continue;
    }
    let net = 0n;
    for (const line of lines) {
      // Decimal(19,4) comes back as a string; compare in integer ten-thousandths
      // so floating point can never be the reason a ledger looks balanced.
      const scaled = BigInt(Math.round(Number(line.amount) * 10_000));
      net += line.isDebit ? scaled : -scaled;
    }
    if (net !== 0n) bad.push({ id: entry.id, reason: `unbalanced by ${Number(net) / 10_000}` });
    if (lines.some((l) => Number(l.amount) <= 0)) {
      bad.push({ id: entry.id, reason: 'line amount <= 0' });
    }
  }
  return bad;
}

/** Duplicate idempotency keys — the money-correctness canary. */
export function findDuplicateKeys(facts) {
  const seen = new Map();
  for (const key of facts.idempotencyKeys) {
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1);
}
