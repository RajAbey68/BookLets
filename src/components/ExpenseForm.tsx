'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createExpense, type ExpenseFormOption } from '@/app/actions/expense.actions';

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

export default function ExpenseForm({
  properties,
  categories,
  vendors,
}: {
  properties: ExpenseFormOption[];
  categories: ExpenseFormOption[];
  vendors: ExpenseFormOption[];
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (properties.length === 0) {
    return (
      <div className="glass-card" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
        <h3 style={{ marginBottom: '0.5rem' }}>No properties available</h3>
        <p style={{ fontSize: '0.875rem' }}>Add or sync a property before recording an expense.</p>
      </div>
    );
  }

  if (categories.length === 0) {
    return (
      <div className="glass-card" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
        <h3 style={{ marginBottom: '0.5rem' }}>No expense categories</h3>
        <p style={{ fontSize: '0.875rem' }}>Seed at least one ExpenseCategory before recording expenses.</p>
      </div>
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const result = await createExpense({
      propertyId: String(formData.get('propertyId') ?? ''),
      expenseCategoryId: String(formData.get('expenseCategoryId') ?? ''),
      vendorName: String(formData.get('vendorName') ?? ''),
      amount: String(formData.get('amount') ?? ''),
      date: String(formData.get('date') ?? ''),
      description: String(formData.get('description') ?? ''),
    });

    if (result.success) {
      router.push('/expenses');
      router.refresh();
    } else {
      setError(result.error);
      setSubmitting(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <form
      onSubmit={handleSubmit}
      className="glass-card"
      style={{ maxWidth: '640px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}
    >
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
        <label style={labelStyle} htmlFor="expenseCategoryId">Category</label>
        <select id="expenseCategoryId" name="expenseCategoryId" required defaultValue="" style={fieldStyle}>
          <option value="" disabled>Select a category</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label style={labelStyle} htmlFor="vendorName">Vendor</label>
        <input
          id="vendorName"
          name="vendorName"
          type="text"
          required
          placeholder="Electric Co, Cleaning Crew, etc."
          list="vendor-suggestions"
          style={fieldStyle}
        />
        {vendors.length > 0 ? (
          <datalist id="vendor-suggestions">
            {vendors.map((v) => (
              <option key={v.id} value={v.name} />
            ))}
          </datalist>
        ) : null}
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.375rem' }}>
          Type any name — existing vendors are matched case-insensitively, new ones are created on save.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <div>
          <label style={labelStyle} htmlFor="amount">Amount (EUR)</label>
          <input
            id="amount"
            name="amount"
            type="number"
            min="0.01"
            step="0.01"
            required
            placeholder="0.00"
            style={fieldStyle}
          />
        </div>
        <div>
          <label style={labelStyle} htmlFor="date">Date</label>
          <input
            id="date"
            name="date"
            type="date"
            required
            defaultValue={today}
            style={fieldStyle}
          />
        </div>
      </div>

      <div>
        <label style={labelStyle} htmlFor="description">Description (optional)</label>
        <input
          id="description"
          name="description"
          type="text"
          placeholder="What was this for?"
          style={fieldStyle}
        />
      </div>

      {error ? (
        <div style={{ color: 'var(--danger-color)', fontSize: '0.875rem', fontWeight: '600' }}>{error}</div>
      ) : null}

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: '0.75rem 1.5rem',
            borderRadius: '10px',
            background: 'var(--accent-color)',
            border: 'none',
            color: '#fff',
            fontWeight: '600',
            cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting ? 'Saving…' : 'Record Expense'}
        </button>
        <Link
          href="/expenses"
          style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', fontWeight: '600', textDecoration: 'none' }}
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
