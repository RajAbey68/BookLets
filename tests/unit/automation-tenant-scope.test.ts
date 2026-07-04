/**
 * RAJ-513 [Sprint 0] — Tenant scoping for the automation vendor match.
 *
 * AutomationService.processReceipt resolved vendors with a bare
 * `name: { contains: vendorName }` — UNSCOPED by organization. Two tenants
 * with a vendor named "Acme Cleaning" would silently share one Vendor row,
 * so org-A's expenses could point at org-B's vendor (cross-tenant bleed).
 *
 * Layers tested:
 *   1. schema — Vendor.organizationId String? + index (add-only retrofit,
 *      same pattern as ActionIntentQueue in 20260703_action_intent_org_scope)
 *   2. behaviour — processReceipt must NOT reuse another org's vendor, must
 *      scope the lookup by organizationId, and must stamp the org on create.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// ─── 1. schema gate ───────────────────────────────────────────────────────────

describe('RAJ-513 — Vendor schema tenant scope', () => {
  const schema = fs.readFileSync(
    path.resolve(__dirname, '../../prisma/schema.prisma'),
    'utf-8'
  );
  const vendor = schema.match(new RegExp('model\\s+Vendor\\s*\\{([^}]+)\\}', 's'))![1];

  it('Vendor has a nullable organizationId (add-only retrofit, no backfill)', () => {
    expect(vendor).toMatch(/organizationId\s+String\?/);
  });

  it('Vendor.organizationId is indexed', () => {
    expect(vendor).toMatch(/@@index\(\[organizationId\]\)/);
  });

  it('migration is add-only (no DROP / RENAME)', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../prisma/migrations/20260704_vendor_org_scope/migration.sql'),
      'utf-8'
    );
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS "organizationId"/);
    expect(migration).not.toMatch(/DROP|RENAME/i);
  });
});

// ─── 2. behaviour (mocked Prisma — filter is applied like the DB would) ───────

describe('RAJ-513 — processReceipt vendor match is org-scoped', () => {
  beforeEach(() => vi.resetModules());

  /** Vendor table containing ONLY another tenant's vendor with a matching name. */
  const foreignVendor = { id: 'vendor-orgB', name: 'Acme Cleaning', organizationId: 'org-B' };

  type Where = {
    organizationId?: string | null;
    name?: { contains?: string };
  };

  async function runProcessReceipt() {
    // findFirst fake that evaluates the where-clause the way Postgres would:
    // if the query carries no organizationId filter, the foreign row matches.
    const vendorFindFirst = vi.fn(async ({ where }: { where: Where }) => {
      const orgOk =
        where.organizationId === undefined || where.organizationId === foreignVendor.organizationId;
      const nameOk =
        !where.name?.contains || foreignVendor.name.includes(where.name.contains);
      return orgOk && nameOk ? foreignVendor : null;
    });
    // Round 2: creation goes through an atomic upsert on the per-org unique.
    // No org-A row exists in this scenario, so the upsert always inserts.
    const vendorUpsert = vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
      id: 'vendor-new',
      ...create,
    }));
    const expenseCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'exp-1',
      ...data,
    }));

    vi.doMock('../../src/lib/prisma', () => ({
      prisma: {
        property: { findFirst: vi.fn().mockResolvedValue({ id: 'prop-1' }) },
        vendor: { findFirst: vendorFindFirst, upsert: vendorUpsert },
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
    return { result, vendorFindFirst, vendorUpsert, expenseCreate };
  }

  it('does NOT reuse another organization\'s vendor (no cross-tenant bleed)', async () => {
    const { vendorUpsert, expenseCreate } = await runProcessReceipt();

    // org-A has no vendor of its own — a new one must be created instead of
    // silently attaching org-A's expense to org-B's vendor row.
    expect(vendorUpsert).toHaveBeenCalled();
    const expenseData = expenseCreate.mock.calls[0][0].data as { vendorId: string };
    expect(expenseData.vendorId).not.toBe(foreignVendor.id);
  });

  it('scopes the vendor lookup by organizationId', async () => {
    const { vendorFindFirst } = await runProcessReceipt();
    expect(vendorFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-A' }),
      })
    );
  });

  it('stamps organizationId on newly created vendors', async () => {
    const { vendorUpsert } = await runProcessReceipt();
    const created = vendorUpsert.mock.calls[0][0].create as { organizationId?: string };
    expect(created.organizationId).toBe('org-A');
  });
});
