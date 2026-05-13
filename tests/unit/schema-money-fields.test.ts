/**
 * Schema money-field precision tests — TDD gate for Float→Decimal migration.
 *
 * These tests read prisma/schema.prisma and assert that every field that
 * holds a monetary amount uses Decimal, not Float. Float has ~15 significant
 * digits and cannot represent 0.1 + 0.2 exactly; in a double-entry ledger
 * this compounds across thousands of transactions.
 *
 * Tests are INTENTIONALLY FAILING before the schema fix is applied.
 * They become green once the migration lands.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const schemaPath = path.resolve(__dirname, '../../prisma/schema.prisma');
const schema = fs.readFileSync(schemaPath, 'utf-8');

/**
 * Parse a model block out of the schema.
 * Returns the raw text between `model <name> {` and the matching closing `}`.
 */
function getModel(name: string): string {
  const regex = new RegExp(`model\\s+${name}\\s*\\{([^}]+)\\}`, 's');
  const match = schema.match(regex);
  if (!match) throw new Error(`Model "${name}" not found in schema.prisma`);
  return match[1];
}

/**
 * Given model text, return the declared type of a named field.
 * e.g. "  totalAmount    Float" → "Float"
 */
function fieldType(modelText: string, fieldName: string): string {
  const lines = modelText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts[0] === fieldName) return parts[1];
  }
  throw new Error(`Field "${fieldName}" not found in model block`);
}

// ─── Booking ──────────────────────────────────────────────────────────────────

describe('Booking — money fields must be Decimal', () => {
  const model = getModel('Booking');

  it('totalAmount is Decimal, not Float', () => {
    expect(fieldType(model, 'totalAmount')).toBe('Decimal');
  });
});

// ─── BookingCharge ────────────────────────────────────────────────────────────

describe('BookingCharge — money fields must be Decimal', () => {
  const model = getModel('BookingCharge');

  it('amount is Decimal, not Float', () => {
    expect(fieldType(model, 'amount')).toBe('Decimal');
  });
});

// ─── GuestPayout ─────────────────────────────────────────────────────────────

describe('GuestPayout — money fields must be Decimal', () => {
  const model = getModel('GuestPayout');

  it('amount is Decimal, not Float', () => {
    expect(fieldType(model, 'amount')).toBe('Decimal');
  });
});

// ─── OwnerStatement ──────────────────────────────────────────────────────────

describe('OwnerStatement — money fields must be Decimal', () => {
  const model = getModel('OwnerStatement');

  it('totalDue is Decimal, not Float', () => {
    expect(fieldType(model, 'totalDue')).toBe('Decimal');
  });
});

// ─── Expense ─────────────────────────────────────────────────────────────────

describe('Expense — money fields must be Decimal', () => {
  const model = getModel('Expense');

  it('amount is Decimal, not Float', () => {
    expect(fieldType(model, 'amount')).toBe('Decimal');
  });

  it('confidenceScore stays Float (not money — 0–1 score)', () => {
    // This is intentionally NOT Decimal — confidence is a float score, not money.
    expect(fieldType(model, 'confidenceScore')).toBe('Float?');
  });
});

// ─── PropertyOwnership ───────────────────────────────────────────────────────

describe('PropertyOwnership — revenue share must be Decimal', () => {
  const model = getModel('PropertyOwnership');

  it('revenueShare is Decimal (precise split arithmetic for owner statements)', () => {
    expect(fieldType(model, 'revenueShare')).toBe('Decimal');
  });
});

// ─── JournalLine (already correct — regression guard) ────────────────────────

describe('JournalLine — regression guard', () => {
  const model = getModel('JournalLine');

  it('amount is already Decimal', () => {
    expect(fieldType(model, 'amount')).toBe('Decimal');
  });

  it('isDebit is Boolean (not debitCredit String)', () => {
    expect(fieldType(model, 'isDebit')).toBe('Boolean');
  });
});

// ─── FiscalPeriod relation ───────────────────────────────────────────────────

describe('FiscalPeriod — relation consistency', () => {
  it('FiscalPeriod does not declare a journalEntries relation without a matching FK on JournalEntry', () => {
    const fpModel = getModel('FiscalPeriod');
    const jeModel = getModel('JournalEntry');

    // If FiscalPeriod declares journalEntries, JournalEntry must have fiscalPeriodId
    const hasFPRelation = fpModel.includes('journalEntries') && fpModel.includes('JournalEntry[]');
    if (hasFPRelation) {
      expect(jeModel).toMatch(/fiscalPeriodId/);
    } else {
      // Relation removed entirely — also valid. Either way, no orphan relation.
      expect(hasFPRelation).toBe(false);
    }
  });
});
