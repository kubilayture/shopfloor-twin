// The probe workspace of `src/reproduce.test.ts`: registers the pair as the nine workspaces do.
import { defineConfig } from 'vitest/config';
import { fcSeed } from '../../src/index.ts';

export default defineConfig({
  test: {
    ...fcSeed,
    include: ['probe.test.ts'],
  },
});
