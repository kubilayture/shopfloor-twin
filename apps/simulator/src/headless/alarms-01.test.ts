/**
 * The golden scenario `alarms-01` (#140): the week-01 seed with injected failures. Its event log
 * equals week-01's up to the first injection, so week-01's live evidence carries over; its ground
 * truth holds at least one flood episode, one chattering point, one fleeting and one standing
 * alarm, so the alarm reconciliation (#142) can't pass vacuously.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readScenario, scenarioOptions } from './golden.ts';
import { runHeadless, type HeadlessResult } from './run.ts';

const GOLDEN = resolve(import.meta.dirname, '../../golden');

interface Logged {
  readonly lines: string[];
  readonly result: HeadlessResult;
}

async function scenario(name: string, days?: number): Promise<Logged> {
  const options = await scenarioOptions(name);
  const lines: string[] = [];
  const end = days === undefined ? options.end : options.start + days * 86_400_000;
  const result = runHeadless({ ...options, end }, (line) => lines.push(line));
  return { lines, result };
}

let alarms: Logged;
let week: Logged;

beforeAll(async () => {
  alarms = await scenario('alarms-01');
  week = await scenario('week-01', readScenario('alarms-01').days);
}, 60_000);

const at = (line: string): number => Date.parse((JSON.parse(line) as { at: string }).at);

describe('golden scenario alarms-01 (#140)', () => {
  it('logs exactly what week-01 logs up to the first injection', () => {
    const injections = readScenario('alarms-01').injections ?? [];
    const first = Math.min(...injections.map((i) => Date.parse(i.at)));
    expect(first).toBe(Date.parse('2026-10-12T05:00:05Z'));
    // The header differs (it lists the injections); every event before the first injection is
    // byte-identical, sequence numbers included.
    const before = (lines: string[]) => lines.slice(1).filter((line) => at(line) < first);
    const prefix = before(alarms.lines);
    expect(prefix.length).toBeGreaterThan(400);
    expect(prefix).toEqual(before(week.lines));
    expect(alarms.lines[prefix.length + 1]).not.toBe(week.lines[prefix.length + 1]);
    // The header is week-01's plus the injections; without injections there is no such field.
    const header = JSON.parse(alarms.lines[0] ?? '{}') as Record<string, unknown>;
    const { injections: listed, ...rest } = header;
    expect(rest).toEqual(JSON.parse(week.lines[0] ?? '{}'));
    expect(listed).toHaveLength(injections.length);
    expect(JSON.parse(week.lines[0] ?? '{}')).not.toHaveProperty('injections');
  });

  it('holds a flood, a chattering point, a fleeting and a standing alarm', () => {
    const truth = alarms.result.summary.alarms;
    const plant = truth.scopes.plant;
    const cell = truth.scopes['cell-m1'];
    const line = truth.scopes['line-a1'];
    if (!plant || !cell || !line) throw new Error('missing scope');

    // Shift A on Monday: 13 raises on Cell M1 within 10 minutes from 08:00 Istanbul, one flood.
    const shiftA = cell.shifts['2026-10-12/A'];
    expect(shiftA).toMatchObject({ raises: 13, peak10: 13, floodWindows: 1 });
    expect(cell.floods).toEqual([
      {
        id: '1791781395000~cnc-02~SPINDLE-OVERLOAD',
        startAt: '2026-10-12T05:03:15.000Z',
        equipment: 'cnc-02',
        code: 'SPINDLE-OVERLOAD',
        endAt: '2026-10-12T05:10:25.000Z',
        peak: 13,
        raises: 3,
      },
    ]);
    expect(plant.floods.map((f) => f.id)).toEqual(cell.floods.map((f) => f.id));
    // CNC-01 COOLANT-PRESSURE three times within 60 s.
    expect(shiftA?.chatteringPoints).toEqual(['cnc-01/COOLANT-PRESSURE']);
    // LKT-01 FIXTURE-SEAL repaired in 500 ms.
    expect(line.shifts['2026-10-12/A']).toMatchObject({ raises: 1, fleeting: 1 });
    // PCK-01 PRINTER-FAULT, injected at 13:30Z and held while PCK-01 was not Running, then
    // repaired for 33 hours: standing at the end of Tuesday's shift B (22:00 Istanbul).
    const printer = truth.occurrences.find((o) => o.code === 'PRINTER-FAULT');
    expect(printer).toEqual({
      equipment: 'pck-01',
      code: 'PRINTER-FAULT',
      priority: 'medium',
      severity: 700,
      raisedAt: '2026-10-12T13:30:20.030Z',
      clearedAt: '2026-10-13T22:30:20.030Z',
      endReason: 'cleared',
    });
    expect(line.shifts['2026-10-13/B']?.standing).toEqual([
      { equipment: 'pck-01', code: 'PRINTER-FAULT', raisedAt: '2026-10-12T13:30:20.030Z' },
    ]);
    expect(plant.shifts['2026-10-13/B']?.standing).toHaveLength(1);

    // Every occurrence is an injected one: 13 + 1 + 1.
    expect(truth.occurrences).toHaveLength(15);
    expect(plant.badActors.run[0]).toMatchObject({
      equipment: 'cnc-02',
      code: 'SPINDLE-OVERLOAD',
      raises: 4,
      share: { fraction: '4/15', decimal: '0.2667' },
    });
  });

  it('applies every injection, and the committed summary is this run', async () => {
    expect(alarms.result.summary.alarms.occurrences.length).toBe(
      readScenario('alarms-01').injections?.length,
    );
    const committed = JSON.parse(
      await readFile(resolve(GOLDEN, 'alarms-01/summary.json'), 'utf8'),
    ) as { schema: string; analysisConfigSha256: string };
    expect(committed.schema).toBe('sim-summary/3');
    expect(committed.analysisConfigSha256).toBe(alarms.result.analysisConfigSha256);
  });

  it('refuses a scenario injection on a calendar boundary or an unknown point', () => {
    const options = { seed: 1, start: Date.UTC(2026, 9, 12, 3), end: Date.UTC(2026, 9, 12, 5) };
    return scenarioOptions('week-01').then(({ config }) => {
      expect(() =>
        runHeadless(
          {
            ...options,
            config,
            injections: [
              { at: Date.UTC(2026, 9, 12, 7), machine: 'cnc-01', code: 'COOLANT-PRESSURE' },
            ],
          },
          () => undefined,
        ),
      ).toThrow(/calendar boundary/);
      expect(() =>
        runHeadless(
          {
            ...options,
            config,
            injections: [{ at: Date.UTC(2026, 9, 12, 4), machine: 'pck-01', code: 'HEATER-FAULT' }],
          },
          () => undefined,
        ),
      ).toThrow(/no failure mode/);
    });
  });
});
