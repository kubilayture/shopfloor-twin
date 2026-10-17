import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { logIn } from './login.ts';
import { SimulatorClient } from '../src/clients.ts';
import { percentile } from '../src/compare.ts';
import { judgeLatency, pageActivityProblems, type Change } from '../src/latency.ts';

/** Exit criterion 3: each machine's latest state within 2 s of the simulator taking it. */
const LIMIT_MS = 2_000;
/** Must end before the shift does (about 470 s after the start at 60×). */
const SAMPLE_MS = Number(process.env.OVERVIEW_SAMPLE_MS ?? 90_000);
const POLL_MS = 200;

const simUrl = process.env.RECONCILE_SIM_URL;
const results = process.env.RECONCILE_RESULTS;

declare global {
  interface Window {
    /** Every change of a state badge, recorded in the page: machine, state, wall time. */
    __stateLog?: { machine: string; state: string; at: number }[];
  }
}

test('the overview shows every machine’s latest state within 2 s at 60×', async ({ page }) => {
  test.skip(!simUrl, 'runs inside pnpm test:reconcile, which starts the stack');
  test.setTimeout(SAMPLE_MS + 90_000);
  const sim = new SimulatorClient(simUrl ?? '');

  await logIn(page);
  await page.goto('/');
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open', {
    timeout: 30_000,
  });
  const machines = Object.keys((await sim.groundTruth()).current).sort();
  for (const id of machines) {
    await expect(page.getByTestId(`state-${id}`)).not.toHaveAttribute('data-state', 'no-data');
  }

  // The page records each badge change itself (every 20 ms), so the measured delay doesn't depend
  // on how often this test asks. Page and test share the host's wall clock.
  await page.evaluate((ids) => {
    const log: { machine: string; state: string; at: number }[] = [];
    const shown = new Map<string, string>();
    const read = () => {
      for (const id of ids) {
        const state =
          document.querySelector(`[data-testid="state-${id}"]`)?.getAttribute('data-state') ??
          'missing';
        if (shown.get(id) !== state) {
          shown.set(id, state);
          log.push({ machine: id, state, at: Date.now() });
        }
      }
    };
    read();
    window.__stateLog = log;
    setInterval(read, 20);
  }, machines);

  // The truth: the simulator's current state per machine. A change's wall time is when the paced
  // simulation clock reached its `since`, from one /ground-truth answer: wall = midpoint of the
  // request + (since − pacedTime) / speed. (Its `simTime`, the processed time, can trail the paced
  // clock by up to a second of wall time between events, which would shorten measured delays.)
  const truth = new Map<string, Change[]>(machines.map((id) => [id, []]));
  const known = new Map<string, string>();
  const { speed } = await sim.status();
  const end = Date.now() + SAMPLE_MS;
  let first = true;
  while (Date.now() < end) {
    const sent = Date.now();
    const ground = await sim.groundTruth();
    const polled = (sent + Date.now()) / 2;
    for (const id of machines) {
      const current = ground.current[id];
      if (!current) continue;
      const key = `${current.state}@${current.since}`;
      if (known.get(id) === key) continue;
      known.set(id, key);
      if (first) continue; // the state when sampling started is not a change
      const at = polled + (Date.parse(current.since) - Date.parse(ground.pacedTime)) / speed;
      truth.get(id)?.push({ at: Math.round(at), state: current.state });
    }
    first = false;
    await sleep(POLL_MS);
  }
  const until = Date.now();
  const log = (await page.evaluate(() => window.__stateLog)) ?? [];
  const shown = new Map<string, Change[]>(
    machines.map((id) => [id, log.filter((s) => s.machine === id)]),
  );
  const result = judgeLatency(truth, shown, until, LIMIT_MS);
  const activity = pageActivityProblems(result.measured, shown);
  const latencies = result.measured.flatMap((m) =>
    m.latencyMs === undefined ? [] : [m.latencyMs],
  );
  const summary = {
    sampleMs: SAMPLE_MS,
    limitMs: LIMIT_MS,
    changes: result.measured.length,
    unjudged: result.unjudged,
    latencyMs:
      latencies.length === 0
        ? null
        : {
            max: Math.max(...latencies),
            p95: percentile(latencies, 95),
            p50: percentile(latencies, 50),
          },
    perMachine: Object.fromEntries(
      machines.map((id) => [id, result.measured.filter((m) => m.machine === id).length]),
    ),
    pageTransitions: Object.fromEntries(
      machines.map((id) => [id, Math.max(0, (shown.get(id)?.length ?? 0) - 1)]),
    ),
    activityProblems: activity,
    violations: result.violations,
  };
  console.log(`overview latency: ${JSON.stringify(summary)}`);
  if (results)
    await writeFile(join(results, 'overview-latency.json'), JSON.stringify(summary, null, 2));
  expect(result.violations, 'state changes the page did not show within 2 s').toEqual([]);
  // A page that never updates could match changes back to the state it shows; it must be live.
  expect(activity, 'the page did not follow the changes').toEqual([]);
  // A meaningful sample: state changes on most machines.
  expect(result.measured.length).toBeGreaterThanOrEqual(20);
});
