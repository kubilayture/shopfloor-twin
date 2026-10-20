/**
 * Line throughput OEE as JSON (#232): `GET /oee/line`, `GET /oee/line/orders`, the `oee:line` push
 * topic and an order's `line`. A value has the shape of the simulator's ground truth
 * (`line-oee.json`'s `LineValueJson`: `from`, `to`, `plannedBusyMs`, `good`, `idealMs`, `oee`,
 * `aboveOne`) plus `through`, so a final bucket compares with the truth's with one equality.
 */
import type { BottleneckDto, LineBucketDto, OrderLineDto } from '@shopfloor/contracts/mes-api';
import { formatFraction, type Bottleneck } from '@shopfloor/oee-core';
import type { LineBucket, LineValue, OrderLineView } from '../oee/index.ts';
import { ratio } from './oee-dto.ts';

const iso = (at: number): string => new Date(at).toISOString();

function safe(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${String(value)} is not a safe integer`);
  return n;
}

export function lineValueDto(value: LineValue): Omit<OrderLineDto, 'open' | 'final'> {
  return {
    from: iso(value.from),
    to: iso(value.to),
    through: iso(value.through),
    plannedBusyMs: safe(value.result.plannedBusyMs),
    good: { ...value.good },
    idealMs: formatFraction(value.result.idealMs),
    oee: value.result.oee === null ? null : ratio(value.result.oee),
    aboveOne: value.result.aboveOne,
  };
}

export function orderLineDto(line: OrderLineView): OrderLineDto {
  return { ...lineValueDto(line.value), open: line.open, final: line.final };
}

export function lineBucketDto(bucket: LineBucket): LineBucketDto {
  return {
    bucket: bucket.bucket,
    key: bucket.key,
    ...lineValueDto(bucket.value),
    final: bucket.final,
    incidents: bucket.incidents.map((incident) => ({ ...incident })),
    mayRevise: bucket.mayRevise,
    revision: bucket.revision,
    epoch: bucket.epoch,
  };
}

export function bottleneckDtos(bottlenecks: Readonly<Record<string, Bottleneck>>): BottleneckDto[] {
  return Object.values(bottlenecks)
    .map((b) => ({
      product: b.product,
      operation: b.operation,
      equipment: [...b.equipment],
      idealCycleMs: b.idealCycleMs,
      effectiveCycleMs: formatFraction(b.effectiveCycleMs),
    }))
    .sort((a, b) => (a.product < b.product ? -1 : a.product > b.product ? 1 : 0));
}
