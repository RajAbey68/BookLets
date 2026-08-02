import Link from 'next/link';
import { fetchActionCentre } from '@/app/actions/action-centre.actions';
import type { ActionItem } from '@/lib/action-centre';

/** Colour per priority — urgent shouts, info recedes. */
const PRIORITY_COLORS: Record<ActionItem['priority'], string> = {
  urgent: 'var(--danger-color)',
  attention: 'var(--warning-color)',
  info: 'var(--text-secondary)',
};

/** Font weight per priority, reinforcing the same ladder as the colours. */
const PRIORITY_WEIGHT: Record<ActionItem['priority'], number> = {
  urgent: 700,
  attention: 600,
  info: 400,
};

/**
 * Raj's "progress + current actions" panel — a read-only server component
 * (no client JS needed): what is waiting on him, what could move forward,
 * and what the system just did. Mounted on the dashboard home and /sandbox.
 * All ranking and wording comes from the pure action-centre lib; this is
 * dumb rendering, and the degraded state is a quiet line, never a crash.
 *
 * The `unavailable` branch is the point of the whole component: when the data
 * could not be gathered it SAYS SO. It never falls back to the calm empty
 * state, because a silent failure that looks healthy is what cost Raj hours.
 */
export default async function ActionCentre() {
  const { unavailable, items } = await fetchActionCentre();

  const hasUrgent = items.some((item) => item.priority === 'urgent');

  return (
    <div className="glass-card" style={{ marginBottom: '1.5rem' }}>
      <h3 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>
        {hasUrgent ? 'What needs you' : 'Status'}
      </h3>

      {unavailable ? (
        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', margin: 0 }}>
          Status unavailable right now — everything else still works. Refresh to retry.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.875rem' }}>
          {items.map((item, index) => {
            const line = (
              <span style={{ color: PRIORITY_COLORS[item.priority], fontWeight: PRIORITY_WEIGHT[item.priority] }}>
                {item.text}
              </span>
            );
            return item.href ? (
              <div key={index}>
                <Link href={item.href} style={{ textDecoration: 'none' }}>
                  {line}
                  <span style={{ color: 'var(--accent-color)', marginLeft: '0.375rem' }}>→</span>
                </Link>
              </div>
            ) : (
              <div key={index}>{line}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
