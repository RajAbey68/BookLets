const IconTrendingUp = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '14px', height: '14px' }}>
    <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
    <polyline points="16 7 22 7 22 13" />
  </svg>
);

const IconTrendingDown = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '14px', height: '14px' }}>
    <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
    <polyline points="16 17 22 17 22 11" />
  </svg>
);

import { ReceiptUploader } from '../components/ReceiptUploader';
import { getDashboardMetrics } from './actions/portfolio.actions';

export default async function Home() {
  const metricsResult = await getDashboardMetrics();
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '2.5rem' }}>
        <div>
          <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: '600', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Overview
          </div>
          <h1 style={{ marginBottom: 0 }}>Financial Dashboard</h1>
        </div>
        
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)', fontWeight: '600', cursor: 'pointer' }}>
            Download Report
          </button>
          <button style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--accent-color)', border: 'none', color: '#fff', fontWeight: '600', cursor: 'pointer', boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)' }}>
            + Create Entry
          </button>
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
        <ReceiptUploader organizationId="org_123" propertyId="prop_abc" />
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
          
          <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', padding: '1rem 0', height: '200px', gap: '1.5rem' }}>
            {[
              { month: 'Jul', gross: 65, net: 25 },
              { month: 'Aug', gross: 85, net: 40 },
              { month: 'Sep', gross: 70, net: 30 },
              { month: 'Oct', gross: 95, net: 45 },
              { month: 'Nov', gross: 80, net: 35 },
              { month: 'Dec', gross: 100, net: 50 },
            ].map((data, i) => (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem' }}>
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', position: 'relative', gap: '4px' }}>
                  <div style={{ width: '12px', height: `${data.gross}%`, background: 'linear-gradient(to top, var(--accent-color), var(--accent-hover))', borderRadius: '4px 4px 0 0', transition: 'height 1s ease-out' }} />
                  <div style={{ width: '12px', height: `${data.net}%`, background: 'rgba(59, 130, 246, 0.2)', borderRadius: '4px 4px 0 0', transition: 'height 1s ease-out' }} />
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: '600' }}>{data.month}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="glass-card">
          <h2 style={{ marginBottom: '1.5rem' }}>Property Yield</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {[
              { name: 'Villa Oceanview', yield: '€8,400', margin: '42%' },
              { name: 'City Loft 4', yield: '€4,200', margin: '38%' },
              { name: 'Mountain Cabin', yield: '€3,150', margin: '31%' },
              { name: 'The Penthouse', yield: '€12,900', margin: '45%' },
            ].map((prop, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem', borderRadius: '10px', background: 'rgba(255,255,255,0.02)' }}>
                <div>
                  <div style={{ fontSize: '0.9375rem', fontWeight: '600' }}>{prop.name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Margin: {prop.margin}</div>
                </div>
                <div style={{ textAlign: 'right', fontWeight: '700', color: 'var(--accent-color)' }}>{prop.yield}</div>
              </div>
            ))}
          </div>
          
          <button style={{ width: '100%', marginTop: '2rem', padding: '0.875rem', borderRadius: '10px', border: '1px dashed var(--surface-border)', background: 'none', color: 'var(--text-secondary)', fontSize: '0.875rem', fontWeight: '600', cursor: 'pointer' }}>
            View Full Analysis
          </button>
        </div>
      </div>
    </>
  );
}
