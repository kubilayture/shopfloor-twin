import { describe, expect, it } from 'vitest';
import { MINUTE, SECOND } from './sim-time.ts';
import { Simulation } from './simulation.ts';

const START = Date.UTC(2026, 9, 12, 3, 0, 0);

interface Tick {
  kind: 'tick';
  machine: string;
  remaining: number;
}

function trace(): string[] {
  const simulation = new Simulation<Tick>(START);
  const log: string[] = [];
  simulation.schedule(START, { kind: 'tick', machine: 'cnc-01', remaining: 3 });
  simulation.schedule(START, { kind: 'tick', machine: 'cnc-02', remaining: 3 });
  simulation.run((event, sim) => {
    log.push(`${String(sim.now)} ${event.machine}`);
    if (event.remaining > 0) {
      sim.scheduleIn(event.machine === 'cnc-01' ? 2 * MINUTE : 3 * MINUTE, {
        ...event,
        remaining: event.remaining - 1,
      });
    }
  });
  return log;
}

describe('Simulation', () => {
  it('starts at the configured time with nothing pending', () => {
    const simulation = new Simulation<string>(START);
    expect(simulation.now).toBe(START);
    expect(simulation.pending).toBe(0);
    expect(simulation.step(() => undefined)).toBe(false);
  });

  it('advances the clock to each event as it is handled', () => {
    const simulation = new Simulation<string>(START);
    simulation.scheduleIn(5 * SECOND, 'b');
    simulation.scheduleIn(1 * SECOND, 'a');
    const seen: [string, number][] = [];
    simulation.run((event, sim) => seen.push([event, sim.now - START]));
    expect(seen).toEqual([
      ['a', 1 * SECOND],
      ['b', 5 * SECOND],
    ]);
  });

  it('lets handlers schedule follow-up events, including at the current time', () => {
    const simulation = new Simulation<string>(START);
    simulation.schedule(START, 'first');
    const seen: string[] = [];
    simulation.run((event, sim) => {
      seen.push(event);
      if (event === 'first') {
        sim.scheduleIn(0, 'same-time follow-up');
      }
    });
    expect(seen).toEqual(['first', 'same-time follow-up']);
  });

  it('runs up to and including the end time, then stops with the clock at the end time', () => {
    const simulation = new Simulation<string>(START);
    simulation.scheduleIn(10 * SECOND, 'at end');
    simulation.scheduleIn(11 * SECOND, 'after end');
    const seen: string[] = [];
    simulation.runUntil(START + 10 * SECOND, (event) => seen.push(event));
    expect(seen).toEqual(['at end']);
    expect(simulation.now).toBe(START + 10 * SECOND);
    expect(simulation.pending).toBe(1);
  });

  it('advances the clock to the end time even when no event is due', () => {
    const simulation = new Simulation<string>(START);
    simulation.runUntil(START + MINUTE, () => undefined);
    expect(simulation.now).toBe(START + MINUTE);
  });

  it('does not handle cancelled events', () => {
    const simulation = new Simulation<string>(START);
    const handle = simulation.scheduleIn(SECOND, 'cancelled');
    simulation.scheduleIn(2 * SECOND, 'kept');
    expect(simulation.cancel(handle)).toBe(true);
    const seen: string[] = [];
    simulation.run((event) => seen.push(event));
    expect(seen).toEqual(['kept']);
  });

  it.each([
    ['a time in the past', (s: Simulation<string>) => s.schedule(START - 1, 'x')],
    ['a fractional time', (s: Simulation<string>) => s.schedule(START + 0.5, 'x')],
    ['a negative delay', (s: Simulation<string>) => s.scheduleIn(-1, 'x')],
    ['a non-finite delay', (s: Simulation<string>) => s.scheduleIn(Number.NaN, 'x')],
    [
      'a fractional end time',
      (s: Simulation<string>) => {
        s.runUntil(START + 0.5, () => undefined);
      },
    ],
  ])('rejects %s', (_case, act) => {
    expect(() => {
      act(new Simulation<string>(START));
    }).toThrow(RangeError);
  });

  it('rejects a fractional start time', () => {
    expect(() => new Simulation<string>(0.5)).toThrow(RangeError);
  });

  it('produces an identical trace on every run', () => {
    const first = trace();
    expect(first).toHaveLength(8);
    expect(first.slice(0, 2)).toEqual([`${String(START)} cnc-01`, `${String(START)} cnc-02`]);
    expect(trace()).toEqual(first);
  });
});
