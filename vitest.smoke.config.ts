import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Live-dependency SMOKE lane — hits the REAL third-party services BookLets
 * depends on (OCR microservice, the app's OAuth/health endpoints). Separate
 * from the hermetic unit lane, which must NEVER touch the network. This lane
 * exists because a mocked OCR let a missing GEMINI_API_KEY ship undetected:
 * every review was green, but the real OCR returned 500 on every receipt.
 *
 * Run: npm run test:smoke  (also runs hourly via .github/workflows/smoke.yml).
 * NOT a per-PR merge gate — it depends on external service availability.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/smoke/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
