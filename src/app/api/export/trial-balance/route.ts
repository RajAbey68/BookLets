import { NextResponse } from 'next/server';
import { getTrialBalanceReport } from '@/lib/trial-balance-report';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const period = new URL(request.url).searchParams.get('period') ?? undefined;
  const report = await getTrialBalanceReport(period);

  if (!report.ok) {
    return NextResponse.json({ error: report.error }, { status: 401 });
  }

  const { trialBalance: tb } = report;

  const rows: string[] = ['Code,Account,Type,Debit,Credit'];
  for (const row of tb.rows) {
    rows.push(
      [
        row.code ?? '',
        `"${row.name.replace(/"/g, '""')}"`,
        row.type,
        row.debit.toFixed(2),
        row.credit.toFixed(2),
      ].join(','),
    );
  }
  rows.push(['', '"TOTALS"', '', tb.totalDebit.toFixed(2), tb.totalCredit.toFixed(2)].join(','));
  rows.push(['', `"${tb.isBalanced ? 'BALANCED' : 'OUT OF BALANCE'}"`, '', '', ''].join(','));

  const csv = rows.join('\r\n');
  const filename = `booklets-trial-balance-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
