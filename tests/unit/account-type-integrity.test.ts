/**
 * RAJ-403 / RAJ-404 — Account type + tenant-integrity tests (TDD gate).
 *
 * RAJ-403: Account.type must be a Postgres ENUM (not free text) and carry an
 * isHeader flag. Without a closed type set, P&L rollup (RAJ-289) cannot
 * distinguish revenue from expenses and normal-balance sign conventions are
 * wrong. SUSPENSE is included because live data already uses it for the
 * clearing account.
 *
 * RAJ-404: parentId must reference an account in the SAME organization. A
 * cross-org parent is a tenant-isolation breach. Enforced two ways: a pure
 * service check (fast, unit-testable) and a composite FK in the migration
 * (parentId, organizationId) → (id, organizationId).
 *
 * Tests are INTENTIONALLY FAILING before the schema fix is applied.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { AccountService, AccountParentOrgMismatchError } from '../../src/lib/account.service';

const schemaPath = path.resolve(__dirname, '../../prisma/schema.prisma');
const schema = fs.readFileSync(schemaPath, 'utf-8');

function getModel(name: string): string {
  const regex = new RegExp(`model\\s+${name}\\s*\\{([^}]+)\\}`, 's');
  const match = schema.match(regex);
  if (!match) throw new Error(`Model "${name}" not found in schema.prisma`);
  return match[1];
}

function getEnum(name: string): string {
  const regex = new RegExp(`enum\\s+${name}\\s*\\{([^}]+)\\}`, 's');
  const match = schema.match(regex);
  if (!match) throw new Error(`Enum "${name}" not found in schema.prisma`);
  return match[1];
}

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

// ─── RAJ-403: AccountType enum ────────────────────────────────────────────────

describe('RAJ-403 — Account.type is a closed enum', () => {
  it('schema declares enum AccountType with exactly the six ledger types', () => {
    const values = getEnum('AccountType')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'));
    expect(values.sort()).toEqual(
      ['ASSET', 'EQUITY', 'EXPENSE', 'LIABILITY', 'REVENUE', 'SUSPENSE'].sort(),
    );
  });

  it('Account.type uses the AccountType enum, not String', () => {
    expect(fieldType(getModel('Account'), 'type')).toBe('AccountType');
  });

  it('Account.isHeader is Boolean defaulting to false', () => {
    const model = getModel('Account');
    expect(fieldType(model, 'isHeader')).toBe('Boolean');
    const line = model.split('\n').find((l) => l.trim().startsWith('isHeader'));
    expect(line).toContain('@default(false)');
  });

  it('migration creates the Postgres enum and casts existing rows', () => {
    const dir = path.resolve(__dirname, '../../prisma/migrations');
    const migrationDirs = fs.readdirSync(dir).filter((d) => d.includes('account_type'));
    expect(migrationDirs.length).toBeGreaterThan(0);
    const sql = fs.readFileSync(path.join(dir, migrationDirs[0], 'migration.sql'), 'utf-8');
    expect(sql).toContain('CREATE TYPE "AccountType"');
    expect(sql).toContain('USING "type"::"AccountType"');
    expect(sql).toContain('"isHeader"');
  });
});

// ─── RAJ-403: normal balance conventions ─────────────────────────────────────

describe('RAJ-403 — normal balance per account type', () => {
  it.each([
    ['ASSET', 'DEBIT'],
    ['EXPENSE', 'DEBIT'],
    ['SUSPENSE', 'DEBIT'],
    ['LIABILITY', 'CREDIT'],
    ['EQUITY', 'CREDIT'],
    ['REVENUE', 'CREDIT'],
  ] as const)('%s accounts have a %s normal balance', (type, expected) => {
    expect(AccountService.normalBalance(type)).toBe(expected);
  });

  it('rejects an unknown account type', () => {
    // Free-text values like "INCOME" slipped through when type was a String.
    expect(() => AccountService.normalBalance('INCOME' as never)).toThrow();
  });
});

// ─── RAJ-404: org-scoped parent ──────────────────────────────────────────────

describe('RAJ-404 — parent account must belong to the same organization', () => {
  const child = { id: 'acc-child', organizationId: 'org-a' };

  it('accepts a parent in the same organization', () => {
    expect(() =>
      AccountService.assertSameOrgParent(child, { id: 'acc-p', organizationId: 'org-a' }),
    ).not.toThrow();
  });

  it('accepts a root account (no parent)', () => {
    expect(() => AccountService.assertSameOrgParent(child, null)).not.toThrow();
  });

  it('rejects a parent from another organization', () => {
    expect(() =>
      AccountService.assertSameOrgParent(child, { id: 'acc-p', organizationId: 'org-b' }),
    ).toThrow(AccountParentOrgMismatchError);
  });

  it('rejects self-parenting', () => {
    expect(() =>
      AccountService.assertSameOrgParent(child, { id: 'acc-child', organizationId: 'org-a' }),
    ).toThrow();
  });

  it('schema enforces the composite FK (parentId, organizationId) → (id, organizationId)', () => {
    const model = getModel('Account');
    expect(model).toContain('fields: [parentId, organizationId]');
    expect(model).toContain('references: [id, organizationId]');
    expect(model).toMatch(/@@unique\(\[id,\s*organizationId\]\)/);
  });
});
