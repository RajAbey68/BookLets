import Link from 'next/link';
import { fetchExpenses } from '@/app/actions/expense.actions';

export const dynamic = 'force-dynamic';

const currency = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const shortDate = new Intl.DateTimeFormat('en-IE', { month: 'short', day: '2-digit', year: 'numeric' });

export default async function ExpensesPage() {
  const expenses = await fetchExpenses();

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '2.5rem' }}>
        <div>
          <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: '600', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Costs
          </div>
          <h1 style={{ marginBottom: 0 }}>Expenses</h1>
        </div>

        <div style={{ display: 'flex', gap: '1rem' }}>
          <Link
            href="/expenses/new"
            style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--accent-color)', border: 'none', color: '#fff', fontWeight: '600', cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
          >
            + Record Expense
          </Link>
        </div>
      </div>

      <div className="glass-card">
        <table className="premium-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Property</th>
              <th>Category</th>
              <th>Vendor</th>
              <th>Description</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {expenses.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-secondary)' }}>
                  <div style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>No expenses recorded yet</div>
                  <div>Click <strong>+ Record Expense</strong> to enter your first cost.</div>
                </td>
              </tr>
            ) : (
              expenses.map((row) => (
                <tr key={row.id}>
                  <td data-label="Date">{shortDate.format(row.date)}</td>
                  <td data-label="Property">{row.property.name}</td>
                  <td data-label="Category">{row.expenseCategory.name}</td>
                  <td data-label="Vendor">{row.vendor.name}</td>
                  <td data-label="Description" style={{ color: 'var(--text-secondary)' }}>
                    {row.description ?? '—'}
                  </td>
                  <td data-label="Amount" style={{ textAlign: 'right', fontWeight: '600' }}>
                    {currency.format(Number(row.amount))}
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
