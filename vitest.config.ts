import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // RAJ-674: real-Postgres integration tests live in their own config
    // (vitest.integration.config.ts) with their own lane/script — this fast
    // unit lane must never try to run them (no live DB in this config).
    exclude: ['**/node_modules/**', 'tests/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Coverage ratchet (RAJ-539). Floors of actual coverage, NO buffer
      // (measured 2026-07-04 on main: lines/statements 22.58%, branches 83.69%,
      // functions 63.77%; denominator includes untested UI components, Next.js
      // routes, and server actions). Any regression fails CI. Thresholds may
      // only be raised — scripts/coverage-ratchet.mjs enforces that on PRs.
      thresholds: { lines: 22, statements: 22, branches: 83, functions: 63 },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
