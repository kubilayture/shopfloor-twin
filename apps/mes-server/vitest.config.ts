import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The entry point runs in the container smoke test; testing.ts is test support.
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/testing.ts', 'src/db/cli.ts'],
      thresholds: { lines: 80, branches: 70 },
    },
  },
});
