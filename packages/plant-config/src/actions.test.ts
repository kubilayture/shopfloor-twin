import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  actionIssues,
  checkActions,
  parseShiftKey,
  shiftStart,
  type ActionSpec,
} from './actions.ts';
import { formatIssues, loadPlantConfig } from './load.ts';
import type { PlantConfig } from './schema.ts';

let config: PlantConfig;

beforeAll(async () => {
  const result = await loadPlantConfig(resolve(import.meta.dirname, '../../../config/plant'));
  if (!result.ok) {
    throw new Error(formatIssues(result.issues));
  }
  config = result.config;
});

// Monday 2026-10-12 in Istanbul (UTC+3): shift A 06:00–14:00 with a break 10:00–10:30.
const at = (iso: string): number => Date.parse(iso);
const codes = (action: ActionSpec) => actionIssues(config, action).map((issue) => issue.code);

describe('console actions (#234)', () => {
  it('accepts a valid action of every kind', () => {
    expect(
      codes({ kind: 'lot-block', at: at('2026-10-12T05:00:05Z'), lot: 'SK1-2610-01' }),
    ).toEqual([]);
    expect(
      codes({ kind: 'lot-release', at: at('2026-10-12T05:00:05Z'), lot: 'SK1-2610-01' }),
    ).toEqual([]);
    expect(
      codes({ kind: 'tool-breakage', at: at('2026-10-12T05:00:05Z'), machine: 'cnc-02' }),
    ).toEqual([]);
    expect(
      codes({ kind: 'operators-absent', shift: '2026-10-12/B', operators: ['op-b1', 'op-b2'] }),
    ).toEqual([]);
  });

  it('refuses an unknown lot, an invalid time and a calendar boundary', () => {
    expect(codes({ kind: 'lot-block', at: at('2026-10-12T03:00:00Z'), lot: 'NOPE' })).toEqual([
      'unknown-lot',
      'calendar-boundary',
    ]);
    expect(codes({ kind: 'lot-release', at: 1.5, lot: 'SK1-2610-01' })).toEqual(['invalid-time']);
    expect(
      codes({ kind: 'lot-block', at: at('2026-10-12T07:30:00Z'), lot: 'SK1-2610-01' }),
    ).toEqual(['calendar-boundary']);
  });

  it('breaks tools on the OP10 CNCs only', () => {
    expect(
      codes({ kind: 'tool-breakage', at: at('2026-10-12T05:00:00Z'), machine: 'asm-01' }),
    ).toEqual(['not-a-cnc']);
    expect(codes({ kind: 'tool-breakage', at: at('2026-10-12T05:00:00Z'), machine: 'x' })).toEqual([
      'unknown-machine',
    ]);
  });

  it('checks the shift and the roster of a forced absence', () => {
    const absent = (shift: string, operators: string[]) =>
      codes({ kind: 'operators-absent', shift, operators });
    expect(absent('2026-10-12/B', ['op-zz'])).toEqual(['unknown-operator']);
    expect(absent('B', ['op-b1'])).toEqual(['invalid-shift']);
    expect(absent('2026-10-17/A', ['op-a1'])).toEqual(['unknown-shift']);
    expect(absent('2026-10-12/B', [])).toEqual(['no-operators']);
    expect(absent('2026-10-12/B', ['op-b1', 'op-b1'])).toEqual(['duplicate-operator']);
    expect(absent('2026-10-12/B', ['op-a1'])).toEqual(['not-on-shift']);
  });

  it('parses shift keys and finds the shift start, the night shift included', () => {
    expect(parseShiftKey('2026-10-12/C')).toEqual({ date: '2026-10-12', shift: 'C' });
    expect(parseShiftKey('2026-10-12')).toBeUndefined();
    expect(parseShiftKey('2026-10-12/C/x')).toBeUndefined();
    expect(shiftStart(config, '2026-10-12/A')).toBe(at('2026-10-12T03:00:00Z'));
    expect(shiftStart(config, '2026-10-12/C')).toBe(at('2026-10-12T19:00:00Z'));
    expect(shiftStart(config, '2026-10-18/A')).toBeUndefined();
    expect(shiftStart(config, 'nope')).toBeUndefined();
  });

  it('cross-checks a list with positions, an unknown kind included', () => {
    expect(
      checkActions(config, [
        { kind: 'lot-block', at: at('2026-10-12T05:00:05Z'), lot: 'SK1-2610-01' },
        { kind: 'lot-block', at: at('2026-10-12T05:00:05Z'), lot: 'NOPE' },
        { kind: 'explode' } as unknown as ActionSpec,
      ]),
    ).toEqual([
      { path: 'actions[1]', message: 'unknown lot "NOPE"' },
      { path: 'actions[2]', message: 'unknown kind "explode"' },
    ]);
  });
});
