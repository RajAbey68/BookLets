import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * RAJ-674 Tier 1 — real-Postgres integration lane, separate from the fast
 * unit lane (vitest.config.ts, which mocks Prisma and never touches a DB).
 *
 * These tests prove the DB-level controls actually work: fiscal-period lock,
 * posted-entry immutability, and the amount>0 CHECK constraint were
 * previously "tested" only by regex-matching migration.sql TEXT (see
 * db-integrity-triggers.test.ts) — a typo in the trigger body would have
 * passed every test. This lane executes them against a real container.
 *
 * Run: npm run test:integration (see scripts/test-integration-setup.sh for
 * what it provisions — an ephemeral Docker Postgres, `prisma db push` for
 * the schema, then the two raw-SQL migrations Prisma cannot express).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    // Real DB I/O — do not parallelize across files sharing one container.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
