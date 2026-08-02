/**
 * S11 sandbox — plain-English labels for the OCR bridge park reasons.
 *
 * Shared by the server-rendered staging-pile summary (/sandbox) and the
 * client-side "Feed into books" result view, so Raj reads the same wording
 * everywhere. Pure constants — no IO, safe to import from either side.
 */
import type { ParkReason } from './ocr-bridge';

export const PARK_REASON_LABELS: Record<ParkReason, string> = {
  NO_DOC_DATE: 'no date on receipt',
  NO_FISCAL_PERIOD: 'date outside an open accounting year',
  BAD_AMOUNT: 'amount missing or not a positive number',
  FX_UNSUPPORTED: 'foreign currency (books are LKR-only for now)',
  OCR_FAILED: 'receipt could not be read (OCR failed)',
};

/** Label for a reason string; unknown reasons fall back to the raw code. */
export function parkReasonLabel(reason: string): string {
  return (PARK_REASON_LABELS as Record<string, string>)[reason] ?? reason;
}
