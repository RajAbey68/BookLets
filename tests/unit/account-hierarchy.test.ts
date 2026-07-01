/**
 * RAJ-283 [P1-01] — Account Hierarchy Model.
 *
 * Schema-assertion gate: the Account model must carry a self-referencing
 * parentId FK so parent accounts can roll up their children's balances
 * (e.g. 4000 Rental Income aggregates 4100 Airbnb + 4200 Direct).
 *
 * Mirrors the schema-money-fields.test.ts pattern: read schema.prisma text
 * and assert the field/relation declarations exist. INTENTIONALLY FAILING
 * until the migration lands.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const schemaPath = path.resolve(__dirname, '../../prisma/schema.prisma');
const schema = fs.readFileSync(schemaPath, 'utf-8');

function getModel(name: string): string {
  const regex = new RegExp(`model\\s+${name}\\s*\\{([^}]+)\\}`, 's');
  const match = schema.match(regex);
  if (!match) throw new Error(`Model "${name}" not found in schema.prisma`);
  return match[1];
}

describe('RAJ-283 — Account self-referencing hierarchy', () => {
  const model = getModel('Account');

  it('declares a nullable parentId scalar', () => {
    // Root accounts have no parent → the FK must be optional.
    expect(model).toMatch(/parentId\s+String\?/);
  });

  it('declares the parent relation on the AccountHierarchy relation name', () => {
    expect(model).toMatch(
      /parent\s+Account\?\s+@relation\("AccountHierarchy",\s*fields:\s*\[parentId\],\s*references:\s*\[id\]\)/
    );
  });

  it('declares the children back-relation on the AccountHierarchy relation name', () => {
    expect(model).toMatch(/children\s+Account\[\]\s+@relation\("AccountHierarchy"\)/);
  });

  it('indexes parentId for rollup queries', () => {
    expect(model).toMatch(/@@index\(\[parentId\]\)/);
  });
});
