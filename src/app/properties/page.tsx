import { fetchPortfolioMetrics, PropertyMetric } from '../actions/property.actions';

const IconBuilding = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '16px', height: '16px' }}>
    <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
    <path d="M9 22v-4h6v4" />
    <path d="M8 6h.01" />
    <path d="M16 6h.01" />
    <path d="M8 10h.01" />
    <path d="M16 10h.01" />
    <path d="M8 14h.01" />
    <path d="M16 14h.01" />
  </svg>
);

const IconUser = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '14px', height: '14px' }}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

export default async function PropertiesPage() {
  const properties = await fetchPortfolioMetrics();

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '2.5rem' }}>
        <div>
          <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: '600', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Portfolio
          </div>
          <h1 style={{ marginBottom: 0 }}>Real Estate Assets</h1>
        </div>
        
        <button style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--accent-color)', border: 'none', color: '#fff', fontWeight: '600', cursor: 'pointer', boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)' }}>
          + Add Property
        </button>
      </div>

      {properties.length === 0 ? (
        <div className="glass-card" style={{ padding: '4rem', textAlign: 'center' }}>
          <h2 style={{ marginBottom: '1rem' }}>No properties found</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>Sync your Hostaway account or add properties manually to see analytics.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '2rem' }}>
          {properties.map((prop) => (
            <div key={prop.id} className="glass-card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '1.5rem', background: `linear-gradient(135deg, ${prop.color}15, transparent)`, borderBottom: '1px solid var(--surface-border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                  <div style={{ background: `${prop.color}20`, color: prop.color, padding: '0.5rem', borderRadius: '10px' }}>
                    <IconBuilding />
                  </div>
                  <div style={{ fontSize: '0.75rem', fontWeight: '700', color: prop.color, background: `${prop.color}10`, padding: '0.25rem 0.75rem', borderRadius: '20px', border: `1px solid ${prop.color}30` }}>
                    {prop.status}
                  </div>
                </div>
                <h3 style={{ margin: '0 0 0.25rem 0', fontSize: '1.25rem' }}>{prop.name}</h3>
                <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '180px' }}>{prop.location}</span>
                  <span>•</span>
                  <span>{prop.units} Units</span>
                </div>
              </div>
              
              <div style={{ padding: '1.5rem', flex: 1 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '1.5rem' }}>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Total Revenue</div>
                    <div style={{ fontSize: '1.125rem', fontWeight: '700' }}>{prop.revenue}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Net Yield</div>
                    <div style={{ fontSize: '1.125rem', fontWeight: '700', color: 'var(--accent-color)' }}>{prop.yield}</div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '1.5rem' }}>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>ADR</div>
                    <div style={{ fontSize: '1rem', fontWeight: '600' }}>{prop.adr}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>RevPAR</div>
                    <div style={{ fontSize: '1rem', fontWeight: '600' }}>{prop.revpar}</div>
                  </div>
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '0.5rem' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Occupancy Rate</span>
                    <span style={{ fontWeight: '700' }}>{prop.occupancy}%</span>
                  </div>
                  <div style={{ height: '6px', background: 'var(--surface-color)', borderRadius: '3px', position: 'relative' }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${prop.occupancy}%`, background: prop.color, borderRadius: '3px' }} />
                  </div>
                </div>
              </div>

              <div style={{ padding: '1rem 1.5rem', background: 'rgba(255,255,255,0.02)', borderTop: '1px solid var(--surface-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                  <IconUser />
                  <span>Primary Manager</span>
                </div>
                <button style={{ background: 'none', border: 'none', color: 'var(--accent-color)', fontWeight: '600', fontSize: '0.875rem', cursor: 'pointer' }}>
                  Details →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
