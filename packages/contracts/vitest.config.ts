import { fcSeed } from '@shopfloor/fc-seed';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Records the run's fast-check seed; FC_SEED pins it (P10-01, runbook).
    ...fcSeed,
  },
});
