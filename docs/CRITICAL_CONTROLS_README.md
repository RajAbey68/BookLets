# Critical Accounting Controls

## Overview

This document describes the critical database and application controls implemented to enforce fiscal integrity, prevent double-posting, and protect the audit trail.

**Status**: Required before P2 ship ✋

---

## Components

### 1. Period Closure Enforcement (Task #1)

**What it does**: Prevents any edits to journal entries that fall within a closed fiscal period.

**How it works**:
- Database trigger `prevent_journal_entry_edit_closed_period` fires BEFORE UPDATE on JournalEntry
- Checks if the entry's date falls within a `FiscalPeriod` where `isClosed = true`
- Raises exception: "Fiscal Integrity Violation: Cannot modify journal entry dated X because it falls within closed period Y"

**Layer of enforcement**:
- Database: Trigger (primary)
- Application: Prisma extension checks fiscal period (backup)

**Application code**:
- `src/lib/prisma.ts` - `create()` and `update()` interceptors
- Queries `FiscalPeriod` by `organizationId`, `startDate`, `endDate`, `isClosed`

**Testing**:
```typescript
// Negative test: Attempt to post to closed period
const closedPeriod = await prisma.fiscalPeriod.create({
  data: { name: 'May 2026', startDate, endDate, isClosed: true, organizationId }
});

try {
  await prisma.journalEntry.create({
    data: {
      organizationId,
      date: dateInMay, // Falls within closed period
      status: 'POSTED',
      lines: { create: [...] }
    }
  });
  // Should throw
} catch (err) {
  assert(err.message.includes('Fiscal Integrity Violation'));
}
```

---

### 2. Idempotency via sourceHash (Task #2)

**What it does**: Prevents duplicate posting when spreadsheet uploads are retried.

**How it works**:
- Each JournalEntry now has a `sourceHash` field (STRING, unique, nullable)
- When posting from a spreadsheet upload, compute SHA256 hash from:
  ```
  {
    sandboxSessionId: upload_session_id,
    amount: total_amount_string,
    date: YYYY-MM-DD,
    description: transaction_description
  }
  ```
- Before posting, check if a JournalEntry with this sourceHash already exists
- If yes: return the existing entry (idempotent)
- If no: create new entry with the sourceHash

**Layer of enforcement**:
- Database: UNIQUE constraint on `sourceHash` (primary)
- Application: Pre-check in `JournalEntry.create()` (backup)

**Application code**:
- `src/lib/idempotency.ts` - helper functions:
  - `computeSourceHash(input)` → SHA256 hex
  - `isAlreadyPosted(sourceHash, prisma)` → boolean

**Usage example**:
```typescript
import { computeSourceHash, isAlreadyPosted } from '@/lib/idempotency';

// When posting a parsed spreadsheet:
const hash = computeSourceHash({
  sandboxSessionId: parsedResult.sessionId,
  amount: parsedResult.netAmount.toString(),
  date: parsedResult.periodLabel, // or compute from date
  description: parsedResult.sheetName
});

const alreadyPosted = await isAlreadyPosted(hash, prisma);
if (alreadyPosted) {
  console.log('Already posted; skipping');
  return;
}

const entry = await prisma.journalEntry.create({
  data: {
    organizationId,
    date,
    sourceHash: hash,
    status: 'POSTED',
    lines: { create: [...] }
  }
});
```

**Testing**:
```typescript
// Positive test: Idempotent re-post returns same entry
const entry1 = await prisma.journalEntry.create({ data: { sourceHash: 'abc123', ... } });
const entry2 = await prisma.journalEntry.create({ data: { sourceHash: 'abc123', ... } });
assert.deepEqual(entry1.id, entry2.id);

// Negative test: Different hashes create different entries
const entry3 = await prisma.journalEntry.create({ data: { sourceHash: 'def456', ... } });
assert.notEqual(entry1.id, entry3.id);
```

---

### 3. Double-Entry Validation (Task #4)

**What it does**: Ensures journal entries obey double-entry rules before posting.

**Rules**:
1. Entry must have at least 2 lines (debit + credit minimum)
2. Sum of debit amounts must equal sum of credit amounts

**How it works**:
- Database trigger `validate_journal_entry_balance` fires BEFORE INSERT/UPDATE on JournalEntry when status = 'POSTED'
- Application-level validation in `src/lib/prisma.ts` as backup
- Trigger queries `JournalLine` for the entry and checks:
  - Line count ≥ 2
  - SUM(amount WHERE isDebit = true) = SUM(amount WHERE isDebit = false)

**Layer of enforcement**:
- Database: Trigger (primary)
- Application: Prisma extension pre-check (backup)

**Application code**:
- `src/lib/prisma.ts` - `create()` interceptor
- Computes balance using `Decimal.js` for precision

**Testing**:
```typescript
// Negative test: Unbalanced entry
try {
  await prisma.journalEntry.create({
    data: {
      organizationId,
      date: now,
      status: 'POSTED',
      lines: {
        create: [
          { accountId: debitAcc, amount: new Decimal('100'), isDebit: true },
          { accountId: creditAcc, amount: new Decimal('50'), isDebit: false }
        ]
      }
    }
  });
  // Should throw
} catch (err) {
  assert(err.message.includes('Trial Balance Violation'));
}

// Positive test: Balanced entry
const entry = await prisma.journalEntry.create({
  data: {
    organizationId,
    date: now,
    status: 'POSTED',
    lines: {
      create: [
        { accountId: debitAcc, amount: new Decimal('100'), isDebit: true },
        { accountId: creditAcc, amount: new Decimal('100'), isDebit: false }
      ]
    }
  }
});
assert.equal(entry.status, 'POSTED');
```

---

### 4. Posted Entry Immutability (Bonus)

**What it does**: Prevents any edits to POSTED entries (only reversals allowed).

**How it works**:
- Database trigger `prevent_edit_posted_entry` fires BEFORE UPDATE on JournalEntry
- If `OLD.status = 'POSTED'` and any data changes, raises exception
- Application-level delete check in Prisma extension

**Layer of enforcement**:
- Database: Trigger (primary)
- Application: Prisma extension `delete()` interceptor (backup)

---

## Migration Instructions

### Apply the Migration

**In Supabase Dashboard or via CLI:**

```bash
# Via psql CLI:
psql $DATABASE_URL -f prisma/migrations/manual/add_critical_accounting_controls.sql

# Via Supabase dashboard:
# 1. Go to SQL Editor
# 2. Paste contents of: prisma/migrations/manual/add_critical_accounting_controls.sql
# 3. Run query
```

**Verify success:**
```sql
-- Check triggers are installed:
SELECT * FROM pg_triggers 
WHERE tgname LIKE 'prevent_%' OR tgname LIKE 'validate_%';

-- Should return 3 rows:
-- prevent_journal_entry_edit_closed_period
-- prevent_edit_posted_journal_entry
-- validate_journal_entry_balance

-- Check sourceHash column:
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'JournalEntry' AND column_name = 'sourceHash';

-- Check unique index:
SELECT indexname FROM pg_indexes WHERE tablename = 'JournalEntry';
-- Should include: JournalEntry_sourceHash_key
```

### Update Prisma Client

The schema is already updated with `sourceHash`. Run:
```bash
npx prisma generate
```

---

## Checklist for P2 Ship

- [ ] Migration applied to production database
- [ ] Triggers verified (3 active triggers)
- [ ] sourceHash column added + unique index
- [ ] `src/lib/idempotency.ts` imported in posting code
- [ ] `src/lib/prisma.ts` updated with idempotency check
- [ ] Double-entry tests pass (balanced vs unbalanced)
- [ ] Period closure tests pass (can't post to closed period)
- [ ] Idempotency tests pass (hash collision detection)
- [ ] Code review on all changes
- [ ] CI/CD pipeline passes

---

## Error Messages (User-Facing)

### Period Closure
```
Fiscal Integrity Violation: Cannot post to 2026-05-15 — it falls within 
closed fiscal period "May 2026".
```

### Double-Entry Violation
```
Trial Balance Violation: Entry is unbalanced by 50.00 LKR. Debits must 
equal Credits.

Trial Balance Violation: A journal entry must have at least 2 lines to 
enforce double-entry bookkeeping.
```

### Posted Entry Edit Attempt
```
Audit Integrity Violation: Cannot edit a POSTED journal entry (id: abc123). 
Create a reversing entry instead.
```

---

## Future Enhancements

### Phase 2 (P5):
- [ ] Multi-currency variance tolerance (±0.5% FX tolerance)
- [ ] Variance reconciliation table + audit trail
- [ ] Automatic reversal entry generation
- [ ] Soft-delete on JournalEntry (not hard delete)

### Phase 3 (P5+):
- [ ] Accounting rules engine (auto-categorize common patterns)
- [ ] Budget vs actual reporting
- [ ] Cost center allocation

---

## References

- SLFRS Requirements: [SL Financial Reporting Standards](https://www.casl.lk/)
- Double-Entry Bookkeeping: [Accounting Standards Overview](https://www.ifrs.org/)
- Migration Location: `prisma/migrations/manual/add_critical_accounting_controls.sql`
- Application Code: `src/lib/prisma.ts`, `src/lib/idempotency.ts`
