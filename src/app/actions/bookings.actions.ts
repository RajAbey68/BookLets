'use server';

import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

export type BookingRow = Prisma.BookingGetPayload<{
  include: { property: true; channel: true };
}>;

/**
 * Fetches reservations with their property and channel for the Bookings page.
 * Fail-soft: returns [] if the database is unreachable so the page renders
 * its empty state instead of a 500.
 */
export async function fetchBookings(): Promise<BookingRow[]> {
  try {
    return await prisma.booking.findMany({
      include: { property: true, channel: true },
      orderBy: { checkIn: 'desc' },
    });
  } catch (error) {
    console.error('[bookings.actions] fetchBookings: DB unreachable, returning empty list:', error);
    return [];
  }
}
