import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        // Ratcheted coverage floor — -2% below actual (Jul 2026: 8.4%l/71.3%b/41.6%f)
        // Only INCREASE thresholds in PRs.
        lines: 8,
        statements: 8,
        branches: 70,
        functions: 41,
      },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
