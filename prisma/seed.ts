import { PrismaClient, AccountType } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set; cannot run the seed.');
}

// Match the runtime adapter in src/lib/prisma.ts: the `schema=booklets`
// query parameter in DATABASE_URL is a Prisma-specific extension that the
// pg driver itself ignores. Set the search_path explicitly via the
// connection options so seeded rows land in the same schema the app
// reads from (booklets), not the default public schema.
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString,
    options: '-c search_path=booklets,public',
  }),
});

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
  const accountDefs: { name: string; code: string; type: AccountType }[] = [
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

  // Structural scaffolding only. Real properties, bookings, and journal
  // entries come from live Hostaway/Ko Lake syncs — never from this seed.
  // (No demo/mock data is created here by design.)

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
