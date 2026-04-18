'use client';

import React, { useState } from 'react';
import { AutomationService } from '../lib/automation.service';

interface ReceiptUploaderProps {
  organizationId: string;
  propertyId: string;
  onSuccess?: (result: any) => void;
}

export const ReceiptUploader: React.FC<ReceiptUploaderProps> = ({ 
  organizationId, 
  propertyId,
  onSuccess 
}) => {
  const [status, setStatus] = useState<'IDLE' | 'UPLOADING' | 'ANALYZING' | 'SUCCESS' | 'ERROR'>('IDLE');
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setStatus('UPLOADING');
    setError(null);

    try {
      // 1. Convert to base64
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });

      const fullBase64 = await base64Promise;
      const base64 = fullBase64.split(',')[1]; // Remove prefix

      // 2. Process via AI Automation
      setStatus('ANALYZING');
      const result = await AutomationService.processReceipt(organizationId, propertyId, base64);
      
      setStatus('SUCCESS');
      if (onSuccess) onSuccess(result);

      // Reset after 3 seconds
      setTimeout(() => setStatus('IDLE'), 3000);

    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to process receipt');
      setStatus('ERROR');
    }
  };

  return (
    <div className={`glass-card transition-all duration-500 ${status === 'ANALYZING' ? 'border-blue-500/50 shadow-[0_0_20px_rgba(59,130,246,0.3)]' : ''}`}>
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <div className={`mb-6 p-4 rounded-full bg-blue-500/10 text-blue-400 ${status === 'ANALYZING' ? 'animate-pulse' : ''}`}>
          {status === 'SUCCESS' ? (
            <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          )}
        </div>

        <h3 className="text-xl font-bold mb-2">
          {status === 'IDLE' && 'Analyze Receipt'}
          {status === 'UPLOADING' && 'Uploading...'}
          {status === 'ANALYZING' && 'AI Extraction in Progress'}
          {status === 'SUCCESS' && 'Post Successful!'}
          {status === 'ERROR' && 'Analysis Failed'}
        </h3>
        <p className="text-sm text-slate-400 mb-6 max-w-[240px]">
          {status === 'IDLE' && 'Drag-and-drop or click to reveal the power of SymbiOS vision.'}
          {status === 'ANALYZING' && 'Gemini 3 Flash is identifying vendors and accounts...'}
          {status === 'SUCCESS' && 'The entry has been recorded in the double-entry ledger.'}
          {status === 'ERROR' && error}
        </p>

        {status === 'SUCCESS' && (
          <div className="mt-[-1rem] mb-4 text-[10px] font-semibold text-amber-400 uppercase tracking-wider flex items-center gap-1">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            Awaiting 4-Eyes Review
          </div>
        )}

        {status === 'IDLE' && (
          <label className="cursor-pointer">
            <span className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-xl font-semibold transition-all text-sm shadow-lg shadow-blue-500/20 active:scale-95 inline-block">
              Upload Document
            </span>
            <input 
              type="file" 
              className="hidden" 
              accept="image/*" 
              onChange={handleFileChange}
              disabled={status !== 'IDLE'}
            />
          </label>
        )}

        {status === 'ERROR' && (
          <button 
            onClick={() => setStatus('IDLE')}
            className="text-xs text-blue-400 hover:text-blue-300 underline font-medium"
          >
            Try again
          </button>
        )}
      </div>
      
      {/* Progress Bar for Analysis state */}
      {status === 'ANALYZING' && (
        <div className="h-1 w-full bg-slate-800 rounded-full overflow-hidden absolute bottom-0 left-0">
          <div className="h-full bg-blue-500 animate-[loading_2s_infinite]" style={{ width: '40%' }}></div>
        </div>
      )}
    </div>
  );
};

// CSS for the progress bar animation
const style = document.createElement('style');
style.innerHTML = `
  @keyframes loading {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(300%); }
  }
`;
if (typeof document !== 'undefined') document.head.appendChild(style);
