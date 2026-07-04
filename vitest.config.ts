import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
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
