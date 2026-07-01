/**
 * RAJ-287 [P1-05] — Manual booking posts to the ledger immediately.
 *
 * Creating a booking must post DR Operating Cash / CR Guest Pre-payments right
 * away (no more "phantom" bookings waiting on a later sync). RevenueService
 * .recordBookingPrepayment is the reusable, idempotent entry point the
 * createBooking action calls.
 *
 * Idempotency (RAJ-284): the post carries source='booking', sourceId=<id>,
 * operation='prepayment', so a retry can't double-post; the deferredPosted
 * flag short-circuits an already-posted booking.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const booking = {
  id: 'bk-1',
  totalAmount: '1250.00',
  propertyId: 'prop-1',
  deferredPosted: false,
  property: { id: 'prop-1', name: 'Villa One', organizationId: 'org-1' },
};

function mockDeps(bookingOverride: Record<string, unknown> = {}) {
  const postEntry = vi.fn().mockResolvedValue({ id: 'je-1' });
  const bookingUpdate = vi.fn().mockResolvedValue({});
  const findUnique = vi.fn().mockResolvedValue({ ...booking, ...bookingOverride });
  // getOrCreateAccount: return existing Operating Cash, then Guest Pre-payments
  const accountFindFirst = vi
    .fn()
    .mockResolvedValueOnce({ id: 'cash', name: 'Operating Cash' })
    .mockResolvedValueOnce({ id: 'deferred', name: 'Guest Pre-payments' });

  vi.doMock('../../src/lib/prisma', () => ({
    prisma: {
      booking: { findUnique, update: bookingUpdate },
      account: { findFirst: accountFindFirst, create: vi.fn() },
      property: { findUnique: vi.fn().mockResolvedValue(booking.property) },
    },
  }));
  vi.doMock('../../src/lib/ledger.service', () => ({ LedgerService: { postEntry } }));
  // HostawayService is imported by revenue.service but unused on this path.
  vi.doMock('../../src/lib/hostaway.service', () => ({ HostawayService: {} }));

  return { postEntry, bookingUpdate, findUnique };
}

describe('RevenueService.recordBookingPrepayment', () => {
  beforeEach(() => vi.resetModules());

  it('posts a balanced DR Cash / CR Guest Pre-payments entry for the booking amount', async () => {
    const { postEntry, bookingUpdate } = mockDeps();
    const { RevenueService } = await import('../../src/lib/revenue.service');

    await RevenueService.recordBookingPrepayment('org-1', 'bk-1', 'user-1');

    expect(postEntry).toHaveBeenCalledOnce();
    const arg = postEntry.mock.calls[0][0];
    expect(arg.organizationId).toBe('org-1');
    expect(arg.makerIdentity).toBe('user-1');

    const debit = arg.lines.find((l: { isDebit: boolean }) => l.isDebit);
    const credit = arg.lines.find((l: { isDebit: boolean }) => !l.isDebit);
    expect(debit.accountId).toBe('cash');
    expect(credit.accountId).toBe('deferred');
    expect(debit.amount.toString()).toBe('1250');
    expect(credit.amount.toString()).toBe('1250');

    // marks the booking posted
    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'bk-1' }, data: { deferredPosted: true } })
    );
  });

  it('carries idempotency metadata so a retry cannot double-post (RAJ-284)', async () => {
    const { postEntry } = mockDeps();
    const { RevenueService } = await import('../../src/lib/revenue.service');

    await RevenueService.recordBookingPrepayment('org-1', 'bk-1', 'user-1');

    const arg = postEntry.mock.calls[0][0];
    expect(arg.source).toBe('booking');
    expect(arg.sourceId).toBe('bk-1');
    expect(arg.operation).toBe('prepayment');
  });

  it('is a no-op when the booking has already posted its pre-payment', async () => {
    const { postEntry, bookingUpdate } = mockDeps({ deferredPosted: true });
    const { RevenueService } = await import('../../src/lib/revenue.service');

    await RevenueService.recordBookingPrepayment('org-1', 'bk-1', 'user-1');

    expect(postEntry).not.toHaveBeenCalled();
    expect(bookingUpdate).not.toHaveBeenCalled();
  });

  it('refuses to post when the booking belongs to a different organisation (tenant isolation)', async () => {
    const { postEntry } = mockDeps({ property: { id: 'prop-1', name: 'Villa One', organizationId: 'org-OTHER' } });
    const { RevenueService } = await import('../../src/lib/revenue.service');

    await expect(
      RevenueService.recordBookingPrepayment('org-1', 'bk-1', 'user-1'),
    ).rejects.toThrow(/organi[sz]ation/i);
    expect(postEntry).not.toHaveBeenCalled();
  });

  it('throws when the booking does not exist', async () => {
    mockDeps();
    vi.doMock('../../src/lib/prisma', () => ({
      prisma: {
        booking: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
        account: { findFirst: vi.fn(), create: vi.fn() },
      },
    }));
    const { RevenueService } = await import('../../src/lib/revenue.service');
    await expect(RevenueService.recordBookingPrepayment('org-1', 'missing', 'user-1')).rejects.toThrow(/not found/i);
  });
});
