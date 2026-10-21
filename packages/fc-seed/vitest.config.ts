import { defineConfig } from 'vitest/config';
import { fcSeed } from './src/index.ts';

export default defineConfig({
  test: {
    ...fcSeed,
    include: ['src/**/*.test.ts'],
    // The reproduction tests start Vitest on the probe workspace, several times.
    testTimeout: 60_000,
  },
});
