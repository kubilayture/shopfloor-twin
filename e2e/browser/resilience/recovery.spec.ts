import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { logIn } from '../login.ts';
import { SimulatorClient } from '../../src/clients.ts';
import { judgeLatency, type Change } from '../../src/latency.ts';

/**
 * The resilience suite's recovery checks in the browser (#243, Phase 9 plan "Resilience suite",
 * "Recovery checks (all runs)"): the overview stays open through a whole run while
 * e2e/src/resilience.ts drives its faults. After each fault the harness appends a mark to
 * RESILIENCE_MARKS (one JSON line: the fault, `readyAt` when every service was ready again and
 * `caughtUpAt` when the MES had caught up with the simulator, both host wall ms), and a last line
 * `{ "done": true }`. For each mark:
 *
 * - the web reconnects its WebSocket: the page's connection status is `open` again within 30 s of
 *   `readyAt` (the live client's backoff is capped at 15 s, jittered up to about 19 s); a fault
 *   that never dropped the socket counts as open at `readyAt`;
 * - the overview is current within 2 s: from `ref`, the later of the reconnect and `caughtUpAt`,
 *   every machine's badge shows the simulator's state at `ref` (or a later one) within 2 s;
 * - live push resumes: every state change the simulator takes in the 15 s after `ref` (longer, up
 *   to 60 s, until it changed at least once: a recovery in a break has nothing to push at first)
 *   is shown within 2 s (the overview's own rule, e2e/src/latency.ts), at least one change judged.
 *
 * The page records its badges and its connection status itself every 20 ms. Results go to
 * RECONCILE_RESULTS/recovery.json.
 */
const LIMIT_MS = 2_000;
const RECONNECT_MS = 30_000;
const SAMPLE_MS = 15_000;
/**
 * The sample goes on past 15 s until the truth has changed at least once after `ref`, up to this
 * long: a recovery inside a break (every machine in PlannedStop) has nothing to push for a while.
 */
const SAMPLE_MAX_MS = 60_000;
const POLL_MS = 200;

const simUrl = process.env.RECONCILE_SIM_URL;
const simToken = process.env.RECONCILE_SIM_TOKEN ?? '';
const marksFile = process.env.RESILIENCE_MARKS;
const results = process.env.RECONCILE_RESULTS;
/** The longest a run may take (the harness's deadline is shorter). */
const RUN_MS = Number(process.env.RESILIENCE_BROWSER_MS ?? 40 * 60_000);

interface Mark {
  readonly fault?: string;
  readonly readyAt?: number;
  readonly caughtUpAt?: number;
  readonly done?: boolean;
}

declare global {
  interface Window {
    __stateLog?: { machine: string; state: string; at: number }[];
    __statusLog?: { status: string; at: number }[];
  }
}

async function readMarks(): Promise<Mark[]> {
  const text = await readFile(marksFile ?? '', 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Mark);
}

/** The value in effect at `at` of a log in time order (the last one at or before it). */
function valueAt<T extends { at: number }>(log: readonly T[], at: number): T | undefined {
  let found: T | undefined;
  for (const entry of log) {
    if (entry.at > at) break;
    found = entry;
  }
  return found;
}

test('after every fault the overview reconnects, is current within 2 s and stays live', async ({
  page,
}) => {
  test.skip(!simUrl || !marksFile, 'runs inside pnpm test:resilience, which starts the stack');
  test.setTimeout(RUN_MS);
  const sim = new SimulatorClient(simUrl ?? '', simToken);

  await logIn(page);
  await page.goto('/');
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open', {
    timeout: 30_000,
  });
  const machines = Object.keys((await sim.groundTruth()).current).sort();
  for (const id of machines) {
    await expect(page.getByTestId(`state-${id}`)).not.toHaveAttribute('data-state', 'no-data');
  }
  await page.evaluate((ids) => {
    const states: { machine: string; state: string; at: number }[] = [];
    const statuses: { status: string; at: number }[] = [];
    const shown = new Map<string, string>();
    let status = '';
    const read = () => {
      const now = Date.now();
      for (const id of ids) {
        const state =
          document.querySelector(`[data-testid="state-${id}"]`)?.getAttribute('data-state') ??
          'missing';
        if (shown.get(id) !== state) {
          shown.set(id, state);
          states.push({ machine: id, state, at: now });
        }
      }
      const current =
        document.querySelector('[data-testid="connection-status"]')?.getAttribute('data-status') ??
        'missing';
      if (current !== status) {
        status = current;
        statuses.push({ status, at: now });
      }
    };
    read();
    window.__stateLog = states;
    window.__statusLog = statuses;
    setInterval(read, 20);
  }, machines);

  const { speed } = await sim.status();
  const outcomes: Record<string, unknown>[] = [];
  const problems: string[] = [];
  let handled = 0;
  const deadline = Date.now() + RUN_MS - 60_000;
  for (;;) {
    const mark = (await readMarks())[handled];
    if (mark?.done === true) break;
    if (mark === undefined) {
      if (Date.now() > deadline) throw new Error('the harness never wrote its last mark');
      await sleep(250);
      continue;
    }
    handled++;
    const fault = mark.fault ?? `mark ${String(handled)}`;
    const readyAt = mark.readyAt ?? Date.now();
    const caughtUpAt = mark.caughtUpAt ?? readyAt;
    // The truth from now on, as wall-clock changes per machine (the overview spec's rule).
    const truth = new Map<string, Change[]>(machines.map((id) => [id, []]));
    const known = new Map<string, string>();
    let openAt: number | undefined;
    let ref: number | undefined;
    let sampleEnd = 0;
    for (;;) {
      const sent = Date.now();
      const ground = await sim.groundTruth();
      const polled = (sent + Date.now()) / 2;
      for (const id of machines) {
        const current = ground.current[id];
        if (!current) continue;
        const key = `${current.state}@${current.since}`;
        if (known.get(id) === key) continue;
        known.set(id, key);
        const at = polled + (Date.parse(current.since) - Date.parse(ground.pacedTime)) / speed;
        truth.get(id)?.push({ at: Math.round(at), state: current.state });
      }
      if (openAt === undefined) {
        const statuses = (await page.evaluate(() => window.__statusLog)) ?? [];
        const atReady = valueAt(statuses, readyAt);
        openAt =
          atReady?.status === 'open' && !statuses.some((s) => s.at > readyAt && s.status !== 'open')
            ? readyAt
            : statuses.find((s) => s.at >= readyAt && s.status === 'open')?.at;
        if (openAt !== undefined) ref = Math.max(openAt, caughtUpAt);
      }
      if (ref !== undefined) {
        const reference = ref;
        const changed = [...truth.values()].some((list) => list.some((c) => c.at > reference));
        const enough = Date.now() >= ref + SAMPLE_MS + LIMIT_MS;
        if (enough && (changed || Date.now() >= ref + SAMPLE_MAX_MS)) {
          sampleEnd = Date.now() - LIMIT_MS;
          break;
        }
      }
      if (ref === undefined && Date.now() > readyAt + RECONNECT_MS) break;
      await sleep(POLL_MS);
    }
    if (openAt === undefined || ref === undefined) {
      problems.push(`${fault}: the WebSocket did not reconnect within ${String(RECONNECT_MS)} ms`);
      outcomes.push({ fault, readyAt, caughtUpAt, reconnected: false });
      continue;
    }
    const reference = ref;
    const until = sampleEnd + LIMIT_MS;
    // At `ref` each machine is expected in the state the truth held then (when the first reading,
    // taken once the mark arrived, found that state already held), and then every change.
    const judged = new Map<string, Change[]>(
      machines.map((id) => {
        const changes = truth.get(id) ?? [];
        const atRef = valueAt(changes, reference);
        return [
          id,
          [
            ...(atRef ? [{ at: reference, state: atRef.state }] : []),
            ...changes.filter((c) => c.at > reference && c.at <= sampleEnd),
          ],
        ];
      }),
    );
    const log = (await page.evaluate(() => window.__stateLog)) ?? [];
    const shown = new Map<string, Change[]>(
      machines.map((id) => [id, log.filter((s) => s.machine === id)]),
    );
    const result = judgeLatency(judged, shown, until, LIMIT_MS);
    const synthetic = machines.filter((id) => valueAt(truth.get(id) ?? [], reference)).length;
    const changes = result.measured.length - synthetic;
    const latencies = result.measured.flatMap((m) =>
      m.latencyMs === undefined ? [] : [m.latencyMs],
    );
    const outcome = {
      fault,
      readyAt,
      caughtUpAt,
      openAt,
      reconnectMs: openAt - readyAt,
      ref: reference,
      sampledMs: sampleEnd - reference,
      currentMs: Math.max(
        0,
        ...result.measured.filter((m) => m.at === reference).map((m) => m.latencyMs ?? Infinity),
      ),
      changesJudged: changes,
      maxLatencyMs: latencies.length === 0 ? null : Math.max(...latencies),
      violations: result.violations,
    };
    outcomes.push(outcome);
    console.log(`recovery ${fault}: ${JSON.stringify(outcome)}`);
    if (openAt - readyAt > RECONNECT_MS) {
      problems.push(`${fault}: reconnected ${String(openAt - readyAt)} ms after readiness`);
    }
    // A machine whose state the first reading found changed after `ref` is judged by that change.
    const unjudged = machines.filter((id) => (judged.get(id) ?? []).length === 0);
    if (unjudged.length > 0) {
      problems.push(`${fault}: nothing of ${unjudged.join(', ')} to judge after ref`);
    }
    if (result.violations.length > 0) {
      problems.push(`${fault}: not shown within 2 s: ${JSON.stringify(result.violations)}`);
    }
    if (changes < 1) problems.push(`${fault}: no state change after the recovery to judge`);
  }
  const summary = { limitMs: LIMIT_MS, sampleMs: SAMPLE_MS, recoveries: outcomes, problems };
  if (results) await writeFile(join(results, 'recovery.json'), JSON.stringify(summary, null, 2));
  expect(problems).toEqual([]);
  expect(outcomes.length).toBeGreaterThan(0);
});
