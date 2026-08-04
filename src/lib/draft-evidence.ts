/**
 * S6 review-ui — pure parsing of the evidence a DRAFT journal entry carries.
 *
 * Automated entries encode their extraction in the memo because there is no
 * structured extraction table yet:
 *
 *   - AutomationService (receipt OCR):  "AUTOMATED: Receipt for <vendor>"
 *   - S5 zip-ingest:                    "ZIP-INGEST: <vendor> [<category>] — <filename>"
 *   - statement-ingest:                 "STATEMENT-INGEST: <the bank's own description>"
 *
 * Receipt IMAGES are not persisted anywhere (uploads are processed in-memory
 * and discarded; Expense.receiptCloudId exists in the schema but nothing
 * writes it), so the parsed memo + agentConfidence + the expense record are
 * the richest evidence available. No IO here — the review queue action and
 * its tests share this single authority.
 */

export type DraftOrigin = 'receipt-automation' | 'zip-ingest' | 'statement-ingest' | 'manual';

export interface ParsedDraftEvidence {
  origin: DraftOrigin;
  /** Vendor name extracted by OCR, if the memo encodes one. */
  vendor: string | null;
  /** Category suggestion (zip-ingest memos only). */
  category: string | null;
  /** Original upload filename (zip-ingest memos only). */
  fileName: string | null;
  /**
   * The bank's own description of the transaction (statement rows only).
   *
   * This is the provenance an operator actually reads: "Sent money to
   * B. A. T. Pansilu Bataduwa (fee: 450.58 LKR)", "Wise Charges for:
   * TRANSFER-2281214695", "Converted 993.00 USD to 331,970.93 LKR". It says
   * who and what, which a filename or a dedup hash cannot.
   *
   * Deliberately NOT folded into `vendor`: half these lines have no vendor in
   * any useful sense — an FX conversion has no counterparty, and a fee refers
   * to another transfer. Labelling them "Vendor" would be a worse lie than
   * leaving the field blank.
   */
  description: string | null;
}

const ZIP_MEMO = /^ZIP-INGEST:\s*(.+?)\s*\[(.*?)\]\s*—\s*(.+)$/;
const AUTOMATED_MEMO = /^AUTOMATED:\s*Receipt for\s+(.+)$/;
const STATEMENT_MEMO = /^STATEMENT-INGEST:\s*(.+)$/;

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
      description: null,
    };
  }

  const automated = text.match(AUTOMATED_MEMO);
  if (automated) {
    return { origin: 'receipt-automation', vendor: automated[1] || null, category: null, fileName: null, description: null };
  }

  const statement = text.match(STATEMENT_MEMO);
  if (statement) {
    const described = statement[1].trim();
    return {
      origin: 'statement-ingest',
      vendor: null,
      category: null,
      fileName: null,
      // "(no description)" is what the importer writes when the bank gave it
      // nothing; carrying that through as if it were a description would put
      // a placeholder on screen where the operator expects provenance.
      description: described && described !== '(no description)' ? described : null,
    };
  }

  // source is structured provenance (RAJ-455) — trust it even when the memo
  // format drifts, so a zip-ingest entry with a rewritten memo still shows
  // its true origin.
  if (source === 'zip-ingest') {
    return { origin: 'zip-ingest', vendor: null, category: null, fileName: null, description: null };
  }
  if (source === 'STATEMENT_INGEST') {
    return { origin: 'statement-ingest', vendor: null, category: null, fileName: null, description: null };
  }

  return { origin: 'manual', vendor: null, category: null, fileName: null, description: null };
}
