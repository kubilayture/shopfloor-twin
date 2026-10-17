import type {
  CharacteristicDto,
  HoldDetailDto,
  HoldDto,
  HoldReasonList,
  HoldSuggestionDto,
  LimitVersionDto,
  SpcChartDto,
  SpcChartName,
  SpcPointDto,
  SpcSignalDto,
} from '@shopfloor/contracts/mes-api';

// SPC and holds as the MES of #200 and #201 answers them, for the quality screens' tests (#203).

export const T0 = Date.parse('2026-10-15T04:00:00.000Z');
export const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const v = (value: number) => ({ value, steps: `${String(Math.round(value * 1000))}/1` });

export function characteristic(overrides: Partial<CharacteristicDto> = {}): CharacteristicDto {
  return {
    id: 'leak-rate',
    name: 'Leak rate',
    equipment: 'lkt-01',
    operation: 'OP40',
    unit: 'Pa/min',
    resolution: 0.001,
    upperSpec: 3.2,
    subgroupSize: 5,
    baselineSubgroups: 20,
    rules: { I: [1, 2, 5], MR: [], Xbar: [1, 2, 5], R: [1] },
    version: 2,
    currentLimits: 1,
    baseline: { needed: 100, final: 100 },
    notice: null,
    signals: { open: 1, unacknowledged: 2 },
    ...overrides,
  };
}

const limits = (lower: number, centre: number, upper: number) => ({
  lower: v(lower),
  centre: v(centre),
  upper: v(upper),
});

export function limitVersion(
  version = 1,
  overrides: Partial<LimitVersionDto> = {},
): LimitVersionDto {
  return {
    version,
    createdAt: at(100),
    createdBy: version === 1 ? 'system' : 'quinn',
    comment: version === 1 ? null : 'after calibration',
    from: null,
    until: null,
    endedAt: null,
    endedBy: null,
    window: {
      from: { epoch: 1, at: at(1), seq: 1 },
      to: { epoch: 1, at: at(100), seq: 100 },
    },
    subgroupSize: 5,
    counts: { readings: 100, movingRanges: 99, subgroups: 20 },
    statistics: { mean: v(2), movingRange: v(0.5), grandMean: v(2), range: v(1) },
    charts: {
      I: limits(0.67, 2, 3.33),
      MR: limits(0, 0.5, 1.63),
      Xbar: limits(1.42, 2, 2.58),
      R: limits(0, 1, 2.11),
    },
    capability: { sigma: v(0.43), cpu: 0.93, cpk: 0.93 },
    ...overrides,
  };
}

export function point(
  minutes: number,
  value: number,
  overrides: Partial<SpcPointDto> = {},
): SpcPointDto {
  return {
    partId: minutes,
    pass: 1,
    epoch: 1,
    at: at(minutes),
    seq: minutes,
    segment: 0,
    value: v(value),
    version: 1,
    baseline: minutes <= 100,
    rules: [],
    final: true,
    ...overrides,
  };
}

const ref = (minutes: number) => ({
  epoch: 1,
  partId: minutes,
  pass: 1,
  at: at(minutes),
  seq: minutes,
});

export function signal(id: number, overrides: Partial<SpcSignalDto> = {}): SpcSignalDto {
  return {
    id,
    characteristic: 'leak-rate',
    chart: 'I',
    rule: 1,
    ruleText: 'one point beyond a control limit',
    version: 1,
    first: ref(100 + id),
    last: ref(100 + id),
    points: 1,
    closedBy: null,
    extentFinal: false,
    baseline: false,
    status: 'provisional',
    detectedAt: at(100 + id),
    detectedPlantAt: at(100 + id),
    finalAt: null,
    withdrawnAt: null,
    withdrawnReason: null,
    acknowledged: null,
    orphaned: false,
    rowVersion: 1,
    ...overrides,
  };
}

export function chart(overrides: Partial<SpcChartDto> = {}): SpcChartDto {
  const pts = (name: SpcChartName) =>
    name === 'I'
      ? [point(101, 2.1), point(102, 3.5, { rules: [1], final: false })]
      : name === 'MR'
        ? [point(102, 1.4, { final: false })]
        : [];
  return {
    characteristic: characteristic(),
    limits: [limitVersion(1)],
    finalThrough: { epoch: 1, at: at(101), seq: 101 },
    readings: { firstPass: 102, retests: 1 },
    points: { I: pts('I'), MR: pts('MR'), Xbar: pts('Xbar'), R: pts('R') },
    subgroups: { complete: 20, pending: 2, dropped: 0 },
    pointsFrom: null,
    retests: [
      {
        epoch: 1,
        partId: 50,
        pass: 2,
        at: at(101),
        seq: 150,
        value: 2.2,
        steps: 2200,
        upperLimit: 3.2,
        result: 'good',
        final: true,
      },
    ],
    signals: [signal(2), signal(1, { status: 'final', extentFinal: true, closedBy: ref(102) })],
    ...overrides,
  };
}

export const HOLD_ID = '0f0e0d0c-0b0a-4900-8800-000000000001';
export const HOLD_ID_2 = '0f0e0d0c-0b0a-4900-8800-000000000002';

export function hold(overrides: Partial<HoldDto> = {}): HoldDto {
  return {
    id: HOLD_ID,
    subject: { kind: 'lot', id: 'K1' },
    state: 'open',
    reason: 'SUSPECT-LOT',
    openedBy: 'quinn',
    openedAt: at(110),
    openedPlantAt: at(110),
    decidedBy: null,
    decidedAt: null,
    decidedPlantAt: null,
    decisionReason: null,
    transitions: 1,
    version: 1,
    scope: { units: 2, cartons: 1, orders: 1 },
    heldMaterialConsumed: 0,
    ...overrides,
  };
}

export function holdDetail(base: HoldDto = hold()): HoldDetailDto {
  return {
    hold: base,
    transitions: [
      {
        n: 1,
        kind: 'opened',
        reason: base.reason,
        comment: 'supplier warning',
        by: base.openedBy,
        at: base.openedAt,
        plantAt: base.openedPlantAt,
        scope: { units: 1, cartons: 1, orders: 1, asOf: at(110), final: false },
        notification: {
          idempotencyKey: `${base.id}~opened~1`,
          status: 'sent',
          attempts: 1,
          lastError: null,
        },
      },
    ],
    units: [
      {
        epoch: 1,
        partId: 7,
        serial: 'VB-100-000007',
        orderId: 'PO-1001',
        carton: 'PO-1001-C01',
        joinedAt: at(110),
      },
      { epoch: 1, partId: 8, serial: null, orderId: 'PO-1001', carton: null, joinedAt: at(111) },
    ],
    unitsTruncated: false,
    orders: ['PO-1001'],
    cartons: ['PO-1001-C01'],
    incidents: [
      {
        id: 4,
        type: 'held-material-consumed',
        lot: 'K1',
        equipment: 'asm-01',
        epoch: 1,
        seq: 30,
        partId: 8,
        operation: 'OP30',
        pass: 1,
        consumedAt: at(111),
        message: 'lot K1 consumed after the hold opened',
        detectedAt: at(111),
      },
    ],
  };
}

export const REASONS: HoldReasonList = {
  reasons: [
    { id: 'SUSPECT-LOT', name: 'Suspect lot', for: ['open'] },
    { id: 'SPC-SIGNAL', name: 'SPC signal', for: ['open'] },
    { id: 'CONFORMS', name: 'Conforms', for: ['release'] },
    { id: 'NONCONFORMING', name: 'Nonconforming', for: ['reject'] },
  ],
};

export function suggestion(overrides: Partial<HoldSuggestionDto> = {}): HoldSuggestionDto {
  return {
    signal: 2,
    characteristic: 'leak-rate',
    chart: 'I',
    rule: 1,
    after: { epoch: 1, at: at(101), seq: 101 },
    through: { epoch: 1, at: at(102), seq: 102 },
    readings: 2,
    units: [
      {
        epoch: 1,
        partId: 102,
        serial: 'VB-100-000102',
        orderId: 'PO-1001',
        carton: 'PO-1001-C02',
      },
      { epoch: 1, partId: 103, serial: null, orderId: 'PO-1001', carton: null },
    ],
    orders: ['PO-1001'],
    cartons: ['PO-1001-C02'],
    final: false,
    ...overrides,
  };
}
