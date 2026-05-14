'use client';

import { useState } from 'react';
import { triggerManualSync } from '@/app/actions/sync.actions';

export default function SyncPropertiesButton() {
  const [state, setState] = useState<'idle' | 'syncing' | 'ok' | 'err'>('idle');
  const [msg, setMsg] = useState('');

  const handleClick = async () => {
    setState('syncing');
    try {
      const result = await triggerManualSync();
      if (result.success) {
        setState('ok');
        setMsg('Synced!');
      } else {
        setState('err');
        setMsg(result.message ?? 'Sync failed');
      }
    } catch {
      setState('err');
      setMsg('Sync failed');
    } finally {
      setTimeout(() => { setState('idle'); setMsg(''); }, 3000);
    }
  };

  const label =
    state === 'syncing' ? 'Syncing…' :
    state === 'ok' ? msg :
    state === 'err' ? msg :
    '↻ Sync Hostaway';

  return (
    <button
      onClick={handleClick}
      disabled={state === 'syncing'}
      style={{
        padding: '0.75rem 1.25rem',
        borderRadius: '10px',
        background: state === 'err' ? 'var(--danger-color)' : 'var(--accent-color)',
        border: 'none',
        color: '#fff',
        fontWeight: '600',
        cursor: state === 'syncing' ? 'not-allowed' : 'pointer',
        boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)',
        opacity: state === 'syncing' ? 0.7 : 1,
      }}
    >
      {label}
    </button>
  );
}
