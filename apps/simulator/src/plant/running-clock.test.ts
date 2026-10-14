import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RunningClock } from './running-clock.ts';

describe('RunningClock', () => {
  it('counts down only while running', () => {
    const clock = new RunningClock();
    clock.set('cycle', 100, 0);
    clock.start(10);
    clock.pause(40);
    clock.sync(500);
    expect(clock.remaining('cycle')).toBe(70);
    clock.start(500);
    clock.sync(520);
    expect(clock.remaining('cycle')).toBe(50);
  });

  it('reports the timer that is due first', () => {
    const clock = new RunningClock();
    clock.set('failure:SPINDLE', 300, 0);
    clock.set('cycle', 100, 0);
    clock.set('minor-stop', 200, 0);
    expect(clock.next()).toEqual({ name: 'cycle', remaining: 100 });
  });

  it('breaks ties by the given priority, then by name', () => {
    const clock = new RunningClock(['cycle']);
    clock.set('minor-stop', 100, 0);
    clock.set('failure:B', 100, 0);
    clock.set('failure:A', 100, 0);
    clock.set('cycle', 100, 0);
    expect(clock.next()?.name).toBe('cycle');
    clock.delete('cycle', 0);
    expect(clock.next()?.name).toBe('failure:A');
  });

  it('has no next timer when empty', () => {
    expect(new RunningClock().next()).toBeUndefined();
  });

  it('measures a newly set timer from the moment it is set', () => {
    const clock = new RunningClock();
    clock.set('minor-stop', 1_000, 0);
    clock.start(0);
    clock.set('cycle', 50, 30);
    clock.sync(60);
    expect(clock.remaining('cycle')).toBe(20);
    expect(clock.remaining('minor-stop')).toBe(940);
  });

  it('ignores a second start and refuses to go back in time', () => {
    const clock = new RunningClock();
    clock.set('cycle', 100, 0);
    clock.start(0);
    clock.start(50);
    clock.sync(60);
    expect(clock.remaining('cycle')).toBe(40);
    expect(() => {
      clock.sync(10);
    }).toThrow(RangeError);
    expect(clock.isRunning).toBe(true);
    clock.pause(60);
    expect(clock.isRunning).toBe(false);
  });

  it('property: total consumption equals total running time', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat(1_000), fc.boolean()), { maxLength: 100 }), (steps) => {
        const clock = new RunningClock();
        clock.set('t', 1e12, 0);
        let now = 0;
        let running = 0;
        for (const [gap, run] of steps) {
          if (clock.isRunning) {
            running += gap;
          }
          now += gap;
          if (run) {
            clock.start(now);
          } else {
            clock.pause(now);
          }
        }
        clock.pause(now);
        expect(1e12 - (clock.remaining('t') ?? 0)).toBe(running);
      }),
    );
  });
});
