'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import SyncButton from './SyncButton';

const IconDashboard = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="7" height="9" x="3" y="3" rx="1" />
    <rect width="7" height="5" x="14" y="3" rx="1" />
    <rect width="7" height="9" x="14" y="12" rx="1" />
    <rect width="7" height="5" x="3" y="16" rx="1" />
  </svg>
);

const IconBuilding = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="16" height="20" x="4" y="2" rx="2" ry="2" />
    <path d="M9 22v-4h6v4" />
    <path d="M8 6h.01" /><path d="M16 6h.01" />
    <path d="M8 10h.01" /><path d="M16 10h.01" />
    <path d="M8 14h.01" /><path d="M16 14h.01" />
  </svg>
);

const IconCalendar = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 2v4" /><path d="M16 2v4" />
    <rect width="18" height="18" x="3" y="4" rx="2" />
    <path d="M3 10h18" />
  </svg>
);

const IconBook = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
  </svg>
);

const IconDownload = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" x2="12" y1="3" y2="15" />
  </svg>
);

const IconCheckSquare = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m9 11 3 3L22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </svg>
);

const IconEye = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const IconInbox = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
);

const IconBookOpen = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 7v14" />
    <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
  </svg>
);

const NAV_ITEMS = [
  { href: '/',           label: 'Dashboard',  Icon: IconDashboard },
  { href: '/properties', label: 'Properties', Icon: IconBuilding  },
  { href: '/bookings',   label: 'Bookings',   Icon: IconCalendar  },
  { href: '/ledger',     label: 'Ledger',     Icon: IconBook      },
  { href: '/sandbox',    label: 'Sandbox',    Icon: IconInbox     },
  { href: '/books',      label: 'Books',      Icon: IconBookOpen  },
  { href: '/review',     label: 'Review',     Icon: IconEye       },
  { href: '/approvals',  label: 'Approvals',  Icon: IconCheckSquare },
];

interface SidebarProps {
  isOpen?: boolean;
  /** DRAFT entries awaiting 4-eyes review — computed server-side (S6). */
  reviewCount?: number;
}

export default function Sidebar({ isOpen, reviewCount }: SidebarProps) {
  const pathname = usePathname();

  return (
    <nav className={`sidebar ${isOpen ? 'open' : ''}`}>
      <div className="sidebar-logo">
        <div style={{ width: '32px', height: '32px', background: 'var(--accent-color)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800 }}>
          B
        </div>
        BookLets
      </div>

      <SyncButton />

      <div className="nav-group">
        <div className="nav-label">Main</div>
        <ul className="nav-links">
          {NAV_ITEMS.map(({ href, label, Icon }) => (
            <li key={href}>
              <Link href={href} className={pathname === href ? 'active' : ''}>
                <Icon />
                {label}
                {href === '/review' && typeof reviewCount === 'number' && reviewCount > 0 && (
                  <span
                    aria-label={`${reviewCount} draft ${reviewCount === 1 ? 'entry' : 'entries'} awaiting review`}
                    style={{ marginLeft: 'auto', minWidth: '1.375rem', padding: '0.0625rem 0.375rem', borderRadius: '999px', background: 'var(--accent-color)', color: '#fff', fontSize: '0.6875rem', fontWeight: 700, textAlign: 'center', lineHeight: '1.125rem' }}
                  >
                    {reviewCount > 99 ? '99+' : reviewCount}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <div className="nav-group" style={{ marginTop: 'auto' }}>
        <ul className="nav-links">
          <li>
            <a
              href="/api/export/ledger"
              download
              style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 0.875rem', borderRadius: '8px', color: 'var(--text-secondary)', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500 }}
            >
              <IconDownload />
              Export CSV
            </a>
          </li>
        </ul>
      </div>
    </nav>
  );
}
