/**
 * Reason-code coverage of the golden week (#119, Phase 5 exit criterion 4): every (state, cause)
 * pair the simulator emits is in the cause vocabulary of `@shopfloor/contracts` (or carries no
 * cause), and the auto-classification rules of `config/plant/reasons.yaml` give each a reason other
 * than UNCODED. Running is no downtime and needs no reason.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UNCODED, classifyCause, plantCauses, type PlantConfig } from '@shopfloor/plant-config';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDefaultConfig } from '../plant/testing.ts';
import { runHeadless } from './run.ts';

const GOLDEN = resolve(import.meta.dirname, '../../golden/week-01');

let config: PlantConfig;

beforeAll(async () => {
  config = await loadDefaultConfig();
});

describe('reason codes over the golden week (#119)', () => {
  it('codes every (state, cause) pair the simulator emits, none as UNCODED', async () => {
    const scenario = JSON.parse(await readFile(resolve(GOLDEN, 'scenario.json'), 'utf8')) as {
      seed: number;
      start: string;
      days: number;
    };
    const start = Temporal.Instant.from(scenario.start).epochMilliseconds;
    const pairs = new Map<string, { state: string; cause: string | null; count: number }>();
    runHeadless(
      { config, seed: scenario.seed, start, end: start + scenario.days * 86_400_000 },
      (line) => {
        const event = JSON.parse(line) as { type?: string; to?: string; cause?: string };
        if (event.type !== 'state' || event.to === undefined) return;
        const cause = event.cause ?? null;
        const key = `${event.to}|${cause ?? ''}`;
        const pair = pairs.get(key) ?? { state: event.to, cause, count: 0 };
        pair.count++;
        pairs.set(key, pair);
      },
    );
    const vocabulary = new Set(plantCauses(config).map((p) => `${p.state}|${p.cause ?? ''}`));
    const emitted = [...pairs.values()].filter((pair) => pair.state !== 'Running');
    // The vocabulary is complete: every cause the simulator gave is listed there.
    expect(
      emitted.filter((p) => p.cause !== null && !vocabulary.has(`${p.state}|${p.cause}`)),
    ).toEqual([]);
    const coded = emitted.map((pair) => ({
      ...pair,
      reason: classifyCause(config.reasons.rules, pair.state, pair.cause),
    }));
    expect(coded.filter((pair) => pair.reason === UNCODED)).toEqual([]);
    // The golden week has breakdowns, minor stops, setups, starvation and blocking.
    expect(new Set(coded.map((pair) => pair.state))).toEqual(
      new Set(['Off', 'Idle', 'Stopped', 'Starved', 'Blocked', 'Setup', 'Down', 'PlannedStop']),
    );
    expect(coded.length).toBe(17);
  });
});
