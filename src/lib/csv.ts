/**
 * CSV cell escaping with formula-injection defence.
 *
 * Financial exports open in Excel/Google Sheets, which execute any cell whose
 * text begins with = + - @ (or a tab/CR before one). An account named
 * "=SUM(...)" or "@cmd" would therefore run. We prefix such values with a
 * single quote to neutralize them, then quote the cell and escape quotes.
 */
export function csvCell(value: string | number): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}
