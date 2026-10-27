import type {
  CartonTraceDto,
  EquipmentDto,
  HoldDto,
  HoldRefDto,
  LotTraceDto,
  SerialTraceDto,
  TraceRecordDto,
  TraceUnitDto,
} from '@shopfloor/contracts/mes-api';
import { PLANT, json, problem } from './fixtures.ts';
import { requestUrl } from './oee-fixtures.ts';

// Trace answers (#199, #201) as the screens of #202 read them.

export const HOLD_ID = '3f0b8f8e-2c4f-4c55-9d0c-0c8a3f1f2a10';

export function record(overrides: Partial<TraceRecordDto> = {}): TraceRecordDto {
  return {
    operation: 'OP10',
    pass: 1,
    equipment: 'CNC-01',
    epoch: 3,
    seq: 10,
    at: '2026-10-15T05:00:00.000Z',
    result: 'good',
    reason: null,
    lots: [{ material: 'BLANK-100', lot: 'BL100-2610-01' }],
    operator: null,
    operatorReported: false,
    reading: null,
    crew: [],
    ...overrides,
  };
}

export const RECORDS: TraceRecordDto[] = [
  record(),
  record({
    operation: 'OP20',
    equipment: 'WSH-01',
    seq: 11,
    at: '2026-10-15T05:03:00.000Z',
    lots: null,
  }),
  record({
    operation: 'OP30',
    equipment: 'ASM-01',
    seq: 12,
    at: '2026-10-15T05:06:00.000Z',
    lots: [
      { material: 'SK-1', lot: 'SK1-2610-01' },
      { material: 'SP-100', lot: 'SP100-2610-01' },
    ],
    operator: 'op-ali',
    operatorReported: true,
    crew: [{ userId: 7, username: 'mehmet', from: '2026-10-15T03:00:00.000Z', to: null }],
  }),
  record({
    operation: 'OP40',
    equipment: 'LKT-01',
    seq: 13,
    at: '2026-10-15T05:08:00.000Z',
    result: 'rework',
    reason: 'LEAK',
    lots: [],
    reading: { characteristic: 'leak-rate', value: 2.4, unit: 'Pa/min', upperLimit: 2 },
  }),
  record({
    operation: 'OP30',
    pass: 2,
    equipment: 'ASM-01',
    seq: 14,
    at: '2026-10-15T05:12:00.000Z',
    lots: [{ material: 'SK-1', lot: 'SK1-2610-02' }],
    operator: null,
    operatorReported: true,
  }),
  record({
    operation: 'OP40',
    pass: 2,
    equipment: 'LKT-01',
    seq: 15,
    at: '2026-10-15T05:14:00.000Z',
    lots: [],
    reading: { characteristic: 'leak-rate', value: 1.1, unit: 'Pa/min', upperLimit: 2 },
  }),
];

export function unit(overrides: Partial<TraceUnitDto> = {}): TraceUnitDto {
  return {
    epoch: 3,
    partId: 42,
    serial: 'VB-100-000042',
    product: 'VB-100',
    orderId: 'PO-1001',
    status: 'packed',
    carton: 'PO-1001-C01',
    records: RECORDS,
    holds: [],
    ...overrides,
  };
}

export function serialTrace(overrides: Partial<SerialTraceDto> = {}): SerialTraceDto {
  return { serial: 'VB-100-000042', units: [unit()], final: true, notFinal: [], ...overrides };
}

export function holdRef(overrides: Partial<HoldRefDto> = {}): HoldRefDto {
  return {
    id: HOLD_ID,
    state: 'open',
    subject: { kind: 'lot', id: 'SK1-2610-01' },
    ...overrides,
  };
}

export function lotTrace(overrides: Partial<LotTraceDto> = {}): LotTraceDto {
  return {
    lot: 'SK1-2610-01',
    material: 'SK-1',
    master: {
      id: 'SK1-2610-01',
      material: 'SK-1',
      quantity: 1800,
      status: 'active',
      importedAt: '2026-10-15T02:00:00.000Z',
    },
    consumed: 2,
    units: [
      {
        epoch: 3,
        partId: 42,
        serial: 'VB-100-000042',
        orderId: 'PO-1001',
        carton: 'PO-1001-C01',
        status: 'packed',
      },
      { epoch: 3, partId: 43, serial: null, orderId: null, carton: null, status: 'wip' },
    ],
    truncated: false,
    orders: ['PO-1001'],
    cartons: ['PO-1001-C01'],
    withLots: [
      { material: 'BLANK-100', lot: 'BL100-2610-01' },
      { material: 'SP-100', lot: 'SP100-2610-01' },
    ],
    holds: [],
    final: true,
    notFinal: [],
    ...overrides,
  };
}

export function cartonTrace(overrides: Partial<CartonTraceDto> = {}): CartonTraceDto {
  return {
    carton: {
      id: 'PO-1001-C01',
      orderId: 'PO-1001',
      product: 'VB-100',
      capacity: 20,
      status: 'closed',
      closedAt: '2026-10-15T06:00:00.000Z',
      members: 1,
      held: false,
    },
    units: [
      {
        epoch: 3,
        partId: 42,
        serial: 'VB-100-000042',
        orderId: 'PO-1001',
        carton: 'PO-1001-C01',
        status: 'packed',
      },
    ],
    lots: [
      { material: 'BLANK-100', lot: 'BL100-2610-01' },
      { material: 'SK-1', lot: 'SK1-2610-01' },
    ],
    holds: [],
    final: true,
    notFinal: [],
    ...overrides,
  };
}

/** A hold as the `quality` topic pushes it (#201). */
export function hold(overrides: Partial<HoldDto> = {}): HoldDto {
  return {
    id: HOLD_ID,
    subject: { kind: 'lot', id: 'SK1-2610-01' },
    state: 'open',
    reason: 'SUSPECT-LOT',
    openedBy: 'quality-user',
    openedAt: '2026-10-15T06:10:00.000Z',
    openedPlantAt: '2026-10-15T06:10:00.000Z',
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

/** What the fake MES answers; tests change it between reads. */
export interface TraceState {
  search: Record<string, { kind: 'serial' | 'lot' | 'carton' | 'order'; id: string }[]>;
  serials: Record<string, SerialTraceDto>;
  lots: Record<string, LotTraceDto>;
  cartons: Record<string, CartonTraceDto>;
  /** `GET /equipment` (the machines' names, UX-8); a 404 when absent, as before. */
  equipment?: EquipmentDto[];
}

export function traceState(overrides: Partial<TraceState> = {}): TraceState {
  return { search: {}, serials: {}, lots: {}, cartons: {}, ...overrides };
}

/** The MES as the trace screens see it, counting the reads per path. */
export function traceMes(state: TraceState) {
  const reads: string[] = [];
  const fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(requestUrl(input), 'http://localhost');
    const path = url.pathname;
    reads.push(path + url.search);
    if (path === '/api/v1/plant') return Promise.resolve(json(PLANT));
    if (path === '/api/v1/equipment' && state.equipment) {
      return Promise.resolve(json({ equipment: state.equipment }));
    }
    if (path === '/api/v1/trace/search') {
      const q = url.searchParams.get('q') ?? '';
      return Promise.resolve(json({ q, results: state.search[q] ?? [] }));
    }
    const match = /^\/api\/v1\/trace\/(serials|lots|cartons)\/([^/]+)$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[2] ?? '');
      const table =
        match[1] === 'serials' ? state.serials : match[1] === 'lots' ? state.lots : state.cartons;
      const found = table[id];
      return Promise.resolve(found ? json(found) : problem(404, 'Not Found', `no ${id}`, path));
    }
    return Promise.resolve(problem(404, 'Not Found', 'no route', path));
  };
  return { fetch, reads, readsOf: (path: string) => reads.filter((read) => read === path).length };
}
