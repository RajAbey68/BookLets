import { NextResponse } from 'next/server';
import { getBalanceSheetReport } from '@/lib/balance-sheet-report';
import type { BalanceSheetSection } from '@/lib/balance-sheet';
import { csvCell } from '@/lib/csv';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const asOf = new URL(request.url).searchParams.get('asOf') ?? undefined;
  const report = await getBalanceSheetReport(asOf);

  if (!report.ok) {
    return NextResponse.json({ error: report.error }, { status: 401 });
  }

  const { balanceSheet: bs } = report;

  const rows: string[] = [
    [csvCell('Balance Sheet'), csvCell(report.organizationName), csvCell(`as of ${report.asOf}`), ''].join(','),
    'Section,Code,Account,Balance',
  ];

  const pushSection = (title: string, section: BalanceSheetSection) => {
    for (const row of section.rows) {
      rows.push(
        [
          csvCell(title),
          csvCell(row.code ?? ''),
          csvCell(`${'  '.repeat(row.depth)}${row.name}`),
          row.rolledUpBalance.toFixed(2),
        ].join(','),
      );
    }
    rows.push([csvCell(title), '', csvCell(`TOTAL ${title.toUpperCase()}`), section.total.toFixed(2)].join(','));
  };

  pushSection('Assets', bs.assets);
  pushSection('Liabilities', bs.liabilities);
  pushSection('Equity', bs.equity);

  const liabilitiesPlusEquity = bs.liabilities.total.plus(bs.equity.total);
  rows.push(['', '', csvCell('LIABILITIES + EQUITY'), liabilitiesPlusEquity.toFixed(2)].join(','));
  rows.push(['', '', csvCell(bs.balances ? 'BALANCED' : 'OUT OF BALANCE'), ''].join(','));

  const csv = rows.join('\r\n');
  const filename = `booklets-balance-sheet-${report.asOf}.csv`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
