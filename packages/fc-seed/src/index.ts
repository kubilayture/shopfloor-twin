/**
 * Recorded fast-check seeds (P10-01, Phase 10 plan "Property seeds"). A workspace's
 * `vitest.config.ts` spreads `fcSeed` into its `test` options:
 *
 *     test: { ...fcSeed, … }
 *
 * Each run then prints `fast-check seed <workspace>: <seed> (FC_SEED=<seed> reproduces)` and every
 * property without an explicit `seed` uses that seed; `FC_SEED=<seed>` pins it.
 */
import { fileURLToPath } from 'node:url';
import './context.ts';

export { drawSeed, parseSeed, resolveSeed, seedLine } from './seed.ts';

const here = (file: string): string => fileURLToPath(new URL(file, import.meta.url));

/** The global setup and setup file, as Vitest `test` options. */
export const fcSeed = {
  globalSetup: [here('./global-setup.ts')],
  setupFiles: [here('./setup.ts')],
};
