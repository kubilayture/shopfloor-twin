/**
 * Downtime for the API and push (#120): record ids, the loss Pareto, and a feed of record changes
 * (created, closed, recoded) derived from the equipment module's piece changes and, for operator
 * coding (#121), from the coding changes.
 */
import { HOUR, type AvailabilityLoss, type Millis } from '@shopfloor/oee-core';
import { NO_SHIFT } from '@shopfloor/shift-calendar';
import type {
  DowntimeCoding,
  DowntimeLoss,
  DowntimeRecord,
  Equipment,
  PiecesChanged,
  StopPiece,
} from '../equipment/index.ts';
import type { ReasonCode } from '../master-data/index.ts';

/** A record's id in the API: `{equipment}~{epoch}~{startMs}` (plan "API, push and web"). */
export const downtimeId = (record: Pick<DowntimeRecord, 'equipment' | 'epoch' | 'start'>): string =>
  `${record.equipment}~${String(record.epoch)}~${String(record.start.getTime())}`;

/** Where a record ends so far: its end, or while open the epoch's watermark. */
export function recordEnd(record: DowntimeRecord, watermark: Date | undefined): Millis {
  return record.end?.getTime() ?? Math.max(record.start.getTime(), watermark?.getTime() ?? 0);
}

export interface ParetoReason {
  readonly reason: string;
  readonly name: string;
  readonly loss: AvailabilityLoss;
  readonly ms: number;
  readonly records: number;
}

export interface ParetoMicroStop {
  readonly cause: string | null;
  readonly ms: number;
  readonly stops: number;
}

export interface Pareto {
  readonly availability: { readonly own: number; readonly external: number };
  readonly reasons: readonly ParetoReason[];
  readonly microStops: readonly ParetoMicroStop[];
}

/**
 * Availability loss by reason (own and external apart) from the records' summed time
 * (`Equipment.downtimeLoss`, no row limit), and micro-stops by cause from the Stopped pieces
 * below the threshold in scheduled buckets, all clipped to [from, to). Reasons never change OEE
 * (ADR-0021), so the sums equal the OEE losses of the same time.
 */
export function pareto(input: {
  readonly losses: readonly DowntimeLoss[];
  readonly stops: readonly StopPiece[];
  readonly from: Date;
  readonly to: Date;
  readonly thresholdMs: Millis;
  readonly reasons: readonly ReasonCode[];
}): Pareto {
  const from = input.from.getTime();
  const to = input.to.getTime();
  const names = new Map(input.reasons.map((reason) => [reason.id, reason.name]));
  const byReason = new Map<
    string,
    { reason: string; loss: AvailabilityLoss; ms: number; records: number }
  >();
  const availability = { own: 0, external: 0 };
  for (const row of input.losses) {
    // The reason in effect: a coding's where one lies, the auto reason elsewhere (#121).
    const key = `${row.loss}\u0000${row.reason}`;
    const entry = byReason.get(key) ?? { reason: row.reason, loss: row.loss, ms: 0, records: 0 };
    entry.ms += row.ms;
    entry.records += row.records;
    byReason.set(key, entry);
    availability[row.loss] += row.ms;
  }
  const byCause = new Map<string | null, { ms: number; intervals: Set<string> }>();
  for (const stop of input.stops) {
    if (stop.wholeMs >= input.thresholdMs || stop.shiftKey === NO_SHIFT) continue;
    const ms = Math.max(0, Math.min(stop.end.getTime(), to) - Math.max(stop.start.getTime(), from));
    if (ms === 0) continue;
    const entry = byCause.get(stop.cause) ?? { ms: 0, intervals: new Set<string>() };
    entry.ms += ms;
    entry.intervals.add(
      `${stop.equipment}~${String(stop.epoch)}~${String(stop.intervalStart.getTime())}`,
    );
    byCause.set(stop.cause, entry);
  }
  return {
    availability,
    reasons: [...byReason.values()]
      .map((entry) => ({ ...entry, name: names.get(entry.reason) ?? entry.reason }))
      .sort((a, b) => b.ms - a.ms || a.reason.localeCompare(b.reason)),
    microStops: [...byCause]
      .map(([cause, entry]) => ({ cause, ms: entry.ms, stops: entry.intervals.size }))
      .sort((a, b) => b.ms - a.ms || String(a.cause).localeCompare(String(b.cause))),
  };
}

export type DowntimeEvent = 'created' | 'closed' | 'recoded' | 'updated' | 'removed';

export interface DowntimeChange {
  readonly event: DowntimeEvent;
  readonly record: DowntimeRecord;
}

export interface DowntimeFeedOptions {
  readonly equipment: Pick<Equipment, 'downtimeRecords' | 'onPiecesChanged' | 'watermarks'>;
  /** Written and clipped codings (#121): a record whose reasons changed is `recoded`. */
  readonly codings?: Pick<DowntimeCoding, 'onChange'>;
  /** How long changes gather before the records are read again (250 ms of wall time). */
  readonly debounceMs?: number;
  /** How long a record is remembered after it ended, in simulation time (2 days). */
  readonly keepMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** The longest a record reaches back before the hours that changed: a shift bucket, plus a margin. */
const LOOKBACK_MS = 25 * HOUR;

/**
 * What operator coding changed about a record: its codings (#121). Not the set's version, which
 * moves with every write to any record of the same (equipment, epoch): clients that write read
 * the version again or retry on 409.
 */
const codingOf = (record: DowntimeRecord): string =>
  JSON.stringify(
    record.codings.map((c) => [c.from.getTime(), c.to.getTime(), c.reason, c.comment, c.codedBy]),
  );

const sameRecord = (a: DowntimeRecord, b: DowntimeRecord): boolean =>
  a.end?.getTime() === b.end?.getTime() &&
  a.intervalStart.getTime() === b.intervalStart.getTime() &&
  a.state === b.state &&
  a.cause === b.cause &&
  a.shiftKey === b.shiftKey &&
  a.autoReason === b.autoReason &&
  a.provisional === b.provisional &&
  codingOf(a) === codingOf(b);

/**
 * Record changes for push (`downtime` topic). Push coalesces per record (ADR-0019), so a slow
 * client may get only a record's latest event: consumers treat every event as an upsert by
 * record id (`removed`: delete), never as a transition from the previous one. The equipment module writes records in the same
 * statement as their pieces, so every record change comes with a `piecesChanged`. The feed only
 * notes the hours there (never reads on ingest's acknowledgement path); a debounced pass reads the
 * records of those hours and compares them with the ones it knows.
 */
export class DowntimeFeed {
  readonly #options: Required<Omit<DowntimeFeedOptions, 'onError' | 'codings'>> &
    Pick<DowntimeFeedOptions, 'onError' | 'codings'>;
  readonly #listeners = new Set<(change: DowntimeChange) => void>();
  readonly #known = new Map<string, DowntimeRecord>();
  readonly #pending = new Map<string, { from: Millis; to: Millis }>();
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #started: Promise<void> | undefined;
  #detach: (() => void) | undefined;

  constructor(options: DowntimeFeedOptions) {
    this.#options = {
      equipment: options.equipment,
      debounceMs: options.debounceMs ?? 250,
      keepMs: options.keepMs ?? 48 * HOUR,
      ...(options.onError ? { onError: options.onError } : {}),
      ...(options.codings ? { codings: options.codings } : {}),
    };
  }

  /** Listens for record changes; the first listener starts the feed. Returns an unsubscribe. */
  subscribe(listener: (change: DowntimeChange) => void): () => void {
    this.#listeners.add(listener);
    this.#started ??= this.#start();
    return () => this.#listeners.delete(listener);
  }

  /** Waits for the start and any pending pass (tests). */
  async settle(): Promise<void> {
    await this.#started;
    while (this.#timer !== undefined || this.#running !== undefined) {
      if (this.#timer !== undefined) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#running ??= this.#pass();
      }
      await this.#running;
    }
  }

  stop(): void {
    this.#detach?.();
    this.#detach = undefined;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #start(): Promise<void> {
    const pieces = this.#options.equipment.onPiecesChanged((change) => {
      this.#changed(change);
    });
    const codings = this.#options.codings?.onChange((change) => {
      this.#changed(change);
    });
    this.#detach = () => {
      pieces();
      codings?.();
    };
    // The records already there are known, not new: the latest two days of the newest epoch.
    const clock = this.#options.equipment.watermarks()[0];
    if (!clock) return;
    const to = clock.watermark.getTime() + HOUR;
    try {
      const records = await this.#options.equipment.downtimeRecords({
        from: new Date(to - this.#options.keepMs),
        to: new Date(to),
      });
      for (const record of records) this.#known.set(downtimeId(record), record);
    } catch (error) {
      this.#options.onError?.(error);
    }
  }

  #changed(change: Pick<PiecesChanged, 'equipment' | 'from' | 'to'>): void {
    const pending = this.#pending.get(change.equipment);
    const from = change.from.getTime();
    const to = change.to.getTime();
    this.#pending.set(change.equipment, {
      from: Math.min(pending?.from ?? from, from),
      to: Math.max(pending?.to ?? to, to),
    });
    this.#schedule();
  }

  #schedule(): void {
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      this.#running ??= this.#pass();
    }, this.#options.debounceMs).unref();
  }

  async #pass(): Promise<void> {
    try {
      const work = [...this.#pending];
      this.#pending.clear();
      for (const [equipment, range] of work) {
        try {
          await this.#compare(equipment, range.from, range.to);
        } catch (error) {
          // Try again with the next change: put the range back.
          const pending = this.#pending.get(equipment);
          this.#pending.set(equipment, {
            from: Math.min(pending?.from ?? range.from, range.from),
            to: Math.max(pending?.to ?? range.to, range.to),
          });
          this.#options.onError?.(error);
        }
      }
      this.#prune();
    } finally {
      this.#running = undefined;
      // Changes that came in meanwhile (or failed ranges put back) get their own pass.
      if (this.#pending.size > 0) this.#schedule();
    }
  }

  async #compare(equipment: string, from: Millis, to: Millis): Promise<void> {
    const records = await this.#options.equipment.downtimeRecords({
      from: new Date(from),
      to: new Date(to),
      equipment,
    });
    const seen = new Set<string>();
    for (const record of records) {
      const id = downtimeId(record);
      seen.add(id);
      const before = this.#known.get(id);
      this.#known.set(id, record);
      if (!before) this.#send('created', record);
      else if (before.end === null && record.end !== null) this.#send('closed', record);
      else if (before.autoReason !== record.autoReason || codingOf(before) !== codingOf(record)) {
        this.#send('recoded', record);
      } else if (!sameRecord(before, record)) this.#send('updated', record);
    }
    // Known records of the same hours that are gone: a late fact re-cut their interval.
    for (const [id, record] of this.#known) {
      if (record.equipment !== equipment || seen.has(id)) continue;
      const start = record.start.getTime();
      const end = record.end?.getTime() ?? Infinity;
      if (start >= from - LOOKBACK_MS && start < to && end > from) {
        this.#known.delete(id);
        this.#send('removed', record);
      }
    }
  }

  #prune(): void {
    const clock = this.#options.equipment.watermarks()[0];
    if (!clock) return;
    const oldest = clock.watermark.getTime() - this.#options.keepMs;
    for (const [id, record] of this.#known) {
      if (record.end !== null && record.end.getTime() < oldest) this.#known.delete(id);
    }
  }

  #send(event: DowntimeEvent, record: DowntimeRecord): void {
    for (const listener of this.#listeners) {
      try {
        listener({ event, record });
      } catch (error) {
        this.#options.onError?.(error);
      }
    }
  }
}
