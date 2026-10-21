import { fcSeed } from '@shopfloor/fc-seed';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Records the run's fast-check seed; FC_SEED pins it (P10-01, runbook).
    ...fcSeed,
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 80, branches: 70 },
    },
  },
});
