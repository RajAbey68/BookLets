import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // 1. Create default organization
  const org = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: {
      name: 'Default Organization',
      slug: 'default',
    },
  });

  console.log('✅ Organization created:', org.id);

  // 2. Seed Chart of Accounts (COA)
  const accounts = [
    { name: 'Operating Cash', code: '1000', accountType: 'ASSET' },
    { name: 'Guest Pre-payments', code: '2000', accountType: 'LIABILITY' },
    { name: 'Rental Income', code: '4000', accountType: 'REVENUE' },
    { name: 'Cleaning Fee Income', code: '4100', accountType: 'REVENUE' },
    { name: 'Commission Expense', code: '6000', accountType: 'EXPENSE' },
    { name: 'Suspense', code: '9999', accountType: 'SUSPENSE' },
  ];

  for (const acc of accounts) {
    await prisma.account.upsert({
      where: { code: acc.code },
      update: {},
      create: {
        organizationId: org.id,
        name: acc.name,
        code: acc.code,
        accountType: acc.accountType,
        createdBy: 'seed',
      },
    });
  }
  console.log('✅ Chart of Accounts seeded');

  // 3. Seed Fiscal Period
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
      createdBy: 'seed',
    },
  });
  console.log(`✅ Fiscal Period opened for ${today.getFullYear()}`);

  // 4. Seed Channels
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
  console.log('✅ Booking channels seeded');

  console.log('✅ Database seeded successfully');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
