import type {
  OrderDto,
  ScrapRecordDto,
  TerminalOperationDto,
  TerminalViewDto,
} from '@shopfloor/contracts/mes-api';

// The operator terminal's fixtures (#177): a Line A1 view with one active order.

export function orderOf(id: string, overrides: Partial<OrderDto> = {}): OrderDto {
  return {
    id,
    revision: 1,
    product: 'VB-100',
    quantity: 4,
    priority: 5,
    plannedStart: '2026-10-15T03:00:00.000Z',
    dueDate: '2026-10-15T11:00:00.000Z',
    erpStatus: 'open',
    status: 'in-progress',
    flags: { short: false, dispatchFailed: false, dispatchLost: false },
    rejection: null,
    dispatched: 4,
    remaining: 0,
    version: 4,
    importedAt: '2026-10-15T02:00:00.000Z',
    updatedAt: '2026-10-15T03:00:00.000Z',
    releasedAt: '2026-10-15T02:10:00.000Z',
    dispatchedAt: '2026-10-15T02:20:00.000Z',
    startedAt: '2026-10-15T03:25:00.000Z',
    completedAt: null,
    closedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

/** An operation as a terminal write answers it (no counts). */
export function answerOf(
  operation: string,
  overrides: Partial<TerminalOperationDto> = {},
): TerminalOperationDto {
  return {
    orderId: 'O-1',
    operation,
    workCenter: 'line-a1',
    version: 1,
    complete: false,
    completedAt: null,
    signedOff: null,
    activities: [],
    ...overrides,
  };
}

/** The answer without its counts (what a write returns). */
export function withoutCounts(
  operation: TerminalOperationDto & { readonly counts?: unknown },
): TerminalOperationDto {
  return answerOf(operation.operation, {
    orderId: operation.orderId,
    workCenter: operation.workCenter,
    version: operation.version,
    complete: operation.complete,
    completedAt: operation.completedAt,
    signedOff: operation.signedOff,
    activities: operation.activities,
  });
}

export function operationOf(
  operation: string,
  overrides: Partial<TerminalOperationDto> = {},
): TerminalOperationDto & {
  counts: { operation: string; in: number; good: number; scrap: number; rework: number };
} {
  return {
    ...answerOf(operation, overrides),
    counts: { operation, in: 2, good: 2, scrap: 0, rework: 0 },
  };
}

export function scrapOf(id: number, overrides: Partial<ScrapRecordDto> = {}): ScrapRecordDto {
  return {
    id,
    equipment: 'lkt-01',
    epoch: 1,
    seq: 40,
    partId: 3,
    serial: 'VB-100-000003',
    orderId: 'O-1',
    operation: 'OP40',
    pass: 2,
    scrappedAt: '2026-10-15T05:00:00.000Z',
    machineReason: 'LEAK',
    codedReason: null,
    comment: null,
    codedBy: null,
    codedAt: null,
    version: 1,
    ...overrides,
  };
}

export function viewOf(overrides: Partial<TerminalViewDto> = {}): TerminalViewDto {
  return {
    workCenter: { id: 'line-a1', name: 'Line A1' },
    shift: {
      epoch: 1,
      key: '2026-10-15/A',
      start: '2026-10-15T03:00:00.000Z',
      end: '2026-10-15T11:00:00.000Z',
    },
    machines: [
      {
        id: 'asm-01',
        name: 'Manual assembly station',
        operation: 'OP30',
        state: { state: 'Running', cause: null, since: '2026-10-15T04:00:00.000Z' },
        job: null,
        orders: ['O-1'],
      },
    ],
    crew: [],
    orders: [
      {
        order: orderOf('O-1'),
        operations: [operationOf('OP30'), operationOf('OP40'), operationOf('OP50')],
        wip: 2,
      },
    ],
    queue: [{ order: orderOf('O-2', { status: 'released', dispatchedAt: null }), equipment: null }],
    scrapRecords: [scrapOf(11)],
    truncated: false,
    quality: { holds: [], signals: [], lots: [], truncated: false },
    ...overrides,
  };
}
