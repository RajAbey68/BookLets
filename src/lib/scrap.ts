'use server';

/**
 * Scrap persistence layer.
 *
 * Writes every spreadsheet upload (and any other operator-provided data) to
 * the `scrap` Postgres schema so nothing is ephemeral between sessions.
 * All calls are fire-and-forget: errors are logged but never bubble up to
 * the caller, so a failed scrap write never breaks the main flow.
 */

import { prisma } from './prisma';
import type { ParseResult } from './spreadsheet-parser';

export async function persistImportToScrap(
  filename: string,
  result: ParseResult,
): Promise<void> {
  try {
    // 1. Insert the session record and get its id.
    const sessionResult = await prisma.$queryRawUnsafe<{ id: string }[]>(`
      INSERT INTO scrap.import_sessions
        (filename, file_hash, period_label, sheet_name, row_count, net_amount, warnings)
      VALUES ($1, $2, $3, $4, $5, $6, $7::text[])
      RETURNING id
    `,
      filename,
      result.fileHash,
      result.periodLabel,
      result.sheetName,
      result.rows.length,
      result.netAmount.toFixed(4),
      result.warnings,
    );

    const sessionId = sessionResult[0]?.id;
    if (!sessionId) return;

    // 2. Insert rows in chunks of 50 to stay within parameter limits.
    const CHUNK = 50;
    for (let i = 0; i < result.rows.length; i += CHUNK) {
      const chunk = result.rows.slice(i, i + CHUNK);
      for (const row of chunk) {
        await prisma.$executeRawUnsafe(`
          INSERT INTO scrap.import_rows
            (session_id, row_number, section, date, description, amounts, petty_cash, warnings)
          VALUES ($1::uuid, $2, $3, $4::date, $5, $6::jsonb, $7, $8::text[])
        `,
          sessionId,
          row.rowNumber,
          row.section,
          row.date ? row.date.toISOString().slice(0, 10) : null,
          row.description,
          JSON.stringify(
            row.amounts.map((a) => ({
              columnHeader: a.columnHeader,
              accountCode: a.accountCode,
              amount: a.amount.toFixed(4),
            })),
          ),
          row.pettyCashTopUp ? row.pettyCashTopUp.toFixed(4) : null,
          row.warnings,
        );
      }
    }

    console.log(
      `[Scrap] Persisted ${result.rows.length} rows for "${filename}" → session ${sessionId}`,
    );
  } catch (err) {
    // Never block the caller — scrap writes are best-effort.
    console.error('[Scrap] Failed to persist import:', err instanceof Error ? err.message : err);
  }
}

/**
 * Log any free-form data the operator provides (paste, note, etc.).
 */
export async function logToScrap(
  source: string,
  label: string,
  content: unknown,
): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`
      INSERT INTO scrap.data_log (source, label, content)
      VALUES ($1, $2, $3::jsonb)
    `,
      source,
      label,
      JSON.stringify(content),
    );
  } catch (err) {
    console.error('[Scrap] Failed to log data:', err instanceof Error ? err.message : err);
  }
}
