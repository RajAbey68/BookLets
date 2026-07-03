import { NextResponse } from 'next/server';
import { resolveActiveContext } from '@/lib/auth-context';
import { prisma } from '@/lib/prisma';
import { csvCell } from '@/lib/csv';

export const dynamic = 'force-dynamic';

export async function GET() {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 401 });
  }

  const { organizationId } = resolved.context;

  const entries = await prisma.journalEntry.findMany({
    where: {
      lines: { some: { account: { organizationId } } },
    },
    include: {
      lines: { include: { account: true } },
    },
    orderBy: { date: 'desc' },
  });

  const rows: string[] = [
    'Date,Entry ID,Status,Account Code,Account Name,Debit,Credit,Memo',
  ];

  for (const entry of entries) {
    for (const line of entry.lines) {
      const debit = line.isDebit ? line.amount.toString() : '';
      const credit = line.isDebit ? '' : line.amount.toString();
      rows.push(
        [
          new Date(entry.date).toISOString().slice(0, 10),
          entry.id,
          entry.status,
          csvCell(line.account.code ?? ''),
          csvCell(line.account.name),
          debit,
          credit,
          csvCell(entry.memo ?? ''),
        ].join(','),
      );
    }
  }

  const csv = rows.join('\r\n');
  const filename = `booklets-ledger-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
