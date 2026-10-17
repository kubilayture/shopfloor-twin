import {
  commandSchema,
  type CommandDetailDto,
  type CommandDto,
  type CommandResultDto,
  type ConfirmationDto,
  type EquipmentDto,
  type OrderDetail,
  type OrderDto,
  type OrderExecutionDto,
} from '@shopfloor/contracts/mes-api';
import { EQUIPMENT, current } from './fixtures.ts';

// Orders as the MES of #174/#175 answers them, for the orders screens' tests (#176).

const T = '2026-10-15T06:00:00.000Z';

export function order(id = 'PO-1001', overrides: Partial<OrderDto> = {}): OrderDto {
  return {
    id,
    revision: 1,
    product: 'VB-100',
    quantity: 20,
    priority: 2,
    plannedStart: '2026-10-15T06:30:00.000Z',
    dueDate: '2026-10-15T14:00:00.000Z',
    erpStatus: 'open',
    status: 'imported',
    flags: { short: false, dispatchFailed: false, dispatchLost: false },
    rejection: null,
    dispatched: 0,
    remaining: 20,
    version: 1,
    importedAt: T,
    updatedAt: T,
    releasedAt: null,
    dispatchedAt: null,
    startedAt: null,
    completedAt: null,
    closedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

export function command(
  orderId = 'PO-1001',
  n = 1,
  overrides: Partial<CommandDetailDto> = {},
): CommandDetailDto {
  return {
    commandId: `${orderId}~OP10~${String(n)}`,
    orderId,
    n,
    equipment: 'cnc-01',
    product: 'VB-100',
    quantity: 20,
    notBefore: '2026-10-15T06:30:00.000Z',
    deviceEpoch: 1,
    createdAt: T,
    updatedAt: T,
    state: 'accepted',
    settled: true,
    failed: false,
    confirmed: true,
    acceptedBy: 'fact',
    acceptedSeq: 42,
    acceptedAt: '2026-10-15T06:01:00.000Z',
    rejection: null,
    seqAfterExpiry: null,
    attempts: 1,
    lastExpiresAt: '2026-10-15T06:01:00.000Z',
    job: 'accepted',
    startedAt: null,
    completedAt: null,
    attemptList: [
      {
        attempt: 1,
        issuedAt: T,
        publishedAt: '2026-10-15T06:00:00.050Z',
        expiresAt: '2026-10-15T06:01:00.000Z',
      },
    ],
    results: [result()],
    ...overrides,
  };
}

/** A `cmd-res` the MES stored for a command: `accepted` unless overridden. */
export function result(overrides: Partial<CommandResultDto> = {}): CommandResultDto {
  return {
    result: 'accepted',
    equipment: 'cnc-01',
    deviceEpoch: 1,
    expiresAt: '2026-10-15T06:01:00.000Z',
    respondedAt: '2026-10-15T06:00:01.000Z',
    receivedAt: '2026-10-15T06:00:01.100Z',
    statusCode: 'Good',
    code: null,
    position: 0,
    acceptedSeq: 42,
    acceptedAt: '2026-10-15T06:01:00.000Z',
    seqAfterExpiry: null,
    reason: null,
    ...overrides,
  };
}

/** A command as the push carries it (no deliveries or results). */
export function pushedCommand(detail: CommandDetailDto): CommandDto {
  return commandSchema.parse(detail);
}

export function confirmation(overrides: Partial<ConfirmationDto> = {}): ConfirmationDto {
  const counts = { yield: 18, scrap: { DIMENSIONAL: 2 }, reworkPasses: 0, material: { BLANK: 20 } };
  return {
    operation: 'OP10',
    n: 1,
    kind: 'final',
    revision: 1,
    ...counts,
    totals: counts,
    confirmedAt: '2026-10-15T08:00:00.000Z',
    idempotencyKey: 'PO-1001~OP10~conf~1',
    createdAt: T,
    messageStatus: 'sent',
    ...overrides,
  };
}

export const ROUTING: OrderDetail['routing'] = [
  { operation: 'OP10', workCenter: 'cell-m1' },
  { operation: 'OP20', workCenter: 'cell-m1' },
  { operation: 'OP30', workCenter: 'line-a1' },
];

export function detail(base: OrderDto, overrides: Partial<OrderDetail> = {}): OrderDetail {
  return {
    order: base,
    routing: ROUTING,
    bom: [{ material: 'BLANK', operation: 'OP10', quantityPerUnit: 1, usage: 'standard' }],
    commands: [],
    confirmations: [],
    erpMessages: [],
    incidents: [],
    history: [],
    ...overrides,
  };
}

export function execution(
  orderId = 'PO-1001',
  overrides: Partial<OrderExecutionDto> = {},
): OrderExecutionDto {
  return {
    orderId,
    operations: [
      {
        operation: 'OP10',
        workCenter: 'cell-m1',
        in: 12,
        good: 11,
        scrap: { DIMENSIONAL: 1 },
        rework: 0,
        material: { BLANK: 12 },
        completedAt: null,
      },
      {
        operation: 'OP20',
        workCenter: 'cell-m1',
        in: 9,
        good: 9,
        scrap: {},
        rework: 0,
        material: {},
        completedAt: null,
      },
    ],
    units: { total: 12, wip: 7, packed: 4, scrapped: 1, lost: 0 },
    wip: { 'after:OP10': 2, 'after:OP20': 5 },
    inMachine: { 'cnc-01': 1 },
    reworkPasses: 0,
    scrap: { OP10: { DIMENSIONAL: 1 } },
    packedGood: 4,
    completedAt: null,
    ...overrides,
  };
}

/** The plant's equipment with a second CNC in the OP10 work center. */
export const ORDER_EQUIPMENT: EquipmentDto[] = [
  ...EQUIPMENT,
  {
    id: 'cnc-02',
    name: 'Machine cnc-02',
    operation: 'OP10',
    interface: 'opcua',
    position: 2,
    site: { id: 'gebze', name: 'Gebze' },
    area: { id: 'machining', name: 'Machining' },
    workCenter: { id: 'cell-m1', name: 'Cell M1' },
    current: current(),
  },
];
