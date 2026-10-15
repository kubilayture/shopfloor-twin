import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The reconciliation itself runs with `pnpm test:reconcile`; here only its pure helpers.
    include: ['src/**/*.test.ts'],
  },
});
