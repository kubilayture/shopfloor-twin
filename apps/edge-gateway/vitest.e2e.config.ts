import { defineConfig } from 'vitest/config';

/** End-to-end tests: every piece as its own process; run alone in their CI job (`pnpm test:e2e`). */
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    testTimeout: 60_000,
  },
});
