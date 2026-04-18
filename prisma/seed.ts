import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Starting BookLets Seeding ---');

  // 1. Create Default Organization
  const org = await prisma.organization.upsert({
    where: { id: 'primary_org' },
    update: {},
    create: {
      id: 'primary_org',
      name: 'Asimov Lettings Portfolio',
    },
  });
  console.log(`Organization created: ${org.name}`);

  // 2. Initialize Chart of Accounts (COA)
  const accounts = [
    { name: 'Operating Cash', type: 'ASSET' },
    { name: 'Guest Pre-payments', type: 'LIABILITY' },
    { name: 'Rental Income', type: 'REVENUE' },
    { name: 'Cleaning Fee Income', type: 'REVENUE' },
    { name: 'Commission Expense', type: 'EXPENSE' },
    { name: 'General Operating Expense', type: 'EXPENSE' },
  ];

  for (const acc of accounts) {
    await prisma.account.upsert({
      where: { id: `acc_${acc.name.replace(/\s+/g, '_').toLowerCase()}` },
      update: {},
      create: {
        id: `acc_${acc.name.replace(/\s+/g, '_').toLowerCase()}` ,
        organizationId: org.id,
        name: acc.name,
        type: acc.type as any,
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
