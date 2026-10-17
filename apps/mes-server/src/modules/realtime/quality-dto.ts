import { formatFraction, type Fraction } from '@shopfloor/oee-core';
import {
  CHARTS,
  RULE_TEXT,
  type ChartLimits,
  type Point,
  type Position,
  type Rule,
} from '@shopfloor/spc-core';
import type {
  CharacteristicDto,
  LimitVersionDto,
  SpcChartDto,
  SpcMeasurementDto,
  SpcPointDto,
  SpcPositionDto,
  SpcSignalDto,
  SpcValueDto,
} from '@shopfloor/contracts/mes-api';
import {
  keyParts,
  type CharacteristicRecord,
  type ChartView,
  type LimitRecord,
  type MeasurementRecord,
  type PointRef,
  type SignalRecord,
} from '../quality/index.ts';

const iso = (at: number | Date): string => new Date(at).toISOString();
const isoOrNull = (at: Date | null): string | null => (at === null ? null : at.toISOString());

/** A value in steps as the API shows it: the unit's double and the exact fraction of steps. */
export function spcValue(steps: Fraction, resolution: number): SpcValueDto {
  return {
    value: (Number(steps.num) / Number(steps.den)) * resolution,
    steps: formatFraction(steps),
  };
}

const position = (p: Position): SpcPositionDto => ({ epoch: p.epoch, at: iso(p.at), seq: p.seq });

export function characteristicDto(c: CharacteristicRecord): CharacteristicDto {
  return {
    id: c.id,
    name: c.name,
    equipment: c.equipment,
    operation: c.operation,
    unit: c.unit,
    resolution: c.resolution,
    upperSpec: c.upperSpec,
    subgroupSize: c.subgroupSize,
    baselineSubgroups: c.baselineSubgroups,
    rules: { I: [...c.rules.I], MR: [...c.rules.MR], Xbar: [...c.rules.Xbar], R: [...c.rules.R] },
    version: c.version,
    currentLimits: c.currentLimits,
    baseline: { ...c.baseline },
    notice:
      c.notice === null
        ? null
        : { kind: c.notice.kind, at: c.notice.at.toISOString(), detail: c.notice.detail },
    signals: { ...c.signals },
  };
}

export function limitVersionDto(v: LimitRecord, resolution: number): LimitVersionDto {
  const value = (f: Fraction) => spcValue(f, resolution);
  const limits: ChartLimits = v.limits;
  const charts = {} as LimitVersionDto['charts'];
  for (const chart of CHARTS) {
    const l = limits.charts[chart];
    charts[chart] = { lower: value(l.lower), centre: value(l.centre), upper: value(l.upper) };
  }
  return {
    version: v.version,
    createdAt: iso(v.createdAt),
    createdBy: v.createdBy,
    comment: v.comment,
    from: v.from === null ? null : position(v.from),
    until: v.until === null ? null : position(v.until),
    endedAt: v.endedAt === null ? null : iso(v.endedAt),
    endedBy: v.endedBy,
    window: { from: position(limits.window.from), to: position(limits.window.to) },
    subgroupSize: limits.subgroupSize,
    counts: { ...limits.counts },
    statistics: {
      mean: value(limits.statistics.mean),
      movingRange: value(limits.statistics.movingRange),
      grandMean: value(limits.statistics.grandMean),
      range: value(limits.statistics.range),
    },
    charts,
    capability:
      v.capability === null
        ? null
        : {
            sigma: value(v.capability.sigma),
            cpu: Number(v.capability.cpu.num) / Number(v.capability.cpu.den),
            cpk: Number(v.capability.cpk.num) / Number(v.capability.cpk.den),
          },
  };
}

const pointRef = (p: PointRef) => ({
  epoch: p.epoch,
  partId: p.partId,
  pass: p.pass,
  at: iso(p.at),
  seq: p.seq,
});

export function signalDto(s: SignalRecord): SpcSignalDto {
  return {
    id: s.id,
    characteristic: s.characteristic,
    chart: s.chart,
    rule: s.rule,
    ruleText: RULE_TEXT[s.rule as Rule],
    version: s.version,
    first: pointRef(s.first),
    last: pointRef(s.last),
    points: s.points,
    closedBy: s.closedBy === null ? null : pointRef(s.closedBy),
    baseline: s.baseline,
    status: s.status,
    detectedAt: s.detectedAt.toISOString(),
    detectedPlantAt: isoOrNull(s.detectedPlantAt),
    finalAt: isoOrNull(s.finalAt),
    withdrawnAt: isoOrNull(s.withdrawnAt),
    withdrawnReason: s.withdrawnReason,
    acknowledged:
      s.acknowledged === null
        ? null
        : {
            by: s.acknowledged.by,
            at: s.acknowledged.at.toISOString(),
            plantAt: isoOrNull(s.acknowledged.plantAt),
            comment: s.acknowledged.comment,
          },
    orphaned: s.acknowledged !== null && s.status === 'withdrawn',
    rowVersion: s.rowVersion,
  };
}

export function measurementDto(m: MeasurementRecord): SpcMeasurementDto {
  return {
    epoch: m.epoch,
    partId: m.partId,
    pass: m.pass,
    at: m.at.toISOString(),
    seq: m.seq,
    value: m.value,
    steps: m.steps,
    upperLimit: m.upperLimit,
    result: m.result,
    final: m.final,
  };
}

function pointDto(p: Point, resolution: number, final: (p: Position) => boolean): SpcPointDto {
  const { partId, pass } = keyParts(p.key);
  return {
    partId,
    pass,
    epoch: p.position.epoch,
    at: iso(p.position.at),
    seq: p.position.seq,
    segment: p.segment,
    value: spcValue(p.value, resolution),
    version: p.version,
    baseline: p.baseline,
    rules: [...p.rules],
    final: final(p.position),
  };
}

/**
 * The charts of a characteristic, optionally only the points whose plant time lies in [from, to)
 * (the limits, counts and signals stay whole).
 */
export function spcChartDto(view: ChartView, range: { from?: Date; to?: Date } = {}): SpcChartDto {
  const resolution = view.characteristic.resolution;
  const inRange = (p: Point): boolean =>
    (range.from === undefined || p.position.at >= range.from.getTime()) &&
    (range.to === undefined || p.position.at < range.to.getTime());
  const points = (chart: (typeof CHARTS)[number]) =>
    view.chart.points[chart].filter(inRange).map((p) => pointDto(p, resolution, view.final));
  return {
    characteristic: characteristicDto(view.characteristic),
    limits: view.limits.map((v) => limitVersionDto(v, resolution)),
    finalThrough: view.finalThrough?.at
      ? {
          epoch: view.finalThrough.epoch,
          seq: view.finalThrough.seq,
          at: iso(view.finalThrough.at),
        }
      : null,
    readings: { firstPass: view.chart.firstPass.length, retests: view.chart.retests.length },
    points: { I: points('I'), MR: points('MR'), Xbar: points('Xbar'), R: points('R') },
    subgroups: {
      complete: view.chart.points.Xbar.length,
      pending: view.chart.pending.length,
      dropped: view.chart.dropped.length,
    },
    retests: view.retests.map(measurementDto),
    signals: view.signals.map(signalDto),
  };
}
