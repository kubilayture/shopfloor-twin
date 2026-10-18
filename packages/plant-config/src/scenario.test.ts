import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatIssues, loadPlantConfig } from './load.ts';
import {
  MAX_TIMELINE_ENTRIES,
  TIMELINE_ACTIONS,
  checkScenarioPlan,
  parseScenario,
  readScenarioFile,
  scenarioPlan,
  type Scenario,
} from './scenario.ts';
import type { PlantConfig } from './schema.ts';

const SCENARIOS = resolve(import.meta.dirname, '../../../config/scenarios');
const folder = mkdtempSync(join(tmpdir(), 'plant-config-scenario-'));
let config: PlantConfig;

beforeAll(async () => {
  const result = await loadPlantConfig(resolve(import.meta.dirname, '../../../config/plant'));
  if (!result.ok) throw new Error(formatIssues(result.issues));
  config = result.config;
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

const HEAD = {
  seed: 7,
  start: '2026-10-12T06:00:00+03:00',
  days: 1,
  config: 'config/plant',
} as const;

const parsed = (raw: unknown): Scenario => {
  const result = parseScenario(raw);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.scenario;
};

const issuesOf = (raw: unknown) => {
  const result = parseScenario(raw);
  return result.ok ? [] : result.issues;
};

describe('scenario schema (#235)', () => {
  it('maps a timeline onto the golden lists: dispatches, injections, actions, in timeline order', () => {
    const plan = scenarioPlan(
      parsed({
        ...HEAD,
        production: 'orders',
        timeline: [
          {
            action: 'dispatch',
            commandId: 'C1',
            machine: 'cnc-01',
            orderId: 'O1',
            product: 'VB-100',
            quantity: 3,
            notBefore: '2026-10-12T03:00:00Z',
          },
          { at: '2026-10-12T04:00:00Z', action: 'pause' },
          { at: '2026-10-12T04:10:00Z', action: 'lot-block', lot: 'SK1-2610-01' },
          { at: '2026-10-12T04:20:00Z', action: 'failure', machine: 'cnc-01', code: 'X' },
          {
            at: '2026-10-12T04:30:00Z',
            action: 'leak-drift',
            machine: 'lkt-01',
            until: '2026-10-12T05:00:00Z',
            shift: 0.6,
          },
          { at: '2026-10-12T04:40:00Z', action: 'opcua-offline', machine: 'cnc-02' },
          { at: '2026-10-12T04:50:00Z', action: 'speed', speed: 2 },
          { action: 'operators-absent', shift: '2026-10-12/B', operators: ['op-b1'] },
          { at: '2026-10-12T05:00:00Z', action: 'tool-breakage', machine: 'cnc-02' },
          {
            at: '2026-10-12T05:10:00Z',
            action: 'modbus-silent',
            until: '2026-10-12T05:20:00Z',
          },
        ],
      }),
    );
    const at = (iso: string) => Date.parse(iso);
    expect(plan.dispatches).toEqual([
      {
        commandId: 'C1',
        machine: 'cnc-01',
        orderId: 'O1',
        product: 'VB-100',
        quantity: 3,
        notBefore: at('2026-10-12T03:00:00Z'),
      },
    ]);
    expect(plan.injections).toEqual([
      { machine: 'cnc-01', code: 'X', at: at('2026-10-12T04:20:00Z') },
      {
        kind: 'leak-drift',
        machine: 'lkt-01',
        shift: 0.6,
        at: at('2026-10-12T04:30:00Z'),
        until: at('2026-10-12T05:00:00Z'),
      },
    ]);
    expect(plan.actions).toEqual([
      { kind: 'lot-block', at: at('2026-10-12T04:10:00Z'), lot: 'SK1-2610-01' },
      { kind: 'operators-absent', shift: '2026-10-12/B', operators: ['op-b1'] },
      { kind: 'tool-breakage', at: at('2026-10-12T05:00:00Z'), machine: 'cnc-02' },
    ]);
    expect(plan.infrastructure).toEqual([
      { kind: 'pause', at: at('2026-10-12T04:00:00Z') },
      { kind: 'opcua-offline', at: at('2026-10-12T04:40:00Z'), machine: 'cnc-02' },
      { kind: 'speed', at: at('2026-10-12T04:50:00Z'), speed: 2 },
      {
        kind: 'modbus-silent',
        at: at('2026-10-12T05:10:00Z'),
        until: at('2026-10-12T05:20:00Z'),
      },
    ]);
    expect(plan.origins).toEqual({
      dispatches: ['timeline[0]'],
      injections: ['timeline[3]', 'timeline[4]'],
      actions: ['timeline[2]', 'timeline[7]', 'timeline[8]'],
      infrastructure: ['timeline[1]', 'timeline[5]', 'timeline[6]', 'timeline[9]'],
    });
    expect(plan).toMatchObject({
      seed: 7,
      start: at('2026-10-12T03:00:00Z'),
      end: at('2026-10-13T03:00:00Z'),
      production: 'orders',
    });
  });

  it('maps the golden keys as before #235, actions included', () => {
    const plan = scenarioPlan(
      parsed({
        ...HEAD,
        injections: [
          { at: '2026-10-12T05:00:05Z', machine: 'cnc-01', code: 'X', repairMs: 3000 },
          {
            kind: 'leak-drift',
            at: '2026-10-12T05:30:00Z',
            until: '2026-10-12T06:00:00Z',
            machine: 'lkt-01',
            shift: -0.2,
          },
        ],
        actions: [
          { kind: 'lot-release', at: '2026-10-12T05:00:00Z', lot: 'L' },
          { kind: 'tool-breakage', at: '2026-10-12T05:10:00Z', machine: 'cnc-02' },
          { kind: 'operators-absent', shift: '2026-10-12/B', operators: ['op-b1'] },
        ],
      }),
    );
    expect(plan.injections.map((i) => i.kind)).toEqual([undefined, 'leak-drift']);
    expect(plan.injections[0]).toEqual({
      machine: 'cnc-01',
      code: 'X',
      at: Date.parse('2026-10-12T05:00:05Z'),
      repairMs: 3000,
    });
    expect(plan.origins.injections).toEqual(['injections[0]', 'injections[1]']);
    expect(plan.actions).toEqual([
      { kind: 'lot-release', at: Date.parse('2026-10-12T05:00:00Z'), lot: 'L' },
      { kind: 'tool-breakage', at: Date.parse('2026-10-12T05:10:00Z'), machine: 'cnc-02' },
      { kind: 'operators-absent', shift: '2026-10-12/B', operators: ['op-b1'] },
    ]);
    expect(plan.origins.actions).toEqual(['actions[0]', 'actions[1]', 'actions[2]']);
    expect(plan.production).toBe('schedule');
    expect(plan.infrastructure).toEqual([]);
  });

  it('parses the committed timelines, which together use every action kind', async () => {
    const kinds = new Set<string>();
    for (const name of ['monday-breakdown-and-recovery', 'monday-orders-dispatch']) {
      const read = await readScenarioFile(join(SCENARIOS, `${name}.yaml`));
      if (!read.ok) throw new Error(read.message);
      for (const entry of read.scenario.timeline ?? []) kinds.add(entry.action);
      expect(checkScenarioPlan(config, scenarioPlan(read.scenario))).toEqual([]);
    }
    expect([...kinds].sort()).toEqual([...TIMELINE_ACTIONS].sort());
  });

  it('refuses mixed keys, entries out of time order, unknown actions and fields', () => {
    expect(
      issuesOf({
        ...HEAD,
        injections: [],
        timeline: [{ at: '2026-10-12T04:00:00Z', action: 'pause' }],
      }),
    ).toEqual([
      {
        path: 'injections',
        message: 'a scenario with a timeline lists its injections in the timeline',
      },
    ]);
    expect(
      issuesOf({
        ...HEAD,
        timeline: [
          { at: '2026-10-12T05:00:00Z', action: 'pause' },
          { action: 'operators-absent', shift: '2026-10-12/B', operators: ['op-b1'] },
          { at: '2026-10-12T04:00:00Z', action: 'pause' },
        ],
      }),
    ).toEqual([{ path: 'timeline[2].at', message: 'timeline entries must be in time order' }]);
    expect(
      issuesOf({ ...HEAD, timeline: [{ at: '2026-10-12T04:00:00Z', action: 'explode' }] }).map(
        (i) => i.path,
      ),
    ).toEqual(['timeline[0].action']);
    expect(
      issuesOf({
        ...HEAD,
        timeline: [{ at: '2026-10-12T04:00:00Z', action: 'pause', for: 5 }],
      }).map((i) => i.path),
    ).toEqual(['timeline[0]']);
    expect(issuesOf({ ...HEAD, timeline: [{ at: '2026-10-12T04:00', action: 'pause' }] })).toEqual([
      { path: 'timeline[0].at', message: 'expected ISO 8601 with an offset or Z' },
    ]);
    expect(
      issuesOf({ ...HEAD, timeline: [{ at: '2026-10-12T04:00:00Z', action: 'speed', speed: 61 }] })
        .length,
    ).toBe(1);
    expect(issuesOf({ ...HEAD, typo: 1 }).map((i) => i.path)).toEqual(['']);
  });

  it('names an unknown injection kind as before #235', () => {
    expect(
      issuesOf({
        ...HEAD,
        injections: [{ kind: 'pressure-drift', at: '2026-10-12T04:30:00Z', machine: 'lkt-01' }],
      }),
    ).toEqual([
      {
        path: 'injections[0]',
        message:
          'unknown kind "pressure-drift" (a failure injection has no kind; a drift is "leak-drift")',
      },
    ]);
  });
});

describe('checkScenarioPlan (#235)', () => {
  it('names each problem by the timeline entry it came from', () => {
    const plan = scenarioPlan(
      parsed({
        ...HEAD,
        days: 0.25,
        timeline: [
          {
            action: 'dispatch',
            commandId: 'C1',
            machine: 'cnc-01',
            orderId: 'O1',
            product: 'VB-100',
            quantity: 3,
            notBefore: '2026-10-12T03:00:00Z',
          },
          { at: '2026-10-12T04:00:00Z', action: 'failure', machine: 'cnc-01', code: 'NOPE' },
          { at: '2026-10-12T04:05:00Z', action: 'lot-block', lot: 'NOPE' },
          { at: '2026-10-12T04:10:00Z', action: 'opcua-offline', machine: 'wsh-01' },
          {
            at: '2026-10-12T04:20:00Z',
            action: 'modbus-silent',
            until: '2026-10-12T04:20:00Z',
          },
          { action: 'operators-absent', shift: '2026-10-12/B', operators: ['op-b1'] },
          { at: '2026-10-12T09:00:00Z', action: 'pause' },
        ],
      }),
    );
    expect(checkScenarioPlan(config, plan)).toEqual([
      { path: 'timeline[1]', message: 'cnc-01 has no failure mode "NOPE"' },
      { path: 'timeline[2]', message: 'unknown lot "NOPE"' },
      {
        path: 'timeline[5]',
        message: 'shift 2026-10-12/B does not start inside the run (start, end)',
      },
      { path: 'timeline[0]', message: 'dispatches need production mode "orders"' },
      { path: 'timeline[3]', message: 'wsh-01 has no OPC UA server' },
      { path: 'timeline[4]', message: 'until must be after at, got 2026-10-12T04:20:00.000Z' },
      {
        path: 'timeline[6]',
        message: '2026-10-12T09:00:00.000Z is outside the run [start, end)',
      },
    ]);
  });
});

describe('scenario schema bounds (#235 review)', () => {
  const one = (extra: object) => issuesOf({ ...HEAD, timeline: [], ...extra });
  const entry = (e: object) => issuesOf({ ...HEAD, timeline: [e] });

  it('takes the edges of the speed, seed and days ranges and refuses past them', () => {
    expect(entry({ at: '2026-10-12T04:00:00Z', action: 'speed', speed: 0.5 })).toEqual([]);
    expect(entry({ at: '2026-10-12T04:00:00Z', action: 'speed', speed: 60 })).toEqual([]);
    expect(entry({ at: '2026-10-12T04:00:00Z', action: 'speed', speed: 0.49 })).toHaveLength(1);
    expect(one({ seed: 2 ** 32 - 1 })).toEqual([]);
    expect(one({ seed: 2 ** 32 }).map((i) => i.path)).toEqual(['seed']);
    expect(one({ seed: -1 }).map((i) => i.path)).toEqual(['seed']);
    expect(one({ days: 0 }).map((i) => i.path)).toEqual(['days']);
    expect(one({ days: 0.25 })).toEqual([]);
    expect(one({ days: 1e-9 })).toEqual([
      {
        path: 'days',
        message: 'days must be a whole number of milliseconds (days × 86,400,000 an integer)',
      },
    ]);
  });

  it('refuses a time finer than a millisecond rather than truncating it', () => {
    expect(entry({ at: '2026-10-12T04:00:00.001Z', action: 'pause' })).toEqual([]);
    expect(entry({ at: '2026-10-12T04:00:00.0015Z', action: 'pause' })).toEqual([
      {
        path: 'timeline[0].at',
        message: 'expected whole milliseconds (the simulation has no finer time)',
      },
    ]);
  });

  it(`takes at most ${String(MAX_TIMELINE_ENTRIES)} entries in a timeline or a golden list`, () => {
    const pauses = (n: number) =>
      Array.from({ length: n }, () => ({ at: '2026-10-12T04:00:00Z', action: 'pause' }));
    expect(one({ timeline: pauses(MAX_TIMELINE_ENTRIES) })).toEqual([]);
    expect(one({ timeline: pauses(MAX_TIMELINE_ENTRIES + 1) }).map((i) => i.path)).toEqual([
      'timeline',
    ]);
    const lots = Array.from({ length: MAX_TIMELINE_ENTRIES + 1 }, () => ({
      kind: 'lot-block',
      at: '2026-10-12T04:00:00Z',
      lot: 'L',
    }));
    expect(issuesOf({ ...HEAD, actions: lots }).map((i) => i.path)).toEqual(['actions']);
    const failures = (n: number) =>
      Array.from({ length: n }, () => ({
        at: '2026-10-12T04:00:00Z',
        machine: 'cnc-01',
        code: 'SPINDLE-OVERLOAD',
      }));
    expect(issuesOf({ ...HEAD, injections: failures(MAX_TIMELINE_ENTRIES) })).toEqual([]);
    expect(
      issuesOf({ ...HEAD, injections: failures(MAX_TIMELINE_ENTRIES + 1) }).map((i) => i.path),
    ).toEqual(['injections']);
    const dispatches = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        commandId: `C${String(i)}`,
        machine: 'cnc-01',
        orderId: `O${String(i)}`,
        product: 'VB-100',
        quantity: 1,
        notBefore: '2026-10-12T03:00:00Z',
      }));
    expect(issuesOf({ ...HEAD, dispatches: dispatches(MAX_TIMELINE_ENTRIES) })).toEqual([]);
    expect(
      issuesOf({ ...HEAD, dispatches: dispatches(MAX_TIMELINE_ENTRIES + 1) }).map((i) => i.path),
    ).toEqual(['dispatches']);
  });
});

describe('checkScenarioPlan edges (#235 review)', () => {
  // Run [03:00Z, 09:00Z): 06:00 to 12:00 Istanbul, shift A only.
  const check = (timeline: object[], testConfig = config) =>
    checkScenarioPlan(testConfig, scenarioPlan(parsed({ ...HEAD, days: 0.25, timeline })));
  const START = '2026-10-12T03:00:00Z';
  const END = '2026-10-12T09:00:00Z';

  it('takes an action and an injection at the start and refuses them at the end', () => {
    // 03:00Z is a shift start, a calendar boundary: only the span is checked here.
    const span = (issues: { path: string; message: string }[]) =>
      issues.filter((i) => i.message.includes('outside the run'));
    expect(span(check([{ at: START, action: 'lot-block', lot: 'SK1-2610-01' }]))).toEqual([]);
    expect(
      span(check([{ at: START, action: 'failure', machine: 'cnc-01', code: 'SPINDLE-OVERLOAD' }])),
    ).toEqual([]);
    expect(check([{ at: END, action: 'lot-block', lot: 'SK1-2610-01' }])).toEqual([
      { path: 'timeline[0]', message: '2026-10-12T09:00:00.000Z is outside the run [start, end)' },
    ]);
    expect(
      check([{ at: END, action: 'failure', machine: 'cnc-01', code: 'SPINDLE-OVERLOAD' }]),
    ).toEqual([
      { path: 'timeline[0]', message: '2026-10-12T09:00:00.000Z is outside the run [start, end)' },
    ]);
    expect(
      check([{ at: '2026-10-12T08:59:59.999Z', action: 'lot-block', lot: 'SK1-2610-01' }]),
    ).toEqual([]);
  });

  it("refuses a forced absence whose shift starts at the run's start or end", () => {
    const absent = (shift: string) => [{ action: 'operators-absent', shift, operators: ['op-a1'] }];
    // Shift A starts at the run's start.
    expect(check(absent('2026-10-12/A'))).toEqual([
      {
        path: 'timeline[0]',
        message: 'shift 2026-10-12/A does not start inside the run (start, end)',
      },
    ]);
    // A run ending at 11:00Z, the start of shift B.
    const plan = scenarioPlan(
      parsed({
        ...HEAD,
        days: 8 / 24,
        timeline: [{ action: 'operators-absent', shift: '2026-10-12/B', operators: ['op-b1'] }],
      }),
    );
    expect(checkScenarioPlan(config, plan)).toEqual([
      {
        path: 'timeline[0]',
        message: 'shift 2026-10-12/B does not start inside the run (start, end)',
      },
    ]);
  });

  it('refuses an infrastructure entry before the start, an unknown machine, no Modbus device', () => {
    expect(check([{ at: '2026-10-12T02:59:59.999Z', action: 'pause' }])).toEqual([
      { path: 'timeline[0]', message: '2026-10-12T02:59:59.999Z is outside the run [start, end)' },
    ]);
    expect(check([{ at: START, action: 'pause' }])).toEqual([]);
    expect(
      check([{ at: '2026-10-12T04:00:00Z', action: 'opcua-offline', machine: 'nope' }]),
    ).toEqual([{ path: 'timeline[0]', message: 'unknown machine "nope"' }]);
    const noModbus = structuredClone(config);
    for (const area of noModbus.plant.areas) {
      for (const workCenter of area.workCenters) {
        workCenter.equipment = workCenter.equipment.filter((e) => e.interface !== 'modbus');
      }
    }
    expect(check([{ at: '2026-10-12T04:00:00Z', action: 'modbus-silent' }], noModbus)).toEqual([
      { path: 'timeline[0]', message: 'the plant has no Modbus device' },
    ]);
  });

  it('refuses overlapping fault windows of one device, and takes back-to-back ones', () => {
    expect(
      check([
        {
          at: '2026-10-12T04:00:00Z',
          action: 'opcua-offline',
          machine: 'cnc-01',
          until: '2026-10-12T04:10:00Z',
        },
        { at: '2026-10-12T04:05:00Z', action: 'opcua-offline', machine: 'cnc-02' },
        { at: '2026-10-12T04:10:00Z', action: 'opcua-offline', machine: 'cnc-01' },
        { at: '2026-10-12T05:00:00Z', action: 'opcua-offline', machine: 'cnc-01' },
        { at: '2026-10-12T05:10:00Z', action: 'modbus-silent' },
        { at: '2026-10-12T05:20:00Z', action: 'modbus-silent', until: '2026-10-12T05:30:00Z' },
      ]),
    ).toEqual([
      {
        path: 'timeline[3]',
        message: 'overlaps the opcua-offline window of timeline[2] (until the end)',
      },
      {
        path: 'timeline[5]',
        message: 'overlaps the modbus-silent window of timeline[4] (until the end)',
      },
    ]);
  });
});

describe('readScenarioFile (#235)', () => {
  it('reads YAML and JSON, and takes a stock file only from the scenario folder', async () => {
    const yaml = join(folder, 'x.yaml');
    writeFileSync(
      yaml,
      `seed: 1\nstart: '2026-10-12T06:00:00+03:00'\ndays: 1\nconfig: config/plant\nstock: lots.yaml\ntimeline: []\n`,
    );
    expect(await readScenarioFile(yaml)).toMatchObject({
      ok: true,
      stock: join(folder, 'lots.yaml'),
    });
    const json = join(folder, 'x.json');
    writeFileSync(json, JSON.stringify({ ...HEAD, stock: '../lots.yaml' }));
    expect(await readScenarioFile(json)).toEqual({
      ok: false,
      message: "stock must be a file name in the scenario's folder",
    });
    expect(await readScenarioFile(join(folder, 'missing.yaml'))).toMatchObject({ ok: false });
  });
});
