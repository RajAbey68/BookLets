import { prisma } from './prisma';
import { HostawayService, HostawayReservation } from './hostaway.service';
import { LedgerService } from './ledger.service';
import { JournalStatus } from './types';
import { Decimal } from 'decimal.js';
import type { Booking, Property } from '@prisma/client';

type BookingWithProperty = Booking & { property: Property };

export type SyncStage = 'sync' | 'recognition';

export interface SyncFailure {
  stage: SyncStage;
  bookingRef: string;
  reason: string;
}

export interface SyncReport {
  reservationsFetched: number;
  bookingsProcessed: number;
  bookingsRecognized: number;
  failures: SyncFailure[];
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Revenue Service
 * 
 * Implements the financial logic for revenue recognition:
 * 1. Revenue is recognized ONLY after guest check-out.
 * 2. Before check-out, bookings are treated as Pre-payments (Liabilities).
 */
export class RevenueService {

  /**
   * Syncs data from Hostaway and manages the financial lifecycle of bookings.
   * Returns a report describing how many records were processed and which failed.
   * Per-record errors are collected so a single bad booking does not abort the run.
   */
  static async syncAndProcess(organizationId: string, makerIdentity: string): Promise<SyncReport> {
    console.log(`[RevenueService] Starting sync for Organization: ${organizationId} (maker: ${makerIdentity})`);

    const report: SyncReport = {
      reservationsFetched: 0,
      bookingsProcessed: 0,
      bookingsRecognized: 0,
      failures: [],
    };

    // 1. Fetch from Hostaway (fatal if this throws — the whole run is unusable)
    const reservations = await HostawayService.fetchReservations();
    report.reservationsFetched = reservations.length;

    for (const res of reservations) {
      try {
        await this.processReservationSync(organizationId, res, makerIdentity);
        report.bookingsProcessed += 1;
      } catch (err) {
        report.failures.push({
          stage: 'sync',
          bookingRef: res.id.toString(),
          reason: describeError(err),
        });
        console.error(`[RevenueService] Sync failed for reservation ${res.id}:`, describeError(err));
      }
    }

    // 2. Process recognition for all bookings that have checked out
    await this.recognizeRevenue(organizationId, makerIdentity, report);

    return report;
  }

  /**
   * Upserts a reservation into the local database.
   */
  private static async processReservationSync(organizationId: string, res: HostawayReservation, makerIdentity: string) {
    const property = await HostawayService.findPropertyByHostawayId(res.listingId);
    if (!property) {
      console.warn(`[RevenueService] No property found for Hostaway Listing ID: ${res.listingId}. Skipping.`);
      return;
    }

    const channel = await this.resolveChannel(res.channelName);

    // Upsert Booking
    const booking = await prisma.booking.upsert({
      where: { hostawayId: res.id.toString() },
      update: {
        status: res.status.toUpperCase(),
        totalAmount: res.totalPrice,
        checkIn: new Date(res.checkInDate),
        checkOut: new Date(res.checkOutDate),
        hostawayStatus: res.status
      },
      create: {
        hostawayId: res.id.toString(),
        propertyId: property.id,
        channelId: channel.id,
        totalAmount: res.totalPrice,
        checkIn: new Date(res.checkInDate),
        checkOut: new Date(res.checkOutDate),
        status: "CONFIRMED",
        hostawayStatus: res.status,
        deferredPosted: false
      }
    });

    // 2. If CONFIRMED and deferred not yet posted, record the Initial Liability
    if (booking.status === 'CONFIRMED' && !booking.deferredPosted) {
      await this.postInitialDeferredEntry(organizationId, booking, makerIdentity);
    }

    // 3. If CANCELLED and deferred WAS posted, we need to reverse the liability
    if (booking.status === 'CANCELLED' && booking.deferredPosted) {
      await this.handleBookingCancellation(organizationId, booking, makerIdentity);
    }
  }

  /**
   * Reverses the initial pre-payment for cancelled bookings.
   */
  private static async handleBookingCancellation(organizationId: string, booking: Booking, makerIdentity: string) {
    console.log(`[RevenueService] Reversing deferred entry for Cancelled Booking ${booking.id}`);

    // RAJ-455: find the deferred-liability entry via the structured
    // source/sourceId provenance (the contract recordBookingPrepayment and
    // postInitialDeferredEntry write), tenant-scoped. The old
    // memo: { contains: hostawayId } substring match silently no-oped when
    // the memo drifted — leaving the liability on the books.
    const entry = await prisma.journalEntry.findFirst({
      where: {
        organizationId,
        source: 'booking',
        sourceId: booking.id,
        status: 'POSTED',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!entry) {
      console.error(
        `[RevenueService] CANCELLATION REVERSAL MISSED: no POSTED journal entry found for ` +
          `booking ${booking.id} (source='booking', sourceId='${booking.id}', org='${organizationId}'). ` +
          `The deferred liability was NOT reversed — investigate and reverse manually.`,
      );
      return;
    }

    await LedgerService.reverseEntry(organizationId, entry.id, 'Booking Cancellation', makerIdentity);
    await prisma.booking.update({
      where: { id: booking.id },
      data: { deferredPosted: false },
    });
  }

  /**
   * RAJ-287 — Post a manually-created booking's guest pre-payment to the ledger
   * immediately: DR Operating Cash / CR Guest Pre-payments.
   *
   * Public, reusable entry point the createBooking action calls so a manual
   * booking never becomes "phantom" revenue waiting on a later Hostaway sync.
   * Idempotent: the post carries source/sourceId/operation (RAJ-284) so a
   * retry cannot double-post, and an already-posted booking short-circuits.
   */
  static async recordBookingPrepayment(
    organizationId: string,
    bookingId: string,
    makerIdentity: string,
  ): Promise<void> {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { property: true },
    });
    if (!booking) {
      throw new Error(`Booking ${bookingId} not found.`);
    }
    // Tenant isolation: never post an entry for a booking that belongs to a
    // different organisation than the one the caller resolved.
    if (booking.property.organizationId !== organizationId) {
      throw new Error(`Booking ${bookingId} does not belong to this organisation.`);
    }
    if (booking.deferredPosted) {
      return; // already posted — nothing to do
    }

    const cashAccount = await this.getOrCreateAccount(organizationId, 'Operating Cash', 'ASSET');
    const deferredAccount = await this.getOrCreateAccount(organizationId, 'Guest Pre-payments', 'LIABILITY');

    const memo = `Booking pre-payment: ${booking.property?.name ?? booking.propertyId} (${bookingId.slice(0, 8)})`;

    await LedgerService.postEntry({
      organizationId,
      date: new Date(),
      memo,
      status: JournalStatus.POSTED,
      makerIdentity,
      // RAJ-284 idempotency — stable per booking + operation.
      source: 'booking',
      sourceId: bookingId,
      operation: 'prepayment',
      lines: [
        { accountId: cashAccount.id, amount: new Decimal(booking.totalAmount), isDebit: true }, // DR Cash
        { accountId: deferredAccount.id, amount: new Decimal(booking.totalAmount), isDebit: false }, // CR Liability
      ],
    });

    await prisma.booking.update({
      where: { id: bookingId },
      data: { deferredPosted: true },
    });
  }

  /**
   * Posts the initial entry when guest payment is received/confirmed.
   * DR Cash (Asset) / CR Guest Pre-payments (Liability)
   */
  private static async postInitialDeferredEntry(organizationId: string, booking: Booking, makerIdentity: string) {
    const cashAccount = await this.getOrCreateAccount(organizationId, "Operating Cash", "ASSET");
    const deferredAccount = await this.getOrCreateAccount(organizationId, "Guest Pre-payments", "LIABILITY");

    const property = await prisma.property.findUnique({ where: { id: booking.propertyId } });
    const memo = `Initial Booking Funds: #${booking.hostawayId} at ${property?.name ?? booking.propertyId}`;

    await LedgerService.postEntry({
      organizationId,
      date: new Date(),
      memo,
      status: JournalStatus.POSTED,
      makerIdentity,
      // RAJ-455: same provenance contract as recordBookingPrepayment, so the
      // cancellation reversal can find this entry structurally (and RAJ-284
      // idempotency guards a same-day re-sync from double-posting).
      source: 'booking',
      sourceId: booking.id,
      operation: 'prepayment',
      lines: [
        {
          accountId: cashAccount.id,
          amount: new Decimal(booking.totalAmount),
          isDebit: true // DR Cash
        },
        {
          accountId: deferredAccount.id,
          amount: new Decimal(booking.totalAmount),
          isDebit: false // CR Liability
        }
      ]
    });

    await prisma.booking.update({
      where: { id: booking.id },
      data: { deferredPosted: true }
    });

    console.log(`[RevenueService] Posted Initial Deferred Entry for Booking ${booking.id}`);
  }

  /**
   * Moves funds from Deferred Revenue to Rental Income for all checked-out guests.
   */
  static async recognizeRevenue(organizationId: string, makerIdentity: string, report?: SyncReport): Promise<SyncReport> {
    const localReport: SyncReport = report ?? {
      reservationsFetched: 0,
      bookingsProcessed: 0,
      bookingsRecognized: 0,
      failures: [],
    };

    const today = new Date();

    // Find all CONFIRMED bookings where checkOut has passed
    const pendingRecognition = await prisma.booking.findMany({
      where: {
        OR: [
          { status: "CONFIRMED", checkOut: { lte: today }, deferredPosted: true },
          { status: "CANCELLED", deferredPosted: true }
        ],
        property: { organizationId }
      },
      include: { property: true }
    });

    console.log(`[RevenueService] Found ${pendingRecognition.length} bookings ready for revenue recognition.`);

    for (const booking of pendingRecognition) {
      try {
        if (booking.status === "CANCELLED") {
          await this.postCancellationReversal(organizationId, booking, makerIdentity);
        } else {
          await this.postRecognitionEntry(organizationId, booking, makerIdentity);
        }
        localReport.bookingsRecognized += 1;
      } catch (err) {
        localReport.failures.push({
          stage: 'recognition',
          bookingRef: booking.hostawayId ?? booking.id,
          reason: describeError(err),
        });
        console.error(`[RevenueService] Recognition failed for booking ${booking.id}:`, describeError(err));
      }
    }

    return localReport;
  }

  /**
   * Reverses the initial deferred entry if a booking is cancelled.
   */
  private static async postCancellationReversal(organizationId: string, booking: BookingWithProperty, makerIdentity: string) {
    if (!booking.deferredPosted) return;

    const cashAccount = await this.getOrCreateAccount(organizationId, "Operating Cash", "ASSET");
    const deferredAccount = await this.getOrCreateAccount(organizationId, "Guest Pre-payments", "LIABILITY");

    const memo = `Cancellation Reversal: Refund for Booking #${booking.hostawayId} at ${booking.property.name}`;

    await LedgerService.postEntry({
      organizationId,
      date: new Date(),
      memo,
      status: JournalStatus.POSTED,
      makerIdentity,
      lines: [
        {
          accountId: deferredAccount.id,
          amount: new Decimal(booking.totalAmount),
          isDebit: true // DR Liability (Decrease)
        },
        {
          accountId: cashAccount.id,
          amount: new Decimal(booking.totalAmount),
          isDebit: false // CR Cash (Decrease)
        }
      ]
    });

    await prisma.booking.update({
      where: { id: booking.id },
      data: { deferredPosted: false }
    });

    console.log(`[RevenueService] Reversed Initial Deferred Entry for Cancelled Booking ${booking.id}`);
  }

  /**
   * Creates the Double-Entry Journal for Revenue Recognition.
   */
  private static async postRecognitionEntry(organizationId: string, booking: BookingWithProperty, makerIdentity: string) {
    // 1. Get/Create the mandatory Accounts for this organization
    const deferredAccount = await this.getOrCreateAccount(organizationId, "Guest Pre-payments", "LIABILITY");
    const revenueAccount = await this.getOrCreateAccount(organizationId, "Rental Income", "REVENUE");

    // 2. Post the Entry
    const memo = `Revenue Recognition: Guest checkout for Booking #${booking.hostawayId} at ${booking.property.name}`;

    // 4-EYES CHECK: Ensure the amount is not unreasonably high before auto-posting
    const HIGH_VALUE_THRESHOLD = 10000; // €10k threshold for manual review
    const status = new Decimal(booking.totalAmount.toString()).gt(HIGH_VALUE_THRESHOLD) ? JournalStatus.DRAFT : JournalStatus.POSTED;

    await LedgerService.postEntry({
      organizationId,
      date: booking.checkOut,
      memo,
      status,
      makerIdentity,
      lines: [
        {
          accountId: deferredAccount.id,
          amount: new Decimal(booking.totalAmount),
          isDebit: true // DR Liability (Decrease)
        },
        {
          accountId: revenueAccount.id,
          amount: new Decimal(booking.totalAmount),
          isDebit: false // CR Revenue (Increase)
        }
      ]
    });

    // 3. Mark the booking as COMPLETED
    await prisma.booking.update({
      where: { id: booking.id },
      data: { status: "COMPLETED" }
    });

    console.log(`[RevenueService] Successfully recognized €${booking.totalAmount} for Booking ${booking.id} (${status})`);
  }

  /**
   * Helper to ensure the necessary Chart of Accounts exists.
   */
  private static async getOrCreateAccount(organizationId: string, name: string, type: string) {
    let account = await prisma.account.findFirst({
      where: { organizationId, name }
    });

    if (!account) {
      account = await prisma.account.create({
        data: {
          organizationId,
          name,
          type,
          currency: "EUR",
        }
      });
    }
    return account;
  }

  /**
   * Resolves a Channel by display name (e.g. "Airbnb", "Booking.com"),
   * falling back to creating the channel if it doesn't yet exist.
   */
  private static async resolveChannel(channelName: string) {
    const name = channelName?.trim() || 'Direct';
    const existing = await prisma.channel.findFirst({ where: { name } });
    if (existing) return existing;
    return prisma.channel.create({ data: { name } });
  }
}
