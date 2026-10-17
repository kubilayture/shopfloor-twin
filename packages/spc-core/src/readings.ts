/**
 * Readings, their order and their segments (ADR-0032).
 *
 * A reading is one measurement of a characteristic, in whole steps of the instrument's resolution
 * (the leak tester reports 0.001 Pa/min, so 2.134 Pa/min is 2134 steps). Readings are placed by
 * plant time within the device epoch; a new epoch starts a new segment, and nothing (moving
 * ranges, subgroups, run rules) spans a segment boundary.
 */

/** Plant time in ms since the Unix epoch. */
export type Millis = number;

/** Where a reading sits: (device epoch, plant time, device sequence), compared in that order. */
export interface Position {
  readonly epoch: number;
  readonly at: Millis;
  /** Orders facts of one machine at the same plant time (the device sequence number). */
  readonly seq: number;
}

export interface Reading extends Position {
  /** Identifies the reading, for example `{epoch}/{partId}/{pass}`; episodes are keyed by it. */
  readonly key: string;
  /** 1 for a part's first test; a retest after rework has 2, 3, … */
  readonly pass: number;
  /** The value in whole steps of the resolution (a safe integer). */
  readonly value: number;
}

export function comparePositions(a: Position, b: Position): number {
  return a.epoch - b.epoch || a.at - b.at || a.seq - b.seq;
}

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Readings in chart order: epoch, plant time, sequence, then key. */
export function orderReadings(readings: readonly Reading[]): Reading[] {
  for (const reading of readings) {
    if (!Number.isSafeInteger(reading.value)) {
      throw new RangeError(`reading ${reading.key} is not a whole number of steps`);
    }
    if (!Number.isSafeInteger(reading.pass) || reading.pass < 1) {
      throw new RangeError(`reading ${reading.key} has pass ${String(reading.pass)}`);
    }
  }
  return [...readings].sort((a, b) => comparePositions(a, b) || compareKeys(a.key, b.key));
}

/**
 * The SPC population: first-pass readings only, in chart order. A retest after rework measures a
 * reworked part, another population; it is shown, never charted (plan "SPC").
 */
export const firstPass = (readings: readonly Reading[]): Reading[] =>
  orderReadings(readings.filter((reading) => reading.pass === 1));

/** The retests (pass 2 and later), in chart order. */
export const retests = (readings: readonly Reading[]): Reading[] =>
  orderReadings(readings.filter((reading) => reading.pass > 1));

/** Ordered readings cut into segments, one per run of equal epochs. */
export function segments(ordered: readonly Reading[]): Reading[][] {
  const result: Reading[][] = [];
  let current: Reading[] = [];
  for (const reading of ordered) {
    const previous = current.at(-1);
    if (previous !== undefined && previous.epoch !== reading.epoch) {
      result.push(current);
      current = [];
    }
    current.push(reading);
  }
  if (current.length > 0) result.push(current);
  return result;
}

/** Whether `p` lies in [from, to], both inclusive. */
export const within = (p: Position, from: Position, to: Position): boolean =>
  comparePositions(p, from) >= 0 && comparePositions(p, to) <= 0;
