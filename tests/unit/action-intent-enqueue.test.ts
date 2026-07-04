/**
 * RAJ-513 [Sprint 0] — Enqueue guard for the 4-eyes ActionIntentQueue.
 *
 * ActionIntentQueue.organizationId was retrofitted nullable
 * (20260703_action_intent_org_scope); the fix round promotes it to NOT NULL
 * at the DB (20260704_action_intent_org_not_null — safe: prod table verified
 * empty). The runtime guard remains: every producer goes through
 * ActionIntentService.enqueue, which REJECTS an intent without a real
 * organizationId — an org-less intent would be invisible on /approvals and
 * undecidable forever, i.e. a silent 4-eyes bypass by omission.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const validInput = {
  organizationId: 'org-A',
  action: 'POST_JOURNAL_ENTRY',
  payload: { entry: 'x' },
  makerIdentity: 'booklets-automation-service',
  confidence: 0.87,
};

function mockPrisma() {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'intent-1',
    status: 'PENDING',
    ...data,
  }));
  vi.doMock('../../src/lib/prisma', () => ({
    prisma: { actionIntentQueue: { create } },
  }));
  return { create };
}

// ─── schema gate (four-eyes fix round, finding 4) ─────────────────────────────
//
// Prod data reality (verified 2026-07-04 on euqdfxekrxnoibeahogq):
// ActionIntentQueue has 0 rows, so the tenant invariant is promoted from
// app-layer-only to a DB-level NOT NULL — safe on an empty table, still
// add-only (no drop/rename). The runtime guard below stays as the friendly
// first line of defence.

describe('RAJ-513 fix round — ActionIntentQueue.organizationId is NOT NULL at the DB', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

  it('schema declares organizationId as required (String, not String?)', () => {
    const schema = read('../../prisma/schema.prisma');
    const model = schema.match(
      new RegExp('model\\s+ActionIntentQueue\\s*\\{([^}]+)\\}', 's')
    )![1];
    expect(model).toMatch(/organizationId\s+String(?!\?)/);
  });

  it('migration promotes the column with SET NOT NULL and stays add-only', () => {
    const migration = read(
      '../../prisma/migrations/20260704_action_intent_org_not_null/migration.sql'
    );
    expect(migration).toMatch(/ALTER COLUMN "organizationId" SET NOT NULL/);
    expect(migration).not.toMatch(/DROP|RENAME|DELETE/i);
  });
});

describe('RAJ-513 — ActionIntentService.enqueue organization guard', () => {
  beforeEach(() => vi.resetModules());

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('rejects enqueue when organizationId is %s — nothing is written', async (_label, orgId) => {
    const { create } = mockPrisma();
    const { ActionIntentService, MissingOrganizationError } = await import(
      '../../src/lib/action-intent.service'
    );

    await expect(
      ActionIntentService.enqueue({ ...validInput, organizationId: orgId as unknown as string })
    ).rejects.toThrow(MissingOrganizationError);
    expect(create).not.toHaveBeenCalled();
  });

  it('enqueues a valid intent with the organizationId persisted', async () => {
    const { create } = mockPrisma();
    const { ActionIntentService } = await import('../../src/lib/action-intent.service');

    const intent = await ActionIntentService.enqueue(validInput);

    expect(create).toHaveBeenCalledOnce();
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.organizationId).toBe('org-A');
    expect(data.action).toBe('POST_JOURNAL_ENTRY');
    expect(data.makerIdentity).toBe('booklets-automation-service');
    expect(intent.id).toBe('intent-1');
  });

  it('does not let the caller pre-set a decision (status/checker are not accepted)', async () => {
    const { create } = mockPrisma();
    const { ActionIntentService } = await import('../../src/lib/action-intent.service');

    await ActionIntentService.enqueue({
      ...validInput,
      // @ts-expect-error — status/checkerIdentity are intentionally not part of the input type
      status: 'APPROVED',
      checkerIdentity: 'attacker',
    });

    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.status).toBeUndefined(); // DB default PENDING applies
    expect(data.checkerIdentity).toBeUndefined();
  });
});
