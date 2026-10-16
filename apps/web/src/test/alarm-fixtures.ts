import type {
  AlarmKpiBucketDto,
  AlarmOccurrenceDto,
  AlarmPointDto,
  AlarmScopes,
  AlarmShelfDto,
  FloodEpisodeDto,
  OperatorBucketDto,
} from '@shopfloor/contracts/mes-api';
import { EPOCH } from './fixtures.ts';
import { SHIFT_END, SHIFT_KEY, SHIFT_START } from './oee-fixtures.ts';

export function shelf(overrides: Partial<AlarmShelfDto> = {}): AlarmShelfDto {
  return {
    shelved: false,
    version: 0,
    by: null,
    reason: null,
    shelvedAt: null,
    epoch: null,
    plantAt: null,
    until: null,
    durationMs: null,
    ...overrides,
  };
}

/** An active, unacknowledged occurrence of CNC-01 COOLANT-PRESSURE raised at seq `seq`. */
export function occurrence(
  seq: number,
  overrides: Partial<AlarmOccurrenceDto> = {},
): AlarmOccurrenceDto {
  const equipment = overrides.equipment ?? 'cnc-01';
  return {
    id: `${equipment}~${String(EPOCH)}~${String(seq)}`,
    equipment,
    epoch: EPOCH,
    seq,
    code: 'COOLANT-PRESSURE',
    priority: 'medium',
    defined: true,
    text: 'Coolant pressure low',
    severity: 700,
    source: 'fact',
    raisedAt: new Date(Date.parse('2026-10-15T05:00:00.000Z') + seq * 1_000).toISOString(),
    endedAt: null,
    endReason: null,
    endSeq: null,
    active: true,
    final: false,
    state: 'unacked-active',
    acknowledged: null,
    shelved: false,
    comments: 0,
    ...overrides,
  };
}

export const ACK = {
  by: 'Ayşe',
  at: '2026-10-16T08:00:00.000Z',
  plantAt: '2026-10-15T06:05:00.000Z',
  comment: '',
};

export function point(overrides: Partial<AlarmPointDto> = {}): AlarmPointDto {
  return {
    equipment: 'cnc-01',
    code: 'COOLANT-PRESSURE',
    defined: true,
    priority: 'medium',
    text: 'Coolant pressure low',
    shelf: shelf(),
    activeOccurrence: null,
    ...overrides,
  };
}

export const SCOPES: AlarmScopes = {
  scopes: [
    { scope: 'plant', id: 'plant', name: 'Plant', equipment: ['cnc-01', 'wsh-01', 'asm-01'] },
    { scope: 'position', id: 'cell-m1', name: 'Cell M1', equipment: ['cnc-01', 'wsh-01'] },
    { scope: 'position', id: 'line-a1', name: 'Line A1', equipment: ['asm-01'] },
    { scope: 'equipment', id: 'cnc-01', name: 'cnc-01', equipment: ['cnc-01'] },
  ],
};

export function episode(overrides: Partial<FloodEpisodeDto> = {}): FloodEpisodeDto {
  return {
    id: '1760504400000~cnc-01~COOLANT-PRESSURE',
    startAt: '2026-10-15T05:00:00.000Z',
    equipment: 'cnc-01',
    code: 'COOLANT-PRESSURE',
    endAt: null,
    peak: 12,
    raises: 12,
    ...overrides,
  };
}

/** The shift bucket of a scope: 14 raises, average 7/24 per 10 minutes. */
export function kpiBucket(overrides: Partial<AlarmKpiBucketDto> = {}): AlarmKpiBucketDto {
  return {
    scope: 'plant',
    id: 'plant',
    bucket: 'shift',
    key: SHIFT_KEY,
    epoch: EPOCH,
    from: SHIFT_START,
    to: SHIFT_END,
    raises: 14,
    byPriority: { high: 2, medium: 11, low: 1 },
    averageRate: { fraction: '7/24', decimal: '0.2917' },
    windows: 48,
    peak10: 12,
    floodWindows: 1,
    floods: [
      {
        id: '1760504400000~cnc-01~COOLANT-PRESSURE',
        startAt: '2026-10-15T05:00:00.000Z',
        floodMs: 240_000,
        peak: 12,
        open: false,
        ended: { endAt: '2026-10-15T05:04:00.000Z', peak: 12, raises: 12 },
      },
    ],
    floodMs: 240_000,
    activeAtEnd: 1,
    standing: [],
    chatteringRaises: 3,
    chatteringPoints: ['cnc-01/COOLANT-PRESSURE'],
    fleeting: 1,
    fleetingUndecided: 0,
    activeMs: 1_530_000,
    provisional: true,
    final: false,
    revision: 0,
    incidents: 0,
    ...overrides,
  };
}

export function hourKpi(
  hourStart: string,
  overrides: Partial<AlarmKpiBucketDto> = {},
): AlarmKpiBucketDto {
  return kpiBucket({
    bucket: 'hour',
    key: hourStart,
    from: hourStart,
    to: new Date(Date.parse(hourStart) + 3_600_000).toISOString(),
    windows: 6,
    ...overrides,
  });
}

export function operatorBucket(overrides: Partial<OperatorBucketDto> = {}): OperatorBucketDto {
  return {
    key: 'range',
    from: SHIFT_START,
    to: SHIFT_END,
    raises: 14,
    shelvedRaises: 2,
    annunciatedRaises: 12,
    timeToAck: { count: 3, sumMs: 100_000, maxMs: 60_000 },
    unacknowledgedAtEnd: 4,
    shelvedMs: [{ equipment: 'cnc-01', code: 'COOLANT-PRESSURE', ms: 900_000 }],
    provisional: true,
    ...overrides,
  };
}
