import type {
  HandoverAuditEntryDto,
  HandoverNoteDto,
  ShiftRecordDto,
  ShiftReportDto,
} from '@shopfloor/contracts/mes-api';
import { SCOPES, kpiBucket, operatorBucket } from './alarm-fixtures.ts';
import { EPOCH } from './fixtures.ts';
import { SHIFT_END, SHIFT_KEY, SHIFT_START, bucket, record } from './oee-fixtures.ts';

export function shiftRecord(overrides: Partial<ShiftRecordDto> = {}): ShiftRecordDto {
  return {
    key: SHIFT_KEY,
    date: '2026-10-15',
    shift: 'A',
    epoch: EPOCH,
    start: SHIFT_START,
    end: SHIFT_END,
    breaks: [],
    status: 'running',
    final: false,
    finalAt: null,
    revision: { inputs: 0, content: 0, contentAtFinal: null },
    ...overrides,
  };
}

export function note(id: number, overrides: Partial<HandoverNoteDto> = {}): HandoverNoteDto {
  return {
    id,
    epoch: EPOCH,
    shiftKey: SHIFT_KEY,
    category: 'equipment',
    text: `Note ${String(id)}`,
    retracted: false,
    createdBy: 'Ayşe',
    author: 'Ayşe',
    version: 1,
    createdAt: `2026-10-16T08:0${String(id % 10)}:00.000Z`,
    createdPlantAt: '2026-10-15T05:00:00.000Z',
    updatedAt: `2026-10-16T08:0${String(id % 10)}:00.000Z`,
    updatedPlantAt: '2026-10-15T05:00:00.000Z',
    ...overrides,
  };
}

export function auditEntry(
  item: HandoverNoteDto,
  overrides: Partial<HandoverAuditEntryDto> = {},
): HandoverAuditEntryDto {
  return {
    id: item.id * 100 + item.version,
    noteId: item.id,
    action: item.version === 1 ? 'created' : 'edited',
    before: null,
    after: { category: item.category, text: item.text, retracted: item.retracted },
    actor: item.author,
    authenticated: false,
    at: item.updatedAt,
    plantAt: item.updatedPlantAt,
    requestId: `req-${String(item.id)}-${String(item.version)}`,
    version: item.version,
    ...overrides,
  };
}

/** A running shift A report: Cell M1 with CNC-01 and WSH-01, Line A1 with ASM-01. */
export function report(overrides: Partial<ShiftReportDto> = {}): ShiftReportDto {
  const machines = ['cnc-01', 'wsh-01', 'asm-01'];
  return {
    ...shiftRecord(),
    incidents: 0,
    asOf: '2026-10-15T06:10:00.000Z',
    generatedAt: '2026-10-16T08:30:00.000Z',
    oee: {
      shiftKey: SHIFT_KEY,
      start: SHIFT_START,
      end: SHIFT_END,
      equipment: machines.map((id) => bucket(id, {}, 'equipment')),
      workCenters: [bucket('cell-m1', {}, 'work-center')],
    },
    downtime: {
      availability: { own: 150_000, external: 50_000 },
      reasons: [
        {
          reason: 'BREAKDOWN/SPINDLE-OVERLOAD',
          name: 'Spindle overload',
          loss: 'own',
          ms: 100_000,
          records: 1,
        },
        { reason: 'STARVED', name: 'Starved', loss: 'external', ms: 50_000, records: 2 },
      ],
      microStops: [{ cause: 'CHIP-JAM', ms: 40_000, stops: 4 }],
      records: 3,
      uncodedMs: 30_000,
      longest: [record({ reason: 'BREAKDOWN/SPINDLE-OVERLOAD', uncoded: false })],
    },
    production: {
      machines: machines.map((equipment) => ({
        equipment,
        produced: 10,
        good: 9,
        scrap: 1,
        rework: 0,
        cycles: [],
      })),
      finished: { equipment: 'asm-01', good: 9 },
      scrap: 3,
    },
    alarms: {
      scopes: SCOPES.scopes
        .filter((scope) => scope.scope !== 'equipment')
        .map((scope) => ({
          scope: scope.scope,
          id: scope.id,
          name: scope.name,
          kpis: scope.id === 'line-a1' ? null : kpiBucket({ scope: scope.scope, id: scope.id }),
          badActors:
            scope.scope === 'plant'
              ? [
                  {
                    equipment: 'cnc-01',
                    code: 'COOLANT-PRESSURE',
                    raises: 12,
                    share: { fraction: '6/7', decimal: '0.8571' },
                    activeMs: 600_000,
                    chatteringRaises: 3,
                  },
                ]
              : [],
          operator: scope.id === 'line-a1' ? null : operatorBucket({ key: SHIFT_KEY }),
        })),
    },
    notes: [],
    ...overrides,
  };
}
