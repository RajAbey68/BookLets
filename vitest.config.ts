import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Coverage ratchet (RAJ-279). Target is 80%, but actual coverage today is
      // lines 8.41% / branches 71.33% / functions 41.55% (denominator includes
      // untested UI components, Next.js routes, and server actions). Gates are
      // set at (current floor - 2%, rounded down) so the pipeline is green now
      // and any regression fails CI. Raise these as coverage grows — never lower.
      thresholds: { lines: 6, statements: 6, branches: 69, functions: 39 },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
