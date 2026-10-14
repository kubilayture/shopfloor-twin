import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, RandomSource, Simulation } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProductionLine, type LineEvent, type PlantEvent } from './line.ts';
import { Inventory } from './materials.ts';
import { continuousOperation, loadDefaultConfig, partsAccountedFor } from './testing.ts';

const T0 = Date.UTC(2026, 9, 12, 3);
let defaults: PlantConfig;

beforeAll(async () => {
  defaults = await loadDefaultConfig();
});

function setup(configure: (c: PlantConfig) => void, seed = 21) {
  const config = structuredClone(defaults);
  continuousOperation(config);
  config.failures.equipment = {};
  config.stock.lots = structuredClone(defaults.stock.lots);
  config.schedule.machines = {
    'cnc-01': [{ product: 'VB-100', quantity: 1_000_000 }],
    'cnc-02': [{ product: 'VB-100', quantity: 1_000_000 }],
  };
  configure(config);
  const events: PlantEvent[] = [];
  const line = new ProductionLine({
    config,
    random: new RandomSource(seed),
    startTime: T0,
    onEvent: (event) => events.push(event),
  });
  const simulation = new Simulation<LineEvent>(T0);
  line.start(simulation);
  const runTo = (time: number): void => {
    simulation.runUntil(time, (event, sim) => {
      line.handle(event, sim);
    });
  };
  return { line, events, simulation, runTo, config };
}

const lotsOf = (quantity: Record<string, number>) => (c: PlantConfig) => {
  c.stock.lots = c.stock.lots.map((lot) => ({
    ...lot,
    quantity: quantity[lot.material] ?? lot.quantity,
  }));
};

describe('Inventory', () => {
  const stock = {
    lots: [
      { id: 'A-1', material: 'A', quantity: 2 },
      { id: 'B-1', material: 'B', quantity: 1 },
      { id: 'A-2', material: 'A', quantity: 1 },
    ],
  };

  it('consumes lots of a material first in, first out', () => {
    const inventory = new Inventory(stock);
    expect([inventory.consume('A'), inventory.consume('A'), inventory.consume('A')]).toEqual([
      'A-1',
      'A-1',
      'A-2',
    ]);
    expect(inventory.available('A')).toBe(false);
    expect(() => inventory.consume('A')).toThrow(RangeError);
  });

  it('skips blocked lots until they are released', () => {
    const inventory = new Inventory(stock);
    expect(inventory.setBlocked('A-1', true)).toBe('A');
    expect(inventory.consume('A')).toBe('A-2');
    expect(inventory.available('A')).toBe(false);
    inventory.setBlocked('A-1', false);
    expect(inventory.consume('A')).toBe('A-1');
    expect(inventory.remaining('A-1')).toBe(1);
  });

  it('rejects an unknown lot', () => {
    expect(() => new Inventory(stock).setBlocked('Z-9', true)).toThrow(/unknown lot/);
  });
});

describe('material flow in the plant (plan section 3)', () => {
  it('links every finished serial to one blank lot and one lot of each component', () => {
    const { line, events, runTo } = setup(() => undefined);
    runTo(T0 + 24 * HOUR);
    const lotsByPart = new Map<number, string[]>();
    for (const e of events) {
      if (e.type === 'material-consumed') {
        lotsByPart.set(e.partId, [...(lotsByPart.get(e.partId) ?? []), e.material]);
      }
    }
    expect(line.finished.length).toBeGreaterThan(400);
    for (const part of line.finished) {
      const materials = (lotsByPart.get(part.id) ?? []).sort();
      expect(materials.filter((m) => m !== 'SK-1')).toEqual(['BLANK-100', 'SP-100']);
      expect(materials.filter((m) => m === 'SK-1').length).toBeGreaterThanOrEqual(1);
      expect(part.lots.map((l) => l.material).sort()).toEqual(materials);
    }
  });

  it('uses blank lots first in, first out', () => {
    const { events, runTo } = setup(lotsOf({ 'BLANK-100': 300 }));
    runTo(T0 + 24 * HOUR);
    const order = events.flatMap((e) =>
      e.type === 'material-consumed' && e.material === 'BLANK-100' ? [e.lotId] : [],
    );
    const firstOfSecond = order.indexOf('BL100-2610-02');
    expect(firstOfSecond).toBe(300);
    expect(order.slice(firstOfSecond).every((lot) => lot === 'BL100-2610-02')).toBe(true);
  });

  it('starves OP10 with MATERIAL:BLANK-100 when blanks run out', () => {
    const { line, events, runTo } = setup(lotsOf({ 'BLANK-100': 5 }));
    runTo(T0 + 6 * HOUR);
    expect(line.producedParts).toBe(10);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'state',
        machineId: 'cnc-02',
        to: 'Starved',
        cause: 'MATERIAL:BLANK-100',
      }),
    );
  });

  it('starves ASM-01 on a missing component and leaves the part waiting in the buffer', () => {
    const { line, events, runTo } = setup(lotsOf({ 'SK-1': 4 }));
    runTo(T0 + 6 * HOUR);
    expect(line.finished.length).toBeLessThanOrEqual(4);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'state',
        machineId: 'asm-01',
        to: 'Starved',
        cause: 'MATERIAL:SK-1',
      }),
    );
    const op30 = line.buffers.find((b) => b.to === 'OP30');
    expect(op30?.size).toBe(op30?.capacity);
    expect(line.producedParts).toBe(partsAccountedFor(line));
  });

  it('stops on a blocked lot and resumes when it is released', () => {
    const { line, simulation, runTo } = setup(() => undefined);
    line.blockLot('SK1-2610-01', true, simulation);
    runTo(T0 + 2 * HOUR);
    expect(line.finished).toHaveLength(0);
    line.blockLot('SK1-2610-01', false, simulation);
    runTo(T0 + 4 * HOUR);
    expect(line.finished.length).toBeGreaterThan(30);
  });

  it('fits a new seal kit, and only a seal kit, on a reworked part', () => {
    const { events, runTo } = setup((c) => {
      c.process.leakTest.upperLimit = c.process.leakTest.mean;
    });
    runTo(T0 + 24 * HOUR);
    const reworked = new Set(
      events.flatMap((e) =>
        e.type === 'cycle-complete' && e.result === 'rework' ? [e.partId] : [],
      ),
    );
    expect(reworked.size).toBeGreaterThan(50);
    const consumed = (partId: number, material: string) =>
      events.filter(
        (e) => e.type === 'material-consumed' && e.partId === partId && e.material === material,
      ).length;
    for (const partId of reworked) {
      const asmCycles = events.filter(
        (e) => e.type === 'cycle-complete' && e.partId === partId && e.machineId === 'asm-01',
      ).length;
      expect(consumed(partId, 'SK-1')).toBe(asmCycles);
      expect(consumed(partId, 'SP-100')).toBe(1);
    }
  });

  it('accounts for every unit: consumed = initial - remaining for each lot', () => {
    const { line, events, runTo, config } = setup(() => undefined);
    runTo(T0 + 48 * HOUR);
    for (const lot of config.stock.lots) {
      const consumed = events.filter(
        (e) => e.type === 'material-consumed' && e.lotId === lot.id,
      ).length;
      expect(consumed).toBe(lot.quantity - (line.inventory.remaining(lot.id) ?? 0));
    }
  });
});
