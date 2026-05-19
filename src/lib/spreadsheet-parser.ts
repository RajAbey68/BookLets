import ExcelJS from 'exceljs';
import { Decimal } from 'decimal.js';
import { createHash, randomUUID } from 'node:crypto';

/**
 * Spreadsheet importer for the operator's monthly Income & Petty Cash Analysis
 * workbook. Targets the April 2026 format (the most mature layout) but is
 * tolerant of the simpler March 2026 structure too.
 *
 * The April sheet has four logical sections, separated by typed marker rows
 * in column B (the Description column):
 *
 *   "Prior Month Income/Exp (not accrued)"  → prior-month catch-up entries
 *   ...transactions...
 *   "Total Prior Months Income/Exp"         → subtotal (skip)
 *
 *   ...daily transactions interleaved with...
 *   "Total Week N"                          → weekly subtotal (skip)
 *
 *   "Recurring Expenses"                    → fixed monthly costs
 *   ...transactions...
 *   "Total Recurring Exp"                   → subtotal (skip)
 *
 *   "Adjustments"
 *     "Accruals"                            → accrual section
 *     "Accrual reversals"                   → accrual-reversal section
 *     "Prepayments"                         → prepayment section
 *     "Prepayment reversals"                → prepayment-reversal section
 *   "Total Adjustments"                     → subtotal (skip)
 *
 *   "Monthly Total with adjustments"        → grand total (validate)
 *
 * Column layout (March + April share this):
 *   B:  Date
 *   C:  Description
 *   D:  Petty Cash (a fund control account, not a category)
 *   E+: alternating Income columns then Expense columns; the column header
 *       text (in row 3) names the GL category.
 */

export type Section =
  | 'prior-month'
  | 'daily'
  | 'recurring'
  | 'accruals'
  | 'accrual-reversals'
  | 'prepayments'
  | 'prepayment-reversals'
  | 'unknown';

export interface ParsedAmount {
  /** GL column header as written in the spreadsheet (e.g. "F&B Income"). */
  columnHeader: string;
  /** Account code from the chart (e.g. "4030"). Null if header unmapped. */
  accountCode: string | null;
  /** Always positive. The column already encodes Dr/Cr (income vs expense). */
  amount: Decimal;
}

export interface ParsedRow {
  /** Stable per-row id; useful for diffing re-uploads. */
  rowId: string;
  /** 1-based source row in the worksheet. */
  rowNumber: number;
  section: Section;
  date: Date | null;
  /** True when the date was forward-filled from a previous row. */
  dateForwardFilled: boolean;
  description: string;
  /** Petty cash top-up amount, when the row populates column D. */
  pettyCashTopUp: Decimal | null;
  amounts: ParsedAmount[];
  /** Quality flags surfaced for the preview UI. */
  warnings: string[];
}

export interface ParseResult {
  sheetName: string;
  periodLabel: string;
  rows: ParsedRow[];
  /** Per-section totals keyed by account code. */
  totalsBySection: Record<Section, Record<string, Decimal>>;
  /** Computed grand total of all expense rows minus income rows. */
  netAmount: Decimal;
  /** Column headers that didn't map to an account code (operator review). */
  unmappedColumns: string[];
  /** Top-level parse warnings (e.g. missing header row). */
  warnings: string[];
  /** sha256 of the file bytes, for change-detection on re-upload. */
  fileHash: string;
}

/**
 * Operator's column headers → chart-of-accounts code. Keys are lower-cased
 * and whitespace-normalised on lookup; common typos are listed explicitly.
 * Codes must exist in the seeded chart (prisma/seed.ts).
 */
const COLUMN_TO_ACCOUNT: Record<string, string> = {
  // Income
  'rent income':                        '4000',
  'cleaning fee income':                '4010',
  'event income':                       '4020',
  'f&b income':                         '4030',
  'other income':                       '4090',

  // Cost of sales
  'food & bev exp':                     '5100',
  'food  & bev exp':                    '5100', // operator double-space
  'food and beverage':                  '5100',
  'refunds':                            '5110',

  // Operating — payroll
  'salaries':                           '6100',
  'wages':                              '6110',
  'bonus':                              '6120',
  'staff welfare':                      '6130',
  'complementaries':                    '6140',
  'service charge':                     '6100', // operator groups SC with payroll

  // Operating — utilities & subs
  'electricity':                        '6200',
  'water':                              '6210',
  'telephone /internet':                '6220',
  'telephone/internet':                 '6220',
  'internet':                           '6220',
  'software':                           '6230',

  // Operating — property
  'cleaning & maintenance':             '6300',
  'laundry & house keeping':            '6310',
  'laundry & housekeeping':             '6310',
  'pool & garden':                      '6320',
  'gym related':                        '6330',

  // Operating — operations
  'fuel':                               '6400',
  'gas':                                '6410',
  'travelling':                         '6420',
  'travel':                             '6420',
  'other operational exp(incl food)':   '6490',
  'other operational exp (incl food)':  '6490',
  'other operating expense':            '6490',

  // Operating — sales & admin
  'sales promotion':                    '6500',
  'commission':                         '6510',
  'admin exp (professional/book keeping)':       '6600',
  'admin exp (professional/book keeping/legal)': '6600',
  'admin exp (professional/bookkeeping/legal)':  '6600',
  'admin exp':                          '6600',

  // Operating — financing
  'loan repayment':                     '6700',

  // Capex
  'minor capex':                        '7100',
};

const SECTION_MARKERS: Array<{ pattern: RegExp; section: Section }> = [
  { pattern: /^prior\s+month\s+income\/exp/i,         section: 'prior-month' },
  { pattern: /^recurring\s+expenses?$/i,              section: 'recurring' },
  { pattern: /^accrual\s+reversals?$/i,               section: 'accrual-reversals' },
  { pattern: /^accruals?$/i,                          section: 'accruals' },
  { pattern: /^prepayment\s+reversals?$/i,            section: 'prepayment-reversals' },
  { pattern: /^prepayments?$/i,                       section: 'prepayments' },
];

const SKIP_MARKERS: RegExp[] = [
  /^total\s+week\s+\d+/i,
  /^total\s+prior\s+months?/i,
  /^total\s+recurring\s+exp/i,
  /^total\s+adjustments?/i,
  /^total\s+income\s+for\s+the\s+month/i,
  /^total\s+expenses?\s+for\s+the\s+month/i,
  /^monthly\s+total/i,
  /^net\s+(profit|loss|cash|income)/i,
  /^adjustments?$/i,                  // pure section header, no data
  /^recurring\s+expenses?$/i,         // pure section header, no data
];

function normaliseHeader(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isBlankCell(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Unwrap ExcelJS rich-cell wrappers (formula, sharedFormula, richText, hyperlink) to a primitive. */
function unwrapCell(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  // Formula / sharedFormula cell: { formula | sharedFormula, result }
  if ('result' in (v as Record<string, unknown>)) return (v as { result: unknown }).result;
  // Rich text: { richText: [{ text }, ...] } — concatenate
  if ('richText' in (v as Record<string, unknown>)) {
    const rt = (v as { richText: Array<{ text?: string }> }).richText;
    return rt.map((r) => r.text ?? '').join('');
  }
  // Hyperlink: { text, hyperlink }
  if ('text' in (v as Record<string, unknown>)) return (v as { text: unknown }).text;
  return v;
}

function toDecimal(raw: unknown): Decimal | null {
  const v = unwrapCell(raw);
  if (typeof v === 'number' && Number.isFinite(v)) return new Decimal(v);
  if (typeof v === 'string') {
    const cleaned = v.replace(/[,\s]/g, '');
    if (cleaned === '' || cleaned === '-') return null;
    try { return new Decimal(cleaned); } catch { return null; }
  }
  return null;
}

function toDate(raw: unknown): Date | null {
  const v = unwrapCell(raw);
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (typeof v === 'number') {
    // Excel serial date
    const epochMs = (v - 25569) * 86400_000;
    const d = new Date(epochMs);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toCellString(raw: unknown): string {
  const v = unwrapCell(raw);
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

/**
 * Find the column-header row by scanning the first ~8 rows for the
 * canonical "Rent Income" cell, then merge headers from the row above
 * (super-headers like Date/Description/Petty Cash/Income/Expenses) and
 * the canonical row itself so we get every column labelled.
 *
 * Returns the row number (1-based) of the data-header row (which is
 * also the last row before data begins) and a map of column-index →
 * normalised header text.
 */
function findHeaderRow(ws: ExcelJS.Worksheet): {
  headerRowNumber: number;
  columnHeaders: Map<number, string>;
} {
  for (let r = 1; r <= Math.min(8, ws.rowCount); r++) {
    const row = ws.getRow(r);
    let sawRentIncome = false;
    row.eachCell((cell) => {
      const s = toCellString(cell.value);
      if (s && normaliseHeader(s) === 'rent income') sawRentIncome = true;
    });
    if (!sawRentIncome) continue;

    // Found the Rent Income row. Merge headers from the row above too,
    // since Date/Description/Petty Cash live on the super-header band.
    const headers = new Map<number, string>();
    const collect = (rowNum: number) => {
      if (rowNum < 1) return;
      ws.getRow(rowNum).eachCell((cell, colNumber) => {
        const raw = toCellString(cell.value);
        const s = raw ? normaliseHeader(raw) : '';
        // Don't overwrite a specific column header (row r) with a generic
        // band header (row r-1) like "Income" or "Expenses".
        if (s && !headers.has(colNumber)) headers.set(colNumber, s);
      });
    };
    // Order matters: collect specific headers first so they win.
    collect(r);
    collect(r - 1);
    collect(r - 2);
    return { headerRowNumber: r, columnHeaders: headers };
  }
  return { headerRowNumber: 0, columnHeaders: new Map() };
}

function inferPeriodLabel(ws: ExcelJS.Worksheet): string {
  // Look in the first 3 rows for an "Apr-26" / "Mar-26" / "March 2026"
  // string in column B, then fall back to the sheet name.
  for (let r = 1; r <= 3; r++) {
    for (let c = 1; c <= 4; c++) {
      const v = ws.getRow(r).getCell(c).value;
      if (typeof v === 'string') {
        const m = v.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\s]*\d{2,4}/i);
        if (m) return m[0];
      }
      if (v instanceof Date) {
        return v.toLocaleString('en-GB', { month: 'short', year: '2-digit' }).replace(' ', '-');
      }
    }
  }
  return ws.name;
}

export async function parseSpreadsheet(buffer: Buffer | ArrayBuffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as ArrayBuffer);

  // Pick the first sheet whose name looks like a month, else first sheet.
  const ws = wb.worksheets.find((w) =>
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(w.name),
  ) ?? wb.worksheets[0];

  const warnings: string[] = [];
  const { headerRowNumber, columnHeaders } = findHeaderRow(ws);
  if (headerRowNumber === 0) {
    throw new Error('Could not locate the header row (looked for "Rent Income" in first 8 rows).');
  }

  const columnAccountCodes = new Map<number, { header: string; accountCode: string | null }>();
  const unmappedColumns = new Set<string>();
  for (const [col, header] of columnHeaders) {
    const code = COLUMN_TO_ACCOUNT[header] ?? null;
    columnAccountCodes.set(col, { header, accountCode: code });
    if (!code && !['date', 'description', 'petty cash', 'income', 'expenses', 'venue',
                    'f&b', 'utilities', 'staff welfare', 'others'].includes(header)) {
      unmappedColumns.add(header);
    }
  }

  // Locate the special column positions (Date, Description, Petty Cash).
  const dateCol = [...columnHeaders].find(([, h]) => h === 'date')?.[0];
  const descCol = [...columnHeaders].find(([, h]) => h === 'description')?.[0];
  const pettyCashCol = [...columnHeaders].find(([, h]) => h === 'petty cash')?.[0];

  if (!dateCol || !descCol) {
    warnings.push('Could not find Date or Description column; some fields will be empty.');
  }

  const rows: ParsedRow[] = [];
  const totalsBySection: Record<Section, Record<string, Decimal>> = {
    'prior-month': {}, 'daily': {}, 'recurring': {},
    'accruals': {}, 'accrual-reversals': {},
    'prepayments': {}, 'prepayment-reversals': {},
    'unknown': {},
  };

  let currentSection: Section = 'daily';
  let lastDate: Date | null = null;

  for (let r = headerRowNumber + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const descStr = descCol ? toCellString(row.getCell(descCol).value).trim() : '';

    // Section marker?
    const sectionHit = SECTION_MARKERS.find((m) => m.pattern.test(descStr));
    if (sectionHit) {
      currentSection = sectionHit.section;
      continue;
    }

    // Skip marker (subtotals, monthly totals, plain "Adjustments" header)?
    if (SKIP_MARKERS.some((p) => p.test(descStr))) continue;

    // Auto-revert to 'daily' once we leave the prior-month block.
    if (currentSection === 'prior-month' && /^prior/i.test(descStr) === false) {
      // implicit — handled by lack of explicit marker for end-of-prior-month
    }

    // Collect amounts from every mapped column on this row.
    const rowAmounts: ParsedAmount[] = [];
    let pettyCashTopUp: Decimal | null = null;

    for (const [col, info] of columnAccountCodes) {
      if (col === dateCol || col === descCol) continue;
      const v = row.getCell(col).value;
      const amt = toDecimal(v);
      if (amt === null || amt.isZero()) continue;

      if (col === pettyCashCol) {
        pettyCashTopUp = amt.abs();
        continue;
      }
      rowAmounts.push({
        columnHeader: info.header,
        accountCode: info.accountCode,
        amount: amt.abs(),
      });
    }

    // Skip rows with no amounts and no useful description.
    if (rowAmounts.length === 0 && pettyCashTopUp === null && !descStr) continue;

    // Date handling — forward-fill from previous row when blank.
    let rowDate: Date | null = null;
    let dateForwardFilled = false;
    if (dateCol) {
      rowDate = toDate(row.getCell(dateCol).value);
      if (rowDate) {
        lastDate = rowDate;
      } else if (lastDate && (rowAmounts.length > 0 || pettyCashTopUp !== null)) {
        rowDate = lastDate;
        dateForwardFilled = true;
      }
    }

    const warnings: string[] = [];
    if (dateForwardFilled) warnings.push('date forward-filled from previous row');
    if (!rowDate && (rowAmounts.length > 0 || pettyCashTopUp !== null)) {
      warnings.push('no date — could not forward-fill');
    }
    if (/no\s+receipt|no\s+invoice|hand\s*written|no\s+date/i.test(descStr)) {
      warnings.push('evidence-quality flag in description');
    }
    if (rowAmounts.some((a) => a.accountCode === null)) {
      warnings.push('one or more amounts in unmapped columns');
    }
    if (pettyCashTopUp && pettyCashTopUp.greaterThan(5000) && !descStr) {
      warnings.push('petty-cash entry > LKR 5,000 has no description (memo required)');
    }

    // Accumulate totals.
    const sectionTotals = totalsBySection[currentSection];
    for (const a of rowAmounts) {
      if (!a.accountCode) continue;
      sectionTotals[a.accountCode] = (sectionTotals[a.accountCode] ?? new Decimal(0)).plus(a.amount);
    }
    if (pettyCashTopUp) {
      sectionTotals['1010'] = (sectionTotals['1010'] ?? new Decimal(0)).plus(pettyCashTopUp);
    }

    rows.push({
      rowId: randomUUID(),
      rowNumber: r,
      section: currentSection,
      date: rowDate,
      dateForwardFilled,
      description: descStr,
      pettyCashTopUp,
      amounts: rowAmounts,
      warnings,
    });
  }

  // Compute net amount: expenses are debits in their own column; income are credits.
  // For a preview metric, net = sum(income) − sum(expenses). Sign matters less
  // than that this matches the spreadsheet's "Monthly Total" computation
  // (which is a column sum, not double-entry).
  let net = new Decimal(0);
  for (const section of Object.keys(totalsBySection) as Section[]) {
    for (const [code, total] of Object.entries(totalsBySection[section])) {
      // Income accounts start with '4', expense with '5','6','7'.
      if (code.startsWith('4')) net = net.plus(total);
      else if (code[0] >= '5' && code[0] <= '7') net = net.minus(total);
    }
  }

  // sha256 of the bytes for re-upload diffing.
  const fileBuf = buffer instanceof Buffer ? buffer : Buffer.from(new Uint8Array(buffer));
  const fileHash = createHash('sha256').update(fileBuf).digest('hex');

  return {
    sheetName: ws.name,
    periodLabel: inferPeriodLabel(ws),
    rows,
    totalsBySection,
    netAmount: net,
    unmappedColumns: [...unmappedColumns],
    warnings,
    fileHash,
  };
}
