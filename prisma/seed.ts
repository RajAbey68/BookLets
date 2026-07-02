import { PrismaClient } from '@prisma/client';
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
  //
  // Drafted from the operator's "KO_LAKE Income & Petty Cash Analysis"
  // spreadsheet (March 2026) column headers, refined per operator
  // confirmation on 2026-05-19. Numbering follows a standard SME pattern:
  //   1xxx Assets         (cash, bank, petty cash, fixed assets)
  //   2xxx Liabilities    (guest pre-payments, loans, payroll deductions)
  //   4xxx Revenue        (rent, events, F&B, other)
  //   5xxx Cost of Sales  (food & beverage, refunds)
  //   6xxx Operating Exp  (payroll, utilities, property, ops, sales/admin)
  //   7xxx Capex          (separate from operating expense)
  //   9xxx Suspense
  //
  // ---------------------------------------------------------------------
  // Operator-confirmed conventions (P0 sign-off, 2026-05-19):
  //
  // • Books currency = LKR. EUR/USD/GBP bookings get converted at
  //   recognition (the source-currency amount lives on Booking; the JE
  //   is in LKR). For USD management reporting, take a single spot rate
  //   on the month-close day and re-value every LKR JournalLine — i.e.
  //   USD reporting is a derived view at close, not a per-entry capture.
  //   A future `FxRate` table will store the chosen month-end rate per
  //   period; the export-to-accountant step (P5) writes both LKR and
  //   USD-equivalent columns using that rate. Out of scope for this PR.
  //
  // • Payroll split (Sri Lanka):
  //     6100 Salaries (Gross Accrual)   — agreed monthly compensation
  //     6110 Wages    (Net Paid)        — what hits employee bank after
  //                                         APIT + EPF-employee deductions
  //     6150 Statutory Contributions    — employer-side EPF (12%) + ETF (3%)
  //   Deduction payables sit in 2200–2220 (liability). Operator's
  //   spreadsheet uses Salaries vs Wages as two separate columns;
  //   keeping both lets the operator record either the accrual or the
  //   cash payment depending on what they have to hand.
  //
  // • Petty Cash float held by the Villa Captain. Top-ups debit
  //   1010 Petty Cash Fund (credit 1000 Bank). Daily purchases credit
  //   1010 and debit the relevant expense account. Single-line petty-
  //   cash entries above LKR 5,000 should carry a memo explaining why
  //   (enforce as a validation rule in P2, not a schema constraint).
  //
  // • Booking-month attribution: when a stay crosses month-end, the
  //   entire revenue posts to the CHECKOUT month — not apportioned by
  //   days. RevenueService.postRecognitionEntry already does this
  //   correctly (uses booking.checkOut as the entry date). Documented
  //   here so future sessions don't try to "fix" it.
  // ---------------------------------------------------------------------
  const accountDefs = [
    // 1xxx — Assets
    { name: 'Bank — LKR (Wise)',              code: '1000', type: 'ASSET',     currency: 'LKR' },
    { name: 'Petty Cash Fund',                code: '1010', type: 'ASSET',     currency: 'LKR' },
    { name: 'Operating Cash',                 code: '1020', type: 'ASSET',     currency: 'LKR' },
    { name: 'Fixed Assets — Equipment',       code: '1500', type: 'ASSET',     currency: 'LKR' },
    { name: 'Fixed Assets — Buildings',       code: '1510', type: 'ASSET',     currency: 'LKR' },

    // 2xxx — Liabilities
    { name: 'Guest Pre-payments',             code: '2000', type: 'LIABILITY', currency: 'LKR' },
    { name: 'Loans Payable',                  code: '2100', type: 'LIABILITY', currency: 'LKR' },
    { name: 'APIT Payable',                   code: '2200', type: 'LIABILITY', currency: 'LKR' },
    { name: 'EPF Payable',                    code: '2210', type: 'LIABILITY', currency: 'LKR' },
    { name: 'ETF Payable',                    code: '2220', type: 'LIABILITY', currency: 'LKR' },

    // 4xxx — Revenue
    { name: 'Rent Income',                    code: '4000', type: 'REVENUE',   currency: 'LKR' },
    { name: 'Cleaning Fee Income',            code: '4010', type: 'REVENUE',   currency: 'LKR' },
    { name: 'Event Income',                   code: '4020', type: 'REVENUE',   currency: 'LKR' },
    { name: 'F&B Income',                     code: '4030', type: 'REVENUE',   currency: 'LKR' },
    { name: 'Other Income',                   code: '4090', type: 'REVENUE',   currency: 'LKR' },

    // 5xxx — Cost of Sales
    { name: 'Food & Beverage Expense',        code: '5100', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Refunds & Adjustments',          code: '5110', type: 'EXPENSE',   currency: 'LKR' },

    // 6xxx — Operating Expense (payroll)
    { name: 'Salaries (Gross Accrual)',       code: '6100', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Wages (Net Paid)',               code: '6110', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Bonus',                          code: '6120', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Staff Welfare',                  code: '6130', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Complementaries',                code: '6140', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Statutory Contributions (EPF/ETF Employer)', code: '6150', type: 'EXPENSE', currency: 'LKR' },

    // 6xxx — Operating Expense (utilities & subscriptions)
    { name: 'Electricity',                    code: '6200', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Water',                          code: '6210', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Telephone & Internet',           code: '6220', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Software Subscriptions',         code: '6230', type: 'EXPENSE',   currency: 'LKR' },

    // 6xxx — Operating Expense (property)
    { name: 'Cleaning & Maintenance',         code: '6300', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Laundry & Housekeeping',         code: '6310', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Pool & Garden',                  code: '6320', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Gym Maintenance',                code: '6330', type: 'EXPENSE',   currency: 'LKR' },

    // 6xxx — Operating Expense (operations)
    { name: 'Fuel',                           code: '6400', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Gas',                            code: '6410', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Travel',                         code: '6420', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Other Operating Expense',        code: '6490', type: 'EXPENSE',   currency: 'LKR' },

    // 6xxx — Operating Expense (sales & admin)
    { name: 'Sales Promotion',                code: '6500', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Commission Expense',             code: '6510', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Admin & Professional Fees',      code: '6600', type: 'EXPENSE',   currency: 'LKR' },

    // 6xxx — Operating Expense (financing)
    { name: 'Loan Interest & Repayment',      code: '6700', type: 'EXPENSE',   currency: 'LKR' },

    // 7xxx — Capex
    { name: 'Minor Capex',                    code: '7100', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Capex — Equipment',              code: '7200', type: 'EXPENSE',   currency: 'LKR' },
    { name: 'Capex — Buildings',              code: '7300', type: 'EXPENSE',   currency: 'LKR' },

    // 9xxx — Suspense / Control
    { name: 'Suspense',                       code: '9999', type: 'SUSPENSE',  currency: 'LKR' },
  ];

  const accountMap: Record<string, string> = {};
  for (const acc of accountDefs) {
    const record = await prisma.account.upsert({
      where: { code: acc.code },
      update: {
        name: acc.name,
        type: acc.type,
        currency: acc.currency,
      },
      create: {
        organizationId: org.id,
        name: acc.name,
        code: acc.code,
        type: acc.type,
        currency: acc.currency,
        createdBy: 'seed',
      },
    });
    accountMap[acc.code] = record.id;
  }
  console.log(`✅ Chart of Accounts seeded (${accountDefs.length} accounts)`);

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
    { id: 'bk_007', propertyId: 'prop_marina_suite',    channelId: 'channel_airbnb',      checkIn: new Date(yr, 3, 5), checkOut: new Date(yr, 3, 9),  totalAmount: '860.00',  status: 'COMPLETED' },
    { id: 'bk_008', propertyId: 'prop_temple_bar',      channelId: 'channel_direct',      checkIn: new Date(yr, 3, 12),checkOut: new Date(yr, 3, 16), totalAmount: '740.00',  status: 'COMPLETED' },
    // Current-month bookings so MTD dashboard metrics are non-zero
    { id: 'bk_009', propertyId: 'prop_coastal_cottage', channelId: 'channel_airbnb',      checkIn: new Date(yr, 4, 2), checkOut: new Date(yr, 4, 7),  totalAmount: '1420.00', status: 'COMPLETED' },
    { id: 'bk_010', propertyId: 'prop_marina_suite',    channelId: 'channel_bookingcom',  checkIn: new Date(yr, 4, 9), checkOut: new Date(yr, 4, 13), totalAmount: '1080.00', status: 'COMPLETED' },
    { id: 'bk_011', propertyId: 'prop_temple_bar',      channelId: 'channel_airbnb',      checkIn: new Date(yr, 4, 16),checkOut: new Date(yr, 4, 20), totalAmount: '920.00',  status: 'CONFIRMED' },
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
        { accountId: accountMap['6510'], amount: '465.00',  isDebit: true },
        { accountId: accountMap['1000'], amount: '465.00',  isDebit: false },
      ],
    },
    // May (current month) — MTD numbers visible on dashboard
    {
      id: 'je_008',
      date: new Date(yr, 4, 7),
      memo: 'Coastal Cottage — Airbnb May 2–7',
      status: 'POSTED',
      lines: [
        { accountId: accountMap['1000'], amount: '1420.00', isDebit: true },
        { accountId: accountMap['4000'], amount: '1420.00', isDebit: false },
      ],
    },
    {
      id: 'je_009',
      date: new Date(yr, 4, 13),
      memo: 'Marina Suite — Booking.com May 9–13',
      status: 'POSTED',
      lines: [
        { accountId: accountMap['1000'], amount: '1080.00', isDebit: true },
        { accountId: accountMap['4000'], amount: '1080.00', isDebit: false },
      ],
    },
    {
      id: 'je_010',
      date: new Date(yr, 4, 13),
      memo: 'May Booking.com commission',
      status: 'POSTED',
      lines: [
        { accountId: accountMap['6510'], amount: '108.00',  isDebit: true },
        { accountId: accountMap['1000'], amount: '108.00',  isDebit: false },
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
