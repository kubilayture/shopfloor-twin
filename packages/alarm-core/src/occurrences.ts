/**
 * Alarm occurrences as `alarm-core` reads them (ADR-0024): one per device raise, in integer
 * milliseconds of device (simulation) time, for one scope (an operator position or the plant) and
 * one epoch. Pure: no I/O, no floating point.
 */

export type Millis = number;

export const HOUR: Millis = 3_600_000;

export const PRIORITIES = ['high', 'medium', 'low'] as const;

export type Priority = (typeof PRIORITIES)[number];

/** The KPI thresholds of `config/plant/alarms.yaml` (`kpi`), all integers. */
export interface AlarmKpiConfig {
  /** A flood is more than this many raises in one window. */
  readonly floodThreshold: number;
  /** The window of the rate and flood measures; it divides an hour. */
  readonly windowMs: Millis;
  /** A raise is chattering when its point raised at least this often in `chatterWindowMs`. */
  readonly chatterCount: number;
  readonly chatterWindowMs: Millis;
  /** An occurrence that clears less than this after its raise is fleeting. */
  readonly fleetingMs: Millis;
  /** An occurrence active at a bucket's end and raised at least this long before it is standing. */
  readonly standingMs: Millis;
}

/** One device raise and its clear, as the caller paired them. */
export interface Occurrence {
  readonly equipment: string;
  readonly code: string;
  readonly priority: Priority;
  /**
   * The device sequence number of the raise: orders one device's raises in the same millisecond.
   * Only its order within the device matters, which is the device's emission order (ADR-0024).
   */
  readonly seq: number;
  readonly raisedAt: Millis;
  /** The clear (device or resync snapshot), or null while open. */
  readonly clearedAt: Millis | null;
  /**
   * Where the clear comes from: the device (default) or `lost`, a resync snapshot that showed the
   * code inactive after its clear was lost. A lost clear's time is not the device's, so it is
   * never fleeting.
   */
  readonly clearKind?: 'device' | 'lost';
}

/**
 * What the caller knows: every fact at or before `asOf` (its "final through" or snapshot time).
 * `closedAt` is the epoch's closing time once a newer epoch exists: nothing happens after it.
 */
export interface Horizon {
  readonly asOf: Millis;
  readonly closedAt?: Millis | null;
}

export type EndReason = 'cleared' | 'lost' | 'superseded' | 'epoch-ended';

/** An occurrence after normalisation, in raise order. */
export interface Prepared extends Occurrence {
  /** Its position in raise order (time, then equipment, `seq` and code). */
  readonly index: number;
  readonly point: string;
  /** When it stopped being active, or null while it is open at `asOf`. */
  readonly endAt: Millis | null;
  readonly endReason: EndReason | null;
  /** Whether its point raised at least `chatterCount` times in (raisedAt − chatterWindowMs, raisedAt]. */
  readonly chattering: boolean;
}

export interface PreparedSet {
  readonly occurrences: readonly Prepared[];
  readonly asOf: Millis;
  readonly closedAt: Millis | null;
  /** Where open things stop: `closedAt` when the epoch is closed, else `asOf`. */
  readonly limit: Millis;
  readonly config: AlarmKpiConfig;
}

/** The key of an alarm point: `equipment/code`. */
export const pointKey = (equipment: string, code: string): string => `${equipment}/${code}`;

const isTime = (value: number): boolean => Number.isSafeInteger(value);

function checkConfig(config: AlarmKpiConfig): void {
  const entries = Object.entries(config) as [string, number][];
  for (const [name, value] of entries) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
    }
  }
  if (HOUR % config.windowMs !== 0) {
    throw new RangeError(`windowMs must divide an hour, got ${String(config.windowMs)}`);
  }
}

/**
 * Raise order: time, then equipment, then `seq`, then code. Within a device that is the device's
 * own order; across devices it never compares sequence numbers, which are per device.
 */
export function compareRaises(a: Occurrence, b: Occurrence): number {
  return (
    a.raisedAt - b.raisedAt ||
    (a.equipment < b.equipment ? -1 : a.equipment > b.equipment ? 1 : 0) ||
    a.seq - b.seq ||
    (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
  );
}

/**
 * Normalises occurrences for the KPIs:
 * - raises after `asOf` are not known yet and are dropped; a clear after `asOf` is open;
 * - an occurrence still open at its point's next raise ends there (`superseded`: a lost clear);
 * - in a closed epoch, what is still open ends at `closedAt` (`epoch-ended`);
 * - chattering is decided per raise, counting the raises of the same point in
 *   (t − chatterWindowMs, t], itself and those before it in the same millisecond included.
 */
export function prepare(
  occurrences: readonly Occurrence[],
  horizon: Horizon,
  config: AlarmKpiConfig,
): PreparedSet {
  checkConfig(config);
  const closedAt = horizon.closedAt ?? null;
  if (!isTime(horizon.asOf) || (closedAt !== null && !isTime(closedAt))) {
    throw new RangeError('asOf and closedAt must be integer milliseconds');
  }
  for (const occurrence of occurrences) {
    const { raisedAt, clearedAt, seq } = occurrence;
    if (!isTime(raisedAt) || !Number.isSafeInteger(seq)) {
      throw new RangeError(`raisedAt and seq must be integers (${occurrence.code})`);
    }
    if (clearedAt !== null && (!isTime(clearedAt) || clearedAt < raisedAt)) {
      throw new RangeError(
        `clearedAt must be an integer at or after raisedAt (${occurrence.code})`,
      );
    }
    if (closedAt !== null && raisedAt > closedAt) {
      throw new RangeError(`raise after the epoch closed (${occurrence.code})`);
    }
    if (closedAt !== null && clearedAt !== null && clearedAt > closedAt) {
      throw new RangeError(`clear after the epoch closed (${occurrence.code})`);
    }
  }
  // A closed epoch is known to its end (ADR-0018: final everywhere).
  const asOf = closedAt !== null && closedAt > horizon.asOf ? closedAt : horizon.asOf;
  const known = occurrences.filter((occurrence) => occurrence.raisedAt <= asOf).sort(compareRaises);

  const nextRaise = new Map<number, Millis>();
  const lastByPoint = new Map<string, number>();
  const recentByPoint = new Map<string, Millis[]>();
  const chattering: boolean[] = [];
  known.forEach((occurrence, index) => {
    const point = pointKey(occurrence.equipment, occurrence.code);
    const previous = lastByPoint.get(point);
    if (previous !== undefined) {
      nextRaise.set(previous, occurrence.raisedAt);
    }
    lastByPoint.set(point, index);
    const recent = (recentByPoint.get(point) ?? []).filter(
      (at) => at > occurrence.raisedAt - config.chatterWindowMs,
    );
    recent.push(occurrence.raisedAt);
    recentByPoint.set(point, recent);
    chattering.push(recent.length >= config.chatterCount);
  });

  const prepared = known.map((occurrence, index): Prepared => {
    const cleared =
      occurrence.clearedAt !== null && occurrence.clearedAt <= asOf ? occurrence.clearedAt : null;
    const next = nextRaise.get(index);
    let endAt: Millis | null = cleared;
    let endReason: EndReason | null =
      cleared === null ? null : occurrence.clearKind === 'lost' ? 'lost' : 'cleared';
    if (next !== undefined && (endAt === null || next < endAt)) {
      endAt = next;
      endReason = 'superseded';
    }
    if (endAt === null && closedAt !== null) {
      endAt = closedAt;
      endReason = 'epoch-ended';
    }
    return {
      ...occurrence,
      clearedAt: cleared,
      index,
      point: pointKey(occurrence.equipment, occurrence.code),
      endAt,
      endReason,
      chattering: chattering[index] ?? false,
    };
  });
  return { occurrences: prepared, asOf, closedAt, limit: closedAt ?? asOf, config };
}
