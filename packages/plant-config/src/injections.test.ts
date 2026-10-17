import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_DRIFT_STEPS,
  MAX_REPAIR_MS,
  checkInjections,
  driftIssues,
  driftSteps,
  injectionIssues,
  isCalendarBoundary,
} from './injections.ts';
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

describe('failure injections (#140)', () => {
  it('accepts a known failure mode off every calendar boundary', () => {
    expect(
      injectionIssues(config, {
        at: at('2026-10-12T05:00:05Z'),
        machine: 'cnc-01',
        code: 'COOLANT-PRESSURE',
        repairMs: 3000,
      }),
    ).toEqual([]);
  });

  it.each([
    ['2026-10-12T03:00:00Z', 'shift A starts'],
    ['2026-10-12T07:00:00Z', 'the break starts'],
    ['2026-10-12T07:30:00Z', 'the break ends'],
    ['2026-10-12T11:00:00Z', 'shift A hands over to B'],
    ['2026-10-17T03:00:00Z', 'Friday shift C ends'],
  ])('refuses %s (%s): a calendar boundary', (iso) => {
    expect(isCalendarBoundary(config, at(iso))).toBe(true);
    expect(
      injectionIssues(config, { at: at(iso), machine: 'cnc-01', code: 'COOLANT-PRESSURE' }).map(
        (issue) => issue.code,
      ),
    ).toEqual(['calendar-boundary']);
  });

  it('is not a boundary one millisecond off', () => {
    expect(isCalendarBoundary(config, at('2026-10-12T07:00:00Z') - 1)).toBe(false);
    expect(isCalendarBoundary(config, at('2026-10-12T07:00:00Z') + 1)).toBe(false);
  });

  it('refuses unknown machines and codes, bad repair times and non-integer times', () => {
    const codes = (injection: Parameters<typeof injectionIssues>[1]) =>
      injectionIssues(config, injection).map((issue) => issue.code);
    const t = at('2026-10-12T05:00:05Z');
    expect(codes({ at: t, machine: 'cnc-09', code: 'COOLANT-PRESSURE' })).toEqual([
      'unknown-machine',
    ]);
    expect(codes({ at: t, machine: 'pck-01', code: 'COOLANT-PRESSURE' })).toEqual(['unknown-code']);
    expect(codes({ at: t, machine: 'cnc-01', code: 'COOLANT-PRESSURE', repairMs: 0 })).toEqual([
      'invalid-repair',
    ]);
    // At most 365 days, so at + repairMs can't overflow the schedule.
    expect(
      codes({ at: t, machine: 'cnc-01', code: 'COOLANT-PRESSURE', repairMs: MAX_REPAIR_MS }),
    ).toEqual([]);
    expect(
      codes({ at: t, machine: 'cnc-01', code: 'COOLANT-PRESSURE', repairMs: MAX_REPAIR_MS + 1 }),
    ).toEqual(['invalid-repair']);
    expect(MAX_REPAIR_MS).toBe(31_536_000_000);
    expect(codes({ at: t + 0.5, machine: 'cnc-01', code: 'COOLANT-PRESSURE' })).toEqual([
      'invalid-time',
    ]);
  });

  it('reports a scenario list with positions', () => {
    expect(
      checkInjections(config, [
        { at: at('2026-10-12T05:00:05Z'), machine: 'cnc-01', code: 'COOLANT-PRESSURE' },
        { at: at('2026-10-12T07:00:00Z'), machine: 'lkt-01', code: 'FIXTURE-SEAL' },
      ]),
    ).toEqual([
      {
        path: 'injections[1]',
        message: '2026-10-12T07:00:00.000Z is a calendar boundary (shift or break start or end)',
      },
    ]);
  });
});

describe('leak-drift injections (ADR-0033)', () => {
  const t = at('2026-10-12T05:00:05Z');
  const codes = (drift: Parameters<typeof driftIssues>[1], runEnd?: number) =>
    driftIssues(config, drift, runEnd).map((issue) => issue.code);

  it('accepts a whole multiple of the resolution on the leak tester, positive or negative', () => {
    expect(codes({ at: t, until: t + 3_600_000, machine: 'lkt-01', shift: 0.6 })).toEqual([]);
    expect(codes({ at: t, until: t + 1, machine: 'lkt-01', shift: -0.001 })).toEqual([]);
    expect(driftSteps(0.6, 0.001)).toBe(600);
    expect(driftSteps(-0.001, 0.001)).toBe(-1);
    expect(driftSteps(1.1, 0.001)).toBe(1100);
  });

  it('refuses a shift that is zero, not a multiple of the resolution, too large or not finite', () => {
    for (const shift of [0, 0.0005, 0.6004, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codes({ at: t, until: t + 1, machine: 'lkt-01', shift })).toEqual(['invalid-shift']);
    }
    expect(driftSteps(MAX_DRIFT_STEPS * 0.001, 0.001)).toBe(MAX_DRIFT_STEPS);
    expect(driftSteps((MAX_DRIFT_STEPS + 1) * 0.001, 0.001)).toBeUndefined();
  });

  it('refuses another machine, an unknown one, and bad times', () => {
    expect(codes({ at: t, until: t + 1, machine: 'asm-01', shift: 0.1 })).toEqual([
      'not-a-leak-tester',
    ]);
    expect(codes({ at: t, until: t + 1, machine: 'lkt-09', shift: 0.1 })).toEqual([
      'unknown-machine',
    ]);
    expect(codes({ at: t, until: t, machine: 'lkt-01', shift: 0.1 })).toEqual(['invalid-until']);
    expect(codes({ at: t, until: t + 0.5, machine: 'lkt-01', shift: 0.1 })).toEqual([
      'invalid-until',
    ]);
    expect(codes({ at: t + 0.5, until: t + 10, machine: 'lkt-01', shift: 0.1 })).toEqual([
      'invalid-time',
    ]);
  });

  it('refuses at and until on a calendar boundary, until only inside the run', () => {
    const breakStart = at('2026-10-12T07:00:00Z');
    expect(codes({ at: breakStart, until: breakStart + 5, machine: 'lkt-01', shift: 0.1 })).toEqual(
      ['calendar-boundary'],
    );
    expect(codes({ at: t, until: breakStart, machine: 'lkt-01', shift: 0.1 })).toEqual([
      'calendar-boundary',
    ]);
    expect(
      codes({ at: t, until: breakStart, machine: 'lkt-01', shift: 0.1 }, breakStart + 1),
    ).toEqual(['calendar-boundary']);
    // At or after the run's end the drift lasts to the end; its until never takes effect.
    expect(codes({ at: t, until: breakStart, machine: 'lkt-01', shift: 0.1 }, breakStart)).toEqual(
      [],
    );
  });

  it('is checked with failure injections in one scenario list', () => {
    expect(
      checkInjections(config, [
        { at: t, machine: 'cnc-01', code: 'COOLANT-PRESSURE' },
        { kind: 'leak-drift', at: t, until: t + 10, machine: 'lkt-01', shift: 0.0001 },
      ]),
    ).toEqual([
      {
        path: 'injections[1]',
        message:
          'shift must be a non-zero whole multiple of 0.001 Pa/min (at most 1000000 steps), got 0.0001',
      },
    ]);
  });
});
