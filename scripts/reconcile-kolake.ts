/**
 * Ko Lake ↔ BookLets daily reconciliation (local pilot — no GCP, per the
 * 2026-07-04 decision; agentisation-design.md §9 / Linear RAJ-510).
 *
 * Thin wiring only — all logic lives in src/lib/reconciliation*.ts and is
 * unit-tested. This script:
 *   1. loads PENDING GuestPayout rows + CONFIRMED bookings for the org,
 *   2. runs the deterministic matcher (minor units, ±3-day window),
 *   3. sends only ambiguous rows to DeepSeek (direct REST, key from env —
 *      the cron wrapper pulls it from the macOS Keychain, never a file),
 *   4. posts DRAFT journal pairs via LedgerService (idempotent re-runs),
 *   5. emits a one-line digest to console and, if configured, Telegram.
 *
 * Env: DATABASE_URL (required), DEEPSEEK_API_KEY (optional — without it
 * ambiguous rows stay exceptions), RECON_ORG_NAME, RECON_LOOKBACK_DAYS,
 * RECON_BANK_ACCOUNT, TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (optional).
 */
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { prisma } from '../src/lib/prisma';
import { LedgerService } from '../src/lib/ledger.service';
import { SETTLEMENT_WINDOW_DAYS, type PayoutRow, type BookingRow } from '../src/lib/reconciliation';
import { runReconciliation } from '../src/lib/reconciliation-runner';
import { adjudicateAmbiguity } from '../src/lib/reconciliation-llm';

const MS_PER_DAY = 86_400_000;
const DEFAULT_LOOKBACK_DAYS = 30;

/**
 * Pre-flight account validation. Deliberately NO auto-creation: the chart of
 * accounts must never be mutated by a cron job (four-eyes review finding —
 * silent account creation is an audit/control violation and a rename would
 * spawn duplicates). Missing accounts fail the run loudly instead.
 */
async function resolveAccounts(organizationId: string) {
  const bankName = process.env.RECON_BANK_ACCOUNT ?? 'Operating Cash';
  const clearingName = process.env.RECON_CLEARING_ACCOUNT ?? 'Payout Clearing';

  const [bank, clearing] = await Promise.all([
    prisma.account.findFirst({ where: { organizationId, name: bankName } }),
    prisma.account.findFirst({ where: { organizationId, name: clearingName } }),
  ]);

  const missing = [
    ...(bank ? [] : [`"${bankName}" (bank/debit side — set RECON_BANK_ACCOUNT or create it)`]),
    ...(clearing
      ? []
      : [`"${clearingName}" (SUSPENSE clearing/credit side — set RECON_CLEARING_ACCOUNT or create it)`]),
  ];
  if (missing.length > 0 || !bank || !clearing) {
    throw new Error(
      `Pre-flight failed for org ${organizationId} — missing account(s): ${missing.join('; ')}. ` +
        `The reconciliation job never creates accounts itself.`
    );
  }

  return { bankAccountId: bank.id, clearingAccountId: clearing.id };
}

async function notify(digest: string): Promise<void> {
  console.log(digest);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: digest }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.error(`[recon] Telegram notify failed: HTTP ${res.status}`);
  } catch (err) {
    console.error('[recon] Telegram notify failed:', err instanceof Error ? err.message : err);
  }
}

async function main() {
  const runDate = new Date();
  const lookbackDays = Number(process.env.RECON_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS);
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) {
    throw new Error(`RECON_LOOKBACK_DAYS must be a positive number, got "${process.env.RECON_LOOKBACK_DAYS}".`);
  }
  const since = new Date(runDate.getTime() - lookbackDays * MS_PER_DAY);

  const org = process.env.RECON_ORG_NAME
    ? await prisma.organization.findFirst({ where: { name: process.env.RECON_ORG_NAME } })
    : await prisma.organization.findFirst();
  if (!org) throw new Error('No organization found — check RECON_ORG_NAME / seed data.');

  const payoutRecords = await prisma.guestPayout.findMany({
    where: { organizationId: org.id, status: 'PENDING', date: { gte: since } },
    orderBy: { date: 'asc' },
  });
  // Bookings can check out up to a window before the earliest payout we consider.
  const bookingSince = new Date(since.getTime() - SETTLEMENT_WINDOW_DAYS * MS_PER_DAY);
  const bookingRecords = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      checkOut: { gte: bookingSince },
      property: { organizationId: org.id },
    },
    orderBy: { checkOut: 'asc' },
  });

  const payouts: PayoutRow[] = payoutRecords.map((p) => ({
    id: p.id,
    date: p.date,
    amount: p.amount.toString(),
    reference: p.reference,
  }));
  const bookings: BookingRow[] = bookingRecords.map((b) => ({
    id: b.id,
    checkOut: b.checkOut,
    totalAmount: b.totalAmount.toString(),
  }));

  console.log(
    `[recon] org=${org.name} payouts=${payouts.length} bookings=${bookings.length} ` +
      `lookback=${lookbackDays}d window=±${SETTLEMENT_WINDOW_DAYS}d ` +
      `deepseek=${process.env.DEEPSEEK_API_KEY ? 'on' : 'off'}`
  );

  const accounts = await resolveAccounts(org.id);

  const summary = await runReconciliation({
    organizationId: org.id,
    accounts,
    payouts,
    bookings,
    postEntry: (input) => LedgerService.postEntry(input),
    updatePayoutStatus: async (payoutId, status) => {
      await prisma.guestPayout.update({ where: { id: payoutId }, data: { status } });
    },
    adjudicate: (ambiguity) =>
      adjudicateAmbiguity(ambiguity, {
        apiKey: process.env.DEEPSEEK_API_KEY,
        allowReferences: process.env.RECON_ALLOW_REFERENCES === 'true',
      }),
    notify,
    runDate,
  });

  // Silent-degradation guard (four-eyes review finding): ambiguous rows piling
  // up because the key vanished must be loud, not a quiet exception trickle.
  if (!process.env.DEEPSEEK_API_KEY && summary.exceptions.some((e) => e.reason.startsWith('ambiguous'))) {
    console.error(
      '[recon] WARNING: ambiguous payouts left unresolved because DEEPSEEK_API_KEY is not set — ' +
        'check the Keychain "deepseek-api" entry on this machine.'
    );
  }

  // Business exceptions are reported in the digest, not as a process failure —
  // cron exit != 0 is reserved for setup/infra faults.
  console.log(
    `[recon] done: matched=${summary.matched} llm_resolved=${summary.llmResolved} exceptions=${summary.exceptions.length}`
  );
}

main()
  .catch((err) => {
    console.error('[recon] FATAL:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
