/**
 * RAJ-513 [Sprint 0] — Enqueue guard for the 4-eyes ActionIntentQueue.
 *
 * ActionIntentQueue.organizationId is nullable (retrofit onto an empty table,
 * 20260703_action_intent_org_scope) and MUST stay nullable (add-only rule).
 * The compensating control is a runtime guard: every producer goes through
 * ActionIntentService.enqueue, which REJECTS an intent without a real
 * organizationId — an org-less intent would be invisible on /approvals and
 * undecidable forever, i.e. a silent 4-eyes bypass by omission.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
