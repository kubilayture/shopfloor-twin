import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { MesClient } from '../src/clients.ts';
import { percentile } from '../src/compare.ts';
import {
  judgeLatency,
  pageActivityProblems,
  snapshotAgreement,
  type Change,
  type Snapshot,
} from '../src/latency.ts';

/**
 * Phase 5 exit criterion 5 (#123): the OEE dashboard shows the API's current-shift values and
 * follows a change within 2 s at 60×. The truth is `GET /api/v1/shifts/{date}/{shift}/oee`, polled
 * every 100 ms; the page records each work-center card's and machine row's `data-oee` every 20 ms.
 */
const LIMIT_MS = 2_000;
/** Must end before the shift does, with the overview's sampling (both run during shift A). */
const SAMPLE_MS = Number(process.env.OEE_SAMPLE_MS ?? 90_000);
const POLL_MS = 100;
/** Page snapshots compared with the API: one every this many ms. */
const SNAPSHOT_MS = 2_000;
/** The push sends at most one delta a second per topic (docs/api/realtime.md). */
const PACING_MS = 2_000;
/** At least this many judged changes per work-center card, and in all. */
const MIN_CARD_CHANGES = 20;
const MIN_CHANGES = 100;
/** The share of page values the polls never saw (held between two polls), at most. */
const MAX_UNOBSERVED = 0.2;
/** Snapshot values equal to an API value around their moment, at least. */
const MIN_AGREEMENT = 0.95;

const mesUrl = process.env.RECONCILE_MES_URL;
const results = process.env.RECONCILE_RESULTS;

declare global {
  interface Window {
    /** Every change of a card's or row's `data-oee`, recorded in the page: id, value, wall time. */
    __oeeLog?: { id: string; value: string; at: number }[];
  }
}

test('the OEE dashboard shows the API’s shift values and each change within 2 s at 60×', async ({
  page,
}) => {
  test.skip(!mesUrl, 'runs inside pnpm test:reconcile, which starts the stack');
  test.setTimeout(SAMPLE_MS + 90_000);
  const mes = new MesClient(mesUrl ?? '');

  const current = await mes.currentShift();
  const shiftKey = current.shiftKey;
  const shiftEnd = Date.parse(current.shift?.end ?? '');
  if (shiftKey === null || current.shift === null) throw new Error('no current shift');
  // Right after 06:00 no machine has data yet: wait until every one has.
  let first = await mes.shiftOee(shiftKey);
  await expect
    .poll(
      async () => {
        first = await mes.shiftOee(shiftKey);
        return [first.workCenters.length, first.equipment.length];
      },
      { timeout: 30_000 },
    )
    .toEqual([2, 6]);
  const workCenters = first.workCenters.map((b) => b.id).sort();
  const machines = first.equipment.map((b) => b.id).sort();
  // All of them, so the comparisons below cover every card and every machine row.
  expect([workCenters.length, machines.length]).toEqual([2, 6]);
  const testIds = new Map([
    ...workCenters.map((id) => [id, `oee-card-${id}`] as const),
    ...machines.map((id) => [id, `oee-machine-${id}`] as const),
  ]);

  await page.goto('/oee');
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open', {
    timeout: 30_000,
  });
  for (const testId of testIds.values()) {
    await expect(page.getByTestId(testId)).toHaveAttribute('data-oee', /./, { timeout: 30_000 });
  }

  // The page records each value change itself (every 20 ms), so the measured delay doesn't depend
  // on how often this test asks. Page and test share the host's wall clock.
  await page.evaluate(
    (entries) => {
      const log: { id: string; value: string; at: number }[] = [];
      const shown = new Map<string, string>();
      const read = () => {
        for (const [id, testId] of entries) {
          const value =
            document.querySelector(`[data-testid="${testId}"]`)?.getAttribute('data-oee') ??
            'missing';
          if (shown.get(id) !== value) {
            shown.set(id, value);
            log.push({ id, value, at: Date.now() });
          }
        }
      };
      read();
      window.__oeeLog = log;
      setInterval(read, 20);
    },
    [...testIds],
  );

  // The truth: the API's four-decimal OEE per id, at the midpoint of the request that saw it.
  const ids = [...testIds.keys()];
  const api = new Map<string, Change[]>(ids.map((id) => [id, []]));
  const snapshots: Snapshot[] = [];
  const end = Date.now() + SAMPLE_MS;
  let nextSnapshot = Date.now() + SNAPSHOT_MS;
  let polls = 0;
  while (Date.now() < end) {
    const sent = Date.now();
    const oee = await mes.shiftOee(shiftKey);
    const polled = Math.round((sent + Date.now()) / 2);
    polls++;
    for (const bucket of [...oee.workCenters, ...oee.equipment]) {
      const changes = api.get(bucket.id);
      const value = bucket.result.oee?.decimal ?? 'n/a';
      if (changes && changes.at(-1)?.state !== value) changes.push({ at: polled, state: value });
    }
    if (Date.now() >= nextSnapshot) {
      nextSnapshot += SNAPSHOT_MS;
      const at = Date.now();
      const values = await page.evaluate(
        (entries) => {
          const read: Record<string, string> = {};
          for (const [id, testId] of entries) {
            read[id] =
              document.querySelector(`[data-testid="${testId}"]`)?.getAttribute('data-oee') ??
              'missing';
          }
          return read;
        },
        [...testIds],
      );
      snapshots.push({ at, values });
    }
    await sleep(POLL_MS);
  }
  const until = Date.now();
  // Sampling stayed inside the shift: its OEE is the one the page shows by default.
  const watermark = (await mes.plant()).clock?.watermark ?? '';
  expect(Date.parse(watermark)).toBeLessThan(shiftEnd);

  const log = (await page.evaluate(() => window.__oeeLog)) ?? [];
  const shown = new Map<string, Change[]>(
    ids.map((id) => [
      id,
      log.filter((s) => s.id === id).map((s) => ({ at: s.at, state: s.value })),
    ]),
  );
  // The first value seen is the state when sampling started, not a change.
  const truth = new Map(ids.map((id) => [id, (api.get(id) ?? []).slice(1)]));
  const observed = new Map(ids.map((id) => [id, new Set(api.get(id)?.map((c) => c.state))]));
  const result = judgeLatency(truth, shown, until, LIMIT_MS, { observed });
  // The push is paced (one delta a second per topic), the API changes about twice a second: the
  // page must still change at least a quarter as often as the API, and on every id.
  const activity = pageActivityProblems(result.measured, shown, 0.25);
  const transitions = ids.flatMap((id) =>
    (shown.get(id) ?? []).slice(1).map((sample) => ({ id, value: sample.state })),
  );
  const unobserved = transitions.filter((t) => observed.get(t.id)?.has(t.value) !== true).length;
  const agreement = snapshotAgreement(snapshots, api, PACING_MS, 500);
  const latencies = result.measured.flatMap((m) =>
    m.latencyMs === undefined ? [] : [m.latencyMs],
  );
  const perId = Object.fromEntries(
    ids.map((id) => [id, result.measured.filter((m) => m.machine === id).length]),
  );
  const summary = {
    shiftKey,
    sampleMs: SAMPLE_MS,
    limitMs: LIMIT_MS,
    polls,
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
    perId,
    pageTransitions: Object.fromEntries(
      ids.map((id) => [id, Math.max(0, (shown.get(id)?.length ?? 0) - 1)]),
    ),
    unobservedPageValues: unobserved,
    snapshots: {
      count: snapshots.length,
      compared: agreement.compared,
      matched: agreement.matched,
      matchedPerKey: agreement.matchedPerKey,
      mismatches: agreement.mismatches,
    },
    activityProblems: activity,
    violations: result.violations,
  };
  console.log(`OEE dashboard latency: ${JSON.stringify(summary)}`);
  if (results) await writeFile(join(results, 'oee-latency.json'), JSON.stringify(summary, null, 2));

  expect(result.violations, 'OEE changes the page did not show within 2 s').toEqual([]);
  expect(activity, 'the page did not follow the changes').toEqual([]);
  // A meaningful sample: changes on both cards, and many in all.
  for (const id of workCenters) expect(perId[id] ?? 0).toBeGreaterThanOrEqual(MIN_CARD_CHANGES);
  expect(result.measured.length).toBeGreaterThanOrEqual(MIN_CHANGES);
  // The page's values are the API's: few that the polls missed, and the snapshots agree.
  expect(unobserved).toBeLessThanOrEqual(transitions.length * MAX_UNOBSERVED);
  expect(agreement.matched).toBeGreaterThanOrEqual(agreement.compared * MIN_AGREEMENT);
  for (const id of ids) expect(agreement.matchedPerKey[id] ?? 0).toBeGreaterThan(0);
});
