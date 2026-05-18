import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchPropertyDetail } from '@/app/actions/property.actions';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

const STATUS_BADGE: Record<string, string> = {
  CONFIRMED: 'badge-success',
  COMPLETED: 'badge-success',
  PENDING: 'badge-warning',
  CANCELLED: 'badge-danger',
};

const shortDate = new Intl.DateTimeFormat('en-IE', { month: 'short', day: '2-digit', year: 'numeric' });

export default async function PropertyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const property = await fetchPropertyDetail(id);

  if (!property) notFound();

  return (
    <>
      <div style={{ marginBottom: '2rem' }}>
        <Link href="/properties" style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', textDecoration: 'none', fontWeight: '600' }}>
          ← Back to Portfolio
        </Link>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '2.5rem' }}>
        <div>
          <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: '600', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {property.type}
          </div>
          <h1 style={{ marginBottom: '0.25rem' }}>{property.name}</h1>
          <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{property.address}</div>
        </div>
        <div style={{ fontSize: '0.75rem', fontWeight: '700', color: property.color, background: `${property.color}10`, padding: '0.35rem 0.9rem', borderRadius: '20px', border: `1px solid ${property.color}30` }}>
          {property.status}
        </div>
      </div>

      <div className="stats-grid" style={{ marginBottom: '2.5rem' }}>
        <div className="glass-card">
          <h3>Total Revenue</h3>
          <div className="stat-value">{property.totalRevenue}</div>
        </div>
        <div className="glass-card">
          <h3>Bookings</h3>
          <div className="stat-value">{property.bookingCount}</div>
        </div>
        <div className="glass-card">
          <h3>Occupancy (30d)</h3>
          <div className="stat-value">{property.occupancy}%</div>
        </div>
        <div className="glass-card">
          <h3>ADR</h3>
          <div className="stat-value">{property.adr}</div>
        </div>
      </div>

      <div className="glass-card">
        <h2 style={{ marginBottom: '1.5rem' }}>Booking History</h2>
        <table className="premium-table">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Channel</th>
              <th>Check In</th>
              <th>Check Out</th>
              <th style={{ textAlign: 'right' }}>Nights</th>
              <th style={{ textAlign: 'right' }}>Total</th>
              <th style={{ textAlign: 'right' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {property.bookings.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-secondary)' }}>
                  <div style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>No bookings yet</div>
                  <div>Bookings for this property will appear here once recorded.</div>
                </td>
              </tr>
            ) : (
              property.bookings.map((b) => (
                <tr key={b.id}>
                  <td data-label="Reference" style={{ fontWeight: '600', color: 'var(--accent-color)' }}>{b.reference}</td>
                  <td data-label="Channel">{b.channelName}</td>
                  <td data-label="Check In">{shortDate.format(b.checkIn)}</td>
                  <td data-label="Check Out">{shortDate.format(b.checkOut)}</td>
                  <td data-label="Nights" style={{ textAlign: 'right' }}>{b.nights}</td>
                  <td data-label="Total" style={{ textAlign: 'right', fontWeight: '600' }}>{b.totalAmount}</td>
                  <td data-label="Status" style={{ textAlign: 'right' }}>
                    <span className={`badge ${STATUS_BADGE[b.status] ?? 'badge-success'}`}>{b.status}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
