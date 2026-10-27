import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { logIn } from './login.ts';
import { MesClient, SimulatorClient } from '../src/clients.ts';
import { percentile } from '../src/compare.ts';
import {
  heldWithin,
  judgeLatency,
  pageActivityProblems,
  pageValueProblems,
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
/**
 * Runs first in project `live`, from the shift's start (as in Phase 5), and must end before the
 * alarm check has to start: before the first injection, about 120 s after the resume.
 */
const SAMPLE_MS = Number(process.env.OEE_SAMPLE_MS ?? 90_000);
const POLL_MS = 100;
/** Page snapshots compared with the API: one every this many ms. */
const SNAPSHOT_MS = 2_000;
/** The push sends at most one delta a second per topic (docs/api/realtime.md). */
const PACING_MS = 2_000;
/**
 * A page value counts as seen by the polls only when the API held it within this of the sample
 * (#147): four-decimal OEE values repeat, so "seen anywhere in the run" took a transient value
 * the polls missed for a stale one. At least the snapshot window (`PACING_MS` before), so a page
 * lagging less still has its stale values judged as stale, and one lagging more fails the
 * snapshot agreement (unit tests in src/latency.test.ts). `MAX_UNOBSERVED` stays run-wide.
 */
const SEEN_WITHIN_MS = 5_000;
/** At least this many judged changes per work-center card, and in all. */
const MIN_CARD_CHANGES = 20;
const MIN_CHANGES = 100;
/**
 * The share of page values the polls never saw (held between two polls), at most. Real runs see
 * about 1 %; the judgement accepts such values whatever their age, so this floor must stay low.
 */
const MAX_UNOBSERVED = 0.05;
/** Snapshot values equal to an API value around their moment, at least. */
const MIN_AGREEMENT = 0.95;
/**
 * Page values whose bucket (#376: the decimal with the inputs the push carried) the API held around
 * their moment, at least. Real runs miss about 1 % by the decimal alone; a value is a new bucket
 * whenever its inputs move, so a push and a poll that disagreed on what a bucket is would leave
 * almost none seen and make every page value count as fresh.
 */
const MIN_IDENTIFIED = 0.9;

/** JSON with every object's keys sorted: the parsed poll and the raw frame may order them apart. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(',')}}`
      : JSON.stringify(value);

/** A bucket as the judgement tells values apart (#376): the decimal and the inputs it came from. */
const bucketKey = (value: string, inputs: unknown): string => `${value} ${canonical(inputs)}`;

const mesUrl = process.env.RECONCILE_MES_URL;
const simUrl = process.env.RECONCILE_SIM_URL;
/** The control API's token (#237): the run passes it with the address. */
const simToken = process.env.RECONCILE_SIM_TOKEN ?? '';
/**
 * Sampling also ends when the paced clock reaches this (simulation time; the first injection less
 * a margin, from reconcile.ts), so the alarm check after it starts in time in a slow environment.
 */
const sampleUntil = Date.parse(process.env.RECONCILE_OEE_UNTIL ?? '');
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
  const mes = new MesClient(mesUrl ?? '', await logIn(page));

  const current = await mes.currentShift();
  const shiftKey = current.shiftKey;
  const shiftEnd = Date.parse(current.shift?.end ?? '');
  if (shiftKey === null || current.shift === null) throw new Error('no current shift');
  // Right after 06:00 the shift has no buckets yet: wait until the API lists all eight.
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

  // Diagnostics (#147): when each value arrived on the WebSocket, to split a delay into the
  // MES's part (API → push) and the page's (push → DOM), and the context of every slow change
  // (above 1.3 s: the API's values and the pushed ones around it). Not judged.
  const frames: { id: string; at: number; state: string; key: string }[] = [];
  const pushed = new Map<string, Change[]>([...testIds.keys()].map((id) => [id, []]));
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const at = Date.now();
      const data = JSON.parse(payload) as {
        type?: string;
        topic?: string;
        shift?: {
          key: string;
          inputs: unknown;
          result: { oee: { decimal: string } | null };
        } | null;
      };
      if ((data.type !== 'oee' && data.type !== 'snapshot') || !data.topic?.startsWith('oee:')) {
        return;
      }
      // Only the work center and machine topics: the dashboard also holds `oee:line` (#233),
      // whose buckets carry no `result`.
      if (!testIds.has(data.topic.slice('oee:'.length))) return;
      if (data.shift?.key !== shiftKey) return;
      const changes = pushed.get(data.topic.slice('oee:'.length));
      const value = data.shift.result.oee?.decimal ?? 'n/a';
      frames.push({
        id: data.topic.slice('oee:'.length),
        at,
        state: value,
        key: bucketKey(value, data.shift.inputs),
      });
      if (changes && changes.at(-1)?.state !== value) changes.push({ at, state: value });
    });
  });
  await page.goto('/oee');
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open', {
    timeout: 30_000,
  });
  // Every card and row shows a value: four decimals, or `n/a` without planned busy time.
  for (const testId of testIds.values()) {
    await expect(page.getByTestId(testId)).toHaveAttribute('data-oee', /^(\d+\.\d{4}|n\/a)$/, {
      timeout: 30_000,
    });
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
  // The same polls by bucket (#376): a new entry whenever the bucket changed, its decimal or not.
  const apiBuckets = new Map<string, Change[]>(ids.map((id) => [id, []]));
  const snapshots: Snapshot[] = [];
  // The wall time the paced clock reaches `sampleUntil`, from one ground-truth answer.
  const startedSampling = Date.now();
  let end = startedSampling + SAMPLE_MS;
  let endedBy = 'OEE_SAMPLE_MS';
  if (simUrl && !Number.isNaN(sampleUntil)) {
    const sim = new SimulatorClient(simUrl, simToken);
    const { speed } = await sim.status();
    const sent = Date.now();
    const { pacedTime } = await sim.groundTruth();
    const polled = (sent + Date.now()) / 2;
    const deadline = polled + (sampleUntil - Date.parse(pacedTime)) / speed;
    if (deadline < end) {
      end = deadline;
      endedBy = 'RECONCILE_OEE_UNTIL';
    }
  }
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
      const buckets = apiBuckets.get(bucket.id);
      const key = bucketKey(value, bucket.inputs);
      if (buckets && buckets.at(-1)?.state !== key) buckets.push({ at: polled, state: key });
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
  // A page value is the bucket of the last push that carried it (#376): four-decimal values repeat
  // within the window as OEE moves down and up, so a fresh value the polls missed must not be taken
  // for the stale one of a second before (the page draws a push within about 20 ms).
  const identify = (id: string, sample: Change): string | undefined =>
    frames.filter((f) => f.id === id && f.state === sample.state && f.at <= sample.at).at(-1)?.key;
  const seenWithin = { truth: apiBuckets, windowMs: SEEN_WITHIN_MS, identify };
  const pageSamples = [...shown].flatMap(([id, samples]) =>
    samples.slice(1).map((sample) => ({ id, sample })),
  );
  const identified = pageSamples.filter(({ id, sample }) => {
    const key = identify(id, sample);
    return (
      key !== undefined && heldWithin(apiBuckets.get(id) ?? [], key, sample.at, SEEN_WITHIN_MS)
    );
  }).length;
  const result = judgeLatency(truth, shown, until, LIMIT_MS, { seenWithin });
  // The push is paced (one delta a second per topic) while the API changes about twice a second,
  // yet the page changed about 0.7 times per judged change in real runs: half is the usual floor.
  const activity = pageActivityProblems(result.measured, shown);
  const agreement = snapshotAgreement(snapshots, api, PACING_MS, 500);
  const values = pageValueProblems(shown, observed, agreement, {
    maxUnobserved: MAX_UNOBSERVED,
    minAgreement: MIN_AGREEMENT,
  });
  // The same judgement on the WebSocket's arrivals (the MES's part), and the page's own delay from
  // a value's arrival to the DOM.
  const pushResult = judgeLatency(truth, pushed, until, LIMIT_MS, { seenWithin });
  const pushLatencies = pushResult.measured.flatMap((m) =>
    m.latencyMs === undefined ? [] : [m.latencyMs],
  );
  const renderLatencies = [...shown].flatMap(([id, samples]) =>
    samples.slice(1).flatMap((sample) => {
      const arrived = (pushed.get(id) ?? []).filter(
        (c) => c.state === sample.state && c.at <= sample.at,
      );
      const last = arrived.at(-1);
      return last ? [sample.at - last.at] : [];
    }),
  );
  const spread = (values: number[]) =>
    values.length === 0
      ? null
      : {
          max: Math.max(...values),
          p95: percentile(values, 95),
          p50: percentile(values, 50),
        };
  const latencies = result.measured.flatMap((m) =>
    m.latencyMs === undefined ? [] : [m.latencyMs],
  );
  const perId = Object.fromEntries(
    ids.map((id) => [id, result.measured.filter((m) => m.machine === id).length]),
  );
  const summary = {
    shiftKey,
    sampleMs: SAMPLE_MS,
    sampledMs: until - startedSampling,
    endedBy,
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
    pageValues: values.transitions,
    unobservedPageValues: values.unobserved,
    identifiedPageValues: identified,
    snapshots: {
      count: snapshots.length,
      compared: agreement.compared,
      matched: agreement.matched,
      matchedPerKey: agreement.matchedPerKey,
      mismatches: agreement.mismatches,
    },
    activityProblems: activity,
    valueProblems: values.problems,
    diagnostics: {
      pushLatencyMs: spread(pushLatencies),
      pushViolations: pushResult.violations.length,
      // Around each violation: what the API held and what arrived on the WebSocket.
      slow: result.measured
        .filter((m) => (m.latencyMs ?? Infinity) > 1_300)
        .slice(0, 20)
        .map((v) => ({
          id: v.machine,
          at: v.at,
          latencyMs: v.latencyMs,
          api: (api.get(v.machine) ?? [])
            .filter((c) => c.at >= v.at - 3_000 && c.at <= v.at + 3_000)
            .map((c) => `${String(c.at - v.at)}:${c.state}`),
          frames: frames
            .filter((f) => f.id === v.machine && f.at >= v.at - 3_000 && f.at <= v.at + 3_000)
            .map((f) => `${String(f.at - v.at)}:${f.state}`),
        })),
      around: result.violations.map((v) => {
        const near = (changes: readonly Change[] | undefined) =>
          (changes ?? [])
            .filter((c) => c.at >= v.at - 4_000 && c.at <= v.at + 4_000)
            .map((c) => `${String(c.at - v.at)}:${c.state}`);
        return {
          id: v.machine,
          at: v.at,
          api: near(api.get(v.machine)),
          pushed: near(pushed.get(v.machine)),
        };
      }),
      renderLatencyMs: spread(renderLatencies),
    },
    violations: result.violations,
  };
  console.log(`OEE dashboard latency: ${JSON.stringify(summary)}`);
  if (results) await writeFile(join(results, 'oee-latency.json'), JSON.stringify(summary, null, 2));

  expect(result.violations, 'OEE changes the page did not show within 2 s').toEqual([]);
  expect(activity, 'the page did not follow the changes').toEqual([]);
  // A meaningful sample: changes on both cards, and many in all.
  for (const id of workCenters) expect(perId[id] ?? 0).toBeGreaterThanOrEqual(MIN_CARD_CHANGES);
  expect(result.measured.length).toBeGreaterThanOrEqual(MIN_CHANGES);
  // The page's values are the API's: few that the polls missed, and the snapshots agree. This is
  // what keeps a lagging page from passing on unseen values (see `observed` in latency.ts).
  expect(values.problems, 'the page did not show the API’s values').toEqual([]);
  // The buckets the push carried are the API's (#376): most page values are ones the polls saw.
  expect(
    identified,
    'page values whose bucket the API held around their moment',
  ).toBeGreaterThanOrEqual(pageSamples.length * MIN_IDENTIFIED);
});
