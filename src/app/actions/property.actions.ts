'use server';

import { prisma } from '@/lib/prisma';
import { Decimal } from 'decimal.js';

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

/**
 * Fetches and calculates live metrics for the property portfolio.
 */
export async function fetchPortfolioMetrics() {
  const properties = await prisma.property.findMany({
    include: {
      bookings: true,
    }
  });

  const metrics: PropertyMetric[] = await Promise.all(properties.map(async (prop) => {
    // 1. Calculate Revenue from Ledger (Rental Income Account)
    // For simplicity, we filter by property memo/association if we had one,
    // but here we can calculate from Bookings associated with this property.
    const totalRevenue = prop.bookings
      .filter(b => b.status === 'COMPLETED' || b.status === 'CONFIRMED')
      .reduce((acc, b) => acc + b.totalAmount, 0);

    // 2. Calculate Occupancy (Last 30 days)
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

    // 3. ADR (Average Daily Rate)
    const totalNights = prop.bookings.reduce((acc, b) => {
      const nights = Math.ceil((b.checkOut.getTime() - b.checkIn.getTime()) / (1000 * 60 * 60 * 24));
      return acc + nights;
    }, 0);
    
    const adr = totalNights > 0 ? totalRevenue / totalNights : 0;

    // 4. RevPAR
    const revpar = (adr * occupancyRate) / 100;

    // 5. Yield (Simplified calc: Revenue / Assumed Asset Value if we had it, or just a mock score)
    const yieldPercentage = (revenue: number) => {
        if (revenue > 10000) return "8.2%";
        if (revenue > 5000) return "5.4%";
        return "3.1%";
    };

    return {
      id: prop.id,
      name: prop.name,
      location: prop.address,
      units: 1, // Defaulting to 1 unit per property record for now
      occupancy: occupancyRate || 0,
      revenue: `€${totalRevenue.toLocaleString()}`,
      yield: yieldPercentage(totalRevenue),
      adr: `€${Math.round(adr)}`,
      revpar: `€${Math.round(revpar)}`,
      status: occupancyRate > 80 ? 'High Yield' : (occupancyRate > 50 ? 'Stable' : 'Seasonal'),
      color: occupancyRate > 80 ? '#10b981' : (occupancyRate > 50 ? '#3b82f6' : '#f59e0b')
    };
  }));

  return metrics;
}
