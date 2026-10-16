/**
 * OEE, shift and downtime answers as JSON (#120): BigInt totals become numbers (checked safe),
 * fractions `num/den` strings with their four-decimal value, in the same shape as the simulator's
 * ground truth (`resultJson` of sim-summary/2), so the two compare with one equality.
 */
import { formatFraction, toDecimal, type Fraction, type OeeResult } from '@shopfloor/oee-core';
import { UNCODED } from '@shopfloor/plant-config';
import { dominantReason, effectiveSegments, type DowntimeRecord } from '../equipment/index.ts';
import type { ScheduledShift } from '@shopfloor/shift-calendar';
import { downtimeId, recordEnd, type OeeBucket } from '../oee/index.ts';
import type {
  DowntimeRecordDto,
  OeeBucketDto,
  OeeResultDto,
  Ratio,
  ShiftInstanceDto,
} from './schemas.ts';

const iso = (at: number | Date): string => new Date(at).toISOString();

function n(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${String(value)} is not a safe integer`);
  }
  return result;
}

export const ratio = (f: Fraction): Ratio => ({
  fraction: formatFraction(f),
  decimal: toDecimal(f),
});

const nullable = (f: Fraction | null): Ratio | null => (f === null ? null : ratio(f));

export function resultDto(result: OeeResult): OeeResultDto {
  const t = result.totals;
  const losses = result.losses;
  return {
    availability: nullable(result.availability),
    performance: nullable(result.performance),
    quality: nullable(result.quality),
    oee: nullable(result.oee),
    anomaly: result.anomaly,
    provisional: result.provisional,
    totals: {
      plannedBusyMs: n(t.plannedBusyMs),
      actualProductionMs: n(t.actualProductionMs),
      excludedMs: n(t.excludedMs),
      longStopMs: n(t.longStopMs),
      microStopMs: n(t.microStopMs),
      idealMs: n(t.idealMs),
      good: n(t.good),
      scrap: n(t.scrap),
      rework: n(t.rework),
      produced: n(t.produced),
    },
    unplanned: {
      good: n(t.unplanned.good),
      produced: n(t.unplanned.produced),
      idealMs: n(t.unplanned.idealMs),
    },
    losses:
      losses === null
        ? null
        : {
            availability: {
              own: {
                stopped: n(losses.availability.own.stopped),
                down: n(losses.availability.own.down),
                setup: n(losses.availability.own.setup),
                idle: n(losses.availability.own.idle),
                total: n(losses.availability.own.total),
              },
              external: {
                starved: n(losses.availability.external.starved),
                blocked: n(losses.availability.external.blocked),
                total: n(losses.availability.external.total),
              },
            },
            performance: {
              microStops: n(losses.performance.microStops),
              speed: n(losses.performance.speed),
              total: n(losses.performance.total),
            },
            quality: ratio(losses.quality),
          },
  };
}

export function bucketDto(bucket: OeeBucket): OeeBucketDto {
  return {
    scope: bucket.scope,
    id: bucket.id,
    bucket: bucket.bucket,
    key: bucket.key,
    shiftKey: bucket.shiftKey,
    start: iso(bucket.start),
    end: iso(bucket.end),
    members: bucket.members.map((m) => ({ equipment: m.equipment, epoch: m.epoch })),
    inputs: {
      stateMs: { ...bucket.stateMs },
      cycles: bucket.cycles.map((c) => ({ product: c.product, result: c.result, count: c.count })),
      stops: bucket.stops,
    },
    result: resultDto(bucket.result),
    final: bucket.final,
    provisionalMs: bucket.provisionalMs,
    revision: bucket.revision,
    incidents: bucket.incidents,
  };
}

export const shiftInstanceDto = (instance: ScheduledShift): ShiftInstanceDto => ({
  key: instance.key,
  date: instance.date,
  shift: instance.shift,
  start: iso(instance.start),
  end: iso(instance.end),
  breaks: instance.breaks.map((b) => ({ start: iso(b.start), end: iso(b.end) })),
});

/** A record with the reasons in effect (#121): codings where they lie, the auto reason elsewhere. */
export function recordDto(record: DowntimeRecord, watermark: Date | undefined): DowntimeRecordDto {
  const start = record.start.getTime();
  const end = recordEnd(record, watermark);
  const segments = effectiveSegments(start, end, record.autoReason, record.codings);
  return {
    id: downtimeId(record),
    equipment: record.equipment,
    epoch: record.epoch,
    start: iso(record.start),
    end: record.end === null ? null : iso(record.end),
    intervalStart: iso(record.intervalStart),
    shiftKey: record.shiftKey,
    state: record.state,
    cause: record.cause,
    loss: record.loss,
    autoReason: record.autoReason,
    reason: dominantReason(segments),
    provisional: record.provisional,
    ms: end - start,
    segments: segments.map((segment) => ({
      from: iso(segment.from),
      to: iso(segment.to),
      reason: segment.reason,
      coded: segment.coded,
    })),
    codings: record.codings.map((coding) => ({
      from: iso(coding.from),
      to: iso(coding.to),
      reason: coding.reason,
      comment: coding.comment,
      codedBy: coding.codedBy,
      codedAt: iso(coding.codedAt),
      version: coding.version,
    })),
    // An open record keeps growing under its auto reason, so it is never fully coded.
    uncoded:
      record.autoReason === UNCODED &&
      (record.end === null || segments.some((segment) => !segment.coded)),
    version: record.codingVersion,
  };
}
