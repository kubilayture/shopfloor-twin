import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { account, signOnAtTerminal } from '../../login.ts';
import { MesClient, SimulatorClient } from '../../../src/clients.ts';
import { percentile } from '../../../src/compare.ts';
import {
  judgeLatency,
  pageActivityProblems,
  pageValueProblems,
  snapshotAgreement,
  type Change,
  type Snapshot,
} from '../../../src/latency.ts';

/**
 * Phase 7 exit criterion 5, the live part (#178): during shift A of orders-01, an operator signs on
 * to Line A1's terminal through the UI (the crew row is checked by the reconciliation), sees the
 * order in progress, and its counts per operation change within 2 s of the cycles; then starts,
 * pauses (with a reason) and resumes their work on an operation, and signs off at the terminal.
 *
 * The truth is the simulator's `/ground-truth` (polled every 200 ms): per order and operation the
 * completed cycles (in, good, scrap, rework) as the ground truth books them at cycle completion,
 * at the midpoint of the poll that first saw them. The page records each `terminal-counts-<order>-
 * <operation>` change itself every 20 ms. Judged with the latency judge and its value floors, as
 * the OEE dashboard (1-oee-live.spec.ts): `seenWithin`, at most 5 % of page values the polls never
 * saw, 95 % of the snapshots agreeing with the truth around their moment, every key agreeing once.
 */
const LIMIT_MS = 2_000;
const SAMPLE_MS = Number(process.env.TERMINAL_SAMPLE_MS ?? 90_000);
const POLL_MS = 200;
const SNAPSHOT_MS = 1_000;
/** The terminal push is paced to one view per 500 ms per topic (docs/api/realtime.md). */
const PACING_MS = 2_000;
const SEEN_WITHIN_MS = 5_000;
const MAX_UNOBSERVED = 0.05;
const MIN_AGREEMENT = 0.95;
const MIN_CHANGES = 20;
const WORK_CENTER = 'line-a1';

const simUrl = process.env.RECONCILE_SIM_URL ?? '';
/** The control API's token (#237): the run passes it with the address. */
const simToken = process.env.RECONCILE_SIM_TOKEN ?? '';
const mesUrl = process.env.RECONCILE_MES_URL ?? '';
const results = process.env.RECONCILE_RESULTS;
/** The order in progress at Line A1 while this runs (orders-01: PO-2610-005, 150 VB-100). */
const orderId = process.env.RECONCILE_TERMINAL_ORDER ?? 'PO-2610-005';
/** The operation the operator starts, pauses and resumes. */
const workOperation = process.env.RECONCILE_TERMINAL_OPERATION ?? 'OP30';

declare global {
  interface Window {
    /** Every change of a terminal count, recorded in the page: key, value, wall time. */
    __countLog?: { key: string; value: string; at: number }[];
  }
}

test('the terminal shows the order counts within 2 s of the cycles; an operator starts, pauses and resumes', async ({
  page,
}) => {
  test.skip(simUrl === '' || mesUrl === '', 'runs inside pnpm test:reconcile');
  test.setTimeout(SAMPLE_MS + 120_000);
  const operator = account('operator');
  const sim = new SimulatorClient(simUrl, simToken);

  // Sign on through the UI: a terminal session and the crew row (shift A runs).
  const cookie = await signOnAtTerminal(page, WORK_CENTER, operator);
  const mes = new MesClient(mesUrl, cookie);
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open', {
    timeout: 30_000,
  });
  // The current order, in progress here, with its Line A1 operations.
  await expect(page.getByTestId(`terminal-order-${orderId}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`terminal-order-status-${orderId}`)).toHaveText('in-progress');
  const view = await mes.terminal(WORK_CENTER);
  expect(view.crew.map((c) => c.username)).toContain(operator.username);
  const operations = [
    ...new Set(view.orders.flatMap((o) => o.operations.map((op) => op.operation))),
  ].sort();
  expect(operations).toEqual(['OP30', 'OP40', 'OP50']);

  await page.evaluate(() => {
    const log: { key: string; value: string; at: number }[] = [];
    const shown = new Map<string, string>();
    const parse = (text: string) =>
      (/in (\d+) · good (\d+) · scrap (\d+) · rework (\d+)/.exec(text)?.slice(1) ?? ['?']).join(
        '/',
      );
    const read = () => {
      for (const node of document.querySelectorAll('[data-testid^="terminal-counts-"]')) {
        const key = node.getAttribute('data-testid')?.slice('terminal-counts-'.length) ?? '';
        const value = parse(node.textContent);
        if (shown.get(key) !== value) {
          shown.set(key, value);
          log.push({ key, value, at: Date.now() });
        }
      }
    };
    read();
    window.__countLog = log;
    setInterval(read, 20);
  });

  // The truth: per order and Line A1 operation, the ground truth's completed cycles.
  const truth = new Map<string, Change[]>();
  const snapshots: Snapshot[] = [];
  const startedSampling = Date.now();
  const end = startedSampling + SAMPLE_MS;
  let nextSnapshot = startedSampling + SNAPSHOT_MS;
  let polls = 0;
  while (Date.now() < end) {
    const sent = Date.now();
    const ground = await sim.groundTruth();
    const polled = Math.round((sent + Date.now()) / 2);
    polls++;
    for (const [id, order] of Object.entries(ground.orders.orders)) {
      if (order.started === 0) continue;
      for (const operation of operations) {
        const q = order.operations[operation];
        const value = q
          ? `${String(q.in)}/${String(q.good)}/${String(q.scrap)}/${String(q.rework)}`
          : '0/0/0/0';
        const key = `${id}-${operation}`;
        const changes = truth.get(key) ?? [];
        if (changes.at(-1)?.state !== value) changes.push({ at: polled, state: value });
        truth.set(key, changes);
      }
    }
    if (Date.now() >= nextSnapshot) {
      nextSnapshot += SNAPSHOT_MS;
      const at = Date.now();
      const values = await page.evaluate(() => {
        const read: Record<string, string> = {};
        for (const node of document.querySelectorAll('[data-testid^="terminal-counts-"]')) {
          const key = node.getAttribute('data-testid')?.slice('terminal-counts-'.length) ?? '';
          read[key] = (
            /in (\d+) · good (\d+) · scrap (\d+) · rework (\d+)/
              .exec(node.textContent)
              ?.slice(1) ?? ['?']
          ).join('/');
        }
        return read;
      });
      snapshots.push({ at, values });
    }
    await sleep(POLL_MS);
  }
  const until = Date.now();
  // Sampling stayed inside the shift the operator signed on in (the paced clock at its end).
  const shiftEnd = Date.parse(view.shift?.end ?? '');
  const sampledUntil = (await sim.status()).simTime;
  const log = (await page.evaluate(() => window.__countLog)) ?? [];
  // A count the page showed for a key the truth never had (an order or operation of nothing).
  const unknownKeys = [...new Set(log.map((s) => s.key))].filter((key) => !truth.has(key));
  const keys = [...truth.keys()].filter((key) => log.some((s) => s.key === key));
  const shown = new Map<string, Change[]>(
    keys.map((key) => [
      key,
      log.filter((s) => s.key === key).map((s) => ({ at: s.at, state: s.value })),
    ]),
  );
  // Every active order of the truth is on the page.
  const missing = [...truth.keys()].filter((key) => !keys.includes(key));
  const judged = new Map(keys.map((key) => [key, (truth.get(key) ?? []).slice(1)]));
  const observed = new Map(keys.map((key) => [key, new Set(truth.get(key)?.map((c) => c.state))]));
  const result = judgeLatency(judged, shown, until, LIMIT_MS, {
    seenWithin: { truth, windowMs: SEEN_WITHIN_MS },
  });
  const activity = pageActivityProblems(result.measured, shown);
  const pageSnapshots = snapshots.map((s) => ({
    at: s.at,
    values: Object.fromEntries(Object.entries(s.values).filter(([key]) => keys.includes(key))),
  }));
  const agreement = snapshotAgreement(pageSnapshots, truth, PACING_MS, 500);
  const values = pageValueProblems(shown, observed, agreement, {
    maxUnobserved: MAX_UNOBSERVED,
    minAgreement: MIN_AGREEMENT,
  });
  const latencies = result.measured.flatMap((m) =>
    m.latencyMs === undefined ? [] : [m.latencyMs],
  );

  // Start, pause with a reason, resume: the operator's work on an operation of the order.
  const op = `${orderId}-${workOperation}`;
  const state = page.getByTestId(`terminal-op-state-${op}`);
  await page.getByTestId(`terminal-start-${op}`).click();
  await expect(state).toContainText('You: working');
  await page.getByTestId(`terminal-pause-${op}`).click();
  await page.getByTestId(`terminal-reason-${op}-material`).click();
  await page.getByTestId(`terminal-pause-confirm-${op}`).click();
  await expect(state).toContainText('You: paused (');
  await page.getByTestId(`terminal-resume-${op}`).click();
  await expect(state).toContainText('You: working');
  const activities = (await mes.terminal(WORK_CENTER)).orders
    .find((o) => o.order.id === orderId)
    ?.operations.find((o) => o.operation === workOperation)?.activities;
  expect(activities?.map((a) => [a.username, a.kind])).toEqual([[operator.username, 'work']]);
  // Sign off at the terminal: the crew row and the open work interval end, the session too.
  await page.getByTestId('terminal-sign-off').click();
  await expect(page.getByTestId('terminal-username')).toBeVisible();
  await expect(page.getByTestId('terminal-username')).toHaveValue('');

  const summary = {
    orderId,
    operations,
    sampleMs: SAMPLE_MS,
    sampledMs: until - startedSampling,
    polls,
    limitMs: LIMIT_MS,
    keys,
    missing,
    unknownKeys,
    shiftEnd: view.shift?.end ?? null,
    sampledUntil,
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
    pageValues: values.transitions,
    unobservedPageValues: values.unobserved,
    snapshots: {
      count: snapshots.length,
      compared: agreement.compared,
      matched: agreement.matched,
      mismatches: agreement.mismatches,
    },
    activityProblems: activity,
    valueProblems: values.problems,
    violations: result.violations,
    work: { operation: workOperation, actions: ['start', 'pause', 'resume'] },
  };
  console.log(`terminal latency: ${JSON.stringify(summary)}`);
  if (results) {
    await writeFile(join(results, 'terminal-latency.json'), JSON.stringify(summary, null, 2));
  }

  expect(missing, 'orders of the truth missing on the terminal').toEqual([]);
  expect(unknownKeys, 'terminal counts of keys the truth never had').toEqual([]);
  expect(Date.parse(sampledUntil)).toBeLessThan(shiftEnd);
  expect(result.violations, 'count changes the terminal did not show within 2 s').toEqual([]);
  expect(activity, 'the terminal did not follow the changes').toEqual([]);
  expect(result.measured.length).toBeGreaterThanOrEqual(MIN_CHANGES);
  expect(values.problems, 'the terminal did not show the truth’s counts').toEqual([]);
});
