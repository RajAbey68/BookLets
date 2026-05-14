'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createBooking, type BookingFormOption } from '@/app/actions/bookings.actions';

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.75rem',
  borderRadius: '10px',
  background: 'var(--surface-color)',
  border: '1px solid var(--surface-border)',
  color: 'var(--text-primary)',
  fontSize: '0.9375rem',
  outline: 'none',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  color: 'var(--text-secondary)',
  marginBottom: '0.5rem',
  fontWeight: '600',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

export default function BookingForm({
  properties,
  channels,
}: {
  properties: BookingFormOption[];
  channels: BookingFormOption[];
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (properties.length === 0) {
    return (
      <div className="glass-card" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
        <h3 style={{ marginBottom: '0.5rem' }}>No properties available</h3>
        <p style={{ fontSize: '0.875rem' }}>Add or sync a property before creating a booking.</p>
      </div>
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const result = await createBooking({
      propertyId: String(formData.get('propertyId') ?? ''),
      channelId: String(formData.get('channelId') ?? ''),
      checkIn: String(formData.get('checkIn') ?? ''),
      checkOut: String(formData.get('checkOut') ?? ''),
      totalAmount: String(formData.get('totalAmount') ?? ''),
      status: String(formData.get('status') ?? 'CONFIRMED'),
    });

    if (result.success) {
      router.push('/bookings');
      router.refresh();
    } else {
      setError(result.error);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="glass-card" style={{ maxWidth: '640px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div>
        <label style={labelStyle} htmlFor="propertyId">Property</label>
        <select id="propertyId" name="propertyId" required defaultValue="" style={fieldStyle}>
          <option value="" disabled>Select a property</option>
          {properties.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label style={labelStyle} htmlFor="channelId">Channel</label>
        <select id="channelId" name="channelId" required defaultValue="" style={fieldStyle}>
          <option value="" disabled>Select a channel</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <div>
          <label style={labelStyle} htmlFor="checkIn">Check In</label>
          <input id="checkIn" name="checkIn" type="date" required style={fieldStyle} />
        </div>
        <div>
          <label style={labelStyle} htmlFor="checkOut">Check Out</label>
          <input id="checkOut" name="checkOut" type="date" required style={fieldStyle} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <div>
          <label style={labelStyle} htmlFor="totalAmount">Total Amount (EUR)</label>
          <input id="totalAmount" name="totalAmount" type="number" min="0.01" step="0.01" required placeholder="0.00" style={fieldStyle} />
        </div>
        <div>
          <label style={labelStyle} htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue="CONFIRMED" style={fieldStyle}>
            <option value="CONFIRMED">Confirmed</option>
            <option value="COMPLETED">Completed</option>
            <option value="PENDING">Pending</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
      </div>

      {error ? (
        <div style={{ color: 'var(--danger-color)', fontSize: '0.875rem', fontWeight: '600' }}>{error}</div>
      ) : null}

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
        <button
          type="submit"
          disabled={submitting}
          style={{ padding: '0.75rem 1.5rem', borderRadius: '10px', background: 'var(--accent-color)', border: 'none', color: '#fff', fontWeight: '600', cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.6 : 1 }}
        >
          {submitting ? 'Creating…' : 'Create Booking'}
        </button>
        <Link href="/bookings" style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', fontWeight: '600', textDecoration: 'none' }}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
