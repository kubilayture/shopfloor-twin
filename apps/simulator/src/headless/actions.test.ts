/**
 * Console actions in the headless run and its header (#234, ADR-0037): listed under `actions`
 * only when a run has any, applied after the dispatches and injections in list order, and the
 * same event log as a live run that accepted them before it started.
 */
import type { ActionSpec, PlantConfig } from '@shopfloor/plant-config';
import { HOUR, MINUTE } from '@shopfloor/sim-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLiveRun } from '../live/run.ts';
import { ManualClock } from '../live/testing.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { runHeadless } from './run.ts';
import { EVENT_SCHEMA, isoTime, stableStringify } from './serialize.ts';

/** Monday 2026-10-12 06:00 Istanbul. */
const START = Date.UTC(2026, 9, 12, 3);
const END = START + 24 * HOUR;
const SEED = 7;

/** Every action kind: a block and release, both ASM-01 operators of shift B, a tool breakage. */
const ACTIONS: readonly ActionSpec[] = [
  { kind: 'lot-block', at: START + 1 * HOUR + 5 * MINUTE, lot: 'SK1-2610-01' },
  { kind: 'lot-release', at: START + 2 * HOUR + 10 * MINUTE, lot: 'SK1-2610-01' },
  { kind: 'operators-absent', shift: '2026-10-12/B', operators: ['op-b1', 'op-b2'] },
  { kind: 'tool-breakage', at: START + 3 * HOUR + 33 * MINUTE, machine: 'cnc-02' },
];

let config: PlantConfig;

beforeAll(async () => {
  config = await loadDefaultConfig();
});

const headless = (actions: readonly ActionSpec[]) => {
  const lines: string[] = [];
  const result = runHeadless({ config, seed: SEED, start: START, end: END, actions }, (line) =>
    lines.push(line),
  );
  return { lines, result };
};

describe('console actions in a headless run (#234)', () => {
  it('lists them under `actions` in the header, and only when there are any', () => {
    const plain = headless([]);
    expect(plain.result.header).not.toHaveProperty('actions');
    expect(Object.keys(JSON.parse(plain.lines[0] ?? '{}') as object)).not.toContain('actions');
    const acted = headless(ACTIONS);
    expect(acted.result.header.actions).toEqual([
      { kind: 'lot-block', at: '2026-10-12T04:05:00.000Z', lot: 'SK1-2610-01' },
      { kind: 'lot-release', at: '2026-10-12T05:10:00.000Z', lot: 'SK1-2610-01' },
      { kind: 'operators-absent', shift: '2026-10-12/B', operators: ['op-b1', 'op-b2'] },
      { kind: 'tool-breakage', at: '2026-10-12T06:33:00.000Z', machine: 'cnc-02' },
    ]);
    // The header is the only line before the first action that differs.
    const firstAction = acted.lines.findIndex((line) => line.includes('"type":"lot"'));
    expect(acted.lines.slice(1, firstAction)).toEqual(plain.lines.slice(1, firstAction));
    const types = acted.lines.slice(1).map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types.filter((t) => t === 'lot')).toHaveLength(2);
    expect(types.filter((t) => t === 'absence')).toHaveLength(1);
    expect(types.filter((t) => t === 'tool-breakage')).toHaveLength(1);
    // Shift B starts with ASM-01 unstaffed.
    const shiftB = Date.UTC(2026, 9, 12, 11);
    expect(acted.lines.slice(1).map((line) => JSON.parse(line) as object)).toContainEqual(
      expect.objectContaining({
        type: 'state',
        machineId: 'asm-01',
        to: 'Idle',
        cause: 'NO-OPERATOR',
        at: isoTime(shiftB),
      }),
    );
  });

  it('refuses actions outside the run or not valid for the configuration', () => {
    expect(() => headless([{ kind: 'lot-block', at: END + MINUTE, lot: 'SK1-2610-01' }])).toThrow(
      /actions\[0\].*outside the run/,
    );
    expect(() => headless([{ kind: 'lot-block', at: START + MINUTE, lot: 'NOPE' }])).toThrow(
      /actions\[0\]: unknown lot/,
    );
    expect(() =>
      headless([{ kind: 'operators-absent', shift: '2026-10-12/A', operators: ['op-a1'] }]),
    ).toThrow(/actions\[0\].*does not start inside the run/);
    expect(() =>
      headless([{ kind: 'tool-breakage', at: START + MINUTE, machine: 'asm-01' }]),
    ).toThrow(/actions\[0\]: asm-01 has no tool/);
  });

  it('refuses an action at exactly the end and a shift that starts exactly at the end', () => {
    const run = (end: number, actions: readonly ActionSpec[]) => () =>
      runHeadless({ config, seed: SEED, start: START, end, actions }, () => undefined);
    // An end off every calendar boundary, so only the run's span refuses it.
    const end = START + 5 * HOUR + 7 * MINUTE;
    expect(run(end, [{ kind: 'lot-block', at: end, lot: 'SK1-2610-01' }])).toThrow(
      /^actions\[0\]: 2026-10-12T08:07:00\.000Z is outside the run \[start, end\)$/,
    );
    expect(run(end, [{ kind: 'tool-breakage', at: end - 1, machine: 'cnc-01' }])).not.toThrow();
    // Shift B starts at 11:00Z: a run ending then never staffs it.
    const shiftB = Date.UTC(2026, 9, 12, 11);
    const absent: ActionSpec = {
      kind: 'operators-absent',
      shift: '2026-10-12/B',
      operators: ['op-b1'],
    };
    expect(run(shiftB, [absent])).toThrow(
      /^actions\[0\]: shift 2026-10-12\/B does not start inside the run \(start, end\)$/,
    );
    expect(run(shiftB + 1, [absent])).not.toThrow();
  });

  it('gives the event log of a live run that accepted the same actions before it started', () => {
    const { lines } = headless(ACTIONS);
    const clock = new ManualClock();
    const live: string[] = [];
    let seq = 0;
    const run = createLiveRun({
      config,
      seed: SEED,
      start: START,
      end: END,
      speed: 60,
      clock,
      onEvent: (event) => {
        seq++;
        live.push(stableStringify({ ...event, schema: EVENT_SCHEMA, seq, at: isoTime(event.at) }));
      },
    });
    for (const action of ACTIONS) {
      expect(run.act(action)).toMatchObject({ ok: true });
    }
    run.pacer.start();
    while (run.pacer.state === 'running') {
      clock.advance(997);
    }
    expect(live).toEqual(lines.slice(1));
    expect(run.actions().map((a) => a.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
  });
});
