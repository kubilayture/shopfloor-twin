import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test, type Page } from '@playwright/test';
import { MesClient, SimulatorClient } from '../src/clients.ts';
import { percentile } from '../src/compare.ts';
import {
  judgeLatency,
  pageActivityProblems,
  pageValueProblems,
  snapshotAgreement,
  type Change,
  type LatencyResult,
  type Snapshot,
} from '../src/latency.ts';

/**
 * Phase 6 exit criterion 3, the live part (#147): during shift A of `alarms-01`, `/alarms` lists
 * every raise within 2 s of the simulator raising it, Cell M1's flood banner shows while the
 * injected flood lasts and goes away after it, and the `/alarms/kpi` cards follow the raises live.
 *
 * The truth is the simulator's `/ground-truth` (polled every 200 ms): its `alarms.occurrences`
 * hold every raise to the millisecond, and `alarms.scopes.<position>.floods` every flood episode.
 * A raise's wall time is when the paced clock reached it, from the poll that first listed it (as
 * in 3-overview.spec.ts). Unlike the overview's states or the OEE values, the truth here is
 * complete: every raise is listed with its exact time, so no page value can be "unseen", and the
 * floors are strict:
 * - **rows:** every raise is one new row; a page row matching no raise of the truth fails
 *   (`maxUnobserved` 0), and the page must add a row for every judged raise (frozen-page ratio 1);
 * - **KPI cards:** `data-raises` must be a count the scope held (`maxUnobserved` 0), and agree
 *   with the truth around each snapshot (95 %). The push is paced to one delta a second per topic
 *   while the injected flood raises up to 12 alarms a second of wall time at 60×, so the card skips
 *   counts: the frozen-page ratio is a quarter of the judged changes, and every scope with a
 *   change must change at least once;
 * - **flood banner:** the episode id in `data-episode` from the episode's start, and none again
 *   from its end, each within 2 s; Line A1, which has no flood, never shows one.
 */
const LIMIT_MS = 2_000;
const POLL_MS = 200;
/** Page snapshots of the KPI cards compared with the truth: one every this many ms. */
const SNAPSHOT_MS = 1_000;
/** The alarm KPI push sends at most one delta a second per topic (docs/api/realtime.md). */
const PACING_MS = 2_000;
const KPI_MIN_RATIO = 0.25;
const MIN_AGREEMENT = 0.95;

const simUrl = process.env.RECONCILE_SIM_URL;
const mesUrl = process.env.RECONCILE_MES_URL;
const results = process.env.RECONCILE_RESULTS;
/** Sampling ends when the paced clock passes this (the last shift A injection plus a margin). */
const sampleUntil = Date.parse(process.env.RECONCILE_ALARMS_UNTIL ?? '');
const shiftKey = process.env.RECONCILE_SHIFT ?? '2026-10-12/A';

declare global {
  interface Window {
    /** Every change seen in the page: key, value, wall time. */
    __alarmLog?: { key: string; value: string; at: number }[];
  }
}

/**
 * Records in the page, every 20 ms, each change of the values `read` returns (key → value), so
 * the measured delay doesn't depend on how often the test asks. Page and test share the clock.
 */
async function record(page: Page, kind: 'list' | 'kpi', keys: readonly string[]): Promise<void> {
  await page.evaluate(
    ({ kind, keys }) => {
      const log: { key: string; value: string; at: number }[] = [];
      const shown = new Map<string, string>();
      const read = (): Map<string, string> => {
        const values = new Map<string, string>();
        if (kind === 'list') {
          // Every row once listed: its key is the occurrence id; banners per position.
          for (const row of document.querySelectorAll('[data-testid^="alarm-row-"]')) {
            const id = row.getAttribute('data-testid')?.slice('alarm-row-'.length) ?? '';
            values.set(`row:${id}`, 'listed');
          }
          for (const id of keys) {
            const banner = document.querySelector(`[data-testid="flood-banner-${id}"]`);
            values.set(`flood:${id}`, banner?.getAttribute('data-episode') ?? 'none');
          }
        } else {
          for (const key of keys) {
            const card = document.querySelector(`[data-testid="kpi-card-${key}"]`);
            values.set(`kpi:${key}`, card?.getAttribute('data-raises') ?? 'missing');
          }
        }
        return values;
      };
      const tick = () => {
        for (const [key, value] of read()) {
          if (shown.get(key) !== value) {
            shown.set(key, value);
            log.push({ key, value, at: Date.now() });
          }
        }
      };
      tick();
      window.__alarmLog = log;
      setInterval(tick, 20);
    },
    { kind, keys },
  );
}

async function pageLog(page: Page) {
  return (await page.evaluate(() => window.__alarmLog)) ?? [];
}

function stats(result: LatencyResult) {
  const latencies = result.measured.flatMap((m) =>
    m.latencyMs === undefined ? [] : [m.latencyMs],
  );
  return {
    judged: result.measured.length,
    unjudged: result.unjudged,
    latencyMs:
      latencies.length === 0
        ? null
        : {
            p50: percentile(latencies, 50),
            p95: percentile(latencies, 95),
            max: Math.max(...latencies),
          },
    violations: result.violations,
  };
}

test('/alarms lists every raise within 2 s, shows the flood banner, and the KPI cards follow', async ({
  page,
  context,
}) => {
  test.skip(!simUrl || !mesUrl, 'runs inside pnpm test:reconcile, which starts the stack');
  if (Number.isNaN(sampleUntil)) throw new Error('RECONCILE_ALARMS_UNTIL is not a time');
  test.setTimeout(10 * 60_000);
  const sim = new SimulatorClient(simUrl ?? '');
  const mes = new MesClient(mesUrl ?? '');
  const current = await mes.currentShift();
  if (current.shiftKey !== shiftKey || current.shift === null) {
    throw new Error(`the plant is not in ${shiftKey}: ${JSON.stringify(current)}`);
  }
  const shiftStart = current.shift.start;
  const shiftEnd = current.shift.end;

  // The positions and their equipment, as the MES scopes them (alarms.yaml).
  const scopes = (await mes.alarmScopes()).scopes;
  const positions = scopes.filter((s) => s.scope === 'position');
  const positionIds = positions.map((p) => p.id).sort();
  expect(positionIds).toEqual(['cell-m1', 'line-a1']);
  const cardKeys = ['plant', ...positionIds.map((id) => `position-${id}`)];
  const scopeOf = new Map<string, string>(
    positions.flatMap((p) => p.equipment.map((e) => [e, `position-${p.id}`] as const)),
  );

  await page.goto('/alarms?view=active');
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('alarm-list')).toHaveAttribute('data-view', 'active');
  const kpiPage = await context.newPage();
  await kpiPage.goto('/alarms/kpi');
  await expect(kpiPage.getByTestId('connection-status')).toHaveAttribute('data-status', 'open', {
    timeout: 30_000,
  });
  for (const key of cardKeys) {
    await expect(kpiPage.getByTestId(`kpi-card-${key}`)).toHaveAttribute('data-raises', /^\d+$/, {
      timeout: 30_000,
    });
  }
  await record(page, 'list', positionIds);
  await record(kpiPage, 'kpi', cardKeys);
  const started = Date.now();
  // Every injection must still lie ahead: one applied before the page recorded can't be judged.
  const firstInjection = Math.min(...(await sim.injections()).map((i) => Date.parse(i.at)));
  const pacedAtStart = Date.parse((await sim.groundTruth()).pacedTime);
  if (pacedAtStart >= firstInjection) {
    throw new Error(
      `the alarm check started too late: the paced clock is at ${new Date(pacedAtStart).toISOString()}, the first injection was at ${new Date(firstInjection).toISOString()} (shorten OEE_SAMPLE_MS)`,
    );
  }

  // The truth: every raise and flood episode, with the wall time the paced clock reached it.
  const { speed } = await sim.status();
  const raises = new Map<
    string,
    { at: number; equipment: string; code: string; raisedAt: string }
  >();
  const floodStart = new Map<string, { at: number; id: string }[]>(
    positionIds.map((id) => [id, []]),
  );
  const floodEnd = new Map<string, { at: number; id: string }[]>(positionIds.map((id) => [id, []]));
  const snapshots: Snapshot[] = [];
  let first = true;
  let polls = 0;
  let nextSnapshot = Date.now() + SNAPSHOT_MS;
  for (;;) {
    const sent = Date.now();
    const truth = await sim.groundTruth();
    const polled = (sent + Date.now()) / 2;
    polls++;
    const paced = Date.parse(truth.pacedTime);
    const wall = (iso: string) => Math.round(polled + (Date.parse(iso) - paced) / speed);
    for (const occurrence of truth.alarms.occurrences) {
      const key = `${occurrence.equipment}|${occurrence.code}|${occurrence.raisedAt}`;
      if (raises.has(key)) continue;
      // Raises before sampling are not changes the page could be timed on.
      raises.set(key, { ...occurrence, at: first ? Number.NaN : wall(occurrence.raisedAt) });
    }
    for (const id of positionIds) {
      for (const episode of truth.alarms.scopes[id]?.floods ?? []) {
        const starts = floodStart.get(id) ?? [];
        if (!starts.some((e) => e.id === episode.id)) {
          starts.push({ id: episode.id, at: first ? Number.NaN : wall(episode.startAt) });
        }
        const ends = floodEnd.get(id) ?? [];
        if (episode.endAt !== null && !ends.some((e) => e.id === episode.id)) {
          ends.push({ id: episode.id, at: first ? Number.NaN : wall(episode.endAt) });
        }
      }
    }
    first = false;
    if (Date.now() >= nextSnapshot) {
      nextSnapshot += SNAPSHOT_MS;
      const at = Date.now();
      const values = await kpiPage.evaluate((keys) => {
        const read: Record<string, string> = {};
        for (const key of keys) {
          read[key] =
            document
              .querySelector(`[data-testid="kpi-card-${key}"]`)
              ?.getAttribute('data-raises') ?? 'missing';
        }
        return read;
      }, cardKeys);
      snapshots.push({ at, values });
    }
    if (paced >= sampleUntil) break;
    if (truth.pacedTime >= shiftEnd) throw new Error(`sampling ran past ${shiftKey}`);
    await sleep(POLL_MS);
  }
  const until = Date.now();

  // The page's rows, each resolved to its occurrence (equipment, code, raise time to the ms).
  const listLog = await pageLog(page);
  const kpiLog = await pageLog(kpiPage);
  const rowIds = [
    ...new Set(listLog.filter((e) => e.key.startsWith('row:')).map((e) => e.key.slice(4))),
  ];
  const rowKey = new Map<string, string>();
  for (const id of rowIds) {
    const { occurrence } = await mes.alarm(id);
    rowKey.set(id, `${occurrence.equipment}|${occurrence.code}|${occurrence.raisedAt}`);
  }

  // Rows: one change per raise ('listed' at its wall time); the page starts without the row.
  const judgedRaises = [...raises].filter(([, r]) => !Number.isNaN(r.at));
  const rowTruth = new Map<string, Change[]>(
    judgedRaises.map(([key, r]) => [key, [{ at: r.at, state: 'listed' }]]),
  );
  const rowPage = new Map<string, Change[]>(
    judgedRaises.map(([key]) => [key, [{ at: started, state: 'absent' }]]),
  );
  const unmatchedRows: string[] = [];
  for (const entry of listLog.filter((e) => e.key.startsWith('row:'))) {
    const key = rowKey.get(entry.key.slice(4)) ?? '';
    const samples = rowPage.get(key);
    if (samples === undefined) {
      // Listed before sampling (none in shift A before the injections), or no raise of the truth.
      if (!raises.has(key)) unmatchedRows.push(entry.key.slice(4));
      continue;
    }
    if (samples.length === 1) samples.push({ at: entry.at, state: 'listed' });
  }
  const rows = judgeLatency(rowTruth, rowPage, until, LIMIT_MS);
  // A raise adds exactly one row: the page must have added one for every judged raise.
  const rowActivity = pageActivityProblems(rows.measured, rowPage, 1);

  // Flood banners: the episode id from its start, `none` again from its end.
  const floodTruth = new Map<string, Change[]>(
    positionIds.map((id) => [
      id,
      [
        ...(floodStart.get(id) ?? []).map((e) => ({ at: e.at, state: e.id })),
        ...(floodEnd.get(id) ?? []).map((e) => ({ at: e.at, state: 'none' })),
      ]
        .filter((c) => !Number.isNaN(c.at))
        .sort((a, b) => a.at - b.at),
    ]),
  );
  const floodPage = new Map<string, Change[]>(
    positionIds.map((id) => [
      id,
      listLog.filter((e) => e.key === `flood:${id}`).map((e) => ({ at: e.at, state: e.value })),
    ]),
  );
  const floods = judgeLatency(floodTruth, floodPage, until, LIMIT_MS);
  const floodActivity = pageActivityProblems(floods.measured, floodPage, 1);

  // KPI cards: the shift's raises per scope, a step at each raise of the scope in the shift.
  const shiftRaises = [...raises.values()]
    .filter((r) => r.raisedAt >= shiftStart && r.raisedAt < shiftEnd)
    .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
  const kpiTruthAll = new Map<string, Change[]>(cardKeys.map((key) => [key, []]));
  const counts = new Map<string, number>(cardKeys.map((key) => [key, 0]));
  const initial = new Map<string, number>(cardKeys.map((key) => [key, 0]));
  for (const raise of shiftRaises) {
    for (const key of ['plant', scopeOf.get(raise.equipment) ?? 'unknown']) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (Number.isNaN(raise.at)) initial.set(key, count);
      else kpiTruthAll.get(key)?.push({ at: raise.at, state: String(count) });
    }
  }
  const kpiShown = new Map<string, Change[]>(
    cardKeys.map((key) => [
      key,
      kpiLog.filter((e) => e.key === `kpi:${key}`).map((e) => ({ at: e.at, state: e.value })),
    ]),
  );
  const kpi = judgeLatency(kpiTruthAll, kpiShown, until, LIMIT_MS);
  const kpiActivity = pageActivityProblems(kpi.measured, kpiShown, KPI_MIN_RATIO);
  // Every count each scope held (complete: the truth lists every raise), from its first.
  const held = new Map<string, Change[]>(
    cardKeys.map((key) => [
      key,
      [{ at: started, state: String(initial.get(key) ?? 0) }, ...(kpiTruthAll.get(key) ?? [])],
    ]),
  );
  const observed = new Map(
    cardKeys.map((key) => [key, new Set(held.get(key)?.map((c) => c.state))]),
  );
  const agreement = snapshotAgreement(snapshots, held, PACING_MS, 500);
  const kpiValues = pageValueProblems(kpiShown, observed, agreement, {
    maxUnobserved: 0,
    minAgreement: MIN_AGREEMENT,
  });

  // The shift A injections the simulator applied, each among the judged raises.
  const injections = (await sim.injections()).filter((i) => i.appliedAt !== undefined);
  const injected = injections.map((i) => `${i.machine}|${i.code}|${i.appliedAt ?? ''}`);
  const injectedJudged = injected.filter((key) =>
    rows.measured.some((m) => m.machine === key && m.latencyMs !== undefined),
  );

  const summary = {
    shiftKey,
    limitMs: LIMIT_MS,
    sampledMs: until - started,
    polls,
    rows: {
      ...stats(rows),
      pageRows: rowIds.length,
      unmatchedRows,
      activityProblems: rowActivity,
    },
    injected: { applied: injected.length, judged: injectedJudged.length },
    floods: {
      ...stats(floods),
      truth: Object.fromEntries(floodTruth),
      page: Object.fromEntries(floodPage),
      activityProblems: floodActivity,
    },
    kpiCards: {
      ...stats(kpi),
      perScope: Object.fromEntries(
        cardKeys.map((key) => [key, kpi.measured.filter((m) => m.machine === key).length]),
      ),
      pageTransitions: Object.fromEntries(
        cardKeys.map((key) => [key, Math.max(0, (kpiShown.get(key)?.length ?? 0) - 1)]),
      ),
      final: Object.fromEntries(cardKeys.map((key) => [key, kpiShown.get(key)?.at(-1)?.state])),
      truthFinal: Object.fromEntries(counts),
      snapshots: {
        count: snapshots.length,
        compared: agreement.compared,
        matched: agreement.matched,
      },
      mismatches: agreement.mismatches,
      activityProblems: kpiActivity,
      valueProblems: kpiValues.problems,
    },
  };
  console.log(`alarms live: ${JSON.stringify(summary)}`);
  if (results)
    await writeFile(join(results, 'alarms-latency.json'), JSON.stringify(summary, null, 2));

  // Rows: every raise listed within 2 s, nothing listed that the plant didn't raise, a live page.
  expect(rows.violations, 'raises the alarm list did not show within 2 s').toEqual([]);
  expect(rowActivity, 'the alarm list did not follow the raises').toEqual([]);
  // No row the truth lacks (the truth lists every raise: the unseen-value floor is 0).
  expect(unmatchedRows, 'rows the plant never raised').toEqual([]);
  // Every injection of shift A applied and judged (13 on Cell M1, 1 fleeting on LKT-01).
  expect(injected.length).toBeGreaterThanOrEqual(14);
  expect(injectedJudged).toEqual(injected);
  // The flood banner of Cell M1 came and went with the episode; Line A1 never flooded.
  expect(floods.violations, 'flood banner changes not shown within 2 s').toEqual([]);
  expect(floodActivity, 'the flood banner did not follow the episode').toEqual([]);
  expect(floodTruth.get('cell-m1')?.map((c) => c.state)).toEqual([
    floodStart.get('cell-m1')?.[0]?.id,
    'none',
  ]);
  expect(floodPage.get('line-a1')?.map((c) => c.state)).toEqual(['none']);
  // KPI cards: every count change within 2 s, values the scope held, a live page.
  expect(kpi.violations, 'KPI card counts not shown within 2 s').toEqual([]);
  expect(kpiActivity, 'the KPI cards did not follow the raises').toEqual([]);
  expect(kpiValues.problems, 'the KPI cards did not show the truth’s counts').toEqual([]);
  for (const key of cardKeys) {
    expect(kpiShown.get(key)?.at(-1)?.state, key).toBe(String(counts.get(key) ?? 0));
  }
});
