import { resolve } from 'node:path';
import { formatIssues, loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { HOUR, MINUTE, RandomSource, Simulation } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { continuousOperation } from './testing.ts';
import { ProductionLine, type LineEvent, type PlantEvent } from './line.ts';

const T0 = Date.UTC(2026, 9, 12, 3);
let defaults: PlantConfig;

beforeAll(async () => {
  const result = await loadPlantConfig(resolve(import.meta.dirname, '../../../../config/plant'));
  if (!result.ok) {
    throw new Error(formatIssues(result.issues));
  }
  defaults = result.config;
});

type Schedule = PlantConfig['schedule']['machines'];

function run(schedule: Schedule, duration: number, seed = 1, configure?: (c: PlantConfig) => void) {
  const config = structuredClone(defaults);
  continuousOperation(config);
  config.schedule.machines = schedule;
  config.failures.equipment = {};
  configure?.(config);
  const events: PlantEvent[] = [];
  const line = new ProductionLine({
    config,
    random: new RandomSource(seed),
    startTime: T0,
    onEvent: (event) => events.push(event),
  });
  const simulation = new Simulation<LineEvent>(T0);
  line.start(simulation);
  simulation.runUntil(T0 + duration, (event, sim) => {
    line.handle(event, sim);
  });
  const durations = (id: string) => {
    const station = line.stations.find((s) => s.id === id);
    if (!station) {
      throw new Error(id);
    }
    return station.machine.durations(T0 + duration);
  };
  return { line, events, durations };
}

const lots = (product: string, quantity: number): Schedule => ({
  'cnc-01': [{ product, quantity }],
  'cnc-02': [{ product, quantity }],
});

describe('material flow with failures off (plan section 3)', () => {
  it('makes ASM-01 the bottleneck: output follows its 150 s cycle', () => {
    const { line, durations } = run(lots('VB-100', 5_000), 24 * HOUR);
    const fillTime = 240 + 60;
    const expected = (24 * 3_600 - fillTime) / 150;
    expect(line.finished.length).toBeGreaterThan(expected * 0.98);
    expect(line.finished.length).toBeLessThan(expected * 1.02);
    const asm = durations('asm-01');
    expect(asm.Running / (24 * HOUR)).toBeGreaterThan(0.99);
    expect(asm.Starved).toBeLessThan(10 * MINUTE);
  });

  it('blocks the faster upstream machines and starves the faster downstream ones', () => {
    const { durations } = run(lots('VB-100', 5_000), 24 * HOUR);
    expect(durations('cnc-01').Blocked).toBeGreaterThan(2 * HOUR);
    expect(durations('wsh-01').Blocked).toBeGreaterThan(2 * HOUR);
    expect(durations('lkt-01').Starved).toBeGreaterThan(4 * HOUR);
    expect(durations('pck-01').Starved).toBeGreaterThan(12 * HOUR);
  });

  it('respects buffer capacities at every moment', () => {
    const { line, events } = run(lots('VB-100', 5_000), 6 * HOUR);
    expect(events.length).toBeGreaterThan(0);
    line.buffers.forEach((buffer) => {
      expect(buffer.size).toBeLessThanOrEqual(buffer.capacity);
    });
    const full = line.buffers.find((b) => b.from === 'OP20');
    expect(full?.size).toBe(full?.capacity);
  });

  it('assigns a serial at the end of OP10 and carries it to the end of the line', () => {
    const { line, events } = run(lots('VB-100', 10), 3 * HOUR);
    const cncSerials = events.flatMap((e) =>
      e.type === 'cycle-complete' && e.machineId.startsWith('cnc') ? [e.serial] : [],
    );
    expect(cncSerials).toHaveLength(20);
    expect(new Set(cncSerials).size).toBe(20);
    expect(cncSerials.every((s) => /^VB-100-\d{6}$/.test(s))).toBe(true);
    expect(line.finished.map((p) => p.serial).sort()).toEqual([...cncSerials].sort());
  });

  it('stops each CNC with "schedule complete" when its campaigns are done', () => {
    const { line, events } = run(lots('VB-100', 3), 2 * HOUR);
    expect(line.finished).toHaveLength(6);
    const last = events.filter((e) => e.type === 'state' && e.machineId === 'cnc-01').at(-1);
    expect(last).toMatchObject({ to: 'Idle', cause: 'SCHEDULE-COMPLETE' });
  });

  it('runs a changeover between campaigns of different variants (plan section 3: 25 min)', () => {
    const schedule: Schedule = {
      'cnc-01': [
        { product: 'VB-100', quantity: 2 },
        { product: 'VB-200', quantity: 2 },
      ],
      'cnc-02': [{ product: 'VB-100', quantity: 1 }],
    };
    const { line, events, durations } = run(schedule, 4 * HOUR);
    const setup = events.filter(
      (e) => e.type === 'state' && e.machineId === 'cnc-01' && e.to === 'Setup',
    );
    expect(setup).toEqual([expect.objectContaining({ cause: 'CHANGEOVER VB-100→VB-200' })]);
    expect(durations('cnc-01').Setup).toBe(25 * MINUTE);
    expect(durations('cnc-02').Setup).toBe(0);
    expect(line.finished.map((p) => p.product).sort()).toEqual([
      'VB-100',
      'VB-100',
      'VB-100',
      'VB-200',
      'VB-200',
    ]);
  });

  it('uses the VB-200 cycle times: bottleneck output follows 210 s at ASM-01', () => {
    const { line } = run(lots('VB-200', 5_000), 24 * HOUR);
    const expected = (24 * 3_600 - 330 - 60) / 210;
    expect(line.finished.length).toBeGreaterThan(expected * 0.98);
    expect(line.finished.length).toBeLessThan(expected * 1.02);
  });

  it('time in all states sums to the elapsed time for every machine', () => {
    const { line } = run(lots('VB-100', 5_000), 10 * HOUR);
    line.stations.forEach((station) => {
      const total = Object.values(station.machine.durations(T0 + 10 * HOUR)).reduce(
        (s, d) => s + d,
        0,
      );
      expect(total).toBe(10 * HOUR);
    });
  });

  it('conserves parts: produced = finished + in buffers + in machines', () => {
    const { line } = run(lots('VB-100', 5_000), 7 * HOUR + 13 * MINUTE);
    const inBuffers = line.buffers.reduce((s, b) => s + b.size, 0);
    const inMachines = line.stations.filter((s) => s.part !== undefined).length;
    expect(line.producedParts).toBe(line.finished.length + inBuffers + inMachines);
  });

  it('is deterministic: the same seed gives the same events, another seed different ones', () => {
    const a = run(lots('VB-100', 5_000), 3 * HOUR, 7).events;
    const b = run(lots('VB-100', 5_000), 3 * HOUR, 7).events;
    const c = run(lots('VB-100', 5_000), 3 * HOUR, 8).events;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  it('runs exactly at ideal time when a station has no cycle-time variation', () => {
    const { events } = run(lots('VB-100', 1), 1 * HOUR, 1, (c) => {
      c.process.cycleTimeCv.OP10 = 0;
    });
    const done = events.find((e) => e.type === 'cycle-complete' && e.machineId === 'cnc-01');
    expect(done?.at).toBe(T0 + 240_000);
  });
});
