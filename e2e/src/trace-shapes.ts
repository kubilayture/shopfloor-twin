/**
 * The trace ground truth's shapes (#204): `trace.json`'s section (`sim-trace/1` without its schema
 * and run header, the live `GET /ground-truth` `trace`) as the simulator writes it
 * (`apps/simulator/src/headless/trace-truth.ts`, `traceSection`), rebuilt here from a `trace-core`
 * `Trace` so the MES's answers compare with the truth in the truth's own shape. Apps never import
 * each other, so the few lines that shape and hash are written out again here, as
 * `apps/mes-server`'s genealogy and SPC reconciliations write them; a difference in any of them
 * would make every live comparison fail, never pass one by accident.
 *
 * The drift section (`drifts`: the first episode after the drift's start and the counterfactual
 * window) needs the counterfactual readings, which only the simulator knows; the MES's side of it
 * is compared on its own (the first episode after the start).
 */
import { createHash } from 'node:crypto';
import type { PlantConfig } from '@shopfloor/plant-config';
import {
  CHARTS,
  type ChartLimits,
  type ChartName,
  type Episode,
  type LimitVersion,
  type Point,
  type Position,
  type RuleSet,
} from '@shopfloor/spc-core';
import type { Carton, Trace, TraceConfig } from '@shopfloor/trace-core';

/** Canonical JSON, keys sorted, `undefined` left out (the simulator's `stableStringify`). */
export function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}

export const sha256 = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

const iso = (ms: number): string => new Date(ms).toISOString();

/** `oee-core`'s `formatFraction`: `num/den`. */
const fraction = (f: { readonly num: bigint; readonly den: bigint }): string =>
  `${String(f.num)}/${String(f.den)}`;

/** The trace configuration from `packing.yaml` and `quality.yaml` (the simulator's `traceConfigOf`). */
export function traceConfigOf(plant: PlantConfig): TraceConfig {
  const operation = plant.process.leakTest.operation;
  const characteristic = plant.quality.characteristics.find((c) => c.operation === operation);
  if (!characteristic) throw new Error('quality.yaml has no characteristic of the leak test');
  return {
    packOperation: plant.packing.operation,
    capacity: { ...plant.packing.capacity },
    spc: {
      characteristic: characteristic.id,
      operation: characteristic.operation,
      subgroupSize: characteristic.subgroupSize,
      baselineSubgroups: characteristic.baselineSubgroups,
      rules: characteristic.rules as RuleSet,
    },
  };
}

/** A reading key `{epoch}/{partId}/{pass}` as the documents name it: part and pass. */
export function keyParts(key: string): { partId: number; pass: number } {
  const [, partId, pass] = key.split('/').map(Number);
  if (partId === undefined || pass === undefined) throw new RangeError(`reading key ${key}`);
  return { partId, pass };
}

/** Every unit as `unitsTraceSha256` hashes it (the simulator's `traceUnits`). */
export const unitsJson = (trace: Trace) =>
  trace.units.map((unit) => ({
    partId: unit.partId,
    serial: unit.serial,
    product: unit.product,
    orderId: unit.orderId,
    status: unit.status,
    carton: unit.carton,
    records: unit.records.map((r) => ({
      operation: r.operation,
      pass: r.pass,
      machine: r.machine,
      at: iso(r.at),
      result: r.result,
      reason: r.reason,
      lots: r.lots.map((l) => ({ material: l.material, lot: l.lot })),
      operator: r.operator,
      reading: r.reading,
    })),
  }));

const partIds = (units: readonly { readonly partId: number }[]): number[] =>
  units.map((u) => u.partId);

const cartonJson = (carton: Carton) => ({
  id: carton.id,
  orderId: carton.orderId,
  product: carton.product,
  capacity: carton.capacity,
  status: carton.status,
  closedAt: carton.closedAt === null ? null : iso(carton.closedAt),
  members: { count: carton.members.length, sha256: sha256(partIds(carton.members)) },
});

const positionJson = (p: Position) => ({ at: iso(p.at) });

const limitsJson = (limits: ChartLimits) => ({
  subgroupSize: limits.subgroupSize,
  window: { from: positionJson(limits.window.from), to: positionJson(limits.window.to) },
  counts: { ...limits.counts },
  statistics: {
    mean: fraction(limits.statistics.mean),
    movingRange: fraction(limits.statistics.movingRange),
    grandMean: fraction(limits.statistics.grandMean),
    range: fraction(limits.statistics.range),
  },
  charts: Object.fromEntries(
    CHARTS.map((chart) => [
      chart,
      {
        lower: fraction(limits.charts[chart].lower),
        centre: fraction(limits.charts[chart].centre),
        upper: fraction(limits.charts[chart].upper),
      },
    ]),
  ),
});

export const versionJson = (v: LimitVersion) => ({
  version: v.version,
  createdAt: iso(v.createdAt),
  from: v.from === null ? null : positionJson(v.from),
  until: v.until === null ? null : positionJson(v.until),
  endedAt: v.endedAt === null ? null : iso(v.endedAt),
  limits: limitsJson(v.limits),
});

/** A chart point as `points.{chart}.sha256` hashes it. */
export const pointJson = (p: Point) => ({
  ...keyParts(p.key),
  at: iso(p.position.at),
  segment: p.segment,
  value: fraction(p.value),
  version: p.version,
  baseline: p.baseline,
  rules: [...p.rules],
});

export const episodeJson = (e: Episode) => ({
  chart: e.chart,
  rule: e.rule,
  version: e.version,
  ...keyParts(e.key),
  at: iso(e.position.at),
  last: keyParts(e.lastKey),
  points: e.points,
  closedBy: e.closedBy === null ? null : keyParts(e.closedBy),
  baseline: e.baseline,
});

export type EpisodeJson = ReturnType<typeof episodeJson>;

/** An episode's identity: characteristic aside, chart, rule, version and triggering point. */
export const episodeIdentity = (e: {
  readonly chart: string;
  readonly rule: number;
  readonly version: number;
  readonly partId: number;
  readonly pass: number;
}): string =>
  `${e.chart}~${String(e.rule)}~${String(e.version)}~${String(e.partId)}/${String(e.pass)}`;

/** The section of a trace as `traceSection` writes it, without `drifts` (see the file's comment). */
export function sectionOf(trace: Trace) {
  const units = unitsJson(trace);
  const chart = trace.spc.chart;
  return {
    traceConfigSha256: sha256(trace.config),
    config: trace.config,
    units: { count: units.length, unitsTraceSha256: sha256(units) },
    orders: trace.orders.map((o) => ({
      orderId: o.orderId,
      product: o.product,
      completedAt: o.completedAt === null ? null : iso(o.completedAt),
    })),
    lots: trace.lots.map((lot) => ({
      lot: lot.lot,
      material: lot.material,
      consumed: lot.consumed,
      units: partIds(lot.units),
      orders: [...lot.orders],
      cartons: [...lot.cartons],
    })),
    cartons: trace.cartons.map(cartonJson),
    spc: {
      characteristic: trace.spc.characteristic,
      readings: { firstPass: chart.firstPass.length, retests: chart.retests.length },
      limits: trace.spc.limits.map(versionJson),
      points: Object.fromEntries(
        CHARTS.map((name: ChartName) => {
          const points = chart.points[name].map(pointJson);
          return [name, { count: points.length, sha256: sha256(points) }];
        }),
      ),
      subgroups: { complete: chart.points.Xbar.length, pending: chart.pending.length },
      episodes: chart.episodes.map(episodeJson),
    },
  };
}

export type TraceSectionJson = ReturnType<typeof sectionOf> & {
  drifts?: readonly {
    readonly injection: number;
    readonly start: {
      partId: number;
      pass: number;
      at: string;
      value: number;
      firstPassBefore: number;
    } | null;
    readonly firstEpisode: (EpisodeJson & { latency: number | null }) | null;
    readonly counterfactual: { readonly clean: boolean };
    readonly window: { readonly before: number; readonly after: number };
  }[];
};
