import { randomInt } from 'node:crypto';

/** fast-check seeds are 32-bit signed integers. */
const MIN_SEED = -(2 ** 31);
const MAX_SEED = 2 ** 31 - 1;

/**
 * The seed `FC_SEED` pins, or `undefined` when it is unset or empty. Anything but a decimal
 * 32-bit signed integer in canonical form (no leading zeros, no `-0`) throws, so a typo fails the run before any test instead of silently
 * drawing a fresh seed.
 */
export function parseSeed(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const text = raw.trim();
  const seed = Number(text);
  if (
    !/^-?(0|[1-9]\d*)$/.test(text) ||
    text === '-0' ||
    !Number.isSafeInteger(seed) ||
    seed < MIN_SEED ||
    seed > MAX_SEED
  ) {
    throw new Error(
      `FC_SEED must be an integer from ${String(MIN_SEED)} to ${String(MAX_SEED)}, got ${JSON.stringify(raw)}`,
    );
  }
  return seed;
}

/** A fresh seed for a run that doesn't pin one. */
export const drawSeed = (): number => randomInt(0, MAX_SEED);

/** `FC_SEED` if set, else a drawn seed. */
export const resolveSeed = (raw: string | undefined): number => parseSeed(raw) ?? drawSeed();

/** The line each workspace prints once per run. */
export const seedLine = (workspace: string, seed: number): string =>
  `fast-check seed ${workspace}: ${String(seed)} (FC_SEED=${String(seed)} reproduces)`;
