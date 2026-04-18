'use client';

import React, { useState } from 'react';
import { triggerManualSync } from '../app/actions/sync.actions';

const IconRefresh = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '16px', height: '16px' }}>
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
);

export default function SyncButton() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const handleSync = async () => {
    setIsSyncing(true);
    setStatus('Syncing...');
    
    try {
      const result = await triggerManualSync();
      if (result.success) {
        setStatus('Sync Success!');
      } else {
        setStatus(`Error: ${result.message}`);
      }
    } catch (err) {
      setStatus('Sync Failed');
    } finally {
      setTimeout(() => {
        setIsSyncing(false);
        setStatus(null);
      }, 3000);
    }
  };

  return (
    <div style={{ padding: '0 1.25rem', marginBottom: '1rem' }}>
      <button 
        onClick={handleSync}
        disabled={isSyncing}
        className={`sync-btn ${isSyncing ? 'syncing' : ''}`}
        style={{
          width: '100%',
          padding: '0.75rem',
          borderRadius: '10px',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid var(--surface-border)',
          color: 'var(--text-secondary)',
          fontSize: '0.875rem',
          fontWeight: '600',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.75rem',
          cursor: isSyncing ? 'not-allowed' : 'pointer',
          transition: 'all 0.2s ease'
        }}
      >
        <div style={{ animation: isSyncing ? 'spin 1.5s linear infinite' : 'none' }}>
          <IconRefresh />
        </div>
        {status || 'Sync Hostaway'}
      </button>

      <style jsx>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .sync-btn:hover:not(:disabled) {
          background: rgba(255,255,255,0.08);
          border-color: var(--accent-color);
          color: var(--text-primary);
        }
        .syncing {
           background: rgba(59, 130, 246, 0.1) !important;
           border-color: var(--accent-color) !important;
        }
      `}</style>
    </div>
  );
}
