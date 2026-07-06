/**
 * Smoke test for the spreadsheet parser. Run with:
 *   npx tsx scripts/test-parse-spreadsheet.ts <path-to-xlsx>
 *
 * Prints a per-section summary and any warnings. Not a unit test — the
 * importer UX will surface the same data in the browser. This script
 * exists so the parser can be iterated against the operator's actual
 * workbook without standing up the full app.
 */
import { readFileSync } from 'node:fs';
import { parseSpreadsheet } from '../src/lib/spreadsheet-parser';

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: tsx scripts/test-parse-spreadsheet.ts <path-to-xlsx>');
    process.exit(1);
  }
  const buf = readFileSync(path);
  const result = await parseSpreadsheet(buf);

  console.log(`# Parsed: ${result.sheetName} (${result.periodLabel})`);
  console.log(`File hash: ${result.fileHash}`);
  console.log(`Rows:      ${result.rows.length}`);
  console.log(`Net:       LKR ${result.netAmount.toFixed(2)}`);
  console.log('');

  console.log('## Per-section totals (by account code)');
  for (const section of Object.keys(result.totalsBySection) as Array<keyof typeof result.totalsBySection>) {
    const totals = result.totalsBySection[section];
    const entries = Object.entries(totals);
    if (entries.length === 0) continue;
    console.log(`\n[${section}]`);
    for (const [code, amt] of entries.sort()) {
      console.log(`  ${code}: ${amt.toFixed(2).padStart(14)}`);
    }
  }
  console.log('');

  if (result.unmappedColumns.length > 0) {
    console.log('## Unmapped column headers (need chart-of-accounts mapping)');
    for (const h of result.unmappedColumns) console.log(`  - ${h}`);
    console.log('');
  }

  const flagged = result.rows.filter((r) => r.warnings.length > 0);
  console.log(`## Row warnings: ${flagged.length} of ${result.rows.length} rows`);
  for (const r of flagged.slice(0, 20)) {
    console.log(`  row ${r.rowNumber}: ${r.warnings.join('; ')}  — "${r.description.slice(0, 60)}"`);
  }
  if (flagged.length > 20) console.log(`  ... (${flagged.length - 20} more)`);

  if (result.warnings.length > 0) {
    console.log('\n## Top-level warnings');
    for (const w of result.warnings) console.log(`  - ${w}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
