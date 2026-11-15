# THIRD-PARTY MODEL REVIEW — ledger repair code (15 Nov 2026)

Requested reviewer: DeepSeek V4.1 Flash. NOT RUN: the OpenRouter workspace behind the available key refuses every DeepSeek endpoint ("Model blocked by guardrail"); it allows nine free models only. On the owner's instruction "Use an allowed model", two allowed models were used instead.

Input to both: the owner-approved rules (TEST-PLAN.md sections 2-3), the unified diff of `src` and `tests` against `main` at commit `7e2151b`, the full current `src/lib/ledger.service.ts`, and the one production caller of `reverseEntry`. Same prompt, temperature 0. The first attempt (6,000 output tokens) returned no text from either model; the run below used 30,000 with low reasoning effort.

## Dispositions (author's triage; the verbatim outputs follow)

### NVIDIA Nemotron 3 Ultra — verdict REJECT; none of its four must-fix items stands

| Its finding | Disposition |
|---|---|
| P0-1 null `originalEntry.date` crashes key computation | rejected — `JournalEntry.date` is a required column (`date DateTime` in `prisma/schema.prisma`); a stored entry cannot have a null date |
| P0-2 race-recovery lookup should use `idempotencyKey` instead of `source`/`sourceId` | rejected as a defect — the reviewer calls the gap theoretical; the key is derived from the same `'reversal'` + original id, and the same lookup serves the repeat-call rule. Either lookup finds the same row |
| P1-1 `new Decimal(line.amount)` without `.toString()` | rejected — line unchanged by this diff; decimal.js accepts the Prisma decimal directly and the tests assert the resulting values |
| P1-2 empty-string currency treated as a stated currency | already recorded as a residual (TEST-PLAN section 10); owner's call, no current caller produces it |
| P2-1 C-8 relies on the helper supplying `source`/`sourceId` | no change — the helper does supply them; if it stopped, the assertion would fail, not pass silently |
| P2-2, P3-1 | no change — the reviewer marks both acceptable as-is |

It states single-currency behaviour of `validateTrialBalance` is unchanged.

### Cohere North Mini Code — verdict APPROVE WITH FIXES; output truncated at the token limit

| Its finding | Disposition |
|---|---|
| Returning the counter-entry with lines "breaks" the `{ id: string }` return type | rejected — an object with `id` plus more fields satisfies `{ id: string }`; `tsc --noEmit` passes. Only this one finding was produced before truncation, so this review is incomplete |

Net result: no new change required. Two free general models are weaker evidence than the requested reviewer; the DeepSeek review remains outstanding.

## Verbatim — NVIDIA Nemotron 3 Ultra

- id: `gen-1794731948-bpYZG66EUoBTEpfOPDMl`
- model: `nvidia/nemotron-3-ultra-550b-a55b:free`
- provider: Nvidia
- usage: prompt 18056, completion 14612, total 32668
- finish_reason: stop

````text
VERDICT: REJECT

[P0-1] P0 blocker — src/lib/ledger.service.ts:450 — Missing null check for originalEntry.date when computing idempotency key — If an old JournalEntry has a null date (the rule D2 explicitly states "there is no fallback when the date is missing"), `computeIdempotencyKey` calls `date.toISOString()` and throws `TypeError: Cannot read property 'toISOString' of null` instead of a proper error. This crashes the reversal endpoint. — Fix: Guard `originalEntry.date` before computing the key; throw a clear error (e.g., "Original entry has no date, cannot reverse").

[P0-2] P0 blocker — src/lib/ledger.service.ts:495 — Race-recovery lookup uses wrong unique key — The catch block re-queries with `where: { organizationId, source: 'reversal', sourceId: entryId }`, but the unique index that caused the P2002 is on `(organizationId, idempotencyKey)`. While the winner *should* have matching `source`/`sourceId`, the lookup should use the same key that the unique index enforces (`idempotencyKey`) to be certain and to avoid a theoretical gap if a future migration changes linkage fields. — Fix: In the catch block, look up by `{ organizationId, idempotencyKey }` (the `idempotencyKey` variable is in scope).

[P1-1] P1 must fix — src/lib/ledger.service.ts:453 — Amount conversion in reversed lines omits `.toString()` — `reversedLines` uses `new Decimal(line.amount)` while `postEntry` uses `new Decimal(line.amount.toString())`. Prisma returns a `Decimal`-compatible object; relying on the constructor without `.toString()` is less robust and inconsistent. — Fix: Change to `amount: new Decimal(line.amount.toString())`.

[P1-2] P1 must fix — src/lib/ledger.service.ts:55 — `validateTrialBalance` treats empty-string currency as a distinct denomination — The rule defines denomination as "currency string exactly as given, or the marker *unspecified* when currency is undefined". An empty string is a currency string (albeit invalid), so the current behaviour is technically correct per spec, but it will reject entries with `currency: ''` mixed with `currency: 'LKR'` with a confusing error listing `''` and `'LKR'`. No caller produces empty strings today, but the check should either normalise empty to `undefined` or document that empty is a valid currency code. — Fix: Decide and document; if empty should be treated as unspecified, map `line.currency ?? null` to `line.currency || null`.

[P2-1] P2 should fix — tests/unit/journal-idempotency.test.ts:260 — Test C-8 assumes idempotency fast-path runs — The test expects `findFirst` to be called once, but the fast-path only runs when an `idempotencyKey` (or `source`+`sourceId`) is present. The `post` helper is not shown; if it stops providing a key, the test would pass incorrectly (validation would still run, but the `findFirst` assertion would fail). — Fix: Make the test explicitly provide `source`/`sourceId` or `idempotencyKey` in the input so the fast-path is guaranteed.

[P2-2] P2 should fix — src/lib/ledger.service.ts:495 — `isIdempotencyConflict` returns true for any P2002 with no `meta.target` — This is conservative but correct; however, if another unique index on the same table ever includes `idempotencyKey` as a non-leading column, a conflict on that index would be misidentified. Low risk now. — Fix: Acceptable as-is; add a comment that the key is the only unique nullable field involving `idempotencyKey`.

[P3-1] P3 minor — src/lib/ledger.service.ts:58 — Mixed-currency error message sorts `'(none stated)'` before currency codes — `labels.sort()` puts `'(none stated)'` first alphabetically. Purely cosmetic. — Fix: Not required.

**Single-currency behaviour of `validateTrialBalance` is UNCHANGED** — Tests C-3, C-4, C-5 confirm that balanced single-currency entries (all same code or all omitted) still pass, unbalanced single-currency entries still report "unbalanced", and the line-count check still runs first.

MUST FIX BEFORE MERGE: P0-1, P0-2, P1-1, P1-2
````

## Verbatim — Cohere North Mini Code

- id: `gen-1794731948-xZI6Q9WnmPE47rd6H9OO`
- model: `cohere/north-mini-code:free`
- provider: Cohere
- usage: prompt 16900, completion 29998, total 46898
- finish_reason: length

````text
VERDICT: APPROVE WITH FIXES

[ID] P0 blocker — src/lib/ledger.service.ts:415-416 — reverseEntryScoped returns existingReversal (including lines) but the method signature promises `{ id: string }`. This type mismatch could cause callers to receive unexpected data, though the only caller (`handleBookingCancellation`) ignores the return value. However, the type contract is broken and could mislead future callers. Fix: adjust return type to match actual return, or ensure the returned object only contains `id`. Since the method is public and used elsewhere? The only caller ignores it, but we should preserve the contract. Change the return type to `Prisma.JournalEntryGetPayload<{ include: { lines: true } }>` and update the caller if needed. However, the caller expects an object with an `id` property; it will still work. The safest fix is to return only `{ id: existingReversal.id }` when returning existing reversal, but that would require restructuring. Since the method is internal (only used by `handleBookingCancellation`), we can change the return type to match the actual return and update the caller accordingly. However, the caller does not use the return value, so we can keep the return as is but fix the type annotation. Let's examine the method signature: `static async reverseEntry(...) : Promise<{ id: string }>`. We need to change it to `Promise<Prisma.JournalEntryGetPayload<{ include: { lines: true } }>>
````
