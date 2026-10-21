// End to end through Vitest: the probe workspace (`fixtures/probe`) registers the pair as the nine
// workspaces do, and each test here runs it in a child Vitest with a chosen `FC_SEED`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ProbeRecord } from '../fixtures/probe/probe.test.ts';

const packageDir = join(import.meta.dirname, '..');
const probeDir = join(packageDir, 'fixtures', 'probe');
const vitestBin = join(packageDir, 'node_modules', '.bin', 'vitest');
const scratch = mkdtempSync(join(tmpdir(), 'fc-seed-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface ProbeRun {
  status: number | null;
  output: string;
  record: ProbeRecord | undefined;
}

let runs = 0;
function runProbe(fcSeed: string | undefined): ProbeRun {
  const out = join(scratch, `probe-${String((runs += 1))}.json`);
  // The child is a fresh Vitest: none of this worker's Vitest variables, and FC_SEED only if given.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST') && key !== 'FC_SEED'),
  );
  const child = spawnSync(vitestBin, ['run', '--root', probeDir], {
    cwd: probeDir,
    encoding: 'utf8',
    env: {
      ...env,
      FC_PROBE_OUT: out,
      NO_COLOR: '1',
      ...(fcSeed === undefined ? {} : { FC_SEED: fcSeed }),
    },
  });
  return {
    status: child.status,
    output: `${child.stdout}${child.stderr}`,
    record: existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as ProbeRecord) : undefined,
  };
}

/** The seed lines a run printed. */
const seedLines = (output: string): string[] =>
  output.split('\n').filter((line) => line.startsWith('fast-check seed '));

/** What fast-check generates from `seed`, computed here independently of the probe. */
const fromSeed = (seed: number): number[] => fc.sample(fc.integer(), { numRuns: 10, seed });

describe('a pinned FC_SEED', () => {
  let first: ProbeRun;
  let second: ProbeRun;
  beforeAll(() => {
    first = runProbe('424242');
    second = runProbe('424242');
  });

  test('prints one seed line for the workspace and run', () => {
    expect(first.status, first.output).toBe(0);
    expect(seedLines(first.output)).toEqual([
      'fast-check seed probe: 424242 (FC_SEED=424242 reproduces)',
    ]);
  });

  test('is applied: the probe generates exactly what that seed generates', () => {
    expect(first.record?.globalSeed).toBe(424242);
    expect(first.record?.asserted).toEqual(fromSeed(424242));
    expect(first.record?.sampled).toEqual(fromSeed(424242));
  });

  test('gives the same generated values in a second run', () => {
    expect(second.status, second.output).toBe(0);
    expect(second.record).toEqual(first.record);
  });

  test('another seed gives other values', () => {
    const other = runProbe('7');
    expect(seedLines(other.output)).toEqual(['fast-check seed probe: 7 (FC_SEED=7 reproduces)']);
    expect(other.record?.asserted).toEqual(fromSeed(7));
    expect(other.record?.asserted).not.toEqual(first.record?.asserted);
  });
});

describe('without FC_SEED', () => {
  test('a drawn seed is printed, applied and reproduces the run', () => {
    const drawn = runProbe(undefined);
    expect(drawn.status, drawn.output).toBe(0);
    const [line] = seedLines(drawn.output);
    const match = /^fast-check seed probe: (\d+) \(FC_SEED=(\d+) reproduces\)$/.exec(line ?? '');
    expect(match, drawn.output).not.toBeNull();
    const seed = Number(match?.[1]);
    expect(match?.[2]).toBe(match?.[1]);
    expect(drawn.record?.globalSeed).toBe(seed);
    expect(drawn.record?.asserted).toEqual(fromSeed(seed));

    const replay = runProbe(String(seed));
    expect(replay.record).toEqual(drawn.record);
  });
});

describe('an explicit seed on the call', () => {
  test('still wins over the global seed', () => {
    const a = runProbe('424242');
    const b = runProbe('99');
    expect(a.record?.explicit).toEqual(fromSeed(156));
    expect(b.record?.explicit).toEqual(fromSeed(156));
    expect(a.record?.sampled).not.toEqual(b.record?.sampled);
  });
});

describe('an invalid FC_SEED', () => {
  test.each(['abc', '1.5', '4294967296'])('%s fails the run before any test', (value) => {
    const run = runProbe(value);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('FC_SEED must be an integer');
    expect(run.record).toBeUndefined();
  });
});
