import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Machine, type StateChange } from './machine.ts';
import {
  IllegalTransitionError,
  MACHINE_STATES,
  TRANSITIONS,
  canTransition,
} from './machine-state.ts';

const T0 = Date.UTC(2026, 9, 12, 3);

const allPairs = MACHINE_STATES.flatMap((from) => MACHINE_STATES.map((to) => [from, to] as const));
const legalPairs = allPairs.filter(([from, to]) => TRANSITIONS[from].includes(to));
const illegalPairs = allPairs.filter(([from, to]) => !TRANSITIONS[from].includes(to));

describe('transition table', () => {
  it('has an entry for every state and only lists known states', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...MACHINE_STATES].sort());
    for (const targets of Object.values(TRANSITIONS)) {
      targets.forEach((target) => {
        expect(MACHINE_STATES).toContain(target);
      });
    }
  });

  it('never allows a transition to the same state', () => {
    MACHINE_STATES.forEach((state) => {
      expect(canTransition(state, state)).toBe(false);
    });
  });

  it('lets every state be reached and left', () => {
    MACHINE_STATES.forEach((state) => {
      expect(TRANSITIONS[state].length).toBeGreaterThan(0);
      expect(legalPairs.some(([, to]) => to === state)).toBe(true);
    });
  });

  it('keeps a Down machine down until repaired (plan section 7: availability loss)', () => {
    expect(TRANSITIONS.Down).toEqual(['Idle', 'Running']);
  });

  it('matches the state diagram in docs/simulation-model.md', async () => {
    const doc = await readFile(
      resolve(import.meta.dirname, '../../../../docs/simulation-model.md'),
      'utf8',
    );
    const documented = [...doc.matchAll(/^ {2}(\w+) --> (\w+)$/gm)].map(
      (m) => `${m[1] ?? ''}->${m[2] ?? ''}`,
    );
    expect(documented.sort()).toEqual(legalPairs.map(([from, to]) => `${from}->${to}`).sort());
  });
});

describe('Machine transitions', () => {
  it.each(legalPairs)('allows %s → %s', (from, to) => {
    const machine = new Machine('cnc-01', from, T0);
    machine.transition(to, T0 + 1);
    expect(machine.state).toBe(to);
    expect(machine.enteredAt).toBe(T0 + 1);
  });

  it.each(illegalPairs)('rejects %s → %s', (from, to) => {
    const machine = new Machine('cnc-01', from, T0);
    expect(() => {
      machine.transition(to, T0 + 1);
    }).toThrow(IllegalTransitionError);
    expect(machine.state).toBe(from);
  });

  it('names the machine and both states in the error', () => {
    const machine = new Machine('lkt-01', 'Off', T0);
    expect(() => {
      machine.transition('Running', T0);
    }).toThrow('lkt-01: illegal transition Off → Running');
  });

  it('rejects a transition earlier than the previous one', () => {
    const machine = new Machine('cnc-01', 'Idle', T0 + 10);
    expect(() => {
      machine.transition('Running', T0);
    }).toThrow(RangeError);
  });

  it('reports each change with its cause to the listener', () => {
    const changes: StateChange[] = [];
    const machine = new Machine('cnc-02', 'Idle', T0, (change) => changes.push(change));
    machine.transition('Running', T0 + 1_000);
    machine.transition('Down', T0 + 5_000, 'SPINDLE-OVERLOAD');
    expect(changes).toEqual([
      { machineId: 'cnc-02', at: T0 + 1_000, from: 'Idle', to: 'Running' },
      {
        machineId: 'cnc-02',
        at: T0 + 5_000,
        from: 'Running',
        to: 'Down',
        cause: 'SPINDLE-OVERLOAD',
      },
    ]);
  });
});

describe('time accounting', () => {
  it('accumulates time per state, including the current one', () => {
    const machine = new Machine('asm-01', 'Idle', T0);
    machine.transition('Running', T0 + 60_000);
    machine.transition('Stopped', T0 + 200_000, 'PART-MISFEED');
    machine.transition('Running', T0 + 230_000);
    const durations = machine.durations(T0 + 300_000);
    expect(durations.Idle).toBe(60_000);
    expect(durations.Running).toBe(140_000 + 70_000);
    expect(durations.Stopped).toBe(30_000);
    expect(machine.elapsed(T0 + 300_000)).toBe(300_000);
  });

  it('refuses to account up to a time before the last transition', () => {
    const machine = new Machine('asm-01', 'Idle', T0);
    machine.transition('Running', T0 + 10);
    expect(() => machine.durations(T0 + 5)).toThrow(RangeError);
  });

  const legalWalk = fc
    .tuple(
      fc.constantFrom(...MACHINE_STATES),
      fc.array(fc.tuple(fc.nat({ max: 1_000 }), fc.nat({ max: 3_600_000 })), { maxLength: 200 }),
      fc.nat({ max: 3_600_000 }),
    )
    .map(([initial, steps, tail]) => ({ initial, steps, tail }));

  it('property: durations of all states always sum to the elapsed time (plan section 4)', () => {
    fc.assert(
      fc.property(legalWalk, ({ initial, steps, tail }) => {
        const machine = new Machine('cnc-01', initial, T0);
        let now = T0;
        for (const [choice, gap] of steps) {
          const options = TRANSITIONS[machine.state];
          const next = options[choice % options.length];
          if (next === undefined) {
            throw new Error('every state has at least one legal transition');
          }
          now += gap;
          machine.transition(next, now);
        }
        now += tail;
        const durations = machine.durations(now);
        const total = Object.values(durations).reduce((sum, d) => sum + d, 0);
        expect(total).toBe(machine.elapsed(now));
        Object.values(durations).forEach((d) => {
          expect(d).toBeGreaterThanOrEqual(0);
        });
      }),
    );
  });
});
