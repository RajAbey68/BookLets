import { Decimal } from 'decimal.js';
import { JournalEntryInput, JournalLineInput, JournalStatus } from './types';

/**
 * Ko Lake reconciliation pilot — deterministic matcher core.
 *
 * Money never touches binary floats: amounts arrive as decimal strings
 * (Prisma Decimal .toString()) and are compared as integer minor units via
 * decimal.js exact arithmetic. Matching is deterministic-first; only payouts
 * with 2+ equal-amount candidates are handed to the LLM adjudicator.
 */

const MS_PER_DAY = 86_400_000;

/** Default settlement window: payout date within ±3 calendar days of check-out. */
export const SETTLEMENT_WINDOW_DAYS = 3;

export interface PayoutRow {
  id: string;
  date: Date;
  /** Decimal string, e.g. "1250.00" (Prisma Decimal .toString()). */
  amount: string;
  reference?: string | null;
}

export interface BookingRow {
  id: string;
  checkOut: Date;
  /** Decimal string, e.g. "1250.00". */
  totalAmount: string;
}

export interface Match {
  payoutId: string;
  bookingId: string;
  amount: string;
  date: Date;
}

export interface Ambiguity {
  payout: PayoutRow;
  candidates: BookingRow[];
}

export interface Unmatched {
  payout: PayoutRow;
  reason: string;
}

export interface ReconcileResult {
  matched: Match[];
  ambiguous: Ambiguity[];
  unmatched: Unmatched[];
}

/**
 * Convert a decimal money string to integer minor units (2dp currencies).
 * Throws on sub-minor-unit precision or non-numeric input — a reconciliation
 * must never silently round money.
 */
export function toMinorUnits(amount: string, minorUnitScale = 2): number {
  const minor = new Decimal(amount).times(new Decimal(10).pow(minorUnitScale));
  if (!minor.isInteger()) {
    throw new Error(`Amount "${amount}" has sub-minor unit precision; refusing to round money.`);
  }
  const n = minor.toNumber();
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Amount "${amount}" exceeds the safe integer range in minor units.`);
  }
  return n;
}

/** UTC calendar-day distance between two instants. */
function calendarDayDistance(a: Date, b: Date): number {
  return Math.abs(Math.floor(a.getTime() / MS_PER_DAY) - Math.floor(b.getTime() / MS_PER_DAY));
}

/**
 * Deterministic pass: for each payout (processed in ascending date order so
 * results are order-independent), find bookings with an exactly equal
 * minor-unit amount whose check-out is within the settlement window.
 * Exactly one candidate → matched (booking consumed). Two or more →
 * ambiguous. Zero → unmatched exception.
 */
export function reconcile(
  payouts: PayoutRow[],
  bookings: BookingRow[],
  windowDays: number = SETTLEMENT_WINDOW_DAYS
): ReconcileResult {
  const matched: Match[] = [];
  const ambiguous: Ambiguity[] = [];
  const unmatched: Unmatched[] = [];

  const available = new Map(bookings.map((b) => [b.id, b]));
  const orderedPayouts = [...payouts].sort((a, b) => a.date.getTime() - b.date.getTime());

  for (const payout of orderedPayouts) {
    const payoutMinor = toMinorUnits(payout.amount);
    const candidates = [...available.values()].filter(
      (b) =>
        toMinorUnits(b.totalAmount) === payoutMinor &&
        calendarDayDistance(payout.date, b.checkOut) <= windowDays
    );

    if (candidates.length === 1) {
      available.delete(candidates[0].id);
      matched.push({
        payoutId: payout.id,
        bookingId: candidates[0].id,
        amount: payout.amount,
        date: payout.date,
      });
    } else if (candidates.length > 1) {
      ambiguous.push({ payout, candidates });
    } else {
      unmatched.push({ payout, reason: 'no booking within window' });
    }
  }

  return { matched, ambiguous, unmatched };
}

/**
 * Assert a set of journal lines balances: sum(debits) == sum(credits) in
 * minor units. Throws — a draft pair that does not balance is a bug, not data.
 */
export function assertBalanced(lines: JournalLineInput[]): void {
  let balance = 0;
  for (const line of lines) {
    const minor = toMinorUnits(line.amount.toString());
    balance += line.isDebit ? minor : -minor;
  }
  if (balance !== 0) {
    throw new Error(
      `Unbalanced journal pair: debits and credits differ by ${balance} minor units.`
    );
  }
}

export interface ReconAccountIds {
  bankAccountId: string;
  clearingAccountId: string;
}

/**
 * Build the DRAFT journal pair for a confirmed match:
 * DR bank (money arrived) / CR payout clearing, source='reconciliation',
 * sourceId=<payout id> so LedgerService idempotency makes re-runs safe.
 */
export function buildDraftJournalInput(
  organizationId: string,
  match: Match,
  accounts: ReconAccountIds
): JournalEntryInput {
  const lines: JournalLineInput[] = [
    { accountId: accounts.bankAccountId, amount: match.amount, isDebit: true },
    { accountId: accounts.clearingAccountId, amount: match.amount, isDebit: false },
  ];
  assertBalanced(lines);

  return {
    organizationId,
    date: match.date,
    memo: `Reconciliation: payout ${match.payoutId} matched to booking ${match.bookingId}`,
    status: JournalStatus.DRAFT,
    lines,
    source: 'reconciliation',
    sourceId: match.payoutId,
    operation: 'payout-match',
    makerIdentity: 'recon-bot',
  };
}

export interface DigestInput {
  runDate: Date;
  matched: number;
  ambiguousResolved: number;
  exceptions: { payoutId: string; amount: string; reason: string }[];
}

/** One-line digest for Telegram/console. */
export function formatDigest(input: DigestInput): string {
  const day = input.runDate.toISOString().slice(0, 10);
  const head =
    `KoLake recon ${day}: matched=${input.matched} ` +
    `llm_resolved=${input.ambiguousResolved} exceptions=${input.exceptions.length}`;
  if (input.exceptions.length === 0) return head;
  const tail = input.exceptions
    .map((e) => `${e.payoutId} ${e.amount} (${e.reason})`)
    .join('; ');
  return `${head} | ${tail}`;
}
