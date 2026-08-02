import Link from 'next/link';

const TABS = [
  { key: 'sandbox', href: '/sandbox', label: 'Sandbox' },
  { key: 'books', href: '/books', label: 'Books' },
] as const;

/**
 * S11 — the Sandbox | Books two-tab bar. Deliberately plain links between the
 * two server-rendered pages (no client-side tab state): the active tab is
 * known from which page renders it.
 */
export default function SandboxBooksTabs({ active }: { active: 'sandbox' | 'books' }) {
  return (
    <div style={{ display: 'flex', gap: '0.25rem', borderBottom: '1px solid var(--surface-border)', marginBottom: '2rem' }}>
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={isActive ? 'page' : undefined}
            style={{
              padding: '0.625rem 1.25rem',
              fontSize: '0.9375rem',
              fontWeight: 600,
              textDecoration: 'none',
              color: isActive ? 'var(--accent-color)' : 'var(--text-secondary)',
              borderBottom: isActive ? '2px solid var(--accent-color)' : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
