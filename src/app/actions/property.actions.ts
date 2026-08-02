'use server';

import { prisma } from '@/lib/prisma';
import { resolveActiveContext } from '@/lib/auth-context';
import { Decimal } from 'decimal.js';
import type { Prisma } from '@prisma/client';

type PropertyWithBookings = Prisma.PropertyGetPayload<{ include: { bookings: true } }>;

export interface PropertyMetric {
  id: string;
  name: string;
  location: string;
  units: number;
  occupancy: number;
  revenue: string;
  yield: string;
  adr: string;
  revpar: string;
  status: string;
  color: string;
}

export async function fetchPortfolioMetrics(): Promise<PropertyMetric[]> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return [];

  const { organizationId } = resolved.context;

  let properties: PropertyWithBookings[] = [];
  try {
    properties = await prisma.property.findMany({
      where: { organizationId },
      include: { bookings: true },
    });
  } catch (error) {
    console.error('[property.actions] fetchPortfolioMetrics: DB unreachable:', error);
    return [];
  }

  return Promise.all(properties.map(async (prop) => {
    const totalRevenue = prop.bookings
      .filter(b => b.status === 'COMPLETED' || b.status === 'CONFIRMED')
      .reduce((acc, b) => acc.plus(new Decimal(b.totalAmount.toString())), new Decimal(0));

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const bookedDays = prop.bookings
      .filter(b => b.checkIn >= thirtyDaysAgo || b.checkOut >= thirtyDaysAgo)
      .reduce((acc, b) => {
        const start = Math.max(b.checkIn.getTime(), thirtyDaysAgo.getTime());
        const end = Math.min(b.checkOut.getTime(), new Date().getTime());
        const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
        return acc + Math.max(0, days);
      }, 0);

    const occupancyRate = Math.min(100, Math.round((bookedDays / 30) * 100));

    const totalNights = prop.bookings.reduce((acc, b) => {
      const nights = Math.ceil((b.checkOut.getTime() - b.checkIn.getTime()) / (1000 * 60 * 60 * 24));
      return acc + nights;
    }, 0);

    const adr = totalNights > 0 ? totalRevenue.div(totalNights) : new Decimal(0);
    const revpar = adr.mul(occupancyRate).div(100);
    // RAJ-674: a real yield is annual net income / property value. The
    // Property model has no valuation/cost-basis field anywhere in the
    // schema, so it cannot be computed — report 'N/A' rather than a
    // plausible-looking number keyed off revenue alone (that was not a
    // yield calculation, just a fabricated display value).
    const yieldBand = 'N/A';

    return {
      id: prop.id,
      name: prop.name,
      location: prop.address,
      units: 1,
      occupancy: occupancyRate || 0,
      revenue: `€${totalRevenue.toNumber().toLocaleString()}`,
      yield: yieldBand,
      adr: `€${Math.round(adr.toNumber())}`,
      revpar: `€${Math.round(revpar.toNumber())}`,
      status: occupancyRate > 80 ? 'High Yield' : (occupancyRate > 50 ? 'Stable' : 'Seasonal'),
      color: occupancyRate > 80 ? '#10b981' : (occupancyRate > 50 ? '#3b82f6' : '#f59e0b'),
    };
  }));
}

export interface PropertyDetailBooking {
  id: string;
  reference: string;
  channelName: string;
  checkIn: Date;
  checkOut: Date;
  nights: number;
  totalAmount: string;
  status: string;
}

export interface PropertyDetail {
  id: string;
  name: string;
  address: string;
  type: string;
  status: string;
  color: string;
  totalRevenue: string;
  bookingCount: number;
  occupancy: number;
  adr: string;
  bookings: PropertyDetailBooking[];
}

export async function fetchPropertyDetail(propertyId: string): Promise<PropertyDetail | null> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return null;

  const { organizationId } = resolved.context;

  let property;
  try {
    // Scoped by organizationId so a guessed id from another org resolves to null.
    property = await prisma.property.findFirst({
      where: { id: propertyId, organizationId },
      include: {
        bookings: {
          include: { channel: true },
          orderBy: { checkIn: 'desc' },
        },
      },
    });
  } catch (error) {
    console.error('[property.actions] fetchPropertyDetail: DB unreachable:', error);
    return null;
  }

  if (!property) return null;

  const totalRevenue = property.bookings
    .filter((b) => b.status === 'COMPLETED' || b.status === 'CONFIRMED')
    .reduce((acc, b) => acc.plus(new Decimal(b.totalAmount.toString())), new Decimal(0));

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const bookedDays = property.bookings
    .filter((b) => b.checkIn >= thirtyDaysAgo || b.checkOut >= thirtyDaysAgo)
    .reduce((acc, b) => {
      const start = Math.max(b.checkIn.getTime(), thirtyDaysAgo.getTime());
      const end = Math.min(b.checkOut.getTime(), new Date().getTime());
      const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
      return acc + Math.max(0, days);
    }, 0);

  const occupancyRate = Math.min(100, Math.round((bookedDays / 30) * 100));

  const totalNights = property.bookings.reduce((acc, b) => {
    const nights = Math.ceil((b.checkOut.getTime() - b.checkIn.getTime()) / (1000 * 60 * 60 * 24));
    return acc + Math.max(0, nights);
  }, 0);

  const adr = totalNights > 0 ? totalRevenue.div(totalNights) : new Decimal(0);

  return {
    id: property.id,
    name: property.name,
    address: property.address,
    type: property.type,
    status: property.status,
    color: occupancyRate > 80 ? '#10b981' : (occupancyRate > 50 ? '#3b82f6' : '#f59e0b'),
    totalRevenue: `€${totalRevenue.toNumber().toLocaleString()}`,
    bookingCount: property.bookings.length,
    occupancy: occupancyRate,
    adr: `€${Math.round(adr.toNumber())}`,
    bookings: property.bookings.map((b) => ({
      id: b.id,
      reference: b.hostawayId ?? b.id.slice(0, 8).toUpperCase(),
      channelName: b.channel.name,
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      nights: Math.max(0, Math.ceil((b.checkOut.getTime() - b.checkIn.getTime()) / (1000 * 60 * 60 * 24))),
      totalAmount: `€${new Decimal(b.totalAmount.toString()).toNumber().toLocaleString()}`,
      status: b.status,
    })),
  };
}
