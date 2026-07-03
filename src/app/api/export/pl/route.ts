import { NextResponse } from 'next/server';
import { getPLStatementReport } from '@/lib/pl-statement-report';
import type { PLSection } from '@/lib/pl-statement';
import { csvCell } from '@/lib/csv';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const period = new URL(request.url).searchParams.get('period') ?? undefined;
  const report = await getPLStatementReport(period, new Date());

  if (!report.ok) {
    return NextResponse.json({ error: report.error }, { status: 401 });
  }

  const { statement, preset, range } = report;

  const rows: string[] = [
    ['Section', 'Code', 'Account', 'Amount', 'Rolled Up'].map(csvCell).join(','),
  ];

  const pushSection = (label: string, section: PLSection) => {
    for (const row of section.rows) {
      rows.push(
        [
          csvCell(label),
          csvCell(row.code ?? ''),
          csvCell(`${'  '.repeat(row.depth)}${row.name}`),
          row.ownAmount.toFixed(2),
          row.rolledUpAmount.toFixed(2),
        ].join(','),
      );
    }
    rows.push([csvCell(label), '', csvCell(`TOTAL ${label.toUpperCase()}`), '', section.total.toFixed(2)].join(','));
  };

  pushSection('Revenue', statement.revenue);
  pushSection('Expenses', statement.expenses);
  rows.push(['', '', csvCell(statement.netProfit.isNegative() ? 'NET LOSS' : 'NET PROFIT'), '', statement.netProfit.toFixed(2)].join(','));

  const csv = rows.join('\r\n');
  // range.endExclusive is the start of the next day — name the file after the last covered day.
  const lastCoveredDay = new Date(range.endExclusive.getTime() - 1);
  const filename = `booklets-pl-${preset.toLowerCase()}-${lastCoveredDay.toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
