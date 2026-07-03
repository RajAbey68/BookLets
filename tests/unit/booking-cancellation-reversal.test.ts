/**
 * RAJ-455 (part 2) — cancellation reversal finds its entry structurally.
 *
 * handleBookingCancellation used to locate the deferred-liability entry via
 * `memo: { contains: booking.hostawayId }` — a fragile substring match that
 * SILENTLY no-oped when nothing matched (cancelled booking, liability never
 * reversed, books quietly wrong). It now uses the structured provenance
 * fields (source: 'booking', sourceId: booking.id) that
 * recordBookingPrepayment established as the contract, and logs a loud
 * console.error when no entry is found.
 *
 * That contract requires JournalEntry to actually persist source/sourceId
 * (previously they were only hashed into the idempotency key), and requires
 * postInitialDeferredEntry — which posts the entry this code later reverses —
 * to set them. Both are pinned here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const booking = {
  id: 'bk-1',
  hostawayId: '12345',
  propertyId: 'prop-1',
  totalAmount: '1250.00',
  status: 'CANCELLED',
  deferredPosted: true,
};

// ─── schema gate ────────────────────────────────────────────────────────────

describe('RAJ-455 — schema', () => {
  const schema = fs.readFileSync(
    path.resolve(__dirname, '../../prisma/schema.prisma'),
    'utf-8'
  );
  const je = schema.match(new RegExp('model\\s+JournalEntry\\s*\\{([^}]+)\\}', 's'))![1];

  it('JournalEntry persists structured provenance: source and sourceId', () => {
    expect(je).toMatch(/source\s+String\?/);
    expect(je).toMatch(/sourceId\s+String\?/);
  });
});

// ─── handleBookingCancellation (mocked deps) ─────────────────────────────────

function mockCancellationDeps(entryFindFirstResult: unknown) {
  const entryFindFirst = vi.fn().mockResolvedValue(entryFindFirstResult);
  const bookingUpdate = vi.fn().mockResolvedValue({});
  vi.doMock('../../src/lib/prisma', () => ({
    prisma: {
      journalEntry: { findFirst: entryFindFirst },
      booking: { update: bookingUpdate },
    },
  }));
  const reverseEntry = vi.fn().mockResolvedValue({ id: 'je-rev' });
  vi.doMock('../../src/lib/ledger.service', () => ({ LedgerService: { reverseEntry } }));
  vi.doMock('../../src/lib/hostaway.service', () => ({ HostawayService: {} }));
  return { entryFindFirst, bookingUpdate, reverseEntry };
}

describe('RevenueService.handleBookingCancellation (RAJ-455)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('looks the entry up by structured source/sourceId scoped to the org — not by memo substring', async () => {
    const { entryFindFirst } = mockCancellationDeps({ id: 'je-1' });
    const { RevenueService } = await import('../../src/lib/revenue.service');

    await RevenueService['handleBookingCancellation']('org-1', booking as never, 'user-1');

    expect(entryFindFirst).toHaveBeenCalledOnce();
    const where = entryFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      organizationId: 'org-1',
      source: 'booking',
      sourceId: 'bk-1',
    });
    expect(where.memo).toBeUndefined();
  });

  it('reverses the found entry (org-scoped) and clears deferredPosted', async () => {
    const { reverseEntry, bookingUpdate } = mockCancellationDeps({ id: 'je-1' });
    const { RevenueService } = await import('../../src/lib/revenue.service');

    await RevenueService['handleBookingCancellation']('org-1', booking as never, 'user-1');

    expect(reverseEntry).toHaveBeenCalledWith('org-1', 'je-1', 'Booking Cancellation', 'user-1');
    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bk-1' },
        data: { deferredPosted: false },
      })
    );
  });

  it('logs a loud console.error and does NOT reverse when no entry is found', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { reverseEntry, bookingUpdate } = mockCancellationDeps(null);
    const { RevenueService } = await import('../../src/lib/revenue.service');

    await expect(
      RevenueService['handleBookingCancellation']('org-1', booking as never, 'user-1')
    ).resolves.toBeUndefined();

    expect(reverseEntry).not.toHaveBeenCalled();
    expect(bookingUpdate).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('bk-1'); // greppable: names the booking it failed on
  });
});

// ─── provenance persistence contract ─────────────────────────────────────────

describe('source/sourceId persistence (RAJ-455 contract)', () => {
  beforeEach(() => vi.resetModules());

  it('LedgerService.postEntry persists source and sourceId onto the created entry', async () => {
    // earlier tests in this file doMock ledger.service; here we need the real one
    vi.doUnmock('../../src/lib/ledger.service');
    const create = vi
      .fn()
      .mockImplementation(({ data }: { data: object }) =>
        Promise.resolve({ id: 'je-1', ...data, lines: [] })
      );
    const tx = { journalEntry: { create } };
    vi.doMock('../../src/lib/prisma', () => ({
      prisma: {
        journalEntry: { findFirst: vi.fn().mockResolvedValue(null) },
        fiscalPeriod: {
          findFirst: vi.fn().mockResolvedValue({ name: 'FY26', isClosed: false }),
        },
        $transaction: vi.fn().mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx)),
      },
    }));
    vi.doMock('../../src/lib/evidence-log.service', () => ({
      EvidenceLogService: { record: vi.fn().mockResolvedValue({}) },
    }));
    const { LedgerService } = await import('../../src/lib/ledger.service');
    const { JournalStatus } = await import('../../src/lib/types');
    const { Decimal } = await import('decimal.js');

    await LedgerService.postEntry({
      organizationId: 'org-1',
      date: new Date('2026-07-03T00:00:00Z'),
      memo: 'test',
      status: JournalStatus.POSTED,
      source: 'booking',
      sourceId: 'bk-1',
      operation: 'prepayment',
      lines: [
        { accountId: 'a', amount: new Decimal('10'), isDebit: true },
        { accountId: 'b', amount: new Decimal('10'), isDebit: false },
      ],
    });

    expect(create).toHaveBeenCalledOnce();
    const data = create.mock.calls[0][0].data;
    expect(data.source).toBe('booking');
    expect(data.sourceId).toBe('bk-1');
  });

  it('postInitialDeferredEntry posts with the source/sourceId contract so cancellation can find it', async () => {
    const postEntry = vi.fn().mockResolvedValue({ id: 'je-1' });
    vi.doMock('../../src/lib/ledger.service', () => ({ LedgerService: { postEntry } }));
    vi.doMock('../../src/lib/hostaway.service', () => ({ HostawayService: {} }));
    vi.doMock('../../src/lib/prisma', () => ({
      prisma: {
        account: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({ id: 'cash', name: 'Operating Cash' })
            .mockResolvedValueOnce({ id: 'deferred', name: 'Guest Pre-payments' }),
          create: vi.fn(),
        },
        property: { findUnique: vi.fn().mockResolvedValue({ id: 'prop-1', name: 'Villa One' }) },
        booking: { update: vi.fn().mockResolvedValue({}) },
      },
    }));
    const { RevenueService } = await import('../../src/lib/revenue.service');

    await RevenueService['postInitialDeferredEntry'](
      'org-1',
      { ...booking, status: 'CONFIRMED', deferredPosted: false } as never,
      'user-1'
    );

    expect(postEntry).toHaveBeenCalledOnce();
    const arg = postEntry.mock.calls[0][0];
    expect(arg.source).toBe('booking');
    expect(arg.sourceId).toBe('bk-1');
  });
});
