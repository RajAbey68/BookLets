import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set; cannot run the seed.');
}
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

async function main() {
  console.log('--- Starting BookLets Seeding ---');

  // 1. Create Default Organization
  const org = await prisma.organization.upsert({
    where: { id: 'primary_org' },
    update: {},
    create: {
      id: 'primary_org',
      name: 'Asimov Lettings Portfolio',
      slug: 'asimov-lettings',
    },
  });
  console.log(`Organization created: ${org.name}`);

  // 2. Initialize Chart of Accounts (COA)
  // Codes follow the standard ledger numbering: 1xxx Assets, 2xxx Liabilities,
  // 4xxx Revenue, 5xxx Expenses, 9999 Suspense (P0.2 governance gate).
  const accounts = [
    { code: '1000', name: 'Operating Cash', type: 'ASSET' },
    { code: '2000', name: 'Guest Pre-payments', type: 'LIABILITY' },
    { code: '4000', name: 'Rental Income', type: 'REVENUE' },
    { code: '4001', name: 'Cleaning Fee Income', type: 'REVENUE' },
    { code: '5000', name: 'Commission Expense', type: 'EXPENSE' },
    { code: '5001', name: 'General Operating Expense', type: 'EXPENSE' },
    { code: '9999', name: 'Suspense', type: 'ASSET' },
  ];

  for (const acc of accounts) {
    await prisma.account.upsert({
      where: { id: `acc_${acc.name.replace(/\s+/g, '_').toLowerCase()}` },
      update: { code: acc.code },
      create: {
        id: `acc_${acc.name.replace(/\s+/g, '_').toLowerCase()}`,
        organizationId: org.id,
        name: acc.name,
        code: acc.code,
        type: acc.type,
        currency: 'EUR',
      },
    });
  }
  console.log('Chart of Accounts initialized.');

  // 3. Create Fiscal Period
  const today = new Date();
  const yearStart = new Date(today.getFullYear(), 0, 1);
  const yearEnd = new Date(today.getFullYear(), 11, 31);

  await prisma.fiscalPeriod.upsert({
    where: { id: `fp_${today.getFullYear()}` },
    update: {},
    create: {
      id: `fp_${today.getFullYear()}`,
      organizationId: org.id,
      name: `FY ${today.getFullYear()}`,
      startDate: yearStart,
      endDate: yearEnd,
      isClosed: false,
    },
  });
  console.log(`Fiscal Period opened for ${today.getFullYear()}.`);

  // 4. Initialize Channels
  const channels = ['Airbnb', 'Booking.com', 'Direct'];
  for (const channelName of channels) {
    await prisma.channel.upsert({
      where: { id: `channel_${channelName.toLowerCase()}` },
      update: {},
      create: {
        id: `channel_${channelName.toLowerCase()}`,
        name: channelName,
      },
    });
  }
  console.log('Booking Channels initialized.');

  console.log('--- Seeding Complete ---');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
