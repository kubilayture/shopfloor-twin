import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkInjections, injectionIssues, isCalendarBoundary } from './injections.ts';
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
