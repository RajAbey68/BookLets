/**
 * Unit tests for LedgerService pure logic.
 *
 * validateTrialBalance has zero external dependencies — no DB, no network.
 * These tests run in ~10ms and guard against regressions in the core
 * double-entry invariant: debits must equal credits.
 *
 * The Decimal precision tests also verify that the service handles amounts
 * that would silently lose precision as IEEE-754 floats
 * (e.g. 0.1 + 0.2 ≠ 0.3 in floating point).
 */
import { describe, it, expect, vi } from 'vitest';
import { Decimal } from 'decimal.js';

// Mock the Prisma singleton — validateTrialBalance is pure and never calls the DB,
// but the module import chain pulls in @prisma/client which requires a generated
// client. We stub it so unit tests run without `prisma generate`.
vi.mock('../../src/lib/prisma', () => ({ prisma: {} }));

import { LedgerService } from '../../src/lib/ledger.service';

// ─── validateTrialBalance ─────────────────────────────────────────────────────

describe('LedgerService.validateTrialBalance', () => {
  it('returns invalid when fewer than two lines are provided', () => {
    const result = LedgerService.validateTrialBalance([
      { accountId: 'acc-1', amount: new Decimal('100.00'), isDebit: true },
    ]);
    expect(result.isValid).toBe(false);
    expect(result.error).toMatch(/at least two lines/);
  });

  it('returns valid for a balanced two-line entry', () => {
    const result = LedgerService.validateTrialBalance([
      { accountId: 'acc-1', amount: new Decimal('500.00'), isDebit: true },
      { accountId: 'acc-2', amount: new Decimal('500.00'), isDebit: false },
    ]);
    expect(result.isValid).toBe(true);
    expect(result.balance.isZero()).toBe(true);
  });

  it('returns invalid when debits exceed credits', () => {
    const result = LedgerService.validateTrialBalance([
      { accountId: 'acc-1', amount: new Decimal('600.00'), isDebit: true },
      { accountId: 'acc-2', amount: new Decimal('500.00'), isDebit: false },
    ]);
    expect(result.isValid).toBe(false);
    expect(result.balance.toString()).toBe('100');
  });

  it('returns invalid when credits exceed debits', () => {
    const result = LedgerService.validateTrialBalance([
      { accountId: 'acc-1', amount: new Decimal('400.00'), isDebit: true },
      { accountId: 'acc-2', amount: new Decimal('500.00'), isDebit: false },
    ]);
    expect(result.isValid).toBe(false);
    expect(result.balance.toString()).toBe('-100');
  });

  it('balances correctly with three lines (split credit)', () => {
    const result = LedgerService.validateTrialBalance([
      { accountId: 'acc-1', amount: new Decimal('1000.00'), isDebit: true },
      { accountId: 'acc-2', amount: new Decimal('600.00'), isDebit: false },
      { accountId: 'acc-3', amount: new Decimal('400.00'), isDebit: false },
    ]);
    expect(result.isValid).toBe(true);
  });

  it('handles euro cent precision without floating-point drift', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE-754 — this MUST be exact in a ledger
    const result = LedgerService.validateTrialBalance([
      { accountId: 'acc-1', amount: new Decimal('0.10'), isDebit: true },
      { accountId: 'acc-2', amount: new Decimal('0.20'), isDebit: true },
      { accountId: 'acc-3', amount: new Decimal('0.30'), isDebit: false },
    ]);
    expect(result.isValid).toBe(true);
    expect(result.balance.isZero()).toBe(true);
  });

  it('handles large amounts (10k+ booking) without precision loss', () => {
    // €12,500.00 revenue recognition entry
    const result = LedgerService.validateTrialBalance([
      { accountId: 'acc-deferred', amount: new Decimal('12500.00'), isDebit: true },
      { accountId: 'acc-revenue',  amount: new Decimal('12500.00'), isDebit: false },
    ]);
    expect(result.isValid).toBe(true);
  });

  it('rejects a zero-difference that hides a rounding error', () => {
    // If amounts were stored as Float, 1/3 split would accumulate error.
    // With Decimal we can detect the 0.01 off.
    const result = LedgerService.validateTrialBalance([
      { accountId: 'acc-1', amount: new Decimal('300.00'), isDebit: true },
      { accountId: 'acc-2', amount: new Decimal('100.00'), isDebit: false },
      { accountId: 'acc-3', amount: new Decimal('100.00'), isDebit: false },
      { accountId: 'acc-4', amount: new Decimal('99.99'),  isDebit: false }, // 1 cent short
    ]);
    expect(result.isValid).toBe(false);
    expect(result.balance.abs().toString()).toBe('0.01');
  });
});

// ─── Decimal precision guard ──────────────────────────────────────────────────

describe('Decimal arithmetic precision (would fail with Float storage)', () => {
  it('0.1 + 0.2 equals 0.3 exactly with Decimal', () => {
    const a = new Decimal('0.1');
    const b = new Decimal('0.2');
    expect(a.plus(b).equals(new Decimal('0.3'))).toBe(true);
  });

  it('0.1 + 0.2 does NOT equal 0.3 with native Float (documents why Decimal is required)', () => {
    // This test proves the problem. 0.1 + 0.2 in IEEE-754:
    const result = 0.1 + 0.2;
    expect(result === 0.3).toBe(false); // floating-point drift confirmed
  });

  it('revenue share split of 1/3 is exact with Decimal to 4dp', () => {
    const total = new Decimal('1500.00');
    const share = new Decimal('0.3333'); // Decimal(5,4) precision
    const ownerCut = total.mul(share);
    // Should be 499.95 — exact, no drift
    expect(ownerCut.toFixed(2)).toBe('499.95');
  });
});
