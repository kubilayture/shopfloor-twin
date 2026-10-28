import { describe, expect, it } from 'vitest';
import { current, EPOCH } from '../test/fixtures.ts';
import {
  abnormalTone,
  isConnectionLost,
  isNewer,
  newest,
  staleness,
  stateCounts,
  stateStyle,
  timeInState,
  worstTone,
} from './states.ts';

describe('isNewer and newest', () => {
  it('orders by epoch, then seq (an anchor has none), then start', () => {
    expect(isNewer(current({ epoch: EPOCH + 1, seq: 1 }), current({ seq: 99 }))).toBe(true);
    expect(isNewer(current({ seq: 1 }), current({ seq: null }))).toBe(true);
    expect(isNewer(current({ seq: null }), current({ seq: 1 }))).toBe(false);
    expect(
      isNewer(
        current({ since: '2026-10-15T06:00:00.000Z' }),
        current({ since: '2026-10-15T06:00:01.000Z' }),
      ),
    ).toBe(false);
    expect(isNewer(current(), current())).toBe(true);
    expect(newest(null, undefined)).toBeUndefined();
    expect(newest(current({ seq: 3 }), null, current({ seq: 4 }))?.seq).toBe(4);
  });
});

describe('timeInState', () => {
  it('counts to the plant clock in the same epoch, else uses the reported age', () => {
    const state = current({ since: '2026-10-15T06:00:00.000Z', ageMs: 5_000 });
    expect(timeInState(state, { epoch: EPOCH, watermark: '2026-10-15T06:02:00.000Z' })).toBe(
      120_000,
    );
    expect(timeInState(state, { epoch: EPOCH + 1, watermark: '2026-10-15T06:02:00.000Z' })).toBe(
      5_000,
    );
    expect(timeInState(current({ ageMs: null }), null)).toBe(0);
  });
});

describe('staleness', () => {
  it('flags a lost connection and states from an older run', () => {
    const clock = { epoch: EPOCH + 1, watermark: '2026-10-15T06:00:00.000Z' };
    expect(staleness(current(), clock, true)).toBe('disconnected');
    expect(staleness(current(), clock, false)).toBe('older-run');
    expect(staleness(current({ epoch: EPOCH + 1 }), clock, false)).toBeUndefined();
    expect(staleness(current(), null, false)).toBeUndefined();
    expect(isConnectionLost('connecting')).toBe(false);
    expect(isConnectionLost('reconnecting')).toBe(true);
    expect(isConnectionLost('stopped')).toBe(true);
  });
});

describe('stateStyle', () => {
  it('labels every state and falls back to the raw name', () => {
    expect(stateStyle('PlannedStop').label).toBe('Planned stop');
    expect(stateStyle('Warp').label).toBe('Warp');
  });
});

describe('abnormal states and the overview summary (UX-2)', () => {
  it('calls only the states that cost output and need a person abnormal, each in its tone', () => {
    const abnormal = ['Starved', 'Blocked', 'Stopped', 'Down'];
    for (const state of [
      'Running',
      'Idle',
      'Setup',
      'PlannedStop',
      'Maintenance',
      'Off',
      'Warp',
      ...abnormal,
    ]) {
      expect(stateStyle(state).abnormal, state).toBe(abnormal.includes(state));
    }
    expect(abnormal.map((state) => stateStyle(state).tone)).toEqual([
      'warn',
      'caution',
      'alarm',
      'alarm',
    ]);
    // The bar is the state's own border colour, in both themes (2.4), not the tone's.
    for (const [state, key] of [
      ['Starved', 'starved'],
      ['Blocked', 'blocked'],
      ['Stopped', 'stopped'],
      ['Down', 'down'],
    ] as const) {
      expect(stateStyle(state).bar, state).toBe(`border-l-4 border-l-state-${key}-border`);
    }
    for (const state of ['Running', 'Idle', 'Maintenance', 'Warp']) {
      expect(stateStyle(state).bar, state).toBeUndefined();
    }
    expect(stateStyle('Maintenance').tone).toBe('info');
    expect(stateStyle('Running').tone).toBe('neutral');
  });

  it('counts machines per state, the most severe abnormal first, no data last', () => {
    expect(
      stateCounts([
        'Running',
        undefined,
        'Starved',
        'Idle',
        'Down',
        'Starved',
        'Warp',
        'Maintenance',
        'Blocked',
      ]),
    ).toEqual([
      { state: 'Down', count: 1 },
      { state: 'Blocked', count: 1 },
      { state: 'Starved', count: 2 },
      { state: 'Maintenance', count: 1 },
      { state: 'Running', count: 1 },
      { state: 'Idle', count: 1 },
      { state: 'Warp', count: 1 },
      { state: 'no-data', count: 1 },
    ]);
    expect(stateCounts([])).toEqual([]);
  });
});

describe('abnormalTone and worstTone (UX-7)', () => {
  it('gives the states that cost output their tone, the normal ones none', () => {
    expect(['Starved', 'Blocked', 'Stopped', 'Down'].map(abnormalTone)).toEqual([
      'warn',
      'caution',
      'alarm',
      'alarm',
    ]);
    expect(
      ['Running', 'Idle', 'Setup', 'PlannedStop', 'Maintenance', 'Off', 'Weird', undefined].map(
        abnormalTone,
      ),
    ).toEqual(Array.from({ length: 8 }, () => undefined));
  });

  it('picks alarm over caution over warn, and none from normal states', () => {
    expect(worstTone(['warn', undefined, 'alarm', 'caution'])).toBe('alarm');
    expect(worstTone(['warn', 'caution'])).toBe('caution');
    expect(worstTone([undefined, 'warn'])).toBe('warn');
    expect(worstTone([undefined, 'neutral', 'info'])).toBeUndefined();
    expect(worstTone([])).toBeUndefined();
  });
});
