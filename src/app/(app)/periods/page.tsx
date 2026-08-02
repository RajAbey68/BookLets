import { fetchFiscalPeriods } from '@/app/actions/fiscal-period.actions';
import FiscalPeriodManager from '@/components/FiscalPeriodManager';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

/**
 * /periods — Accounting periods.
 *
 * The page that makes the fiscal-period control usable by the person who owns
 * the books rather than only by whoever can run a seed script. Until this
 * existed, `LedgerService.checkFiscalPeriod` refused every posting on a fresh
 * deployment ("No fiscal period defined for the date 7/12/2026") and there was
 * no way, from inside the running application, to fix it.
 *
 * The copy assumes the reader has never heard the phrase "fiscal period": it
 * leads with what a period DOES (it decides which dates you can still record,
 * and closing one freezes those figures), not with what it is called.
 */
export default async function PeriodsPage() {
  const view = await fetchFiscalPeriods();

  return (
    <>
      <div style={{ marginBottom: '1.5rem' }}>
        <div
          style={{
            fontSize: '0.875rem',
            color: 'var(--accent-color)',
            fontWeight: '600',
            marginBottom: '0.5rem',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Setup
        </div>
        <h1 style={{ marginBottom: '0.5rem' }}>Accounting periods</h1>
        <p style={{ color: 'var(--text-secondary)', margin: 0, maxWidth: '52rem' }}>
          Your books are kept in periods — usually one per financial year. A receipt, invoice or
          bank line can only be recorded if its date falls inside a period that is still open.
          When a year is finished you close its period, and its figures are fixed for good.
        </p>
      </div>

      <FiscalPeriodManager view={view} />
    </>
  );
}
