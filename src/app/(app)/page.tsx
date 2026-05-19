const IconTrendingUp = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '14px', height: '14px' }}>
    <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
    <polyline points="16 7 22 7 22 13" />
  </svg>
);

import Link from 'next/link';
import { ReceiptUploader } from '@/components/ReceiptUploader';
import { getDashboardMetrics, getRevenueTrend } from '@/app/actions/portfolio.actions';
import { getDefaultUploadContext } from '@/app/actions/context.actions';
import { fetchPortfolioMetrics } from '@/app/actions/property.actions';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

export default async function Home() {
  const [metricsResult, uploadContext, properties, trendResult] = await Promise.all([
    getDashboardMetrics(),
    getDefaultUploadContext(),
    fetchPortfolioMetrics(),
    getRevenueTrend(),
  ]);
  const trend = (trendResult.success && trendResult.data) ? trendResult.data : [];
  const trendMax = Math.max(1, ...trend.map((p) => Math.max(p.revenue, p.netIncome)));
  const hasTrend = trend.some((p) => p.revenue !== 0 || p.netIncome !== 0);
  const metrics = (metricsResult.success && metricsResult.data) ? metricsResult.data : {
    totalRevenue: 0,
    netIncome: 0,
    netMargin: 0,
    occupancy: 0,
    adr: 0,
    revpar: 0
  };

  const formatCurrency = (val: number) => 
    new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(val);

  return (
    <>
      <div className="page-header">
        <div>
          <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: '600', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Overview
          </div>
          <h1 style={{ marginBottom: 0 }}>Financial Dashboard</h1>
        </div>

        <div className="page-header-actions">
          <a
            href="/api/export/ledger"
            download
            style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)', fontWeight: '600', cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
          >
            Download Report
          </a>
          <Link
            href="/ledger"
            style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--accent-color)', border: 'none', color: '#fff', fontWeight: '600', cursor: 'pointer', boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
          >
            + Create Entry
          </Link>
        </div>
      </div>
      
      <div className="stats-grid">
        <div className="glass-card">
          <h3>Total Revenue</h3>
          <div className="stat-value">{formatCurrency(metrics.totalRevenue)}</div>
          <div className="stat-trend trend-up">
            <IconTrendingUp />
            <span>MTD Performance</span>
          </div>
        </div>
        
        <div className="glass-card">
          <h3>Net Income</h3>
          <div className="stat-value">{formatCurrency(metrics.netIncome)}</div>
          <div className="stat-trend trend-up">
            <IconTrendingUp />
            <span>Normalized Margin: {metrics.netMargin}%</span>
          </div>
        </div>
        
        <div className="glass-card">
          <h3>ADR / RevPAR</h3>
          <div className="stat-value">{formatCurrency(metrics.adr)} / {formatCurrency(metrics.revpar)}</div>
          <div className="stat-trend trend-up">
            <IconTrendingUp />
            <span>Yield vs Last Month</span>
          </div>
        </div>
        
        <div className="glass-card">
          <h3>Portfolio Occupancy</h3>
          <div className="stat-value">{metrics.occupancy}%</div>
          <div className="stat-trend trend-up">
            <IconTrendingUp />
            <span>Active Inventory</span>
          </div>
        </div>
      </div>
      
      <div style={{ marginBottom: '2.5rem' }}>
        {uploadContext ? (
          <ReceiptUploader propertyId={uploadContext.propertyId} />
        ) : (
          <div className="glass-card" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
            <h3 style={{ marginBottom: '0.5rem' }}>Receipt upload unavailable</h3>
            <p style={{ fontSize: '0.875rem' }}>
              No properties configured for this organization yet. Add a property to start
              uploading receipts.
            </p>
          </div>
        )}
      </div>

      <div className="dashboard-grid">
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
            <h2 style={{ marginBottom: 0 }}>Revenue Trend</h2>
            <div style={{ display: 'flex', gap: '1rem', fontSize: '0.75rem', fontWeight: '600' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <div style={{ width: '8px', height: '8px', background: 'var(--accent-color)', borderRadius: '2px' }} />
                <span>Gross Revenue</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <div style={{ width: '8px', height: '8px', background: 'rgba(59, 130, 246, 0.3)', borderRadius: '2px' }} />
                <span>Net Income</span>
              </div>
            </div>
          </div>
          
          {hasTrend ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: '0.75rem', padding: '1rem 0', height: '240px' }}>
              {trend.map((point) => (
                <div key={point.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', height: '100%' }}>
                  <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: '4px' }}>
                    <div
                      title={`Gross Revenue: ${formatCurrency(point.revenue)}`}
                      style={{ width: '40%', height: `${(point.revenue / trendMax) * 100}%`, minHeight: point.revenue > 0 ? '3px' : '0', background: 'var(--accent-color)', borderRadius: '4px 4px 0 0' }}
                    />
                    <div
                      title={`Net Income: ${formatCurrency(point.netIncome)}`}
                      style={{ width: '40%', height: `${(Math.max(0, point.netIncome) / trendMax) * 100}%`, minHeight: point.netIncome > 0 ? '3px' : '0', background: 'rgba(59, 130, 246, 0.3)', borderRadius: '4px 4px 0 0' }}
                    />
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{point.month}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem 0', minHeight: '200px', color: 'var(--text-secondary)', textAlign: 'center' }}>
              <div>
                <div style={{ fontSize: '0.9375rem', marginBottom: '0.25rem' }}>No revenue trend yet</div>
                <div style={{ fontSize: '0.8125rem' }}>Trends appear once bookings are recorded and recognised.</div>
              </div>
            </div>
          )}
        </div>

        <div className="glass-card">
          <h2 style={{ marginBottom: '1.5rem' }}>Property Yield</h2>
          {properties.length === 0 ? (
            <div style={{ padding: '2rem 0.75rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <div style={{ fontSize: '0.9375rem', marginBottom: '0.25rem' }}>No properties yet</div>
              <div style={{ fontSize: '0.8125rem' }}>Sync Hostaway or add a property to see per-asset yield.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {properties.map((prop) => (
                <div key={prop.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem', borderRadius: '10px', background: 'rgba(255,255,255,0.02)' }}>
                  <div>
                    <div style={{ fontSize: '0.9375rem', fontWeight: '600' }}>{prop.name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Yield: {prop.yield}</div>
                  </div>
                  <div style={{ textAlign: 'right', fontWeight: '700', color: 'var(--accent-color)' }}>{prop.revenue}</div>
                </div>
              ))}
            </div>
          )}

          <Link href="/properties" style={{ display: 'block', width: '100%', marginTop: '2rem', padding: '0.875rem', borderRadius: '10px', border: '1px dashed var(--surface-border)', background: 'none', color: 'var(--text-secondary)', fontSize: '0.875rem', fontWeight: '600', cursor: 'pointer', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
            View Full Analysis
          </Link>
        </div>
      </div>
    </>
  );
}
