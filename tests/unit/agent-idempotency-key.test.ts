/**
 * RAJ-513 [Sprint 0] — Agent-safe idempotency key.
 *
 * The derived ledger key (RAJ-284) folds in the UTC calendar day, so an
 * agent retry that crosses midnight computes a DIFFERENT key and
 * double-posts. Per the external review spec, agent-originated postings use
 * a caller-supplied deterministic key with NO date component:
 *
 *   sha256("agent:{agentName}:{taskId}:{accountId}:{amountMinorUnits}:{bookingReference}")
 *
 * postEntry already honours an explicit `idempotencyKey` (fast path + P2002
 * race recovery) — this adds the deterministic helper and proves, end to
 * end against a simulated store, that:
 *   - the same explicit key twice returns ONE posting both times, even when
 *     the retry lands on the other side of midnight;
 *   - different keys create two postings;
 *   - the derived-key default for human/UI paths is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { Decimal } from 'decimal.js';

const agentParams = {
  agentName: 'receipt-bot',
  taskId: 'task-77',
  accountId: 'acc-1',
  amountMinorUnits: 12345,
  bookingReference: 'BK-2026-042',
};

// ─── 1. pure key computation ──────────────────────────────────────────────────

describe('LedgerService.computeAgentIdempotencyKey', () => {
  beforeEach(() => vi.resetModules());

  const load = async () => {
    vi.doMock('../../src/lib/prisma', () => ({ prisma: {} }));
    return (await import('../../src/lib/ledger.service')).LedgerService;
  };

  it('matches the external review spec byte-for-byte', async () => {
    const LedgerService = await load();
    const expected = createHash('sha256')
      .update('agent:receipt-bot:task-77:acc-1:12345:BK-2026-042')
      .digest('hex');
    expect(LedgerService.computeAgentIdempotencyKey(agentParams)).toBe(expected);
  });

  it('is deterministic and a 64-char hex sha256 digest', async () => {
    const LedgerService = await load();
    const key = LedgerService.computeAgentIdempotencyKey(agentParams);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(LedgerService.computeAgentIdempotencyKey({ ...agentParams })).toBe(key);
  });

  it('differs when any component differs', async () => {
    const LedgerService = await load();
    const base = LedgerService.computeAgentIdempotencyKey(agentParams);
    expect(LedgerService.computeAgentIdempotencyKey({ ...agentParams, agentName: 'other-bot' })).not.toBe(base);
    expect(LedgerService.computeAgentIdempotencyKey({ ...agentParams, taskId: 'task-78' })).not.toBe(base);
    expect(LedgerService.computeAgentIdempotencyKey({ ...agentParams, accountId: 'acc-2' })).not.toBe(base);
    expect(LedgerService.computeAgentIdempotencyKey({ ...agentParams, amountMinorUnits: 12346 })).not.toBe(base);
    expect(LedgerService.computeAgentIdempotencyKey({ ...agentParams, bookingReference: 'BK-2026-043' })).not.toBe(base);
  });
});

// ─── 2. postEntry with an explicit agent key (simulated store) ────────────────

describe('LedgerService.postEntry — explicit agent idempotency key', () => {
  beforeEach(() => vi.resetModules());

  const balancedLines = [
    { accountId: 'acc-1', amount: new Decimal('123.45'), isDebit: true },
    { accountId: 'acc-2', amount: new Decimal('123.45'), isDebit: false },
  ];

  /** In-memory JournalEntry store honouring the (org, idempotencyKey) unique. */
  async function loadWithStore() {
    const entries: Array<Record<string, unknown>> = [];
    const findFirst = vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      entries.find(
        (e) => e.organizationId === where.organizationId && e.idempotencyKey === where.idempotencyKey
      ) ?? null
    );
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const entry = { id: `je-${entries.length + 1}`, ...data, lines: [] };
      entries.push(entry);
      return entry;
    });
    vi.doMock('../../src/lib/prisma', () => ({
      prisma: {
        journalEntry: { findFirst },
        fiscalPeriod: {
          findFirst: vi.fn().mockResolvedValue({ id: 'fp1', name: 'FY26', isClosed: false, locked: false }),
        },
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
          cb({ journalEntry: { create } })
        ),
      },
    }));
    vi.doMock('../../src/lib/evidence-log.service', () => ({
      EvidenceLogService: { record: vi.fn() },
    }));
    const { LedgerService } = await import('../../src/lib/ledger.service');
    const { JournalStatus } = await import('../../src/lib/types');
    return { LedgerService, JournalStatus, create, entries };
  }

  it('same explicit key twice → a single posting, returned both times — even across midnight', async () => {
    const { LedgerService, JournalStatus, create } = await loadWithStore();
    const key = LedgerService.computeAgentIdempotencyKey(agentParams);

    const first = await LedgerService.postEntry({
      organizationId: 'org-A',
      date: new Date('2026-07-01T23:59:50Z'),
      status: JournalStatus.POSTED,
      idempotencyKey: key,
      lines: balancedLines,
    });
    // agent retry lands after midnight UTC — derived day-keys would differ here
    const second = await LedgerService.postEntry({
      organizationId: 'org-A',
      date: new Date('2026-07-02T00:00:10Z'),
      status: JournalStatus.POSTED,
      idempotencyKey: key,
      lines: balancedLines,
    });

    expect(create).toHaveBeenCalledOnce();
    expect(second.id).toBe(first.id);
  });

  it('different keys → two distinct postings', async () => {
    const { LedgerService, JournalStatus, create } = await loadWithStore();
    const keyA = LedgerService.computeAgentIdempotencyKey(agentParams);
    const keyB = LedgerService.computeAgentIdempotencyKey({ ...agentParams, taskId: 'task-78' });

    const a = await LedgerService.postEntry({
      organizationId: 'org-A',
      date: new Date('2026-07-01'),
      status: JournalStatus.POSTED,
      idempotencyKey: keyA,
      lines: balancedLines,
    });
    const b = await LedgerService.postEntry({
      organizationId: 'org-A',
      date: new Date('2026-07-01'),
      status: JournalStatus.POSTED,
      idempotencyKey: keyB,
      lines: balancedLines,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(a.id).not.toBe(b.id);
  });

  it('derived key default (human/UI path) is unchanged: source+sourceId still day-scoped', async () => {
    const { LedgerService } = await loadWithStore();
    // No behaviour change for existing callers — the day component remains.
    expect(
      LedgerService.computeIdempotencyKey('hostaway', 'res-42', new Date('2026-07-01'))
    ).not.toBe(LedgerService.computeIdempotencyKey('hostaway', 'res-42', new Date('2026-07-02')));
  });
});
