'use server';

import {
  parseSpreadsheet,
  serializeParseResult,
  type SerializedParseResult,
} from '@/lib/spreadsheet-parser';
import { resolveActiveContext } from '@/lib/auth-context';
import { persistImportToScrap } from '@/lib/scrap';

export interface ParseUploadedSpreadsheetResult {
  ok: boolean;
  /**
   * Present when ok === true. Monetary fields are pre-formatted strings
   * (LKR, 2 dp) because Decimal class instances cannot cross the
   * Server-Action serialization boundary.
   */
  result?: SerializedParseResult;
  /** Present when ok === false. Surfaces in the UI inline. */
  error?: string;
}

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — the operator's monthly workbook is ~40 KB; 10 MB is a sanity limit.

const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream', // some uploaders mis-tag
]);

/**
 * Read-only preview: parse an uploaded .xlsx and return the structured rows
 * plus per-section totals. Writes nothing — does not post journal entries,
 * does not store the file. P2 will add the persistence + posting step.
 */
export async function parseUploadedSpreadsheet(
  formData: FormData,
): Promise<ParseUploadedSpreadsheetResult> {
  const ctx = await resolveActiveContext();
  if (!ctx.ok) {
    return { ok: false, error: ctx.error };
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return { ok: false, error: 'No file uploaded.' };
  }

  if (file.size === 0) {
    return { ok: false, error: 'Uploaded file is empty.' };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Limit is ${MAX_BYTES / 1024 / 1024} MB.` };
  }
  if (file.type && !ALLOWED_MIME.has(file.type)) {
    return { ok: false, error: `Unsupported file type: ${file.type}. Upload an .xlsx workbook.` };
  }

  let buffer: Buffer;
  try {
    const arrayBuf = await file.arrayBuffer();
    buffer = Buffer.from(new Uint8Array(arrayBuf));
  } catch (err) {
    return { ok: false, error: `Could not read uploaded file: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const result = await parseSpreadsheet(buffer);
    console.log(
      `[ImportAction] ${ctx.context.userId} parsed ${file.name}: ` +
      `${result.rows.length} rows, ${result.unmappedColumns.length} unmapped cols, ${result.warnings.length} warnings`,
    );
    // Persist to scrap schema so data survives between sessions (fire-and-forget).
    void persistImportToScrap(file.name, result);
    return { ok: true, result: serializeParseResult(result) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ImportAction] Parse failed for ${file.name}: ${message}`);
    return { ok: false, error: `Parse failed: ${message}` };
  }
}
