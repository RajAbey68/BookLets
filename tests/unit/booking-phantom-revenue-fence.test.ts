/**
 * D4 [S10 phantom-fix] — Regression fence: manual bookings must never create
 * phantom revenue.
 *
 * The alleged defect (revenue recognized at booking time, or revenue with no
 * cash/liability counterpart) is ALREADY FIXED by RAJ-287 (merge e8df4a2,
 * feat/booking-ledger-posting): createBooking posts DR Operating Cash /
 * CR Guest Pre-payments at payment time via
 * RevenueService.recordBookingPrepayment, and revenue is only recognized
 * later (DR Guest Pre-payments / CR Rental Income at checkout, RevenueService
 * .recognizeRevenue). These tests pin that behaviour so it cannot regress:
 *
 *  1. createBooking with a funds-received status (CONFIRMED/COMPLETED) posts
 *     the pre-payment; PENDING/CANCELLED post nothing.
 *  2. A failed ledger post rolls the booking back — no booking may exist
 *     without its journal entry (the original "phantom" shape).
 *  3. The pre-payment touches ONLY Operating Cash (ASSET) and Guest
 *     Pre-payments (LIABILITY) — never Rental Income or any REVENUE account.
 *  4. Manual path and Hostaway-sync path carry the identical idempotency
 *     triple (source='booking', sourceId=<booking.id>, operation='prepayment')
 *     so LedgerService dedupes a same-day double-post across the two paths.
 *  5. A re-sync of a booking whose liability is already posted
 *     (deferredPosted=true) posts nothing — no double-count.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type AnyRecord = Record<string, unknown>;

// ─── shared fixtures ──────────────────────────────────────────────────────────

const ORG = 'org-1';
const USER = 'user-1';

const createdBooking = {
  id: 'bk-manual-1',
  propertyId: 'prop-1',
  channelId: 'ch-1',
  totalAmount: '1250.00',
  status: 'CONFIRMED',
  hostawayId: null,
  deferredPosted: false,
};

// ─── 1 + 2. createBooking action gates ────────────────────────────────────────

interface ActionSetup {
  recordFails?: boolean;
}

function setupAction(overrides: ActionSetup = {}) {
  const bookingCreate = vi.fn().mockResolvedValue(createdBooking);
  const bookingDelete = vi.fn().mockResolvedValue(createdBooking);
  const recordBookingPrepayment = overrides.recordFails
    ? vi.fn().mockRejectedValue(new Error('fiscal period closed'))
    : vi.fn().mockResolvedValue(undefined);

  vi.doMock('../../src/lib/prisma', () => ({
    prisma: {
      property: { findFirst: vi.fn().mockResolvedValue({ id: 'prop-1' }) },
      channel: { findUnique: vi.fn().mockResolvedValue({ id: 'ch-1' }) },
      booking: { create: bookingCreate, delete: bookingDelete },
    },
  }));
  vi.doMock('../../src/lib/auth-context', () => ({
    resolveActiveContext: vi.fn().mockResolvedValue({
      ok: true,
      context: { organizationId: ORG, organizationName: 'Org One', userId: USER, role: 'OWNER' },
    }),
  }));
  vi.doMock('../../src/lib/revenue.service', () => ({
    RevenueService: { recordBookingPrepayment },
  }));
  vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));

  return { bookingCreate, bookingDelete, recordBookingPrepayment };
}

const validInput = {
  propertyId: 'prop-1',
  channelId: 'ch-1',
  checkIn: '2026-08-01',
  checkOut: '2026-08-05',
  totalAmount: '1250.00',
  status: 'CONFIRMED',
};

describe('D4 fence — createBooking posts the pre-payment at payment time', () => {
  beforeEach(() => vi.resetModules());

  it.each(['CONFIRMED', 'COMPLETED'])(
    'a manual %s booking (funds received) posts its guest pre-payment immediately',
    async (status) => {
      const { recordBookingPrepayment } = setupAction();
      const { createBooking } = await import('../../src/app/actions/bookings.actions');

      const result = await createBooking({ ...validInput, status });

      expect(result).toEqual({ success: true });
      expect(recordBookingPrepayment).toHaveBeenCalledExactlyOnceWith(ORG, createdBooking.id, USER);
    },
  );

  it('a PENDING booking (no funds received) posts NOTHING to the ledger', async () => {
    const { recordBookingPrepayment } = setupAction();
    const { createBooking } = await import('../../src/app/actions/bookings.actions');

    const result = await createBooking({ ...validInput, status: 'PENDING' });

    expect(result).toEqual({ success: true });
    expect(recordBookingPrepayment).not.toHaveBeenCalled();
  });

  it('rolls the booking back when the ledger post fails — a booking may never exist without its journal entry', async () => {
    const { bookingDelete, recordBookingPrepayment } = setupAction({ recordFails: true });
    const { createBooking } = await import('../../src/app/actions/bookings.actions');

    const result = await createBooking(validInput);

    expect(recordBookingPrepayment).toHaveBeenCalledOnce();
    expect(result.success).toBe(false);
    expect(bookingDelete).toHaveBeenCalledExactlyOnceWith({ where: { id: createdBooking.id } });
  });
});

// ─── 3. the pre-payment never touches a revenue account ───────────────────────

function setupRevenueService(bookingOverride: AnyRecord = {}) {
  // Earlier describes doMock revenue.service / auth-context / next/cache;
  // doMock registrations survive vi.resetModules(), so lift them explicitly —
  // these tests exercise the REAL RevenueService.
  vi.doUnmock('../../src/lib/revenue.service');
  vi.doUnmock('../../src/lib/auth-context');
  vi.doUnmock('next/cache');

  const requestedAccounts: Array<{ name: string; type: string }> = [];
  const postEntry = vi.fn().mockResolvedValue({ id: 'je-1' });

  const accountFor = (name: string) =>
    name === 'Operating Cash'
      ? { id: 'acc-cash', name, type: 'ASSET' }
      : name === 'Guest Pre-payments'
        ? { id: 'acc-deferred', name, type: 'LIABILITY' }
        : { id: `acc-${name}`, name, type: 'REVENUE' };

  const booking = {
    ...createdBooking,
    property: { id: 'prop-1', name: 'Villa One', organizationId: ORG },
    ...bookingOverride,
  };

  vi.doMock('../../src/lib/prisma', () => ({
    prisma: {
      booking: {
        findUnique: vi.fn().mockResolvedValue(booking),
        update: vi.fn().mockResolvedValue({}),
        upsert: vi.fn().mockResolvedValue(booking),
        findMany: vi.fn().mockResolvedValue([]),
      },
      account: {
        // getOrCreateAccount goes through findFirst({ where: { organizationId, name } })
        findFirst: vi.fn().mockImplementation(({ where }: { where: { name: string } }) => {
          return Promise.resolve(accountFor(where.name));
        }),
        create: vi.fn().mockImplementation(({ data }: { data: { name: string; type: string } }) => {
          requestedAccounts.push({ name: data.name, type: data.type });
          return Promise.resolve({ id: `acc-${data.name}`, ...data });
        }),
      },
      property: { findUnique: vi.fn().mockResolvedValue(booking.property) },
      channel: { findFirst: vi.fn().mockResolvedValue({ id: 'ch-1', name: 'Direct' }) },
    },
  }));
  vi.doMock('../../src/lib/ledger.service', () => ({ LedgerService: { postEntry } }));
  vi.doMock('../../src/lib/hostaway.service', () => ({ HostawayService: {} }));

  return { postEntry, requestedAccounts, booking };
}

describe('D4 fence — no revenue is recognized at booking/payment time', () => {
  beforeEach(() => vi.resetModules());

  it('recordBookingPrepayment posts DR Cash / CR Guest Pre-payments as POSTED — and touches NO revenue account', async () => {
    const { postEntry } = setupRevenueService();
    const { RevenueService } = await import('../../src/lib/revenue.service');
    const { JournalStatus } = await import('../../src/lib/types');

    await RevenueService.recordBookingPrepayment(ORG, createdBooking.id, USER);

    expect(postEntry).toHaveBeenCalledOnce();
    const arg = postEntry.mock.calls[0][0];

    // Exactly two lines: DR asset(cash), CR liability(deferred). Balanced.
    expect(arg.lines).toHaveLength(2);
    const debit = arg.lines.find((l: { isDebit: boolean }) => l.isDebit);
    const credit = arg.lines.find((l: { isDebit: boolean }) => !l.isDebit);
    expect(debit.accountId).toBe('acc-cash');
    expect(credit.accountId).toBe('acc-deferred');
    expect(debit.amount.toString()).toBe(credit.amount.toString());
    expect(debit.amount.toString()).toBe('1250');

    // No line may reference any account other than cash/deferred — in
    // particular not Rental Income. Regressing this reintroduces D4.
    const accountIds = arg.lines.map((l: { accountId: string }) => l.accountId);
    expect(accountIds).not.toContain('acc-Rental Income');

    // Posted (funds movement is a fact, not an estimate) — the maker/checker
    // DRAFT gate applies to revenue RECOGNITION, which happens later.
    expect(arg.status).toBe(JournalStatus.POSTED);
  });
});

// ─── 4. idempotency parity between manual path and Hostaway-sync path ─────────

describe('D4 fence — manual and sync paths share one idempotency identity (no double-post)', () => {
  beforeEach(() => vi.resetModules());

  async function captureTriple(invoke: (svc: AnyRecord, booking: AnyRecord) => Promise<void>) {
    const { postEntry, booking } = setupRevenueService();
    const mod = await import('../../src/lib/revenue.service');
    await invoke(mod.RevenueService as unknown as AnyRecord, booking);
    expect(postEntry).toHaveBeenCalledOnce();
    const { source, sourceId, operation } = postEntry.mock.calls[0][0];
    return { source, sourceId, operation };
  }

  it('recordBookingPrepayment (manual) and postInitialDeferredEntry (sync) post the identical source/sourceId/operation triple', async () => {
    const manual = await captureTriple(async (svc) => {
      await (svc as { recordBookingPrepayment: (o: string, b: string, m: string) => Promise<void> })
        .recordBookingPrepayment(ORG, createdBooking.id, USER);
    });

    vi.resetModules();

    const sync = await captureTriple(async (svc, booking) => {
      // private in TS only — the fence intentionally reaches in so a rename or
      // provenance drift on the sync path fails loudly here.
      await (svc as { postInitialDeferredEntry: (o: string, b: AnyRecord, m: string) => Promise<void> })
        .postInitialDeferredEntry(ORG, booking, 'hostaway-sync');
    });

    expect(manual).toEqual({ source: 'booking', sourceId: createdBooking.id, operation: 'prepayment' });
    expect(sync).toEqual(manual);
  });

  it('the shared triple hashes to the same idempotency key for the same org and day — LedgerService dedupes the second post', async () => {
    vi.doUnmock('../../src/lib/ledger.service'); // use the REAL key derivation
    vi.doMock('../../src/lib/prisma', () => ({ prisma: {} }));
    const { LedgerService } = await import('../../src/lib/ledger.service');

    const day = new Date('2026-07-12T09:00:00Z');
    const laterSameDay = new Date('2026-07-12T21:30:00Z');

    const manualKey = LedgerService.computeIdempotencyKey('booking', createdBooking.id, day, {
      organizationId: ORG,
      operation: 'prepayment',
    });
    const syncKey = LedgerService.computeIdempotencyKey('booking', createdBooking.id, laterSameDay, {
      organizationId: ORG,
      operation: 'prepayment',
    });

    expect(syncKey).toBe(manualKey);
  });
});

// ─── 5. re-sync of an already-posted booking posts nothing ────────────────────

describe('D4 fence — Hostaway re-sync of an already-posted booking does not double-post', () => {
  beforeEach(() => vi.resetModules());

  it('syncAndProcess skips the deferred post when booking.deferredPosted is already true', async () => {
    const { postEntry } = setupRevenueService({ deferredPosted: true, hostawayId: '42' });
    // Override HostawayService with one reservation that maps onto the booking.
    vi.doMock('../../src/lib/hostaway.service', () => ({
      HostawayService: {
        fetchReservations: vi.fn().mockResolvedValue([
          {
            id: 42,
            listingId: 7,
            channelName: 'Airbnb',
            status: 'confirmed',
            totalPrice: '1250.00',
            checkInDate: '2026-08-01',
            checkOutDate: '2026-08-05',
          },
        ]),
        findPropertyByHostawayId: vi
          .fn()
          .mockResolvedValue({ id: 'prop-1', organizationId: ORG }),
      },
    }));
    const { RevenueService } = await import('../../src/lib/revenue.service');

    // The upsert mock returns status CONFIRMED with deferredPosted=true —
    // i.e. the liability is already on the books (posted manually or by a
    // previous sync). The re-sync must not post a second entry.
    const report = await RevenueService.syncAndProcess(ORG, 'hostaway-sync');

    expect(report.bookingsProcessed).toBe(1);
    expect(report.failures).toEqual([]);
    expect(postEntry).not.toHaveBeenCalled();
  });
});
