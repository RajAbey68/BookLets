/**
 * One place that decides how money is rendered.
 *
 * Before this module, nine separate files each called
 * `Intl.NumberFormat('de-DE', { currency: 'EUR' })` inline. Every ledger line
 * the importers write is LKR — ocr-bridge.ts and statement-ingest.ts both pass
 * `currency: 'LKR'` explicitly — so those nine call sites were painting a euro
 * sign onto rupee amounts. The number was right and the symbol was wrong,
 * which is the worst combination: nothing looks broken enough to investigate,
 * and the operator reads a figure ~350x its real value.
 *
 * Fixing it in nine places would have left a tenth to be written next week.
 * Import from here instead.
 */

/**
 * The books' currency.
 *
 * A constant rather than a lookup because there is genuinely one currency
 * today: Ko Lake operates in Sri Lanka and every imported line is LKR. When a
 * second currency becomes real, this is the single symbol to widen into an
 * organisation-level setting — and the compiler will point at every use.
 *
 * NOTE: `Account.currency` and `JournalLine.currency` now default to "LKR" in
 * prisma/schema.prisma, via 20260802_currency_default_lkr — but that migration
 * is NOT yet applied in production, where the column default is still "EUR".
 *
 * That matters because not every write path sets a currency. The two importers
 * do, but zip-ingest posts lines with `currency: undefined`, so Postgres
 * applies the column default and the row lands as EUR. Production already
 * holds such rows. Existing rows are deliberately not rewritten by the
 * migration: a genuinely-EUR row is indistinguishable from one that merely
 * inherited the default, so that call needs eyes on real data first.
 */
export const BOOKS_CURRENCY = 'LKR';

/**
 * Above this booking value, revenue recognition parks the entry as DRAFT for
 * a human to approve instead of posting it automatically.
 *
 * DENOMINATED IN BOOKS_CURRENCY. This was previously the bare literal 10000
 * in revenue.service.ts, commented "€10k threshold for manual review" — and
 * 10,000 rupees is roughly thirty euro. Left as it was, the control would
 * have caught essentially every booking Ko Lake takes and buried the operator
 * in an approval queue, while looking like a considered threshold.
 *
 * 3,500,000 LKR keeps the original intent — about €10,000 at the rate in
 * effect when this was written — rather than inventing a new policy. It is a
 * BUSINESS decision, not a technical one: raise it and large bookings post
 * without a second pair of eyes; lower it and routine bookings queue up.
 * Change it here, deliberately.
 */
export const HIGH_VALUE_REVIEW_THRESHOLD = 3_500_000;

/**
 * Locale used for grouping and decimal marks.
 *
 * 'en-LK' renders LKR as "Rs 1,550.00" with the thousands/decimal convention
 * Sri Lankan statements use. The previous 'de-DE' produced "1.550,00 €" —
 * dots for thousands and commas for decimals — which is actively misleading
 * on a Sri Lankan set of books even before the wrong symbol.
 */
const MONEY_LOCALE = 'en-LK';

/**
 * What the call sites actually hold.
 *
 * Amounts reach the screen as Prisma `Decimal`s, as the strings the ledger
 * serialises, and occasionally as plain numbers. Accepting all three keeps
 * `Number(...)` conversions out of nine call sites — and, more to the point,
 * keeps anyone from reaching for a float earlier in the chain than necessary.
 */
export type MoneyLike = string | number | { toString(): string };

/**
 * Format a ledger amount for display.
 *
 * Accepts the string form the ledger stores (Decimal serialised, never a
 * float) as well as numbers, so call sites do not have to convert and risk
 * precision loss on the way to the screen.
 *
 * `currency` defaults to the books' currency but is accepted per call so rows
 * that genuinely carry another currency render as themselves rather than
 * being relabelled — the same bug in the opposite direction.
 */
export function formatMoney(
  amount: MoneyLike,
  currency: string = BOOKS_CURRENCY,
): string {
  const value = typeof amount === 'number' ? amount : Number(amount.toString());
  if (!Number.isFinite(value)) return String(amount);
  try {
    return new Intl.NumberFormat(MONEY_LOCALE, { style: 'currency', currency }).format(value);
  } catch {
    // An unknown or malformed currency code must not blank out a figure on
    // screen — show the number with the code beside it instead.
    return `${new Intl.NumberFormat(MONEY_LOCALE).format(value)} ${currency}`;
  }
}
