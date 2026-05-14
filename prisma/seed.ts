import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // 1. Organisation
  const org = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: {
      name: 'BookLets Portfolio',
      slug: 'default',
    },
  });
  console.log('✅ Organization:', org.id);

  // 2. Chart of Accounts
  const accountDefs = [
    { name: 'Operating Cash',       code: '1000', type: 'ASSET' },
    { name: 'Guest Pre-payments',   code: '2000', type: 'LIABILITY' },
    { name: 'Rental Income',        code: '4000', type: 'REVENUE' },
    { name: 'Cleaning Fee Income',  code: '4100', type: 'REVENUE' },
    { name: 'Commission Expense',   code: '6000', type: 'EXPENSE' },
    { name: 'Suspense',             code: '9999', type: 'SUSPENSE' },
  ];

  const accountMap: Record<string, string> = {};
  for (const acc of accountDefs) {
    const record = await prisma.account.upsert({
      where: { code: acc.code },
      update: {},
      create: {
        organizationId: org.id,
        name: acc.name,
        code: acc.code,
        type: acc.type,
        createdBy: 'seed',
      },
    });
    accountMap[acc.code] = record.id;
  }
  console.log('✅ Chart of Accounts seeded');

  // 3. Fiscal Period (current year)
  const today = new Date();
  await prisma.fiscalPeriod.upsert({
    where: { id: `fp_${today.getFullYear()}` },
    update: {},
    create: {
      id: `fp_${today.getFullYear()}`,
      organizationId: org.id,
      name: `FY ${today.getFullYear()}`,
      startDate: new Date(today.getFullYear(), 0, 1),
      endDate: new Date(today.getFullYear(), 11, 31),
      createdBy: 'seed',
    },
  });
  console.log('✅ Fiscal period created');

  // 4. Channels
  for (const channelName of ['Airbnb', 'Booking.com', 'Direct']) {
    await prisma.channel.upsert({
      where: { id: `channel_${channelName.toLowerCase().replace('.', '')}` },
      update: {},
      create: {
        id: `channel_${channelName.toLowerCase().replace('.', '')}`,
        name: channelName,
      },
    });
  }
  console.log('✅ Channels seeded');

  // 5. Demo Properties
  const properties = [
    {
      id: 'prop_marina_suite',
      name: 'Marina Suite',
      address: '14 Harbour View, Dún Laoghaire, Dublin',
      type: 'APARTMENT',
      status: 'ACTIVE',
    },
    {
      id: 'prop_temple_bar',
      name: 'Temple Bar Loft',
      address: '8 Crown Alley, Temple Bar, Dublin 2',
      type: 'APARTMENT',
      status: 'ACTIVE',
    },
    {
      id: 'prop_coastal_cottage',
      name: 'Coastal Cottage',
      address: '3 Strand Road, Portmarnock, Co. Dublin',
      type: 'HOUSE',
      status: 'ACTIVE',
    },
  ];

  for (const prop of properties) {
    await prisma.property.upsert({
      where: { id: prop.id },
      update: {},
      create: { ...prop, organizationId: org.id },
    });
  }
  console.log('✅ Demo properties created');

  // 6. Demo Bookings
  const yr = today.getFullYear();
  const bookings = [
    { id: 'bk_001', propertyId: 'prop_marina_suite',   channelId: 'channel_airbnb',      checkIn: new Date(yr, 0, 5), checkOut: new Date(yr, 0, 10), totalAmount: '1250.00', status: 'COMPLETED' },
    { id: 'bk_002', propertyId: 'prop_temple_bar',      channelId: 'channel_airbnb',      checkIn: new Date(yr, 0, 8), checkOut: new Date(yr, 0, 12), totalAmount: '980.00',  status: 'COMPLETED' },
    { id: 'bk_003', propertyId: 'prop_coastal_cottage', channelId: 'channel_bookingcom',  checkIn: new Date(yr, 1, 1), checkOut: new Date(yr, 1, 7),  totalAmount: '1540.00', status: 'COMPLETED' },
    { id: 'bk_004', propertyId: 'prop_marina_suite',    channelId: 'channel_direct',      checkIn: new Date(yr, 1, 14),checkOut: new Date(yr, 1, 18), totalAmount: '900.00',  status: 'COMPLETED' },
    { id: 'bk_005', propertyId: 'prop_temple_bar',      channelId: 'channel_bookingcom',  checkIn: new Date(yr, 2, 3), checkOut: new Date(yr, 2, 8),  totalAmount: '1100.00', status: 'COMPLETED' },
    { id: 'bk_006', propertyId: 'prop_coastal_cottage', channelId: 'channel_airbnb',      checkIn: new Date(yr, 2, 20),checkOut: new Date(yr, 2, 25), totalAmount: '1350.00', status: 'COMPLETED' },
    { id: 'bk_007', propertyId: 'prop_marina_suite',    channelId: 'channel_airbnb',      checkIn: new Date(yr, 3, 5), checkOut: new Date(yr, 3, 9),  totalAmount: '860.00',  status: 'CONFIRMED' },
    { id: 'bk_008', propertyId: 'prop_temple_bar',      channelId: 'channel_direct',      checkIn: new Date(yr, 3, 12),checkOut: new Date(yr, 3, 16), totalAmount: '740.00',  status: 'CONFIRMED' },
  ];

  for (const bk of bookings) {
    await prisma.booking.upsert({
      where: { id: bk.id },
      update: {},
      create: bk,
    });
  }
  console.log('✅ Demo bookings created');

  // 7. Demo Journal Entries (double-entry)
  const entries = [
    {
      id: 'je_001',
      date: new Date(yr, 0, 10),
      memo: 'Marina Suite — Airbnb booking Jan 5–10',
      status: 'POSTED',
      lines: [
        { accountId: accountMap['1000'], amount: '1250.00', isDebit: true },
        { accountId: accountMap['4000'], amount: '1250.00', isDebit: false },
      ],
    },
    {
      id: 'je_002',
      date: new Date(yr, 0, 12),
      memo: 'Temple Bar Loft — Airbnb booking Jan 8–12',
      status: 'POSTED',
      lines: [
        { accountId: accountMap['1000'], amount: '980.00',  isDebit: true },
        { accountId: accountMap['4000'], amount: '980.00',  isDebit: false },
      ],
    },
    {
      id: 'je_003',
      date: new Date(yr, 1, 7),
      memo: 'Coastal Cottage — Booking.com Feb 1–7',
      status: 'POSTED',
      lines: [
        { accountId: accountMap['1000'], amount: '1540.00', isDebit: true },
        { accountId: accountMap['4000'], amount: '1540.00', isDebit: false },
      ],
    },
    {
      id: 'je_004',
      date: new Date(yr, 1, 18),
      memo: 'Marina Suite — Direct booking Feb 14–18',
      status: 'POSTED',
      lines: [
        { accountId: accountMap['1000'], amount: '900.00',  isDebit: true },
        { accountId: accountMap['4000'], amount: '900.00',  isDebit: false },
      ],
    },
    {
      id: 'je_005',
      date: new Date(yr, 2, 8),
      memo: 'Temple Bar Loft — Booking.com Mar 3–8',
      status: 'POSTED',
      lines: [
        { accountId: accountMap['1000'], amount: '1100.00', isDebit: true },
        { accountId: accountMap['4000'], amount: '1100.00', isDebit: false },
      ],
    },
    {
      id: 'je_006',
      date: new Date(yr, 2, 25),
      memo: 'Coastal Cottage — Airbnb Mar 20–25',
      status: 'POSTED',
      lines: [
        { accountId: accountMap['1000'], amount: '1350.00', isDebit: true },
        { accountId: accountMap['4000'], amount: '1350.00', isDebit: false },
      ],
    },
    {
      id: 'je_007',
      date: new Date(yr, 2, 28),
      memo: 'Q1 Airbnb platform commission',
      status: 'POSTED',
      lines: [
        { accountId: accountMap['6000'], amount: '465.00',  isDebit: true },
        { accountId: accountMap['1000'], amount: '465.00',  isDebit: false },
      ],
    },
  ];

  for (const entry of entries) {
    const { lines, ...entryData } = entry;
    await prisma.journalEntry.upsert({
      where: { id: entry.id },
      update: {},
      create: {
        ...entryData,
        organizationId: org.id,
        makerIdentity: 'seed',
        lines: { create: lines.map(l => ({ ...l, currency: 'EUR', createdBy: 'seed' })) },
      },
    });
  }
  console.log('✅ Demo journal entries created');

  console.log('\n✅ Seed complete. org.id =', org.id);
  console.log('\nTo attach your user account, run in Supabase SQL editor:');
  console.log(`INSERT INTO booklets."Membership" (id, "userId", "organizationId", role, "createdAt", "updatedAt")`);
  console.log(`SELECT gen_random_uuid(), u.id, o.id, 'OWNER', now(), now()`);
  console.log(`FROM booklets."User" u, booklets."Organization" o`);
  console.log(`WHERE u.email = '<your-google-email>' AND o.slug = 'default';`);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
