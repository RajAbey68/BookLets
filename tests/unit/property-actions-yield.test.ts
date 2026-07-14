/**
 * fetchPortfolioMetrics must never fabricate a yield percentage.
 *
 * The Property model has no valuation/cost-basis field anywhere in the
 * schema (confirmed by reading prisma/schema.prisma directly) — annual
 * income / asset value cannot be computed without one. The prior code
 * returned a hardcoded band ('8.2%'/'5.4%'/'3.1%') keyed off revenue alone,
 * which is not a yield calculation at all — just a fabricated number shown
 * to users as if it were real (P1 zero-fabrication violation). This is the
 * exact "Property Yield" dashboard card that prompted this investigation.
 *
 * Fix: report 'N/A' until real valuation data exists. No new formula is
 * invented here — inventing a plausible-looking substitute would repeat the
 * same defect with extra steps.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

function mockDeps(bookings: Array<{ status: string; totalAmount: string; checkIn: Date; checkOut: Date }>) {
  vi.doMock('../../src/lib/auth-context', () => ({
    resolveActiveContext: vi.fn().mockResolvedValue({
      ok: true,
      context: { organizationId: 'org-1', organizationName: 'Test Org', userId: 'user-1', role: 'OWNER' },
    }),
  }));
  vi.doMock('../../src/lib/prisma', () => ({
    prisma: {
      property: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'prop-1',
            name: 'Test Villa',
            address: '1 Test Street',
            bookings: bookings.map((b, i) => ({ id: `bk-${i}`, ...b })),
          },
        ]),
      },
    },
  }));
}

beforeEach(() => vi.resetModules());

describe('fetchPortfolioMetrics — yield field (RAJ-674)', () => {
  it('reports N/A for a low-revenue property (was fabricated as "3.1%")', async () => {
    mockDeps([
      { status: 'COMPLETED', totalAmount: '1000.00', checkIn: new Date('2026-01-01'), checkOut: new Date('2026-01-05') },
    ]);
    const { fetchPortfolioMetrics } = await import('../../src/app/actions/property.actions');

    const [metric] = await fetchPortfolioMetrics();
    expect(metric.yield).toBe('N/A');
  });

  it('reports N/A for a high-revenue property too (was fabricated as "8.2%") — revenue alone never implies yield', async () => {
    mockDeps([
      { status: 'COMPLETED', totalAmount: '50000.00', checkIn: new Date('2026-01-01'), checkOut: new Date('2026-01-05') },
    ]);
    const { fetchPortfolioMetrics } = await import('../../src/app/actions/property.actions');

    const [metric] = await fetchPortfolioMetrics();
    expect(metric.yield).toBe('N/A');
    // Guard against ever re-introducing a hardcoded percentage band.
    expect(metric.yield).not.toMatch(/%/);
  });

  it('reports N/A for a property with no bookings at all', async () => {
    mockDeps([]);
    const { fetchPortfolioMetrics } = await import('../../src/app/actions/property.actions');

    const [metric] = await fetchPortfolioMetrics();
    expect(metric.yield).toBe('N/A');
  });

  it('still computes real revenue/occupancy/ADR/RevPAR — only yield is disabled', async () => {
    mockDeps([
      { status: 'COMPLETED', totalAmount: '1200.00', checkIn: new Date(), checkOut: new Date(Date.now() + 3 * 86400000) },
    ]);
    const { fetchPortfolioMetrics } = await import('../../src/app/actions/property.actions');

    const [metric] = await fetchPortfolioMetrics();
    expect(metric.revenue).toContain('1,200');
    expect(metric.yield).toBe('N/A');
  });
});
