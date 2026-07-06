import Link from 'next/link';
import { fetchBookings } from '@/app/actions/bookings.actions';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

const STATUS_BADGE: Record<string, string> = {
  CONFIRMED: 'badge-success',
  COMPLETED: 'badge-success',
  PENDING: 'badge-warning',
  CANCELLED: 'badge-danger',
};

const currency = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const shortDate = new Intl.DateTimeFormat('en-IE', { month: 'short', day: '2-digit' });

export default async function BookingsPage() {
  const bookings = await fetchBookings();

  return (
    <>
      <div className="page-header">
        <div>
          <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: '600', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Bookings
          </div>
          <h1 style={{ marginBottom: 0 }}>Reservations</h1>
        </div>

        <div className="page-header-actions">
          <Link
            href="/bookings/new"
            style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--accent-color)', border: 'none', color: '#fff', fontWeight: '600', cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
          >
            + Create Booking
          </Link>
        </div>
      </div>

      <div className="glass-card">
        <table className="premium-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Property</th>
              <th>Channel</th>
              <th>Check In</th>
              <th>Check Out</th>
              <th style={{ textAlign: 'right' }}>Total</th>
              <th style={{ textAlign: 'right' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {bookings.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-secondary)' }}>
                  <div style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>No reservations found</div>
                  <div>Sync your Hostaway account to populate bookings.</div>
                </td>
              </tr>
            ) : (
              bookings.map((row) => (
                <tr key={row.id}>
                  <td data-label="ID" style={{ fontWeight: '600', color: 'var(--accent-color)' }}>
                    {row.hostawayId ?? row.id.slice(0, 8).toUpperCase()}
                  </td>
                  <td data-label="Property">{row.property.name}</td>
                  <td data-label="Channel">{row.channel.name}</td>
                  <td data-label="Check In">{shortDate.format(row.checkIn)}</td>
                  <td data-label="Check Out">{shortDate.format(row.checkOut)}</td>
                  <td data-label="Total" style={{ textAlign: 'right', fontWeight: '600' }}>
                    {currency.format(Number(row.totalAmount))}
                  </td>
                  <td data-label="Status" style={{ textAlign: 'right' }}>
                    <span className={`badge ${STATUS_BADGE[row.status] ?? 'badge-success'}`}>
                      {row.status}
                    </span>
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
