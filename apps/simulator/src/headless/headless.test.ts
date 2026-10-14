import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR, RandomSource, Simulation } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProductionLine, type LineEvent } from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { configHash, runHeadless, summaryDocument } from './run.ts';
import { stableStringify } from './serialize.ts';

const run = promisify(execFile);
const START = Date.UTC(2026, 9, 12, 3);
const WEEK = 7 * 24 * HOUR;
let config: PlantConfig;

beforeAll(async () => {
  config = await loadDefaultConfig();
});

const headless = (seed: number, end = START + WEEK, cfg = config) => {
  const lines: string[] = [];
  const result = runHeadless({ config: cfg, seed, start: START, end }, (line) => lines.push(line));
  return { lines, result };
};

describe('stableStringify', () => {
  it('sorts keys at every level and drops undefined fields', () => {
    expect(stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[{"y":2,"z":1}]},"b":1}',
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('refuses %s', (value) => {
    expect(() => stableStringify({ value })).toThrow(RangeError);
  });

  it('refuses values JSON cannot represent', () => {
    expect(() => stableStringify({ f: () => 1 })).toThrow(TypeError);
  });
});

describe('runHeadless (plan section 4, headless mode)', () => {
  it('produces byte-identical output for the same seed and different output for another', () => {
    const a = headless(42, START + 2 * 24 * HOUR);
    const b = headless(42, START + 2 * 24 * HOUR);
    const c = headless(43, START + 2 * 24 * HOUR);
    expect(b.lines.join('\n')).toBe(a.lines.join('\n'));
    expect(summaryDocument(b.result)).toBe(summaryDocument(a.result));
    expect(c.lines.join('\n')).not.toBe(a.lines.join('\n'));
  });

  it('writes a header, then numbered, versioned events in time order', () => {
    const { lines, result } = headless(1, START + 24 * HOUR);
    const [header, ...events] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(header).toMatchObject({
      schema: 'sim-run/1',
      seed: 1,
      start: '2026-10-12T03:00:00.000Z',
    });
    expect(events).toHaveLength(result.eventCount);
    events.forEach((event, i) => {
      expect(event.schema).toBe('sim-event/1');
      expect(event.seq).toBe(i + 1);
    });
    const times = events.map((e) => Date.parse(String(e.at)));
    expect(times.every((t, i) => i === 0 || t >= (times[i - 1] ?? 0))).toBe(true);
  });

  it('matches the machines own time accounting exactly (ground truth from events)', () => {
    const { result } = headless(7);
    const line = new ProductionLine({ config, random: new RandomSource(7), startTime: START });
    const simulation = new Simulation<LineEvent>(START);
    line.start(simulation);
    simulation.runUntil(START + WEEK, (event, sim) => {
      line.handle(event, sim);
    });
    for (const station of line.stations) {
      expect(result.summary.machines[station.id]?.stateMs).toEqual(
        station.machine.durations(START + WEEK),
      );
    }
    expect(result.summary.production.started).toBe(line.producedParts);
  });

  it('splits state time by shift instance, and the shifts add up to the totals', () => {
    const { result } = headless(3);
    for (const machine of Object.values(result.summary.machines)) {
      const shifts = Object.values(machine.byShift);
      const total = (s: Record<string, number>) => Object.values(s).reduce((a, b) => a + b, 0);
      expect(shifts.reduce((sum, s) => sum + total(s), 0)).toBe(WEEK);
      expect(total(machine.byShift['2026-10-13/B'] ?? {})).toBe(8 * HOUR);
      expect(total(machine.byShift['no-shift'] ?? {})).toBe(48 * HOUR);
      expect(machine.byShift['2026-10-13/B']?.PlannedStop).toBe(30 * 60_000);
    }
    expect(Object.keys(result.summary.machines['asm-01']?.byShift ?? {})).toHaveLength(16);
  });

  it('counts cycles and production consistently with the event log', () => {
    const { lines, result } = headless(5);
    const cycles = lines
      .slice(1)
      .map((line) => JSON.parse(line) as { type: string; machineId?: string; result?: string })
      .filter((e) => e.type === 'cycle-complete');
    const asm = result.summary.machines['asm-01']?.cycles;
    expect(asm?.good).toBe(
      cycles.filter((e) => e.machineId === 'asm-01' && e.result === 'good').length,
    );
    const finished = Object.values(result.summary.production.finished).reduce((s, n) => s + n, 0);
    expect(finished).toBe(result.summary.machines['pck-01']?.cycles.good);
    expect(Object.keys(result.summary.lots)).toEqual(config.stock.lots.map((l) => l.id));
  });

  it('identifies the configuration by a hash that changes when the plant changes', () => {
    const changed = structuredClone(config);
    changed.products.changeoverMinutes = 30;
    expect(configHash(config)).toMatch(/^[0-9a-f]{64}$/);
    expect(configHash(changed)).not.toBe(configHash(config));
    expect(configHash(structuredClone(config))).toBe(configHash(config));
  });

  it('rejects an end time that is not after the start', () => {
    expect(() => headless(1, START)).toThrow(RangeError);
  });
});

describe('headless CLI', () => {
  const cli = resolve(import.meta.dirname, 'cli.ts');

  it('writes events.jsonl and summary.json for a run', async () => {
    const out = await mkdtemp(join(tmpdir(), 'sim-headless-'));
    try {
      const { stdout } = await run(process.execPath, [
        cli,
        '--seed',
        '9',
        '--days',
        '1',
        '--out',
        out,
      ]);
      expect(stdout).toMatch(/seed 9, 1 days: \d+ events/);
      const summary = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8')) as {
        schema: string;
      };
      expect(summary.schema).toBe('sim-summary/1');
      const events = (await readFile(join(out, 'events.jsonl'), 'utf8')).trim().split('\n');
      expect(events.length).toBeGreaterThan(1_000);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('exits with status 2 on invalid arguments', async () => {
    await expect(run(process.execPath, [cli, '--days', 'zero'])).rejects.toMatchObject({ code: 2 });
  });
});
