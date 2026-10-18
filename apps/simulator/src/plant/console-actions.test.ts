/**
 * Console actions (#234, Phase 9 plan "Console actions", ADR-0037): lot block and release, forced
 * operator absence and tool breakage. Each is a new event variant written only when used, the run
 * before the action is the run without it, and no random draw is added or removed.
 */
import type { PlantConfig } from '@shopfloor/plant-config';
import {
  HOUR,
  MINUTE,
  RandomSource,
  Simulation,
  type RandomStream,
  type SimTime,
} from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { InvariantChecker } from '../headless/invariants.ts';
import {
  ProductionLine,
  type ActionRequest,
  type ActionResult,
  type LineEvent,
  type PlantEvent,
  type ProductionMode,
} from './line.ts';
import { loadDefaultConfig } from './testing.ts';

/** Monday 2026-10-12 06:00 in Istanbul: shift A starts (A 03:00–11:00Z, break 07:00–07:30Z). */
const START = Date.UTC(2026, 9, 12, 3);
const SEED = 20261012;

let defaults: PlantConfig;

beforeAll(async () => {
  defaults = await loadDefaultConfig();
});

/** A random source that records how many draws each stream made. */
class CountingSource extends RandomSource {
  readonly draws = new Map<string, number>();

  override stream(key: string): RandomStream {
    const inner = super.stream(key);
    const count = () => {
      this.draws.set(key, (this.draws.get(key) ?? 0) + 1);
    };
    return {
      key,
      nextUint32: () => {
        count();
        return inner.nextUint32();
      },
      nextFloat: () => {
        count();
        return inner.nextFloat();
      },
    };
  }
}

interface Simulated {
  readonly events: PlantEvent[];
  readonly line: ProductionLine;
  readonly simulation: Simulation<LineEvent>;
  readonly results: ActionResult[];
  readonly random: CountingSource;
  /** Draws per stream when the simulation time first reached each mark. */
  readonly drawsAt: Map<SimTime, Map<string, number>>;
}

function simulate(
  config: PlantConfig,
  actions: readonly ActionRequest[],
  until: SimTime,
  options: {
    production?: ProductionMode;
    marks?: readonly SimTime[];
    before?: (line: ProductionLine, simulation: Simulation<LineEvent>) => void;
  } = {},
): Simulated {
  const events: PlantEvent[] = [];
  const random = new CountingSource(SEED);
  const line = new ProductionLine({
    config,
    random,
    startTime: START,
    production: options.production,
    onEvent: (event) => {
      events.push(event);
      checker.record(event);
    },
  });
  const checker = new InvariantChecker(line, config, START);
  const simulation = new Simulation<LineEvent>(START);
  line.start(simulation);
  options.before?.(line, simulation);
  const results = actions.map((action) => line.act(action, simulation));
  const marks = [...(options.marks ?? [])].sort((a, b) => a - b);
  const drawsAt = new Map<SimTime, Map<string, number>>();
  simulation.runUntil(until, (event, sim) => {
    while (marks.length > 0 && (marks[0] ?? Infinity) <= sim.now) {
      drawsAt.set(marks.shift() ?? 0, new Map(random.draws));
    }
    line.handle(event, sim);
    checker.check(sim.now);
  });
  return { events, line, simulation, results, random, drawsAt };
}

type StateEvent = Extract<PlantEvent, { type: 'state' }>;
type CycleEvent = Extract<PlantEvent, { type: 'cycle-complete' }>;

const before = (events: readonly PlantEvent[], at: SimTime) => events.filter((e) => e.at < at);
const states = (events: readonly PlantEvent[], machine: string): StateEvent[] =>
  events.filter((e): e is StateEvent => e.type === 'state' && e.machineId === machine);
const cycles = (events: readonly PlantEvent[], machine: string): CycleEvent[] =>
  events.filter((e): e is CycleEvent => e.type === 'cycle-complete' && e.machineId === machine);
/** The state a machine is in at `at` (the last state event at or before it). */
const stateAt = (events: readonly PlantEvent[], machine: string, at: SimTime) =>
  states(events, machine)
    .filter((e) => e.at <= at)
    .at(-1);

describe('lot block and release (#234)', () => {
  it('starves ASM-01 on its only seal-kit lot, writes lot events and resumes on release', () => {
    const config = structuredClone(defaults);
    const blockAt = START + 1 * HOUR + 7 * MINUTE;
    const releaseAt = START + 2 * HOUR + 13 * MINUTE;
    const end = START + 3 * HOUR + 30 * MINUTE;
    const plain = simulate(config, [], end);
    const run = simulate(
      config,
      [
        { kind: 'lot-block', lot: 'SK1-2610-01', at: blockAt },
        { kind: 'lot-release', lot: 'SK1-2610-01', at: releaseAt },
      ],
      end,
    );
    expect(run.results).toEqual([
      {
        ok: true,
        action: {
          id: 1,
          kind: 'lot-block',
          lot: 'SK1-2610-01',
          material: 'SK-1',
          at: blockAt,
          status: 'scheduled',
        },
      },
      {
        ok: true,
        action: {
          id: 2,
          kind: 'lot-release',
          lot: 'SK1-2610-01',
          material: 'SK-1',
          at: releaseAt,
          status: 'scheduled',
        },
      },
    ]);
    // The run before the block is the plain run.
    expect(before(run.events, blockAt)).toEqual(before(plain.events, blockAt));
    expect(run.events.filter((e) => e.type === 'lot')).toEqual([
      {
        type: 'lot',
        at: blockAt,
        lotId: 'SK1-2610-01',
        material: 'SK-1',
        transition: 'blocked',
        action: 1,
      },
      {
        type: 'lot',
        at: releaseAt,
        lotId: 'SK1-2610-01',
        material: 'SK-1',
        transition: 'released',
        action: 2,
      },
    ]);
    // VB-100 needs SK-1: ASM-01 starves once its current cycle is done, and nothing consumes the
    // lot while it is blocked.
    const starved = states(run.events, 'asm-01').find(
      (e) => e.at >= blockAt && e.to === 'Starved' && e.cause === 'MATERIAL:SK-1',
    );
    expect(starved).toBeDefined();
    expect(starved?.at).toBeLessThan(releaseAt);
    expect(
      run.events.filter(
        (e) =>
          e.type === 'material-consumed' &&
          e.lotId === 'SK1-2610-01' &&
          e.at > blockAt &&
          e.at < releaseAt,
      ),
    ).toEqual([]);
    // The release wakes it at once.
    expect(stateAt(run.events, 'asm-01', releaseAt)?.to).toBe('Running');
    expect(run.line.lots().find((lot) => lot.id === 'SK1-2610-01')?.blocked).toBe(false);
    expect(run.line.actions().map((a) => a.status)).toEqual(['applied', 'applied']);
    // A run without lot actions writes no lot event.
    expect(plain.events.some((e) => e.type === 'lot')).toBe(false);
  });

  it('lists the lots with what is left and whether they are blocked', () => {
    const config = structuredClone(defaults);
    const run = simulate(
      config,
      [{ kind: 'lot-block', lot: 'BL200-2610-01', at: START + MINUTE }],
      START + HOUR,
    );
    const lots = run.line.lots();
    expect(lots.map((lot) => lot.id)).toEqual(config.stock.lots.map((lot) => lot.id));
    expect(lots.find((lot) => lot.id === 'BL200-2610-01')).toEqual({
      id: 'BL200-2610-01',
      material: 'BLANK-200',
      remaining: 900,
      blocked: true,
    });
    const blanks = run.events.filter(
      (e) => e.type === 'material-consumed' && e.lotId === 'BL100-2610-01',
    ).length;
    expect(lots.find((lot) => lot.id === 'BL100-2610-01')?.remaining).toBe(900 - blanks);
  });

  it('refuses an unknown lot, a time in the past and a calendar boundary', () => {
    const config = structuredClone(defaults);
    const run = simulate(config, [], START + HOUR);
    const act = (request: ActionRequest) => run.line.act(request, run.simulation);
    expect(act({ kind: 'lot-block', lot: 'NOPE' })).toMatchObject({
      ok: false,
      code: 'unknown-lot',
    });
    expect(act({ kind: 'lot-block', lot: 'SK1-2610-01', at: START + MINUTE })).toMatchObject({
      ok: false,
      code: 'in-the-past',
    });
    expect(
      act({ kind: 'lot-release', lot: 'SK1-2610-01', at: START + 4 * HOUR }), // break start
    ).toMatchObject({ ok: false, code: 'calendar-boundary' });
    expect(act({ kind: 'lot-block', lot: 'SK1-2610-01', at: 1.5 })).toMatchObject({
      ok: false,
      code: 'invalid-time',
    });
    expect(run.line.actions()).toEqual([]);
  });
});

describe('forced operator absence (#234)', () => {
  /** Tuesday's shift A: 2026-10-13 06:00 Istanbul. */
  const TUESDAY_A = Date.UTC(2026, 9, 13, 3);
  const operatorLines = (events: readonly PlantEvent[]) =>
    events.filter((e) => e.type === 'operator');

  it('leaves ASM-01 Idle NO-OPERATOR at the shift start when both qualified operators are absent', () => {
    const config = structuredClone(defaults);
    const end = TUESDAY_A + 8 * HOUR + 30 * MINUTE;
    const plain = simulate(config, [], end);
    const run = simulate(
      config,
      [{ kind: 'operators-absent', shift: '2026-10-13/A', operators: ['op-a2', 'op-a1'] }],
      end,
    );
    expect(run.results).toEqual([
      {
        ok: true,
        action: {
          id: 1,
          kind: 'operators-absent',
          shift: '2026-10-13/A',
          start: TUESDAY_A,
          operators: ['op-a2', 'op-a1'],
          status: 'planned',
        },
      },
    ]);
    expect(before(run.events, TUESDAY_A)).toEqual(before(plain.events, TUESDAY_A));
    const atStart = run.events.filter((e) => e.at === TUESDAY_A);
    const absence = atStart.findIndex((e) => e.type === 'absence');
    // In roster order, before the shift's operator lines.
    expect(atStart[absence]).toEqual({
      type: 'absence',
      at: TUESDAY_A,
      shiftId: 'A',
      shiftDate: '2026-10-13',
      operators: ['op-a1', 'op-a2'],
    });
    expect(atStart.findIndex((e) => e.type === 'operator')).toBeGreaterThan(absence);
    expect(atStart).toContainEqual({
      type: 'operator',
      at: TUESDAY_A,
      machineId: 'asm-01',
      operatorId: null,
      absent: ['op-a1', 'op-a2'],
    });
    expect(atStart).toContainEqual(
      expect.objectContaining({
        type: 'state',
        machineId: 'asm-01',
        to: 'Idle',
        cause: 'NO-OPERATOR',
      }),
    );
    // ASM-01 never runs in that shift.
    const shiftEnd = TUESDAY_A + 8 * HOUR;
    expect(
      states(run.events, 'asm-01').filter(
        (e) => e.at >= TUESDAY_A && e.at < shiftEnd && e.to === 'Running',
      ),
    ).toEqual([]);
    // The draws still happen: every other shift is staffed exactly as in the plain run.
    const otherShifts = (events: readonly PlantEvent[]) =>
      operatorLines(events).filter((e) => e.at !== TUESDAY_A);
    expect(otherShifts(run.events)).toEqual(otherShifts(plain.events));
    for (const key of [...run.random.draws.keys()].filter((k) => k.startsWith('operators/'))) {
      expect(run.random.draws.get(key)).toBe(plain.random.draws.get(key));
    }
    expect(run.line.operators().absences).toEqual([
      {
        id: 1,
        kind: 'operators-absent',
        shift: '2026-10-13/A',
        start: TUESDAY_A,
        operators: ['op-a2', 'op-a1'],
        status: 'applied',
        appliedAt: TUESDAY_A,
      },
    ]);
    expect(plain.events.some((e) => e.type === 'absence')).toBe(false);
  });

  it('reports the roster with who is present, absent or off shift', () => {
    const config = structuredClone(defaults);
    config.operators.absenceProbabilityPerShift = 0;
    const run = simulate(
      config,
      [{ kind: 'operators-absent', shift: '2026-10-13/A', operators: ['op-a1'] }],
      TUESDAY_A + HOUR,
    );
    const view = run.line.operators();
    expect(view.currentShift).toBe('2026-10-13/A');
    expect(view.operators.find((op) => op.id === 'op-a1')).toEqual({
      id: 'op-a1',
      shift: 'A',
      skills: ['asm-01', 'lkt-01', 'pck-01'],
      speedFactor: 1,
      status: 'absent',
      station: null,
      forced: true,
    });
    expect(view.operators.find((op) => op.id === 'op-a2')).toMatchObject({
      status: 'present',
      station: 'asm-01',
      forced: false,
    });
    expect(view.operators.find((op) => op.id === 'op-b1')).toMatchObject({
      status: 'off-shift',
      station: null,
    });
    // Between shifts on the weekend nobody is on shift.
    const weekend = simulate(config, [], Date.UTC(2026, 9, 17, 12));
    expect(weekend.line.operators().currentShift).toBeNull();
    expect(new Set(weekend.line.operators().operators.map((op) => op.status))).toEqual(
      new Set(['off-shift']),
    );
  });

  it('refuses a started shift, an unknown shift or operator and an operator of another shift', () => {
    const config = structuredClone(defaults);
    const run = simulate(config, [], START + HOUR);
    const act = (request: ActionRequest) => run.line.act(request, run.simulation);
    const absent = (shift: string, operators: string[]) =>
      act({ kind: 'operators-absent', shift, operators });
    expect(absent('2026-10-12/A', ['op-a1'])).toMatchObject({ ok: false, code: 'shift-started' });
    expect(absent('2026-10-12/B', ['op-x'])).toMatchObject({
      ok: false,
      code: 'unknown-operator',
    });
    expect(absent('2026-10-17/A', ['op-a1'])).toMatchObject({ ok: false, code: 'unknown-shift' });
    expect(absent('2026-10-12/Z', ['op-a1'])).toMatchObject({ ok: false, code: 'unknown-shift' });
    expect(absent('monday/B', ['op-b1'])).toMatchObject({ ok: false, code: 'invalid-shift' });
    expect(absent('2026-10-12/B', ['op-a1'])).toMatchObject({ ok: false, code: 'not-on-shift' });
    expect(absent('2026-10-12/B', [])).toMatchObject({ ok: false, code: 'no-operators' });
    expect(absent('2026-10-12/B', ['op-b1', 'op-b1'])).toMatchObject({
      ok: false,
      code: 'duplicate-operator',
    });
    expect(absent('2026-10-12/B', ['op-b1'])).toMatchObject({ ok: true });
  });
});

describe('tool breakage (#234)', () => {
  /** No natural end of life in the window, and a defect only at wear 1.0. */
  function brittleConfig(): PlantConfig {
    const config = structuredClone(defaults);
    config.process.tool.lifeCycles = 100_000;
    config.process.tool.defectProbability = [
      { wear: 0, probability: 0 },
      { wear: 0.8, probability: 0 },
      { wear: 1, probability: 1 },
    ];
    return config;
  }

  it('draws the cycle in progress at wear 1.0 and changes the tool at the next start', () => {
    const config = brittleConfig();
    const at = START + 1 * HOUR + 2 * MINUTE + 3_456;
    const end = START + 3 * HOUR;
    const plain = simulate(config, [], end);
    // Precondition: CNC-01 is in the middle of a cycle at `at`.
    expect(stateAt(plain.events, 'cnc-01', at)?.to).toBe('Running');
    const run = simulate(config, [{ kind: 'tool-breakage', machine: 'cnc-01', at }], end, {
      marks: [at],
    });
    expect(before(run.events, at)).toEqual(before(plain.events, at));
    const cyclesBefore = cycles(plain.events, 'cnc-01').filter((e) => e.at < at).length;
    expect(run.events.filter((e) => e.type === 'tool-breakage')).toEqual([
      { type: 'tool-breakage', at, machineId: 'cnc-01', action: 1, cycles: cyclesBefore },
    ]);
    // No state change at `at`: the cycle runs on.
    expect(states(run.events, 'cnc-01').filter((e) => e.at === at)).toEqual([]);
    // The cycle in progress ends as in the plain run and is scrapped (wear 1.0 → p = 1).
    const next = cycles(run.events, 'cnc-01').find((e) => e.at > at);
    const plainNext = cycles(plain.events, 'cnc-01').find((e) => e.at > at);
    expect(next?.at).toBe(plainNext?.at);
    expect(next).toMatchObject({ result: 'scrap', reason: 'DIMENSIONAL' });
    // Then the tool change, at the same instant, from the next start.
    expect(states(run.events, 'cnc-01').find((e) => e.at >= (next?.at ?? 0))).toMatchObject({
      at: next?.at,
      to: 'Setup',
      cause: 'TOOL-CHANGE',
    });
    // Only that cycle is scrapped; the plain run scraps none.
    expect(cycles(run.events, 'cnc-01').filter((e) => e.result === 'scrap')).toHaveLength(1);
    expect(plain.events.some((e) => e.type === 'cycle-complete' && e.result === 'scrap')).toBe(
      false,
    );
    expect(run.line.actions()).toEqual([
      {
        id: 1,
        kind: 'tool-breakage',
        machine: 'cnc-01',
        at,
        status: 'applied',
        appliedAt: at,
        cycles: cyclesBefore,
      },
    ]);
  });

  it('keeps one defect draw per OP10 cycle and draws nothing for the breakage or the change', () => {
    const config = structuredClone(defaults);
    const at = START + 1 * HOUR + 2 * MINUTE + 3_456;
    const end = START + 6 * HOUR;
    const plain = simulate(config, [], end, { marks: [at] });
    const run = simulate(config, [{ kind: 'tool-breakage', machine: 'cnc-01', at }], end, {
      marks: [at],
    });
    // Up to `at` every stream drew exactly what the plain run drew.
    expect(run.drawsAt.get(at)).toEqual(plain.drawsAt.get(at));
    for (const result of [plain, run]) {
      for (const cnc of ['cnc-01', 'cnc-02']) {
        expect(result.random.draws.get(`${cnc}/quality/defect`) ?? 0).toBe(
          cycles(result.events, cnc).length,
        );
      }
    }
    // The broken run changed CNC-01's tool once more than the plain run.
    const changes = (events: readonly PlantEvent[]) =>
      states(events, 'cnc-01').filter((e) => e.to === 'Setup' && e.cause === 'TOOL-CHANGE').length;
    expect(changes(run.events)).toBe(changes(plain.events) + 1);
    // CNC-02 keeps its times and results (part ids are line-wide, so they may move).
    const shape = (events: readonly PlantEvent[]) =>
      cycles(events, 'cnc-02')
        .filter((e) => e.at < at + 8 * MINUTE)
        .map((e) => [e.at, e.result]);
    expect(shape(run.events)).toEqual(shape(plain.events));
  });

  it('changes the tool at the next start when no cycle is in progress', () => {
    const config = structuredClone(defaults);
    const at = START + 30 * MINUTE;
    const dispatchAt = START + 1 * HOUR;
    const end = START + 2 * HOUR;
    // Orders mode without jobs: CNC-01 is Idle NO-ORDER until the dispatch.
    const run = simulate(config, [{ kind: 'tool-breakage', machine: 'cnc-01', at }], end, {
      production: 'orders',
      marks: [dispatchAt],
    });
    expect(stateAt(run.events, 'cnc-01', at)).toMatchObject({ to: 'Idle', cause: 'NO-ORDER' });
    expect(states(run.events, 'cnc-01').filter((e) => e.at > START && e.at <= end)).toEqual([]);
    // Dispatch a job: the start path changes the broken tool first.
    const later = simulate(config, [{ kind: 'tool-breakage', machine: 'cnc-01', at }], end, {
      production: 'orders',
      // Accepted at the start, due at `dispatchAt` (its `notBefore` wakes the CNC).
      before: (line, simulation) => {
        line.loadOrder(
          'cnc-01',
          {
            commandId: 'cmd-1',
            orderId: 'ord-1',
            product: 'VB-100',
            quantity: 2,
            notBefore: dispatchAt,
          },
          simulation,
        );
      },
    });
    expect(states(later.events, 'cnc-01').find((e) => e.at >= dispatchAt)).toMatchObject({
      at: dispatchAt,
      to: 'Setup',
      cause: 'TOOL-CHANGE',
    });
  });

  it('refuses a machine without a tool, an unknown machine, the past and a boundary', () => {
    const config = structuredClone(defaults);
    const run = simulate(config, [], START + HOUR);
    const act = (request: ActionRequest) => run.line.act(request, run.simulation);
    expect(act({ kind: 'tool-breakage', machine: 'asm-01' })).toMatchObject({
      ok: false,
      code: 'not-a-cnc',
    });
    expect(act({ kind: 'tool-breakage', machine: 'cnc-09' })).toMatchObject({
      ok: false,
      code: 'unknown-machine',
    });
    expect(act({ kind: 'tool-breakage', machine: 'cnc-01', at: START + MINUTE })).toMatchObject({
      ok: false,
      code: 'in-the-past',
    });
    expect(act({ kind: 'tool-breakage', machine: 'cnc-01', at: START + 8 * HOUR })).toMatchObject({
      ok: false,
      code: 'calendar-boundary',
    });
    expect(act({ kind: 'tool-breakage', machine: 'cnc-02' })).toMatchObject({
      ok: true,
      action: { id: 1, machine: 'cnc-02', at: START + HOUR, status: 'scheduled' },
    });
  });
});
