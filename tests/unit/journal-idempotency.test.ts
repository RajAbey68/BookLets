/**
 * RAJ-284 [P1-02] — Idempotency key on JournalEntry.
 *
 * A duplicate POST — from crash-recovery, a retried webhook, or a
 * double-clicked form — must NOT create a second ledger entry. The
 * idempotencyKey = hash(source + sourceId + date) is UNIQUE at the DB level;
 * the service returns the already-posted entry instead of throwing.
 *
 * Three layers tested:
 *   1. schema — idempotencyKey String? @unique
 *   2. computeIdempotencyKey — pure, deterministic, collision-resistant
 *   3. postEntry — fast-path dedupe + P2002 race handling (mocked Prisma)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Decimal } from 'decimal.js';

// ─── 1. schema gate ───────────────────────────────────────────────────────────

describe('RAJ-284 — schema', () => {
  const schema = fs.readFileSync(
    path.resolve(__dirname, '../../prisma/schema.prisma'),
    'utf-8'
  );
  const je = schema.match(new RegExp('model\\s+JournalEntry\\s*\\{([^}]+)\\}', 's'))![1];

  it('JournalEntry has a nullable, unique idempotencyKey', () => {
    expect(je).toMatch(/idempotencyKey\s+String\?\s+@unique/);
  });
});

// ─── 2. pure key computation ───────────────────────────────────────────────────

describe('LedgerService.computeIdempotencyKey', () => {
  // Mock the prisma singleton so importing the service does not require a
  // generated client / DATABASE_URL.
  beforeEach(() => vi.resetModules());

  it('is deterministic for identical inputs', async () => {
    vi.doMock('../../src/lib/prisma', () => ({ prisma: {} }));
    const { LedgerService } = await import('../../src/lib/ledger.service');
    const d = new Date('2026-07-01T10:00:00Z');
    expect(LedgerService.computeIdempotencyKey('hostaway', 'res-42', d)).toBe(
      LedgerService.computeIdempotencyKey('hostaway', 'res-42', d)
    );
  });

  it('returns a 64-char hex sha256 digest', async () => {
    vi.doMock('../../src/lib/prisma', () => ({ prisma: {} }));
    const { LedgerService } = await import('../../src/lib/ledger.service');
    const key = LedgerService.computeIdempotencyKey('hostaway', 'res-42', new Date('2026-07-01'));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when source, sourceId, or day differ', async () => {
    vi.doMock('../../src/lib/prisma', () => ({ prisma: {} }));
    const { LedgerService } = await import('../../src/lib/ledger.service');
    const d = new Date('2026-07-01');
    const base = LedgerService.computeIdempotencyKey('hostaway', 'res-42', d);
    expect(LedgerService.computeIdempotencyKey('manual', 'res-42', d)).not.toBe(base);
    expect(LedgerService.computeIdempotencyKey('hostaway', 'res-43', d)).not.toBe(base);
    expect(LedgerService.computeIdempotencyKey('hostaway', 'res-42', new Date('2026-07-02'))).not.toBe(base);
  });

  it('is unambiguous across field boundaries (no "a"+"bc" == "ab"+"c" collision)', async () => {
    vi.doMock('../../src/lib/prisma', () => ({ prisma: {} }));
    const { LedgerService } = await import('../../src/lib/ledger.service');
    const d = new Date('2026-07-01');
    expect(LedgerService.computeIdempotencyKey('a', 'bc', d)).not.toBe(
      LedgerService.computeIdempotencyKey('ab', 'c', d)
    );
  });

  it('normalizes to the calendar day (time-of-day jitter on retry is ignored)', async () => {
    vi.doMock('../../src/lib/prisma', () => ({ prisma: {} }));
    const { LedgerService } = await import('../../src/lib/ledger.service');
    expect(
      LedgerService.computeIdempotencyKey('hostaway', 'res-42', new Date('2026-07-01T09:00:00Z'))
    ).toBe(
      LedgerService.computeIdempotencyKey('hostaway', 'res-42', new Date('2026-07-01T23:30:00Z'))
    );
  });

  // Post-review hardening (independent review, DeepSeek b29386ba):
  it('is scoped by organization — same source/sourceId/day across orgs never collide', async () => {
    vi.doMock('../../src/lib/prisma', () => ({ prisma: {} }));
    const { LedgerService } = await import('../../src/lib/ledger.service');
    const d = new Date('2026-07-01');
    expect(
      LedgerService.computeIdempotencyKey('hostaway', 'res-42', d, { organizationId: 'org-a' })
    ).not.toBe(
      LedgerService.computeIdempotencyKey('hostaway', 'res-42', d, { organizationId: 'org-b' })
    );
  });

  it('distinguishes different operations on the same source entity + day', async () => {
    vi.doMock('../../src/lib/prisma', () => ({ prisma: {} }));
    const { LedgerService } = await import('../../src/lib/ledger.service');
    const d = new Date('2026-07-01');
    expect(
      LedgerService.computeIdempotencyKey('hostaway', 'res-42', d, { operation: 'REVENUE' })
    ).not.toBe(
      LedgerService.computeIdempotencyKey('hostaway', 'res-42', d, { operation: 'FEE' })
    );
  });

  it('stays backward-compatible: the 3-arg form is unchanged and deterministic', async () => {
    vi.doMock('../../src/lib/prisma', () => ({ prisma: {} }));
    const { LedgerService } = await import('../../src/lib/ledger.service');
    const d = new Date('2026-07-01');
    // omitting opts must equal passing empty opts — no silent drift for callers
    // that have not adopted org/operation scoping yet
    expect(LedgerService.computeIdempotencyKey('hostaway', 'res-42', d)).toBe(
      LedgerService.computeIdempotencyKey('hostaway', 'res-42', d, {})
    );
  });
});

// ─── 3. postEntry idempotent behaviour (mocked Prisma) ─────────────────────────

describe('LedgerService.postEntry — idempotency', () => {
  const openPeriod = { id: 'fp1', name: '2026', isClosed: false };
  const existingEntry = { id: 'existing-1', lines: [] };

  const balancedLines = [
    { accountId: 'a', amount: new Decimal('100.00'), isDebit: true },
    { accountId: 'b', amount: new Decimal('100.00'), isDebit: false },
  ];

  beforeEach(() => vi.resetModules());

  it('returns the existing entry without posting when the key already exists (fast path)', async () => {
    const findUnique = vi.fn().mockResolvedValue(existingEntry);
    const $transaction = vi.fn();
    vi.doMock('../../src/lib/prisma', () => ({
      prisma: {
        journalEntry: { findUnique, create: vi.fn() },
        fiscalPeriod: { findFirst: vi.fn().mockResolvedValue(openPeriod) },
        $transaction,
      },
    }));
    vi.doMock('../../src/lib/evidence-log.service', () => ({ EvidenceLogService: { record: vi.fn() } }));
    const { LedgerService } = await import('../../src/lib/ledger.service');
    const { JournalStatus } = await import('../../src/lib/types');

    const result = await LedgerService.postEntry({
      organizationId: 'org1',
      date: new Date('2026-07-01'),
      status: JournalStatus.POSTED,
      lines: balancedLines,
      source: 'hostaway',
      sourceId: 'res-42',
    });

    expect(result).toBe(existingEntry);
    expect($transaction).not.toHaveBeenCalled();
  });

  it('recovers by returning the winning entry when a concurrent POST hits the unique constraint (P2002)', async () => {
    const { Prisma } = await import('@prisma/client');
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['idempotencyKey'] },
    });
    // First lookup: no existing entry → proceed to transaction, which loses the
    // race and throws P2002. Second lookup: the winner is now visible.
    const findUnique = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingEntry);
    const $transaction = vi.fn().mockRejectedValue(p2002);
    vi.doMock('../../src/lib/prisma', () => ({
      prisma: {
        journalEntry: { findUnique, create: vi.fn() },
        fiscalPeriod: { findFirst: vi.fn().mockResolvedValue(openPeriod) },
        $transaction,
      },
    }));
    vi.doMock('../../src/lib/evidence-log.service', () => ({ EvidenceLogService: { record: vi.fn() } }));
    const { LedgerService } = await import('../../src/lib/ledger.service');
    const { JournalStatus } = await import('../../src/lib/types');

    const result = await LedgerService.postEntry({
      organizationId: 'org1',
      date: new Date('2026-07-01'),
      status: JournalStatus.POSTED,
      lines: balancedLines,
      source: 'hostaway',
      sourceId: 'res-42',
    });

    expect(result).toBe(existingEntry);
    expect($transaction).toHaveBeenCalledOnce();
  });

  it('rethrows a non-idempotency error unchanged', async () => {
    const boom = new Error('database on fire');
    const findUnique = vi.fn().mockResolvedValue(null);
    const $transaction = vi.fn().mockRejectedValue(boom);
    vi.doMock('../../src/lib/prisma', () => ({
      prisma: {
        journalEntry: { findUnique, create: vi.fn() },
        fiscalPeriod: { findFirst: vi.fn().mockResolvedValue(openPeriod) },
        $transaction,
      },
    }));
    vi.doMock('../../src/lib/evidence-log.service', () => ({ EvidenceLogService: { record: vi.fn() } }));
    const { LedgerService } = await import('../../src/lib/ledger.service');
    const { JournalStatus } = await import('../../src/lib/types');

    await expect(
      LedgerService.postEntry({
        organizationId: 'org1',
        date: new Date('2026-07-01'),
        status: JournalStatus.POSTED,
        lines: balancedLines,
        source: 'hostaway',
        sourceId: 'res-42',
      })
    ).rejects.toThrow(/database on fire/);
  });
});
