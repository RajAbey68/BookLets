/**
 * RAJ-513 [fix round] — Deterministic vendor selection within an organization.
 *
 * External review finding 2: the org-scoped lookup still used a bare
 * `name: { contains }` findFirst with NO ordering — Postgres returns rows in
 * arbitrary order, so with several partial matches ("Acme Cleaning Co",
 * "Acme Cleaning Services") the SAME receipt could attach to DIFFERENT
 * vendors run-to-run. Fixed selection order:
 *   1. exact match on normalizedName (trim/lowercase/collapse-whitespace);
 *   2. else oldest contains-match (orderBy createdAt asc) — deterministic;
 *   3. else create, stamping normalizedName; a P2002 unique-race
 *      (organizationId, normalizedName) is recovered by re-reading the winner.
 *
 * Prod data reality (verified 2026-07-04 on euqdfxekrxnoibeahogq): Vendor has
 * 0 rows, so the per-org unique index on normalizedName is added now while it
 * is provably safe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// ─── 1. schema gate ───────────────────────────────────────────────────────────

describe('RAJ-513 fix round — Vendor normalizedName schema', () => {
  const schema = fs.readFileSync(
    path.resolve(__dirname, '../../prisma/schema.prisma'),
    'utf-8'
  );
  const vendor = schema.match(new RegExp('model\\s+Vendor\\s*\\{([^}]+)\\}', 's'))![1];

  it('Vendor has a normalizedName column', () => {
    expect(vendor).toMatch(/normalizedName\s+String\?/);
  });

  it('Vendor is unique per (organizationId, normalizedName)', () => {
    expect(vendor).toMatch(/@@unique\(\[organizationId,\s*normalizedName\]\)/);
  });

  it('migration is add-only (no DROP / RENAME / DELETE)', () => {
    const migration = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../prisma/migrations/20260704_vendor_normalized_name/migration.sql'
      ),
      'utf-8'
    );
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS "normalizedName"/);
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/);
    expect(migration).not.toMatch(/DROP|RENAME|DELETE/i);
  });
});

// ─── 2. behaviour (mocked Prisma evaluating where/orderBy like Postgres) ──────

type VendorRow = {
  id: string;
  name: string;
  normalizedName?: string | null;
  organizationId: string | null;
  createdAt: Date;
};

type Where = {
  organizationId?: string | null;
  normalizedName?: string;
  name?: { contains?: string };
};

describe('RAJ-513 fix round — processReceipt vendor selection is deterministic', () => {
  beforeEach(() => vi.resetModules());

  function makeFindFirst(store: VendorRow[]) {
    return vi.fn(
      async ({ where, orderBy }: { where: Where; orderBy?: { createdAt?: 'asc' | 'desc' } }) => {
        let rows = store.filter(
          (r) => where.organizationId === undefined || r.organizationId === where.organizationId
        );
        if (where.normalizedName !== undefined) {
          rows = rows.filter((r) => r.normalizedName === where.normalizedName);
        }
        if (where.name?.contains) {
          rows = rows.filter((r) => r.name.includes(where.name!.contains!));
        }
        if (orderBy?.createdAt === 'asc') {
          rows = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        } else if (where.name?.contains) {
          // No ordering requested on a multi-row contains match: simulate
          // Postgres arbitrary order by returning the NEWEST row, so any
          // unordered fallback is caught as nondeterminism.
          rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return rows[0] ?? null;
      }
    );
  }

  async function runProcessReceipt(
    store: VendorRow[],
    createImpl?: (args: { data: Record<string, unknown> }) => Promise<VendorRow>
  ) {
    const vendorFindFirst = makeFindFirst(store);
    const vendorCreate = vi.fn(
      createImpl ??
        (async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            id: 'vendor-new',
            createdAt: new Date('2026-07-04'),
            ...data,
          } as VendorRow;
          store.push(row);
          return row;
        })
    );
    const expenseCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'exp-1',
      ...data,
    }));

    vi.doMock('../../src/lib/prisma', () => ({
      prisma: {
        property: { findFirst: vi.fn().mockResolvedValue({ id: 'prop-1' }) },
        vendor: { findFirst: vendorFindFirst, create: vendorCreate },
        account: { findFirst: vi.fn().mockResolvedValue({ id: 'acc-1' }) },
        expenseCategory: {
          findFirst: vi.fn().mockResolvedValue({ id: 'cat-1', accountId: 'acc-exp' }),
          create: vi.fn(),
        },
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
          cb({ expense: { create: expenseCreate } })
        ),
      },
    }));
    vi.doMock('../../src/lib/http', () => ({
      fetchWithTimeout: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          extraction: {
            vendorName: 'Acme Cleaning',
            date: '2026-07-01',
            totalAmount: 100,
            categorySuggestion: 'Cleaning',
            confidence: 0.95,
          },
        }),
      }),
    }));
    vi.doMock('../../src/lib/ledger.service', () => ({
      LedgerService: { postEntry: vi.fn().mockResolvedValue({ id: 'je-1' }) },
    }));

    const { AutomationService } = await import('../../src/lib/automation.service');
    const result = await AutomationService.processReceipt('org-A', 'prop-1', 'base64==');
    const expenseData = expenseCreate.mock.calls[0][0].data as { vendorId: string };
    return { result, vendorFindFirst, vendorCreate, vendorId: expenseData.vendorId };
  }

  it('prefers the exact (normalized) name match over any contains match', async () => {
    const { vendorId } = await runProcessReceipt([
      {
        id: 'v-contains-newest',
        name: 'Acme Cleaning Services',
        normalizedName: 'acme cleaning services',
        organizationId: 'org-A',
        createdAt: new Date('2026-06-01'),
      },
      {
        id: 'v-exact',
        name: 'Acme Cleaning',
        normalizedName: 'acme cleaning',
        organizationId: 'org-A',
        createdAt: new Date('2026-06-15'),
      },
    ]);
    expect(vendorId).toBe('v-exact');
  });

  it('falls back to the OLDEST contains-match (createdAt asc) — never arbitrary order', async () => {
    const { vendorId, vendorCreate } = await runProcessReceipt([
      {
        id: 'v-newer',
        name: 'Acme Cleaning Services',
        normalizedName: 'acme cleaning services',
        organizationId: 'org-A',
        createdAt: new Date('2026-06-20'),
      },
      {
        id: 'v-older',
        name: 'Acme Cleaning Co',
        normalizedName: 'acme cleaning co',
        organizationId: 'org-A',
        createdAt: new Date('2026-01-05'),
      },
    ]);
    expect(vendorCreate).not.toHaveBeenCalled();
    expect(vendorId).toBe('v-older');
  });

  it('stamps normalizedName (trimmed, lowercased) on newly created vendors', async () => {
    const { vendorCreate } = await runProcessReceipt([]);
    const data = vendorCreate.mock.calls[0][0].data as { normalizedName?: string };
    expect(data.normalizedName).toBe('acme cleaning');
  });

  it('recovers from the (org, normalizedName) unique race: P2002 → re-read the winner', async () => {
    const winner: VendorRow = {
      id: 'v-winner',
      name: 'Acme Cleaning',
      normalizedName: 'acme cleaning',
      organizationId: 'org-A',
      createdAt: new Date('2026-07-04'),
    };
    const store: VendorRow[] = [];
    const { vendorId } = await runProcessReceipt(store, async () => {
      // Concurrent writer won the unique constraint; surface Prisma's P2002
      // and make the winner visible to the recovery re-read.
      store.push(winner);
      const err = new Error('Unique constraint failed') as Error & { code: string };
      err.code = 'P2002';
      throw err;
    });
    expect(vendorId).toBe('v-winner');
  });
});
