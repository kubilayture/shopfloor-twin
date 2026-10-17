/**
 * Measures the in-control false-alarm run length of a rule set (ADR-0032; Phase 8 plan, #195),
 * with `spc-core` itself, by simulation.
 *
 * Each replication draws leak readings as the simulator does in control, normal(2.0, 0.45) Pa/min
 * at 0.001 Pa/min (whole steps: 2000 + 450·z rounded), estimates limit version 1 from the first
 * 20 subgroups of 5, and charts them with the rule set. The run length is the number of readings
 * after the baseline up to and including the reading that opens the first new (not baseline)
 * episode on any chart; replications without one within the horizon are censored and counted.
 *
 * It also prints, for comparison with probes P4b and P4c (review of PR #207): signalling readings
 * per 1,000 after the baseline, P(no new episode within 20 and 60 readings), and P(a signalling
 * reading in readings 120–139) without a drift and with +0.6 Pa/min from reading 120.
 *
 * Usage: node scripts/false-alarm-run-length.ts [replications=2000] [seed=195] [horizon=1000]
 */
import { DEFAULT_RULES, firstVersion, spcChart, type Reading, type RuleSet } from '../src/index.ts';

const [replications = 2000, seed = 195, horizon = 1000] = process.argv
  .slice(2)
  .map((arg) => Number(arg));

const BASELINE = 100;
const DRIFT_AT = 120;
const DRIFT_STEPS = 600;

/** mulberry32: a small seeded generator, so a run can be repeated exactly. */
function generator(start: number): () => number {
  let state = start >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number): number {
  let u = 0;
  while (u === 0) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

const toReadings = (values: readonly number[]): Reading[] =>
  values.map((value, i) => ({ key: String(i), epoch: 1, at: i * 1000, seq: i, pass: 1, value }));

interface Outcome {
  /** Readings after the baseline to the first new episode; `null` if none in the horizon. */
  readonly runLength: number | null;
  readonly newEpisodes: number;
  readonly signalling: Set<number>;
}

function evaluate(values: readonly number[], rules: RuleSet): Outcome {
  const readings = toReadings(values);
  const version = firstVersion(readings, { subgroupSize: 5, baselineSubgroups: 20 });
  if (version === null) throw new Error('no baseline');
  const chart = spcChart({ readings, versions: [version], rules, subgroupSize: 5 });
  const fresh = chart.episodes.filter((e) => !e.baseline && Number(e.key) >= BASELINE);
  const first = fresh.reduce<number | null>(
    (min, e) => (min === null || Number(e.key) < min ? Number(e.key) : min),
    null,
  );
  const signalling = new Set<number>();
  for (const points of Object.values(chart.points)) {
    for (const p of points) if (p.rules.length > 0) signalling.add(Number(p.key));
  }
  return {
    runLength: first === null ? null : first - BASELINE + 1,
    newEpisodes: fresh.length,
    signalling,
  };
}

const RULE_SETS: [string, RuleSet][] = [
  ['defaults: 1, 2, 5 on I and Xbar; 1 on MR and R', DEFAULT_RULES],
  [
    "P4b's '1,2,5 on I and Xbar' (no MR or R chart), to cross-check the probe",
    { I: [1, 2, 5], MR: [], Xbar: [1, 2, 5], R: [] },
  ],
  [
    "draft: 1, 2, 3, 5, 6 on I and Xbar; 1 on MR (P4b's 'plan default')",
    { I: [1, 2, 3, 5, 6], MR: [1], Xbar: [1, 2, 3, 5, 6], R: [] },
  ],
];

const started = performance.now();
for (const [name, rules] of RULE_SETS) {
  const random = generator(seed);
  const lengths: number[] = [];
  let censored = 0;
  let episodes = 0;
  let signalling = 0;
  let clean20 = 0;
  let clean60 = 0;
  let false20 = 0;
  let detected20 = 0;
  for (let r = 0; r < replications; r += 1) {
    const values = Array.from({ length: BASELINE + horizon }, () =>
      Math.round(2000 + 450 * gaussian(random)),
    );
    const outcome = evaluate(values, rules);
    if (outcome.runLength === null) censored += 1;
    else lengths.push(outcome.runLength);
    if (outcome.runLength === null || outcome.runLength > 20) clean20 += 1;
    if (outcome.runLength === null || outcome.runLength > 60) clean60 += 1;
    episodes += outcome.newEpisodes;
    signalling += [...outcome.signalling].filter((i) => i >= BASELINE).length;
    const inWindow = (set: Set<number>): boolean =>
      [...set].some((i) => i >= DRIFT_AT && i < DRIFT_AT + 20);
    if (inWindow(outcome.signalling)) false20 += 1;
    const drifted = values.map((v, i) => (i >= DRIFT_AT ? v + DRIFT_STEPS : v));
    if (inWindow(evaluate(drifted.slice(0, DRIFT_AT + 20), rules).signalling)) detected20 += 1;
  }
  lengths.sort((a, b) => a - b);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const quantile = (q: number): number => lengths[Math.floor(q * (lengths.length - 1))] ?? NaN;
  const perThousand = (n: number): string => ((1000 * n) / (replications * horizon)).toFixed(1);
  const share = (n: number): string => (n / replications).toFixed(2);
  console.log(`\n${name}`);
  console.log(
    `  run length to the first new episode (readings after the baseline): mean ${mean.toFixed(1)}, median ${String(quantile(0.5))}, 10 % ${String(quantile(0.1))}, 90 % ${String(quantile(0.9))}; censored at ${String(horizon)}: ${String(censored)} of ${String(replications)}`,
  );
  console.log(
    `  per 1,000 in-control readings: ${perThousand(episodes)} new episodes, ${perThousand(signalling)} signalling readings`,
  );
  console.log(
    `  P(no new episode within 20 readings) ${share(clean20)}, within 60 ${share(clean60)}`,
  );
  console.log(
    `  P(a signalling reading in readings 120–139): no drift ${share(false20)}, +0.6 Pa/min from 120 ${share(detected20)}`,
  );
}
console.log(
  `\n${String(replications)} replications, seed ${String(seed)}, horizon ${String(horizon)}, ${((performance.now() - started) / 1000).toFixed(0)} s`,
);
