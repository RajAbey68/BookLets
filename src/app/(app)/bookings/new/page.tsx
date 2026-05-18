import Link from 'next/link';
import { fetchBookingFormOptions } from '@/app/actions/bookings.actions';
import BookingForm from '@/components/BookingForm';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

export default async function NewBookingPage() {
  const { properties, channels } = await fetchBookingFormOptions();

  return (
    <>
      <div style={{ marginBottom: '2rem' }}>
        <Link href="/bookings" style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', textDecoration: 'none', fontWeight: '600' }}>
          ← Back to Reservations
        </Link>
      </div>

      <div style={{ marginBottom: '2.5rem' }}>
        <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: '600', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Bookings
        </div>
        <h1 style={{ marginBottom: 0 }}>Create Booking</h1>
      </div>

      <BookingForm properties={properties} channels={channels} />
    </>
  );
}
