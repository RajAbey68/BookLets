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

/** Money scale of JournalLine.amount — Decimal(19,4). */
export const MONEY_SCALE = 4;

/**
 * Turn a Decimal(19,4) value into an exact scaled integer (ten-thousandths).
 *
 * Parsed from the STRING, digit by digit. The previous version did
 * `BigInt(Math.round(Number(amount) * 10_000))`, which routes the money check
 * through a binary float on its way to claiming exactness — and Decimal(19,4)
 * ranges up to 10^15, far past the 2^53 where that stops being safe. A balance
 * assertion that can itself drift is not a balance assertion.
 *
 * Throws on anything that is not a plain decimal (including exponent notation
 * a driver might produce): failing loudly beats silently comparing nonsense.
 */
export function toScaledMoney(value, scale = MONEY_SCALE) {
  const raw = typeof value === 'string' ? value.trim() : String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(raw);
  if (!match) {
    throw new Error(`Refusing to compare "${raw}" as money: not a plain decimal string.`);
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > scale) {
    throw new Error(`"${raw}" has more than ${scale} decimal places; the column is Decimal(19,${scale}).`);
  }
  return BigInt((sign === '-' ? '-' : '') + whole + fraction.padEnd(scale, '0'));
}

/** Render a scaled integer back to a human decimal string, exactly. */
export function formatScaledMoney(scaled, scale = MONEY_SCALE) {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Double-entry integrity, checked directly: every entry has at least two
 * lines and its debits equal its credits. An import that creates the right
 * NUMBER of unbalanced entries is still a broken import.
 *
 * All arithmetic is exact integer arithmetic on the scaled values — no float
 * is involved at any point.
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
      const scaled = toScaledMoney(line.amount);
      net += line.isDebit ? scaled : -scaled;
    }
    if (net !== 0n) bad.push({ id: entry.id, reason: `unbalanced by ${formatScaledMoney(net)}` });
    if (lines.some((l) => toScaledMoney(l.amount) <= 0n)) {
      bad.push({ id: entry.id, reason: 'line amount <= 0' });
    }
  }
  return bad;
}

/** Exact sum of every debit line, in scaled integer units. */
export function sumDebitsScaled(facts) {
  let total = 0n;
  for (const lines of facts.linesByEntry.values()) {
    for (const line of lines) {
      if (line.isDebit) total += toScaledMoney(line.amount);
    }
  }
  return total;
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
