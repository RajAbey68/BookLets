import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organization.findFirst();
  if (!org) {
    console.log('No organization found');
    return;
  }

  const accounts = await prisma.account.findMany({ where: { organizationId: org.id } });
  if (accounts.length < 2) {
    console.log('Not enough accounts found');
    return;
  }

  const cash = accounts.find(a => a.name.includes('Cash')) || accounts[0];
  const revenue = accounts.find(a => a.name.includes('Revenue')) || accounts[1];

  await prisma.journalEntry.create({
    data: {
      date: new Date(),
      memo: 'Test Automated Entry',
      status: 'POSTED',
      lines: {
        create: [
          { accountId: cash.id, amount: 500, isDebit: true },
          { accountId: revenue.id, amount: 500, isDebit: false }
        ]
      }
    }
  });
  console.log('Journal entry created');
}

main().catch(console.error).finally(() => prisma.$disconnect());
