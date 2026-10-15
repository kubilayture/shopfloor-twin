import { defineConfig } from 'vitest/config';

/** Long-running tests (the golden-week reconciliation): run alone in their CI job (`pnpm test:e2e`). */
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    testTimeout: 60_000,
  },
});
