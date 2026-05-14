'use server';

import { prisma } from '@/lib/prisma';
import { resolveActiveContext } from '@/lib/auth-context';
import type { Prisma } from '@prisma/client';

export type BookingRow = Prisma.BookingGetPayload<{
  include: { property: true; channel: true };
}>;

export async function fetchBookings(): Promise<BookingRow[]> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return [];

  const { organizationId } = resolved.context;

  try {
    return await prisma.booking.findMany({
      where: { property: { organizationId } },
      include: { property: true, channel: true },
      orderBy: { checkIn: 'desc' },
    });
  } catch (error) {
    console.error('[bookings.actions] fetchBookings: DB unreachable:', error);
    return [];
  }
}
