import { prisma } from '../src/lib/prisma';
import { RevenueService } from '../src/lib/revenue.service';
import { Decimal } from 'decimal.js';

/**
 * Verification Script: Hostaway Sync & Revenue Recognition
 * 
 * This script demonstrates:
 * 1. Syncing reservations from Hostaway (Mock).
 * 2. Recognizing revenue for a guest who checked out today.
 * 3. Verifying the double-entry results in the ledger.
 */
async function testSync() {
  console.log('--- STARTING HOSTAWAY INTEGRATION TEST ---');

  // 1. Setup: Ensure an Organization and Property exist
  const org = await prisma.organization.upsert({
    where: { id: 'org_test_001' },
    update: {},
    create: { id: 'org_test_001', name: 'Test Rentals' }
  });

  const property = await prisma.property.upsert({
    where: { hostawayId: '501' },
    update: {},
    create: {
      name: 'Oceanfront Penthouse',
      address: '123 Beach Rd',
      type: 'APARTMENT',
      status: 'ACTIVE',
      hostawayId: '501',
      organizationId: org.id
    }
  });

  // Ensure a Fiscal Period exists for the current date
  const today = new Date();
  const startOfYear = new Date(today.getFullYear(), 0, 1);
  const endOfYear = new Date(today.getFullYear(), 11, 31);
  
  await prisma.fiscalPeriod.upsert({
    where: { id: 'fp_2026' },
    update: {},
    create: {
      id: 'fp_2026',
      organizationId: org.id,
      name: 'FY 2026',
      startDate: startOfYear,
      endDate: endOfYear,
      isClosed: false
    }
  });

  console.log(`[Test] Confirmed Organization: ${org.name} and Property: ${property.name}`);

  // 2. Execute Sync
  // This will pull 2 mock reservations: 
  // - Res 1: Checked out today (Should be recognized)
  // - Res 2: Active (Should remain in Deferred Revenue)
  await RevenueService.syncAndProcess(org.id);

  // 3. Verify Outcomes
  const confirmed = await prisma.booking.findMany({ where: { propertyId: property.id } });
  console.log(`[Test] Total bookings synced: ${confirmed.length}`);

  const completed = confirmed.filter(b => b.status === 'COMPLETED');
  const pending = confirmed.filter(b => b.status === 'CONFIRMED');

  console.log(`[Test] Completed (Recognized): ${completed.length}`);
  console.log(`[Test] Pending (Deferred): ${pending.length}`);

  // 4. Check Ledger
  const entries = await prisma.journalEntry.findMany({
    where: { memo: { contains: 'Revenue Recognition' } },
    include: { lines: { include: { account: true } } }
  });

  console.log('\n--- LEDGER VERIFICATION ---');
  entries.forEach(entry => {
    console.log(`Entry: ${entry.memo}`);
    entry.lines.forEach(line => {
      console.log(`  ${line.isDebit ? 'DR' : 'CR'} ${line.account.name}: €${line.amount}`);
    });
  });

  console.log('\n--- TEST COMPLETE ---');
}

testSync()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
