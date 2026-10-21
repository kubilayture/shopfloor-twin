/**
 * Vitest setup file (P10-01): runs in each test file's worker before its tests and makes the
 * run's seed fast-check's global default. A `seed` passed to an `fc.assert` or `fc.sample` call
 * still wins over it.
 */
import fc from 'fast-check';
import { inject } from 'vitest';
import './context.ts';

fc.configureGlobal({ ...fc.readConfigureGlobal(), seed: inject('fcSeed') });
