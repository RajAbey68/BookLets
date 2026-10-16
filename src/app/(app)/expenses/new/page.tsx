import Link from 'next/link';
import { fetchExpenseFormOptions } from '@/app/actions/expense.actions';
import ExpenseForm from '@/components/ExpenseForm';

export const dynamic = 'force-dynamic';

export default async function NewExpensePage() {
  const { properties, categories, vendors } = await fetchExpenseFormOptions();

  return (
    <>
      <div style={{ marginBottom: '2rem' }}>
        <Link href="/expenses" style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', textDecoration: 'none', fontWeight: '600' }}>
          ← Back to Expenses
        </Link>
      </div>

      <div style={{ marginBottom: '2.5rem' }}>
        <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: '600', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Costs
        </div>
        <h1 style={{ marginBottom: 0 }}>Record Expense</h1>
      </div>

      <ExpenseForm properties={properties} categories={categories} vendors={vendors} />
    </>
  );
}
