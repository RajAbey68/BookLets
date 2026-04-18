const IconSearch = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '18px', height: '18px', color: 'var(--text-secondary)' }}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const IconBell = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '20px', height: '20px', color: 'var(--text-secondary)' }}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

const IconChevronDown = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '16px', height: '16px', color: 'var(--text-secondary)' }}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const IconMenu = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '24px', height: '24px' }}>
    <line x1="4" x2="20" y1="12" y2="12" />
    <line x1="4" x2="20" y1="6" y2="6" />
    <line x1="4" x2="20" y1="18" y2="18" />
  </svg>
);

export default function AppHeader({ onMenuClick }: { onMenuClick?: () => void }) {
  return (
    <header className="app-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button 
          onClick={onMenuClick}
          className="lg:hidden"
          style={{ background: 'none', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '0.5rem' }}
        >
          <IconMenu />
        </button>

        <div style={{ display: 'none', alignItems: 'center', gap: '0.75rem', cursor: 'pointer', padding: '0.5rem 0.75rem', borderRadius: '10px' }} className="lg:flex">
          <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'linear-gradient(135deg, #3b82f6, #60a5fa)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: '800' }}>AC</div>
          <div>
            <div style={{ fontSize: '0.875rem', fontWeight: '700' }}>Acme Portfolio</div>
            <div style={{ fontSize: '0.625rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Organization</div>
          </div>
          <IconChevronDown />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', background: 'var(--surface-color)', padding: '0.5rem 1rem', borderRadius: '10px', gap: '0.75rem', border: '1px solid var(--surface-border)' }} className="hidden sm:flex transition-all w-[40px] focus-within:w-[300px] lg:w-[300px]">
          <IconSearch />
          <input 
            type="text" 
            placeholder="Search..." 
            style={{ background: 'none', border: 'none', color: 'var(--text-primary)', outline: 'none', fontSize: '0.875rem', width: '100%' }}
            className="hidden lg:block focus:block"
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <div style={{ position: 'relative', cursor: 'pointer' }} className="p-2">
          <IconBell />
          <div style={{ position: 'absolute', top: '6px', right: '6px', width: '8px', height: '8px', background: 'var(--danger-color)', borderRadius: '50%', border: '2px solid var(--bg-color)' }} />
        </div>
        
        <div style={{ height: '24px', width: '1px', background: 'var(--surface-border)' }} className="hidden sm:block" />
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
          <div style={{ textAlign: 'right' }} className="hidden md:block">
            <div style={{ fontSize: '0.875rem', fontWeight: '600' }}>John Doe</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Admin</div>
          </div>
          <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', border: '1px solid rgba(255,255,255,0.1)' }} />
        </div>
      </div>
    </header>
  );
}
