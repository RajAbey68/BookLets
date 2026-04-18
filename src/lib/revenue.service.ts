import { prisma } from './prisma';
import { HostawayService, HostawayReservation } from './hostaway.service';
import { LedgerService } from './ledger.service';
import { JournalStatus } from './types';
import { Decimal } from 'decimal.js';

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
   */
  static async syncAndProcess(organizationId: string) {
    console.log(`[RevenueService] Starting sync for Organization: ${organizationId}`);
    
    // 1. Fetch from Hostaway
    const reservations = await HostawayService.fetchReservations();
    
    for (const res of reservations) {
      await this.processReservationSync(organizationId, res);
    }

    // 2. Process recognition for all bookings that have checked out
    await this.recognizeRevenue(organizationId);
  }

  /**
   * Upserts a reservation into the local database.
   */
  private static async processReservationSync(organizationId: string, res: HostawayReservation) {
    const property = await HostawayService.findPropertyByHostawayId(res.listingId);
    if (!property) {
      console.warn(`[RevenueService] No property found for Hostaway Listing ID: ${res.listingId}. Skipping.`);
      return;
    }

    // Upsert Booking
    const booking = await prisma.booking.upsert({
      where: { hostawayId: res.id.toString() },
      update: {
        status: res.status.toUpperCase() as any,
        totalAmount: res.totalPrice,
        checkIn: new Date(res.checkInDate),
        checkOut: new Date(res.checkOutDate),
        hostawayStatus: res.status
      },
      create: {
        hostawayId: res.id.toString(),
        propertyId: property.id,
        channelId: "channel_gen_001", // Default channel mapping
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
      await this.postInitialDeferredEntry(organizationId, booking);
    }

    // 3. If CANCELLED and deferred WAS posted, we need to reverse the liability
    if (booking.status === 'CANCELLED' && booking.deferredPosted) {
      await this.handleBookingCancellation(organizationId, booking);
    }
  }

  /**
   * Reverses the initial pre-payment for cancelled bookings.
   */
  private static async handleBookingCancellation(organizationId: string, booking: any) {
    console.log(`[RevenueService] Reversing deferred entry for Cancelled Booking ${booking.id}`);
    
    // Find the latest journal entry for this booking (memo contains hostawayId)
    const entry = await prisma.journalEntry.findFirst({
      where: {
        memo: { contains: booking.hostawayId },
        lines: { some: { account: { organizationId } } }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (entry) {
       await LedgerService.reverseEntry(entry.id, "Booking Cancellation");
       await prisma.booking.update({
         where: { id: booking.id },
         data: { deferredPosted: false }
       });
    }
  }

  /**
   * Posts the initial entry when guest payment is received/confirmed.
   * DR Cash (Asset) / CR Guest Pre-payments (Liability)
   */
  private static async postInitialDeferredEntry(organizationId: string, booking: any) {
    const cashAccount = await this.getOrCreateAccount(organizationId, "Operating Cash", "ASSET");
    const deferredAccount = await this.getOrCreateAccount(organizationId, "Guest Pre-payments", "LIABILITY");
    
    const memo = `Initial Booking Funds: #${booking.hostawayId} at ${booking.hostawayId}`;
    
    try {
      await LedgerService.postEntry({
        organizationId,
        date: new Date(),
        memo,
        status: JournalStatus.POSTED,
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
    } catch (err: any) {
      console.error(`[RevenueService] Failed Initial Deferred Posting:`, err.message);
    }
  }

  /**
   * Moves funds from Deferred Revenue to Rental Income for all checked-out guests.
   */
  static async recognizeRevenue(organizationId: string) {
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
      if (booking.status === "CANCELLED") {
        await this.postCancellationReversal(organizationId, booking);
      } else {
        await this.postRecognitionEntry(organizationId, booking);
      }
    }
  }

  /**
   * Reverses the initial deferred entry if a booking is cancelled.
   */
  private static async postCancellationReversal(organizationId: string, booking: any) {
    if (!booking.deferredPosted) return;

    const cashAccount = await this.getOrCreateAccount(organizationId, "Operating Cash", "ASSET");
    const deferredAccount = await this.getOrCreateAccount(organizationId, "Guest Pre-payments", "LIABILITY");
    
    const memo = `Cancellation Reversal: Refund for Booking #${booking.hostawayId} at ${booking.property.name}`;
    
    try {
      await LedgerService.postEntry({
        organizationId,
        date: new Date(),
        memo,
        status: JournalStatus.POSTED,
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
    } catch (err: any) {
      console.error(`[RevenueService] Failed Cancellation Reversal:`, err.message);
    }
  }

  /**
   * Creates the Double-Entry Journal for Revenue Recognition.
   */
  private static async postRecognitionEntry(organizationId: string, booking: any) {
    // 1. Get/Create the mandatory Accounts for this organization
    const deferredAccount = await this.getOrCreateAccount(organizationId, "Guest Pre-payments", "LIABILITY");
    const revenueAccount = await this.getOrCreateAccount(organizationId, "Rental Income", "REVENUE");

    // 2. Post the Entry
    const memo = `Revenue Recognition: Guest checkout for Booking #${booking.hostawayId} at ${booking.property.name}`;
    
    try {
      // 4-EYES CHECK: Ensure the amount is not unreasonably high before auto-posting
      const amountThreshold = 10000; // €10k threshold for manual review
      const status = booking.totalAmount > amountThreshold ? JournalStatus.DRAFT : JournalStatus.POSTED;

      await LedgerService.postEntry({
        organizationId,
        date: booking.checkOut,
        memo,
        status,
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
    } catch (err: any) {
      console.error(`[RevenueService] Failed to post recognition for Booking ${booking.id}:`, err.message);
    }
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
          type: type as any,
          currency: "EUR"
        }
      });
    }
    return account;
  }
}
