import type {
  BottleneckDto,
  DowntimeRecordDto,
  LineBucketDto,
  LineOeeDto,
  OeeBucketDto,
  OeeResultDto,
  OrderJobOeeDto,
  OrderOeeDto,
  Pareto,
  ReasonCodes,
  ShiftInstanceDto,
} from '@shopfloor/contracts/mes-api';
import { EPOCH } from './fixtures.ts';

/** The URL a stubbed `fetch` was called with. */
export const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** The JSON body a stubbed `fetch` was sent, if any. */
export const requestBody = (init: RequestInit | undefined): unknown =>
  typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;

export const SHIFT_KEY = '2026-10-15/A';
export const SHIFT_START = '2026-10-15T03:00:00.000Z';
export const SHIFT_END = '2026-10-15T11:00:00.000Z';
export const CLOCK = '2026-10-15T06:10:00.000Z';

/**
 * A consistent result: PBT 1 000 000 ms, own loss 150 000, external 50 000, APT 800 000,
 * micro-stops 40 000, ideal 700 000 (speed 60 000), 9 good of 10 (quality loss 70 000):
 * A 4/5, P 7/8, Q 9/10, OEE 63/100.
 */
export function result(overrides: Partial<OeeResultDto> = {}): OeeResultDto {
  return {
    availability: { fraction: '4/5', decimal: '0.8000' },
    performance: { fraction: '7/8', decimal: '0.8750' },
    quality: { fraction: '9/10', decimal: '0.9000' },
    oee: { fraction: '63/100', decimal: '0.6300' },
    anomaly: false,
    provisional: false,
    totals: {
      plannedBusyMs: 1_000_000,
      actualProductionMs: 800_000,
      excludedMs: 0,
      longStopMs: 0,
      microStopMs: 40_000,
      idealMs: 700_000,
      good: 9,
      scrap: 1,
      rework: 0,
      produced: 10,
    },
    unplanned: { good: 0, produced: 0, idealMs: 0 },
    losses: {
      availability: {
        own: { stopped: 0, down: 100_000, setup: 0, idle: 50_000, total: 150_000 },
        external: { starved: 50_000, blocked: 0, total: 50_000 },
      },
      performance: { microStops: 40_000, speed: 60_000, total: 100_000 },
      quality: { fraction: '70000/1', decimal: '70000.0000' },
    },
    ...overrides,
  };
}

/** PBT = 0: every ratio null ("n/a"), no losses. */
export function emptyResult(): OeeResultDto {
  return result({
    availability: null,
    performance: null,
    quality: null,
    oee: null,
    losses: null,
    totals: {
      plannedBusyMs: 0,
      actualProductionMs: 0,
      excludedMs: 1_000_000,
      longStopMs: 0,
      microStopMs: 0,
      idealMs: 0,
      good: 0,
      scrap: 0,
      rework: 0,
      produced: 0,
    },
  });
}

export function bucket(
  id: string,
  overrides: Partial<OeeBucketDto> = {},
  scope: OeeBucketDto['scope'] = id.includes('-0') ? 'equipment' : 'work-center',
): OeeBucketDto {
  return {
    scope,
    id,
    bucket: 'shift',
    key: SHIFT_KEY,
    shiftKey: SHIFT_KEY,
    start: SHIFT_START,
    end: SHIFT_END,
    members: [{ equipment: id, epoch: EPOCH }],
    inputs: { stateMs: { Running: 800_000 }, cycles: [], stops: 0 },
    result: result(),
    final: false,
    provisionalMs: 120_000,
    revision: 0,
    incidents: 0,
    ...overrides,
  };
}

export function hourBucket(id: string, hourStart: string, overrides: Partial<OeeBucketDto> = {}) {
  return bucket(id, {
    bucket: 'hour',
    key: hourStart,
    start: hourStart,
    end: new Date(Date.parse(hourStart) + 3_600_000).toISOString(),
    ...overrides,
  });
}

export const SHIFT: ShiftInstanceDto = {
  key: SHIFT_KEY,
  date: '2026-10-15',
  shift: 'A',
  start: SHIFT_START,
  end: SHIFT_END,
  breaks: [],
};

export const PREVIOUS_SHIFT: ShiftInstanceDto = {
  key: '2026-10-14/C',
  date: '2026-10-14',
  shift: 'C',
  start: '2026-10-14T19:00:00.000Z',
  end: '2026-10-15T03:00:00.000Z',
  breaks: [],
};

export const CURRENT_SHIFT = {
  clock: { epoch: EPOCH, watermark: CLOCK },
  shiftKey: SHIFT_KEY,
  shift: SHIFT,
};

export const PARETO: Pareto = {
  scope: 'work-center',
  id: 'cell-m1',
  from: SHIFT_START,
  to: SHIFT_END,
  members: [{ equipment: 'cnc-01', epoch: EPOCH }],
  availability: { own: 150_000, external: 50_000 },
  reasons: [
    {
      reason: 'BREAKDOWN/SPINDLE-OVERLOAD',
      name: 'Spindle overload',
      loss: 'own',
      ms: 100_000,
      records: 1,
    },
    {
      reason: 'STARVED',
      name: 'Starved by the upstream station',
      loss: 'external',
      ms: 50_000,
      records: 2,
    },
    {
      reason: 'ORGANISATION/UNSPECIFIED',
      name: 'Idle, cause not reported',
      loss: 'own',
      ms: 50_000,
      records: 1,
    },
  ],
  microStops: [{ cause: 'CHIP-JAM', ms: 40_000, stops: 4 }],
};

export const REASONS: ReasonCodes = {
  reasons: [
    { id: 'BREAKDOWN', parent: null, name: 'Breakdown', active: true },
    {
      id: 'BREAKDOWN/SPINDLE-OVERLOAD',
      parent: 'BREAKDOWN',
      name: 'Spindle overload',
      active: true,
    },
    {
      id: 'BREAKDOWN/UNSPECIFIED',
      parent: 'BREAKDOWN',
      name: 'Breakdown, cause not reported',
      active: true,
    },
    { id: 'SETUP', parent: null, name: 'Setup', active: true },
    { id: 'SETUP/TOOL-CHANGE', parent: 'SETUP', name: 'Tool change', active: true },
    { id: 'OLD', parent: null, name: 'Retired', active: false },
    { id: 'UNCODED', parent: null, name: 'Not coded', active: true },
  ],
};

export function record(overrides: Partial<DowntimeRecordDto> = {}): DowntimeRecordDto {
  const start = overrides.start ?? '2026-10-15T04:00:00.000Z';
  const end = overrides.end === undefined ? '2026-10-15T04:10:00.000Z' : overrides.end;
  const id = overrides.id ?? `cnc-01~${String(EPOCH)}~${String(Date.parse(start))}`;
  const ms = end === null ? 300_000 : Date.parse(end) - Date.parse(start);
  return {
    id,
    equipment: 'cnc-01',
    epoch: EPOCH,
    start,
    end,
    intervalStart: start,
    shiftKey: SHIFT_KEY,
    state: 'Down',
    cause: null,
    loss: 'own',
    autoReason: 'UNCODED',
    reason: 'UNCODED',
    provisional: false,
    ms,
    segments: [{ from: start, to: end ?? start, reason: 'UNCODED', coded: false }],
    codings: [],
    uncoded: true,
    version: 3,
    ...overrides,
  };
}

// ---- Order and line OEE (#233) ----

/** The MES's bottleneck per product: ASM-01 for both (ideal ÷ 1 machine). */
export const BOTTLENECKS: BottleneckDto[] = [
  {
    product: 'VB-100',
    operation: 'OP30',
    equipment: ['asm-01'],
    idealCycleMs: 150_000,
    effectiveCycleMs: '150000/1',
  },
  {
    product: 'VB-200',
    operation: 'OP30',
    equipment: ['asm-01'],
    idealCycleMs: 210_000,
    effectiveCycleMs: '210000/1',
  },
];

/**
 * A line bucket: 100 good VB-100 × 150 s = 15 000 000 ms ideal over 20 000 000 ms planned,
 * line OEE 3/4.
 */
export function lineBucket(
  bucket: 'hour' | 'shift',
  key: string,
  overrides: Partial<LineBucketDto> = {},
): LineBucketDto {
  const from = bucket === 'shift' ? SHIFT_START : key;
  const to = bucket === 'shift' ? SHIFT_END : new Date(Date.parse(key) + 3_600_000).toISOString();
  return {
    bucket,
    key,
    from,
    to,
    through: to,
    plannedBusyMs: 20_000_000,
    good: { 'VB-100': 100 },
    idealMs: '15000000/1',
    oee: { fraction: '3/4', decimal: '0.7500' },
    aboveOne: false,
    final: false,
    incidents: [],
    mayRevise: false,
    revision: 0,
    ...overrides,
  };
}

export function lineOee(bucket: 'hour' | 'shift', buckets: LineBucketDto[]): LineOeeDto {
  return {
    bucket,
    from: SHIFT_START,
    to: SHIFT_END,
    productionMode: 'orders',
    bottlenecks: BOTTLENECKS,
    buckets,
  };
}

/** A job of an order: head at its accepted fact, a closed window, OEE 63/100 (`result`). */
export function orderJob(
  commandId: string,
  overrides: Partial<OrderJobOeeDto> = {},
): OrderJobOeeDto {
  return {
    commandId,
    machine: 'cnc-01',
    deviceEpoch: EPOCH,
    quantity: 20,
    notBefore: SHIFT_START,
    head: { kind: 'head', at: SHIFT_START, source: 'accepted', reason: null },
    window: {
      from: SHIFT_START,
      to: '2026-10-15T04:30:00.000Z',
      open: false,
      headTimeUnknown: false,
      endLost: false,
      lost: false,
    },
    cycles: 10,
    oee: result(),
    final: true,
    ...overrides,
  };
}

/** An order's own line OEE: 9 good × 150 s over 2 h in progress, 3/16; final. */
export const ORDER_LINE: NonNullable<OrderOeeDto['line']> = {
  from: SHIFT_START,
  to: '2026-10-15T05:00:00.000Z',
  through: '2026-10-15T05:00:00.000Z',
  plannedBusyMs: 7_200_000,
  good: { 'VB-100': 9 },
  idealMs: '1350000/1',
  oee: { fraction: '3/16', decimal: '0.1875' },
  aboveOne: false,
  open: false,
  final: true,
};

/** An order's OEE (`GET /oee/orders/{id}`): final, one job, yield 9/10, line OEE 3/16. */
export function orderOee(orderId: string, overrides: Partial<OrderOeeDto> = {}): OrderOeeDto {
  return {
    orderId,
    product: 'VB-100',
    status: 'completed',
    oee: result(),
    open: false,
    pending: false,
    headTimeUnknown: false,
    endLost: false,
    lost: false,
    final: true,
    jobs: [orderJob(`${orderId}-1`)],
    firstPassYield: {
      firstPassGood: 9,
      started: 10,
      yield: { fraction: '9/10', decimal: '0.9000' },
      final: true,
    },
    completedAt: '2026-10-15T05:00:00.000Z',
    cutoffs: [{ machine: 'cnc-01', epoch: EPOCH, at: '2026-10-15T06:00:00.000Z' }],
    incidents: [],
    mayRevise: false,
    revision: 0,
    line: ORDER_LINE,
    ...overrides,
  };
}
