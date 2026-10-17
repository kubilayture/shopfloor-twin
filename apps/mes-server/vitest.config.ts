import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // End-to-end tests run in their own CI job (`test:e2e`), not with the unit and integration tests.
    exclude: ['**/node_modules/**', '**/*.e2e.test.ts'],
    // These files start processes and containers; in parallel they starve a 2-core CI runner.
    fileParallelism: false,
    // Generous: the suites share the machine with other runs (#212); a hang still fails by name.
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The entry points run as processes in the end-to-end tests (#100); testing.ts and
      // *test-support.ts are test support.
      exclude: [
        'src/**/*.test.ts',
        'src/**/*test-support.ts',
        'src/main.ts',
        'src/testing.ts',
        'src/db/cli.ts',
      ],
      thresholds: { lines: 80, branches: 70 },
    },
  },
});
