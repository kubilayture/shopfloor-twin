import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The entry point runs in the container smoke test.
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      thresholds: { lines: 80, branches: 70 },
    },
  },
});
