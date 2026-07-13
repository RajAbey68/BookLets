/**
 * S6 review-ui — pure parsing of the evidence a DRAFT journal entry carries.
 *
 * Automated entries encode their extraction in the memo because there is no
 * structured extraction table yet:
 *
 *   - AutomationService (receipt OCR):  "AUTOMATED: Receipt for <vendor>"
 *   - S5 zip-ingest:                    "ZIP-INGEST: <vendor> [<category>] — <filename>"
 *
 * Receipt IMAGES are not persisted anywhere (uploads are processed in-memory
 * and discarded; Expense.receiptCloudId exists in the schema but nothing
 * writes it), so the parsed memo + agentConfidence + the expense record are
 * the richest evidence available. No IO here — the review queue action and
 * its tests share this single authority.
 */

export type DraftOrigin = 'receipt-automation' | 'zip-ingest' | 'manual';

export interface ParsedDraftEvidence {
  origin: DraftOrigin;
  /** Vendor name extracted by OCR, if the memo encodes one. */
  vendor: string | null;
  /** Category suggestion (zip-ingest memos only). */
  category: string | null;
  /** Original upload filename (zip-ingest memos only). */
  fileName: string | null;
}

const ZIP_MEMO = /^ZIP-INGEST:\s*(.+?)\s*\[(.*?)\]\s*—\s*(.+)$/;
const AUTOMATED_MEMO = /^AUTOMATED:\s*Receipt for\s+(.+)$/;

export function parseDraftEvidence(
  memo: string | null | undefined,
  source?: string | null,
): ParsedDraftEvidence {
  const text = (memo ?? '').trim();

  const zip = text.match(ZIP_MEMO);
  if (zip) {
    return {
      origin: 'zip-ingest',
      vendor: zip[1] || null,
      category: zip[2] || null,
      fileName: zip[3] || null,
    };
  }

  const automated = text.match(AUTOMATED_MEMO);
  if (automated) {
    return { origin: 'receipt-automation', vendor: automated[1] || null, category: null, fileName: null };
  }

  // source is structured provenance (RAJ-455) — trust it even when the memo
  // format drifts, so a zip-ingest entry with a rewritten memo still shows
  // its true origin.
  if (source === 'zip-ingest') {
    return { origin: 'zip-ingest', vendor: null, category: null, fileName: null };
  }

  return { origin: 'manual', vendor: null, category: null, fileName: null };
}
