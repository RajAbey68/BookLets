import { prisma } from './prisma';
import { Decimal } from 'decimal.js';

export interface PortfolioMetrics {
  totalRevenue: number;
  netIncome: number;
  netMargin: number;
  occupancy: number;
  adr: number;
  revpar: number;
}

export interface RevenueTrendPoint {
  month: string;
  revenue: number;
  netIncome: number;
}

/**
 * Metrics Service
 * 
 * Computes real-time financial and operational metrics 
 * derived from the Double-Entry Ledger and Booking data.
 */
export class MetricsService {

  static async getPortfolioMetrics(organizationId: string): Promise<PortfolioMetrics> {
    const today = new Date();
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    // 1. Calculate Total Revenue (CR entries in Revenue accounts)
    const revenueLines = await prisma.journalLine.findMany({
      where: {
        journalEntry: {
          status: 'POSTED',
          date: { gte: firstOfMonth }
        },
        account: {
          organizationId,
          type: 'REVENUE'
        }
      }
    });

    const totalRevenue = revenueLines.reduce(
      (acc, curr) => curr.isDebit ? acc.minus(new Decimal(curr.amount)) : acc.plus(new Decimal(curr.amount)), 
      new Decimal(0)
    ).toNumber();

    // 2. Calculate Total Expenses (DR entries in Expense accounts)
    const expenseLines = await prisma.journalLine.findMany({
      where: {
        journalEntry: {
          status: 'POSTED',
          date: { gte: firstOfMonth }
        },
        account: {
          organizationId,
          type: 'EXPENSE'
        }
      }
    });

    const totalExpenses = expenseLines.reduce(
      (acc, curr) => curr.isDebit ? acc.plus(new Decimal(curr.amount)) : acc.minus(new Decimal(curr.amount)), 
      new Decimal(0)
    ).toNumber();

    const netIncome = totalRevenue - totalExpenses;
    const netMargin = totalRevenue > 0 ? (netIncome / totalRevenue) * 100 : 0;

    // 3. Operational Metrics (ADR, RevPAR, Occupancy)
    const bookings = await prisma.booking.findMany({
      where: {
        property: { organizationId },
        status: 'COMPLETED',
        checkOut: { gte: firstOfMonth }
      }
    });

    const totalOccupiedNights = bookings.length; // Simplified: 1 booking = 1 stay segment for this aggregation

    // Get Total Units/Properties for capacity
    const propertyCount = await prisma.property.count({ where: { organizationId } });
    const daysInMonth = today.getDate();
    const totalAvailableNights = propertyCount * daysInMonth;

    const occupancy = totalAvailableNights > 0 ? (totalOccupiedNights / totalAvailableNights) * 100 : 0;
    const adr = totalOccupiedNights > 0 ? totalRevenue / totalOccupiedNights : 0;
    const revpar = totalAvailableNights > 0 ? totalRevenue / totalAvailableNights : 0;

    return {
      totalRevenue,
      netIncome,
      netMargin: Math.round(netMargin * 10) / 10,
      occupancy: Math.round(occupancy),
      adr: Math.round(adr * 100) / 100,
      revpar: Math.round(revpar * 100) / 100
    };
  }

  /**
   * Monthly gross-revenue and net-income series for the trailing `months`
   * window (inclusive of the current month). Aggregates POSTED journal
   * lines in REVENUE and EXPENSE accounts, bucketed by entry month.
   */
  static async getRevenueTrend(organizationId: string, months = 6): Promise<RevenueTrendPoint[]> {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth() - (months - 1), 1);

    const lines = await prisma.journalLine.findMany({
      where: {
        journalEntry: {
          organizationId,
          status: 'POSTED',
          date: { gte: start },
        },
        account: {
          organizationId,
          type: { in: ['REVENUE', 'EXPENSE'] },
        },
      },
      include: {
        journalEntry: { select: { date: true } },
        account: { select: { type: true } },
      },
    });

    const buckets = new Map<string, { revenue: Decimal; expense: Decimal }>();
    for (let i = 0; i < months; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() - (months - 1) + i, 1);
      buckets.set(`${d.getFullYear()}-${d.getMonth()}`, { revenue: new Decimal(0), expense: new Decimal(0) });
    }

    for (const line of lines) {
      const d = new Date(line.journalEntry.date);
      const bucket = buckets.get(`${d.getFullYear()}-${d.getMonth()}`);
      if (!bucket) continue;
      const amount = new Decimal(line.amount);
      if (line.account.type === 'REVENUE') {
        bucket.revenue = line.isDebit ? bucket.revenue.minus(amount) : bucket.revenue.plus(amount);
      } else {
        bucket.expense = line.isDebit ? bucket.expense.plus(amount) : bucket.expense.minus(amount);
      }
    }

    const result: RevenueTrendPoint[] = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() - (months - 1) + i, 1);
      const bucket = buckets.get(`${d.getFullYear()}-${d.getMonth()}`)!;
      const revenue = bucket.revenue.toNumber();
      const expense = bucket.expense.toNumber();
      result.push({
        month: d.toLocaleString('en-IE', { month: 'short' }),
        revenue,
        netIncome: revenue - expense,
      });
    }
    return result;
  }
}
