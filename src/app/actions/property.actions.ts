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
    const yieldBand = totalRevenue.gt(10000) ? '8.2%' : totalRevenue.gt(5000) ? '5.4%' : '3.1%';

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
