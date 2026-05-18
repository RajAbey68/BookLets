'use server';

import { prisma } from '@/lib/prisma';
import { resolveActiveContext } from '@/lib/auth-context';
import { revalidatePath } from 'next/cache';
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

export interface BookingFormOption {
  id: string;
  name: string;
}

export async function fetchBookingFormOptions(): Promise<{
  properties: BookingFormOption[];
  channels: BookingFormOption[];
}> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { properties: [], channels: [] };

  const { organizationId } = resolved.context;

  try {
    const [properties, channels] = await Promise.all([
      prisma.property.findMany({
        where: { organizationId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.channel.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return { properties, channels };
  } catch (error) {
    console.error('[bookings.actions] fetchBookingFormOptions: DB unreachable:', error);
    return { properties: [], channels: [] };
  }
}

export interface CreateBookingInput {
  propertyId: string;
  channelId: string;
  checkIn: string;
  checkOut: string;
  totalAmount: string;
  status: string;
}

const BOOKING_STATUSES = ['CONFIRMED', 'COMPLETED', 'PENDING', 'CANCELLED'];

export async function createBooking(
  input: CreateBookingInput,
): Promise<{ success: true } | { success: false; error: string }> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { success: false, error: resolved.error };

  const { organizationId } = resolved.context;
  const { propertyId, channelId, checkIn, checkOut, totalAmount, status } = input;

  if (!propertyId || !channelId || !checkIn || !checkOut || !totalAmount) {
    return { success: false, error: 'All fields are required.' };
  }

  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  if (Number.isNaN(checkInDate.getTime()) || Number.isNaN(checkOutDate.getTime())) {
    return { success: false, error: 'Invalid check-in or check-out date.' };
  }
  if (checkOutDate <= checkInDate) {
    return { success: false, error: 'Check-out must be after check-in.' };
  }

  const amount = Number(totalAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: 'Total amount must be a positive number.' };
  }

  const bookingStatus = BOOKING_STATUSES.includes(status) ? status : 'CONFIRMED';

  try {
    // Verify the property belongs to the caller's org — never trust the client id.
    const property = await prisma.property.findFirst({
      where: { id: propertyId, organizationId },
      select: { id: true },
    });
    if (!property) {
      return { success: false, error: 'Property not found in your organisation.' };
    }

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true },
    });
    if (!channel) {
      return { success: false, error: 'Selected channel no longer exists.' };
    }

    await prisma.booking.create({
      data: {
        propertyId,
        channelId,
        checkIn: checkInDate,
        checkOut: checkOutDate,
        totalAmount: amount.toFixed(2),
        status: bookingStatus,
      },
    });

    revalidatePath('/bookings');
    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('[bookings.actions] createBooking failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create booking.' };
  }
}
