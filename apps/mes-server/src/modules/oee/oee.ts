/**
 * The `oee` module (#120, ADR-0021, ADR-0022): OEE per equipment and per work center, per hour and
 * per shift bucket, computed on read from the equipment and ingest modules' hourly aggregates and
 * stop pieces (through their `index.ts`). It owns no tables: nothing is stored, so nothing goes
 * stale.
 */
import {
  CYCLE_RESULTS,
  HOUR,
  OEE_STATES,
  bucketTotals,
  oeeFromTotals,
  sumTotals,
  type CycleCount,
  type CycleResult,
  type Millis,
  type OeeConfig,
  type OeeResult,
  type OeeState,
  type OeeTotals,
} from '@shopfloor/oee-core';
import { NO_SHIFT, shiftKeyAt, shiftSegments, type ShiftPattern } from '@shopfloor/shift-calendar';
import type { DowntimeRecord, Equipment, StateHour, StopPiece } from '../equipment/index.ts';
import type { Ingest, IngestNotice } from '../ingest/index.ts';
import type { EquipmentInfo, MasterData, ReasonCode } from '../master-data/index.ts';
import { hourEnd, hourStart, shiftBuckets, type ShiftBucket } from './shifts.ts';

export type OeeScope = 'equipment' | 'work-center';
export type OeeBucketKind = 'hour' | 'shift';

/** What the module reads from the other modules (their `index.ts` interfaces). */
export interface OeeSources {
  readonly equipment: Pick<
    Equipment,
    'oeeInputs' | 'stopPieces' | 'downtimeRecords' | 'onPiecesChanged' | 'watermark' | 'watermarks'
  >;
  readonly ingest: Pick<Ingest, 'cycleHourly' | 'cyclesRefreshed' | 'onStored'>;
  readonly masterData: Pick<MasterData, 'equipment' | 'reasonCodes'>;
}

export interface OeeOptions extends OeeSources {
  readonly shiftPattern: ShiftPattern;
  /** `config/plant/oee.yaml`: the micro-stop threshold and the scheduled-time rule. */
  readonly config: OeeConfig;
  /** Ideal cycle ms per product and operation (plant-config `idealCycleMs`). */
  readonly idealCycleMs: Readonly<Record<string, Readonly<Record<string, Millis>>>>;
}

export interface OeeQuery {
  readonly scope: OeeScope;
  readonly id: string;
  readonly bucket: OeeBucketKind;
  readonly from: Date;
  readonly to: Date;
  /** The device epoch to read; default: per machine the newest with data in the range. */
  readonly epoch?: number | undefined;
}

export interface OeeMember {
  readonly equipment: string;
  readonly epoch: number;
}

/** OEE of one equipment or work center over one hour or shift bucket. */
export interface OeeBucket {
  readonly scope: OeeScope;
  readonly id: string;
  readonly bucket: OeeBucketKind;
  /** The hour start (ISO 8601) or the shift key. */
  readonly key: string;
  readonly shiftKey: string;
  readonly start: Date;
  readonly end: Date;
  readonly members: readonly OeeMember[];
  /** Time per state (every state) and cycles per product and result, summed over the members. */
  readonly stateMs: Readonly<Record<OeeState, number>>;
  readonly cycles: readonly CycleCount[];
  /** Stopped pieces read. */
  readonly stops: number;
  readonly result: OeeResult;
  readonly final: boolean;
  readonly provisionalMs: number;
  readonly revision: number;
  readonly incidents: number;
}

/** Sent after anything an OEE bucket is computed from changed (pieces or cycles). */
export interface OeeChange {
  readonly equipment: string;
  readonly epoch: number;
  /** Whole UTC hours [from, to) that changed. */
  readonly from: Date;
  readonly to: Date;
}

/** A work center and its machines, in line order. */
export interface WorkCenter {
  readonly id: string;
  readonly name: string;
  readonly equipment: readonly string[];
}

/** One machine's inputs for one UTC hour of one epoch. */
interface HourCell {
  readonly hour: Millis;
  readonly shiftKey: string;
  readonly stateMs: Partial<Record<OeeState, number>>;
  readonly stops: { ms: number; wholeMs: number; open: boolean }[];
  readonly cycles: Map<string, number>;
  /** Rows of `state_hourly` were read for the hour. */
  rows: boolean;
  /** Every row final (a `bucket_finality` row and `state_hourly` refreshed through it). */
  rowsFinal: boolean;
  provisionalMs: number;
  revision: number;
  readonly incidentIds: Set<number>;
}

interface MemberData {
  readonly equipment: string;
  readonly operation: string;
  readonly epoch: number;
  readonly cells: ReadonlyMap<Millis, HourCell>;
}

interface Catalog {
  readonly equipment: ReadonlyMap<string, EquipmentInfo>;
  readonly order: readonly string[];
  readonly workCenters: ReadonlyMap<string, WorkCenter>;
}

const OEE_STATE_SET: ReadonlySet<string> = new Set(OEE_STATES);
const isOeeState = (state: string): state is OeeState => OEE_STATE_SET.has(state);

const RESULT_ORDER = new Map<string, number>(CYCLE_RESULTS.map((result, i) => [result, i]));

const cycleKey = (product: string, result: string): string => `${product}\u0000${result}`;

function cycleList(cycles: ReadonlyMap<string, number>): CycleCount[] {
  return [...cycles]
    .map(([key, count]) => {
      const [product = '', result = 'good'] = key.split('\u0000');
      return { product, result: result as CycleResult, count };
    })
    .sort((a, b) =>
      a.product < b.product
        ? -1
        : a.product > b.product
          ? 1
          : (RESULT_ORDER.get(a.result) ?? 0) - (RESULT_ORDER.get(b.result) ?? 0),
    );
}

/** The highest epoch of the rows, or undefined without rows (no spreading of long lists). */
function newestEpoch(
  ...lists: readonly (readonly { readonly epoch: number }[])[]
): number | undefined {
  let newest: number | undefined;
  for (const list of lists) {
    for (const row of list) if (newest === undefined || row.epoch > newest) newest = row.epoch;
  }
  return newest;
}

/**
 * OEE on read (ADR-0021, ADR-0022). Inputs per (machine, device epoch, UTC hour): time per state
 * from `equipment.state_hourly`, Stopped pieces with their whole interval's length, read in the
 * same REPEATABLE READ snapshot (the Stopped time is derived from those pieces, so `oee-core`'s
 * check can't throw on a stale aggregate row either), and cycles from `ingest.cycle_hourly`. A
 * shift bucket is the sum of its hours (shifts start and end on whole hours); a work center is
 * the sum of its machines' inputs.
 */
export class Oee {
  readonly #options: OeeOptions;
  readonly #listeners = new Set<(change: OeeChange) => void>();
  #catalog: Catalog | undefined;
  #detach: (() => void)[] = [];

  constructor(options: OeeOptions) {
    this.#options = options;
  }

  /** Loads the equipment catalog and follows the changes OEE is computed from. */
  async start(): Promise<void> {
    await this.#loadCatalog();
    this.#detach.push(
      this.#options.equipment.onPiecesChanged((change) => {
        this.#emit(change);
      }),
      this.#options.ingest.onStored((notice: IngestNotice) => {
        if (notice.type !== 'cycle') return;
        const hour = hourStart(notice.cycle.sourceTime.getTime());
        this.#emit({
          equipment: notice.cycle.equipment,
          epoch: notice.cycle.epoch,
          from: new Date(hour),
          to: new Date(hour + HOUR),
        });
      }),
    );
  }

  stop(): void {
    for (const detach of this.#detach.splice(0)) detach();
  }

  /**
   * Listens for changes to OEE inputs (synchronously, from the modules' notices: the listener must
   * only record what changed, never read). Returns an unsubscribe.
   */
  onChange(listener: (change: OeeChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get config(): OeeConfig {
    return this.#options.config;
  }

  get shiftPattern(): ShiftPattern {
    return this.#options.shiftPattern;
  }

  /** Every work center with its machines, in line order. */
  async workCenters(): Promise<WorkCenter[]> {
    return [...(await this.#loadCatalog()).workCenters.values()];
  }

  /** The machines of an equipment or work center; undefined when it doesn't exist. */
  async members(scope: OeeScope, id: string): Promise<readonly string[] | undefined> {
    const catalog = await this.#loadCatalog();
    if (scope === 'equipment') return catalog.equipment.has(id) ? [id] : undefined;
    return catalog.workCenters.get(id)?.equipment;
  }

  /** The reason tree of master data (for names in the Pareto). */
  reasonCodes(): Promise<ReasonCode[]> {
    return this.#options.masterData.reasonCodes({ inactive: true });
  }

  /**
   * OEE buckets of one equipment or work center over [from, to): hour buckets for the hours that
   * overlap it, or shift buckets for the shifts that overlap it (whole shifts; no-shift stretches
   * clipped to the range's hours). Only buckets with data are returned, by start.
   */
  async buckets(query: OeeQuery): Promise<OeeBucket[]> {
    const members = await this.members(query.scope, query.id);
    if (!members) throw new RangeError(`no ${query.scope} ${query.id}`);
    const from = query.from.getTime();
    const to = query.to.getTime();
    const defs =
      query.bucket === 'hour'
        ? this.#hourBuckets(hourStart(from), hourEnd(to))
        : shiftBuckets(this.#options.shiftPattern, from, to);
    const first = defs[0];
    const last = defs.at(-1);
    if (!first || !last) return [];
    const data = await this.#read(members, first.start, last.end, query.epoch);
    return defs.flatMap((def) => {
      const bucket = this.#assemble(query.scope, query.id, query.bucket, def, members, data);
      return bucket ? [bucket] : [];
    });
  }

  /**
   * One shift bucket for every machine and every work center (`GET /shifts/{date}/{shift}/oee`),
   * read once.
   */
  async shift(
    bucket: ShiftBucket,
    epoch?: number,
  ): Promise<{ equipment: OeeBucket[]; workCenters: OeeBucket[] }> {
    const catalog = await this.#loadCatalog();
    const data = await this.#read(catalog.order, bucket.start, bucket.end, epoch);
    const equipment = catalog.order.flatMap((id) => {
      const result = this.#assemble('equipment', id, 'shift', bucket, [id], data);
      return result ? [result] : [];
    });
    const workCenters = [...catalog.workCenters.values()].flatMap((wc) => {
      const result = this.#assemble('work-center', wc.id, 'shift', bucket, wc.equipment, data);
      return result ? [result] : [];
    });
    return { equipment, workCenters };
  }

  /**
   * The hour and the shift bucket the plant clock (the newest epoch's watermark) is in, for an
   * equipment or work center (push, `oee:<id>`). Null where there is no clock or no data.
   */
  async current(
    scope: OeeScope,
    id: string,
  ): Promise<{ hour: OeeBucket | null; shift: OeeBucket | null }> {
    const members = await this.members(scope, id);
    const clock = this.#options.equipment.watermarks()[0];
    if (!members || !clock) return { hour: null, shift: null };
    // The instant just before the watermark: at 07:00:00.000 the hour in progress is 06:00.
    const at = clock.watermark.getTime() - 1;
    const hour = { key: '', start: hourStart(at), end: hourStart(at) + HOUR };
    const segment = shiftSegments(this.#options.shiftPattern, at - 4 * 24 * HOUR, at + 1).at(-1);
    const shift: ShiftBucket =
      segment === undefined
        ? { key: NO_SHIFT, start: hour.start, end: hour.end }
        : segment.key === NO_SHIFT
          ? { key: NO_SHIFT, start: hourStart(segment.from), end: hour.end }
          : (shiftBuckets(this.#options.shiftPattern, at, at + 1)[0] ?? {
              key: segment.key,
              start: segment.from,
              end: hour.end,
            });
    const from = Math.min(hour.start, shift.start);
    const to = Math.max(hour.end, shift.end);
    const data = await this.#read(members, from, to, clock.epoch);
    return {
      hour: this.#assemble(scope, id, 'hour', hour, members, data) ?? null,
      shift: this.#assemble(scope, id, 'shift', shift, members, data) ?? null,
    };
  }

  /** Downtime records of the members, newest epoch per machine (or `epoch`), for the Pareto. */
  async downtimeRecords(
    members: readonly string[],
    from: Date,
    to: Date,
    epoch: number | undefined,
    limit: number,
  ): Promise<{ records: DowntimeRecord[]; stops: StopPiece[]; members: OeeMember[] }> {
    const records: DowntimeRecord[] = [];
    const stops: StopPiece[] = [];
    const chosen: OeeMember[] = [];
    for (const equipment of members) {
      const scope = { equipment, ...(epoch === undefined ? {} : { epoch }) };
      const [own, pieces] = await Promise.all([
        this.#options.equipment.downtimeRecords({ from, to, limit, ...scope }),
        this.#options.equipment.stopPieces(from, to, scope),
      ]);
      const newest = epoch ?? newestEpoch(own, pieces);
      if (newest === undefined) continue;
      chosen.push({ equipment, epoch: newest });
      records.push(...own.filter((r) => r.epoch === newest));
      stops.push(...pieces.filter((p) => p.epoch === newest));
    }
    return { records, stops, members: chosen };
  }

  #hourBuckets(from: Millis, to: Millis): ShiftBucket[] {
    const buckets: ShiftBucket[] = [];
    for (let hour = from; hour < to; hour += HOUR) {
      buckets.push({ key: new Date(hour).toISOString(), start: hour, end: hour + HOUR });
    }
    return buckets;
  }

  async #loadCatalog(): Promise<Catalog> {
    if (this.#catalog) return this.#catalog;
    const list = await this.#options.masterData.equipment();
    const workCenters = new Map<string, WorkCenter>();
    for (const info of list) {
      const wc = workCenters.get(info.workCenter.id);
      workCenters.set(info.workCenter.id, {
        id: info.workCenter.id,
        name: info.workCenter.name,
        equipment: [...(wc?.equipment ?? []), info.id],
      });
    }
    this.#catalog = {
      equipment: new Map(list.map((info) => [info.id, info])),
      order: list.map((info) => info.id),
      workCenters,
    };
    return this.#catalog;
  }

  #emit(change: OeeChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch {
        // A listener's failure must not reach the notifying module (ingest's acknowledgement path).
      }
    }
  }

  /**
   * Reads the hours [from, to) of the machines: state rows and stop pieces in one snapshot, cycles
   * after. Per machine, the epoch asked for or the newest one with data in the range.
   */
  async #read(
    members: readonly string[],
    from: Millis,
    to: Millis,
    epoch: number | undefined,
  ): Promise<Map<string, MemberData>> {
    const catalog = await this.#loadCatalog();
    const range = { from: new Date(from), to: new Date(to) };
    const scope = epoch === undefined ? {} : { epoch };
    const inputs = await this.#options.equipment.oeeInputs(range.from, range.to, {
      equipment: members,
      ...scope,
    });
    const cycles = await Promise.all(
      members.map((equipment) =>
        this.#options.ingest.cycleHourly(range.from, range.to, { equipment, ...scope }),
      ),
    );
    const result = new Map<string, MemberData>();
    members.forEach((equipment, i) => {
      const rows = inputs.hours.filter((row) => row.equipment === equipment);
      const stops = inputs.stops.filter((stop) => stop.equipment === equipment);
      const counts = cycles[i] ?? [];
      const newest = epoch ?? newestEpoch(rows, stops, counts);
      if (newest === undefined) return;
      const cells = new Map<Millis, HourCell>();
      const cell = (hour: Millis): HourCell => {
        let found = cells.get(hour);
        if (!found) {
          found = {
            hour,
            shiftKey: shiftKeyAt(this.#options.shiftPattern, hour),
            stateMs: {},
            stops: [],
            cycles: new Map(),
            rows: false,
            rowsFinal: true,
            provisionalMs: 0,
            revision: 0,
            incidentIds: new Set(),
          };
          cells.set(hour, found);
        }
        return found;
      };
      for (const row of rows) {
        if (row.epoch !== newest) continue;
        this.#addRow(cell(row.hour.getTime()), row);
      }
      for (const stop of stops) {
        if (stop.epoch !== newest) continue;
        cell(stop.hour.getTime()).stops.push({
          ms: stop.end.getTime() - stop.start.getTime(),
          wholeMs: stop.wholeMs,
          open: stop.open,
        });
      }
      for (const count of counts) {
        if (count.epoch !== newest) continue;
        const target = cell(count.hour.getTime()).cycles;
        const key = cycleKey(count.product, count.result);
        target.set(key, (target.get(key) ?? 0) + count.count);
      }
      for (const found of cells.values()) {
        // ADR-0021: Stopped time derived from the pieces read, never from a second read.
        const stopped = found.stops.reduce((sum, stop) => sum + stop.ms, 0);
        if (stopped > 0 || found.stateMs.Stopped !== undefined) found.stateMs.Stopped = stopped;
      }
      result.set(equipment, {
        equipment,
        operation: catalog.equipment.get(equipment)?.operation ?? '',
        epoch: newest,
        cells,
      });
    });
    return result;
  }

  #addRow(cell: HourCell, row: StateHour): void {
    if (!isOeeState(row.state)) throw new RangeError(`unknown state "${row.state}"`);
    cell.rows = true;
    cell.stateMs[row.state] = (cell.stateMs[row.state] ?? 0) + row.ms;
    cell.rowsFinal &&= row.final;
    cell.provisionalMs += row.provisionalMs;
    cell.revision = Math.max(cell.revision, row.revision);
    for (const id of row.incidentIds) cell.incidentIds.add(id);
  }

  #totals(member: MemberData, cell: HourCell): OeeTotals {
    return bucketTotals(
      {
        scheduled: cell.shiftKey !== NO_SHIFT,
        stateMs: cell.stateMs,
        stops: cell.stops,
        cycles: cycleList(cell.cycles),
        operation: member.operation,
        idealCycleMs: this.#options.idealCycleMs,
      },
      this.#options.config,
    );
  }

  /** One bucket of an equipment or work center from the members' hour cells; none without data. */
  #assemble(
    scope: OeeScope,
    id: string,
    kind: OeeBucketKind,
    def: ShiftBucket,
    members: readonly string[],
    data: ReadonlyMap<string, MemberData>,
  ): OeeBucket | undefined {
    const totals: OeeTotals[] = [];
    const stateMs = Object.fromEntries(OEE_STATES.map((state) => [state, 0])) as Record<
      OeeState,
      number
    >;
    const cycles = new Map<string, number>();
    const incidents = new Set<number>();
    const read: OeeMember[] = [];
    let complete = true;
    let cellsFinal = true;
    let provisionalMs = 0;
    let revision = 0;
    let stops = 0;
    for (const equipment of members) {
      const member = data.get(equipment);
      const cells = member
        ? [...member.cells.values()]
            .filter((cell) => cell.hour >= def.start && cell.hour < def.end)
            .sort((a, b) => a.hour - b.hour)
        : [];
      // A member is complete when the bucket's last hour has its rows (finality grows in time).
      if (!member || !cells.some((cell) => cell.rows && cell.hour === def.end - HOUR)) {
        complete = false;
      }
      if (!member || cells.length === 0) continue;
      read.push({ equipment, epoch: member.epoch });
      for (const cell of cells) {
        totals.push(this.#totals(member, cell));
        for (const [state, ms] of Object.entries(cell.stateMs) as [OeeState, number][]) {
          stateMs[state] += ms;
        }
        for (const [key, count] of cell.cycles) cycles.set(key, (cycles.get(key) ?? 0) + count);
        for (const incident of cell.incidentIds) incidents.add(incident);
        cellsFinal &&=
          cell.rows && cell.rowsFinal && this.#options.ingest.cyclesRefreshed(new Date(cell.hour));
        provisionalMs += cell.provisionalMs;
        revision = Math.max(revision, cell.revision);
        stops += cell.stops.length;
      }
    }
    if (read.length === 0) return undefined;
    const result = oeeFromTotals(sumTotals(totals));
    return {
      scope,
      id,
      bucket: kind,
      key: kind === 'hour' ? new Date(def.start).toISOString() : def.key,
      shiftKey: kind === 'hour' ? shiftKeyAt(this.#options.shiftPattern, def.start) : def.key,
      start: new Date(def.start),
      end: new Date(def.end),
      members: read,
      stateMs,
      cycles: cycleList(cycles),
      stops,
      result,
      final: complete && cellsFinal && !result.provisional,
      provisionalMs,
      revision,
      incidents: incidents.size,
    };
  }
}
