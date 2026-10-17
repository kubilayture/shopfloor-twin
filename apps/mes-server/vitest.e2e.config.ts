import { defineConfig } from 'vitest/config';

/**
 * Long-running tests (the golden reconciliations): run alone in their CI job (`pnpm test:e2e`),
 * and one file at a time (#199 review): side by side, four golden replays and their Testcontainers
 * databases made each other's timings meaningless.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
