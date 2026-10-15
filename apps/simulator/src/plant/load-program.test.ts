import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, RandomSource, Simulation } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProductionLine, type LineEvent, type PlantEvent } from './line.ts';
import { continuousOperation, loadDefaultConfig } from './testing.ts';

const T0 = Date.UTC(2026, 9, 12, 3);
let defaults: PlantConfig;

beforeAll(async () => {
  defaults = await loadDefaultConfig();
});

function setup(schedule: PlantConfig['schedule']['machines']) {
  const config = structuredClone(defaults);
  continuousOperation(config);
  config.failures.equipment = {};
  config.schedule.machines = schedule;
  const events: PlantEvent[] = [];
  const line = new ProductionLine({
    config,
    random: new RandomSource(9),
    startTime: T0,
    onEvent: (e) => events.push(e),
  });
  const simulation = new Simulation<LineEvent>(T0);
  line.start(simulation);
  const runTo = (t: number) => {
    simulation.runUntil(t, (event, sim) => {
      line.handle(event, sim);
    });
  };
  return { line, simulation, events, runTo };
}

describe('LoadProgram (plan section 5, data path 3)', () => {
  it('runs the loaded campaign next, with a changeover at the next cycle boundary, then resumes the schedule', () => {
    const { line, simulation, events, runTo } = setup({
      'cnc-01': [{ product: 'VB-100', quantity: 1_000 }],
      'cnc-02': [{ product: 'VB-100', quantity: 1_000 }],
    });
    runTo(T0 + HOUR);
    const result = line.loadProgram('cnc-01', 'VB-200', 3, simulation);
    expect(result).toEqual({ ok: true, position: 1 });
    runTo(T0 + 6 * HOUR);
    const cnc = events.filter((e) => 'machineId' in e && e.machineId === 'cnc-01');
    const loaded = cnc.findIndex((e) => e.type === 'program-loaded');
    expect(cnc[loaded]).toMatchObject({ at: T0 + HOUR, product: 'VB-200', quantity: 3 });
    const after = cnc.slice(loaded);
    const setups = after
      .filter((e) => e.type === 'state' && e.to === 'Setup')
      .map((e) => (e.type === 'state' ? e.cause : ''));
    expect(setups.slice(0, 2)).toEqual(['CHANGEOVER VB-100→VB-200', 'CHANGEOVER VB-200→VB-100']);
    const products = after.flatMap((e) => (e.type === 'cycle-complete' ? [e.product] : []));
    expect(products.slice(1, 4)).toEqual(['VB-200', 'VB-200', 'VB-200']);
    expect(products.slice(4, 6)).toEqual(['VB-100', 'VB-100']);
    expect(['VB-100', 'VB-200']).toContain(products[0]);
  });

  it('wakes a CNC whose schedule is complete', () => {
    const { line, simulation, events, runTo } = setup({
      'cnc-01': [{ product: 'VB-100', quantity: 1 }],
      'cnc-02': [{ product: 'VB-100', quantity: 1 }],
    });
    runTo(T0 + HOUR);
    expect(line.stations.find((s) => s.id === 'cnc-01')?.machine.state).toBe('Idle');
    line.loadProgram('cnc-01', 'VB-100', 2, simulation);
    runTo(T0 + 2 * HOUR);
    const made = events.filter(
      (e) => e.type === 'cycle-complete' && e.machineId === 'cnc-01',
    ).length;
    expect(made).toBe(3);
  });

  it('names the first changeover of a CNC with nothing loaded "none", never "undefined"', () => {
    // A validated schedule always has a first campaign, so only a CNC built
    // with an empty campaign list starts with no product loaded.
    const { line, simulation, events, runTo } = setup({
      'cnc-01': [],
      'cnc-02': [{ product: 'VB-100', quantity: 1_000 }],
    });
    runTo(T0 + HOUR);
    line.loadProgram('cnc-01', 'VB-100', 2, simulation);
    runTo(T0 + 2 * HOUR);
    const setups = events.flatMap((e) =>
      e.type === 'state' && e.machineId === 'cnc-01' && e.to === 'Setup' ? [e.cause] : [],
    );
    expect(setups).toEqual(['CHANGEOVER none→VB-100']);
  });

  it.each([
    ['asm-01', 'VB-100', 1, 'does not run programs'],
    ['cnc-01', 'VB-999', 1, 'unknown product'],
    ['cnc-01', 'VB-100', 0, 'integer from 1'],
    ['cnc-01', 'VB-100', 1.5, 'integer from 1'],
    ['cnc-01', 'VB-100', 100_001, 'integer from 1'],
  ])('rejects %s / %s / %s', (machine, product, quantity, reason) => {
    const { line, simulation, events } = setup({ 'cnc-01': [{ product: 'VB-100', quantity: 5 }] });
    const result = line.loadProgram(machine, product, quantity, simulation);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain(reason);
    expect(events.some((e) => e.type === 'program-loaded')).toBe(false);
  });
});
