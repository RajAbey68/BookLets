import { Decimal } from 'decimal.js';
import type { JournalLineInput } from './types';

/**
 * RAJ-286 — Manual Journal Entry parsing/validation.
 *
 * Pure boundary validator behind the /ledger/new form and the
 * createManualJournalEntry server action: raw string form input in, a typed
 * and balanced entry (or a human-readable error) out. No DB, no network.
 * LedgerService.postEntry re-validates balance as the authority.
 */

export interface RawJournalLine {
  accountId: string;
  amount: string;
  isDebit: boolean;
}

export interface RawManualJournalEntry {
  date: string;
  memo?: string;
  lines: RawJournalLine[];
}

export interface ParsedManualJournalEntry {
  date: Date;
  memo?: string;
  lines: JournalLineInput[];
}

export type ParseResult =
  | { ok: true; value: ParsedManualJournalEntry }
  | { ok: false; error: string };

const MIN_LINES = 2;

/**
 * Validate and coerce raw form input into a balanced JournalEntryInput.
 *
 * `validAccountIds` is the set of account ids that belong to the caller's
 * organisation — every line's account is checked against it so a client can
 * never post against another tenant's account.
 */
export function parseManualJournalEntry(
  raw: RawManualJournalEntry,
  validAccountIds: ReadonlySet<string>,
): ParseResult {
  const date = new Date(raw.date);
  if (!raw.date || Number.isNaN(date.getTime())) {
    return { ok: false, error: 'A valid entry date is required.' };
  }

  const rawLines = raw.lines ?? [];
  if (rawLines.length < MIN_LINES) {
    return { ok: false, error: 'A journal entry must have at least two lines.' };
  }

  const lines: JournalLineInput[] = [];
  let debits = new Decimal(0);
  let credits = new Decimal(0);

  for (let i = 0; i < rawLines.length; i++) {
    const { accountId, amount: rawAmount, isDebit } = rawLines[i];
    const n = i + 1;

    if (!accountId) {
      return { ok: false, error: `Line ${n}: select an account.` };
    }
    if (!validAccountIds.has(accountId)) {
      return { ok: false, error: `Line ${n}: account not found in your organisation.` };
    }

    let amount: Decimal;
    try {
      amount = new Decimal(rawAmount);
    } catch {
      return { ok: false, error: `Line ${n}: amount is not a valid number.` };
    }
    if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
      return { ok: false, error: `Line ${n}: amount must be greater than zero.` };
    }

    if (isDebit) {
      debits = debits.plus(amount);
    } else {
      credits = credits.plus(amount);
    }
    lines.push({ accountId, amount, isDebit });
  }

  const diff = debits.minus(credits);
  if (!diff.isZero()) {
    return {
      ok: false,
      error: `Entry is unbalanced by ${diff.abs().toFixed(2)}. Debits must equal credits.`,
    };
  }

  const memo = raw.memo?.trim();
  return {
    ok: true,
    value: { date, memo: memo ? memo : undefined, lines },
  };
}
