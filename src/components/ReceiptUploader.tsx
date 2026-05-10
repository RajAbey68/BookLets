'use client';

import React, { useState } from 'react';
import { processReceiptAction } from '../app/actions/receipt.actions';
import type { AutomationResult } from '../lib/automation.service';

interface ReceiptUploaderProps {
  organizationId: string;
  propertyId: string;
  onSuccess?: (result: AutomationResult) => void;
}

type UploaderStatus = 'IDLE' | 'UPLOADING' | 'ANALYZING' | 'SUCCESS' | 'ERROR';

const IconUpload = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
  </svg>
);

const IconCheck = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

const IconAlert = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
  </svg>
);

export const ReceiptUploader: React.FC<ReceiptUploaderProps> = ({
  organizationId,
  propertyId,
  onSuccess,
}) => {
  const [status, setStatus] = useState<UploaderStatus>('IDLE');
  const [error, setError] = useState<string | null>(null);
  const [showHil, setShowHil] = useState(false);

  const cardClass = [
    'glass-card',
    status === 'ANALYZING' ? 'is-analyzing' : '',
    status === 'SUCCESS' && !showHil ? 'is-success' : '',
    status === 'SUCCESS' && showHil ? 'is-hil' : '',
  ].filter(Boolean).join(' ');

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setStatus('UPLOADING');
    setError(null);
    setShowHil(false);

    try {
      const reader = new FileReader();
      const fullBase64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
      const imageBase64 = fullBase64.split(',')[1];

      setStatus('ANALYZING');
      const response = await processReceiptAction({
        organizationId,
        propertyId,
        imageBase64,
        source: 'WEB',
      });

      if (!response.success) {
        throw new Error(response.error);
      }

      setShowHil(response.data.status === 'HIL_REQUIRED');
      setStatus('SUCCESS');
      if (onSuccess) onSuccess(response.data);

      setTimeout(() => setStatus('IDLE'), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to process receipt';
      console.error('[ReceiptUploader]', err);
      setError(message);
      setStatus('ERROR');
    }
  };

  return (
    <div className={cardClass}>
      <div className="uploader">
        <div className={`uploader-icon ${status === 'ANALYZING' ? 'pulsing' : ''}`}>
          {status === 'SUCCESS' ? <IconCheck /> : status === 'ERROR' ? <IconAlert /> : <IconUpload />}
        </div>

        <h3 className="uploader-title">
          {status === 'IDLE' && 'Analyze Receipt'}
          {status === 'UPLOADING' && 'Uploading...'}
          {status === 'ANALYZING' && 'AI Extraction in Progress'}
          {status === 'SUCCESS' && (showHil ? 'Awaiting Approval' : 'Post Successful!')}
          {status === 'ERROR' && 'Analysis Failed'}
        </h3>

        <p className="uploader-body">
          {status === 'IDLE' && 'Drag-and-drop or click to reveal the power of SymbiOS vision.'}
          {status === 'UPLOADING' && 'Reading file...'}
          {status === 'ANALYZING' && 'Gemini 3 Flash is identifying vendors and accounts...'}
          {status === 'SUCCESS' && !showHil && 'The entry has been recorded in the double-entry ledger.'}
          {status === 'SUCCESS' && showHil && 'Confidence below threshold. Entry queued as DRAFT for human review.'}
          {status === 'ERROR' && error}
        </p>

        {status === 'SUCCESS' && showHil && (
          <span className="uploader-hil">
            <IconAlert />
            Awaiting 4-Eyes Review
          </span>
        )}

        {status === 'IDLE' && (
          <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
            Upload Document
            <input
              type="file"
              style={{ display: 'none' }}
              accept="image/*"
              onChange={handleFileChange}
            />
          </label>
        )}

        {status === 'ERROR' && (
          <button
            type="button"
            onClick={() => { setStatus('IDLE'); setError(null); }}
            className="uploader-error-link"
          >
            Try again
          </button>
        )}
      </div>

      {status === 'ANALYZING' && (
        <div className="uploader-progress">
          <div className="uploader-progress-bar" />
        </div>
      )}
    </div>
  );
};
