import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test, type Page } from '@playwright/test';
import { account, logIn, signOnAtTerminal } from '../../login.ts';
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
import { episodeIdentity, type TraceSectionJson } from '../../../src/trace-shapes.ts';

/**
 * Phase 8 exit criterion 5, the live part (#204): during shift A of quality-01, with the leak drift
 * posted before the resume, every SPC episode of the leak test appears on `/quality/spc/<id>` (a
 * quality user's desk) and on the Line A1 terminal (an operator signed on there for the whole
 * sampling, whose crew row the trace page shows after the drain) within 2 s of the reading that
 * triggers it.
 *
 * The truth is the simulator's live `/ground-truth` `trace` (polled every 250 ms): each episode
 * (chart, rule, limit version, triggering part and pass) at the midpoint of the poll that first saw
 * it. Each page records itself, every 20 ms, which signal rows it shows (`signal-row-<id>`,
 * `terminal-signal-<id>`); after the sampling the MES's ids are mapped to the same identity through
 * its API (`GET …/chart`). Judged with the latency judge and its value floors as the terminal
 * counts (orders/live/terminal-live.spec.ts): `seenWithin`, at most 5 % of page values the polls
 * never saw, 95 % of the snapshots agreeing with the truth around their moment, every key agreeing
 * once. Baseline episodes (created with limit version 1, plan review round 3 MEDIUM 2) must appear
 * too but are not latency-judged. The drift's first episode must be among those judged.
 */
const LIMIT_MS = 2_000;
const POLL_MS = 250;
const SNAPSHOT_MS = 1_000;
const PACING_MS = 2_000;
const SEEN_WITHIN_MS = 5_000;
const MAX_UNOBSERVED = 0.05;
const MIN_AGREEMENT = 0.95;
/** quality-01's shift A has 15 episodes after the baseline before 10:55 UTC (trace.json). */
const MIN_JUDGED = 10;
/** Signal episodes one terminal view shows at most (`TERMINAL_LIMITS.signals`), baseline ones never. */
const TERMINAL_SIGNALS = 10;
const WORK_CENTER = 'line-a1';
const SHOWN = 'shown';
const ABSENT = 'absent';

const simUrl = process.env.RECONCILE_SIM_URL ?? '';
const mesUrl = process.env.RECONCILE_MES_URL ?? '';
const results = process.env.RECONCILE_RESULTS;
const characteristic = process.env.RECONCILE_CHARACTERISTIC ?? 'leak-rate';
/** Simulation time at which the sampling ends (before the end of shift A). */
const until = Date.parse(process.env.RECONCILE_SPC_UNTIL ?? '');
/** The drift's first episode in the golden truth (identity), which must be judged. */
const driftEpisode = process.env.RECONCILE_DRIFT_EPISODE ?? '';
/**
 * The simulation time the operator signs on at, at the earliest (review MEDIUM 2): an hour into the
 * shift, so the units whose OP30 ran before it show that the crew is absent where nobody was
 * signed on, not only present where somebody was. No episode forms before it.
 */
const crewFrom = Date.parse(process.env.RECONCILE_CREW_FROM ?? '');

declare global {
  interface Window {
    /** Every change of the signal rows a page shows: the row id, shown or not, wall time. */
    __signalLog?: { id: string; shown: boolean; at: number }[];
  }
}

/** Starts the page's own record of the rows whose test id starts with `prefix`. */
async function recordRows(page: Page, prefix: string): Promise<void> {
  await page.evaluate((prefix) => {
    const log: { id: string; shown: boolean; at: number }[] = [];
    let shown = new Set<string>();
    const read = () => {
      const now = new Set<string>();
      for (const node of document.querySelectorAll(`[data-testid^="${prefix}"]`)) {
        const id = node.getAttribute('data-testid')?.slice(prefix.length) ?? '';
        if (/^\d+$/.test(id)) now.add(id);
      }
      const at = Date.now();
      for (const id of now) if (!shown.has(id)) log.push({ id, shown: true, at });
      for (const id of shown) if (!now.has(id)) log.push({ id, shown: false, at });
      shown = now;
    };
    read();
    window.__signalLog = log;
    setInterval(read, 20);
  }, prefix);
}

/** The ids a page shows now. */
const shownNow = (page: Page, prefix: string) =>
  page.evaluate((prefix) => {
    const ids: string[] = [];
    for (const node of document.querySelectorAll(`[data-testid^="${prefix}"]`)) {
      const id = node.getAttribute('data-testid')?.slice(prefix.length) ?? '';
      if (/^\d+$/.test(id)) ids.push(id);
    }
    return ids;
  }, prefix);

interface PageJudgement {
  readonly keys: number;
  readonly judged: number;
  readonly unjudged: number;
  readonly unknown: readonly string[];
  readonly missing: readonly string[];
  readonly latencyMs: { max: number; p95: number; p50: number } | null;
  readonly violations: readonly unknown[];
  readonly activityProblems: readonly string[];
  readonly valueProblems: readonly string[];
  readonly snapshots: { compared: number; matched: number; mismatches: readonly string[] };
  readonly driftJudged: boolean;
}

test('every SPC episode of the drifted shift appears on the SPC page and the Line A1 terminal within 2 s', async ({
  browser,
}) => {
  test.skip(simUrl === '' || mesUrl === '', 'runs inside pnpm test:reconcile');
  expect(Number.isFinite(until)).toBe(true);
  test.setTimeout(20 * 60_000);
  const sim = new SimulatorClient(simUrl);

  // The operator at Line A1 (a terminal session and the crew row), the quality user at the desk.
  const terminal = await (await browser.newContext()).newPage();
  const operator = account('operator');
  // The sign-on's simulation time, read by this check (not by the MES): the reconciliation judges
  // the crew on every unit's OP30 record by it (crew-window.json, review MEDIUM 2).
  if (Number.isFinite(crewFrom)) {
    while (Date.parse((await sim.status()).simTime) < crewFrom) await sleep(200);
  }
  const signOnFrom = (await sim.status()).simTime;
  await signOnAtTerminal(terminal, WORK_CENTER, operator);
  const signOnTo = (await sim.status()).simTime;
  await expect(terminal.getByTestId('connection-status')).toHaveAttribute('data-status', 'open', {
    timeout: 30_000,
  });
  await expect(terminal.getByTestId('terminal-signals')).toHaveAttribute('aria-live', 'polite');
  const desk = await (await browser.newContext()).newPage();
  const cookie = await logIn(desk, account('quality'));
  await desk.goto(`/quality/spc/${characteristic}`);
  await expect(desk.getByTestId('spc-chart-page')).toBeVisible({ timeout: 30_000 });
  await expect(desk.getByTestId('connection-status')).toHaveAttribute('data-status', 'open', {
    timeout: 30_000,
  });
  await recordRows(desk, 'signal-row-');
  await recordRows(terminal, 'terminal-signal-');

  // The truth: every episode of the live trace, at the midpoint of the poll that first saw it.
  const startedSampling = Date.now();
  const truthSeen = new Map<string, { at: number; baseline: boolean }>();
  /** Per poll, the episodes the terminal should show: its 10 newest after the baseline. */
  const terminalAt: { at: number; keys: Set<string> }[] = [];
  const snapshots: { at: number; desk: string[]; terminal: string[] }[] = [];
  let nextSnapshot = startedSampling + SNAPSHOT_MS;
  let polls = 0;
  let simTime = 0;
  while (simTime < until) {
    const sent = Date.now();
    const ground = await sim.groundTruthJson();
    const polled = Math.round((sent + Date.now()) / 2);
    polls++;
    simTime = Date.parse(String(ground.simTime));
    const trace = ground.trace as TraceSectionJson;
    for (const episode of trace.spc.episodes) {
      const key = episodeIdentity(episode);
      if (!truthSeen.has(key)) truthSeen.set(key, { at: polled, baseline: episode.baseline });
    }
    // The terminal's rule (TERMINAL_LIMITS.signals, newest first by the triggering point's time,
    // then the later episode): episodes are listed in order of their first point, so among equal
    // times the later in the list is the newer.
    const newest = trace.spc.episodes
      .map((episode, index) => ({ episode, index }))
      .filter(({ episode }) => !episode.baseline)
      .sort((a, b) => Date.parse(b.episode.at) - Date.parse(a.episode.at) || b.index - a.index)
      .slice(0, TERMINAL_SIGNALS)
      .map(({ episode }) => episodeIdentity(episode));
    terminalAt.push({ at: polled, keys: new Set(newest) });
    if (Date.now() >= nextSnapshot) {
      nextSnapshot += SNAPSHOT_MS;
      const at = Date.now();
      snapshots.push({
        at,
        desk: await shownNow(desk, 'signal-row-'),
        terminal: await shownNow(terminal, 'terminal-signal-'),
      });
    }
    await sleep(POLL_MS);
  }
  const sampledUntil = Date.now();
  const sampledSimTime = (await sim.status()).simTime;

  // The MES's ids as identities (its API, after the sampling; withdrawn ones included).
  const mes = new MesClient(mesUrl, cookie);
  const chart = await mes.spcChart(characteristic);
  const identityOf = new Map(
    chart.signals.map((s) => [
      String(s.id),
      episodeIdentity({
        chart: s.chart,
        rule: s.rule,
        version: s.version,
        partId: s.first.partId,
        pass: s.first.pass,
      }),
    ]),
  );
  const withdrawn = chart.signals.filter((s) => s.status === 'withdrawn').map((s) => s.id);

  // Per key, the truth's values in time order. The SPC page lists every episode: absent until
  // first seen, then shown. The terminal its newest ten after the baseline: shown while among them.
  const deskTruth = new Map<string, Change[]>();
  for (const [key, seen] of truthSeen) {
    deskTruth.set(key, [
      { at: startedSampling, state: ABSENT },
      { at: seen.at, state: SHOWN },
    ]);
  }
  const terminalTruth = new Map<string, Change[]>();
  for (const [key, seen] of truthSeen) {
    if (seen.baseline) continue;
    const changes: Change[] = [{ at: startedSampling, state: ABSENT }];
    for (const { at, keys } of terminalAt) {
      const state = keys.has(key) ? SHOWN : ABSENT;
      if (changes.at(-1)?.state !== state) changes.push({ at, state });
    }
    terminalTruth.set(key, changes);
  }
  const judge = async (
    page: Page,
    which: 'desk' | 'terminal',
    truth: ReadonlyMap<string, readonly Change[]>,
  ) => {
    const log = (await page.evaluate(() => window.__signalLog)) ?? [];
    const unknown = [
      ...new Set(
        log
          .map((e) => identityOf.get(e.id) ?? `id ${e.id} (not in the API)`)
          .filter((key) => !truth.has(key) && !(which === 'terminal' && truthSeen.has(key))),
      ),
    ];
    const shown = new Map<string, Change[]>();
    for (const key of truth.keys()) {
      const samples: Change[] = [{ at: startedSampling, state: ABSENT }];
      for (const entry of log) {
        if (identityOf.get(entry.id) !== key) continue;
        const state = entry.shown ? SHOWN : ABSENT;
        if (samples.at(-1)?.state !== state) samples.push({ at: entry.at, state });
      }
      shown.set(key, samples);
    }
    const missing = [...truth.keys()].filter(
      (key) =>
        (truth.get(key) ?? []).some((s) => s.state === SHOWN) &&
        (shown.get(key) ?? []).every((s) => s.state !== SHOWN),
    );
    const judgedKeys = [...truthSeen]
      .filter(([key, s]) => !s.baseline && truth.has(key))
      .map(([key]) => key);
    const judged = new Map(judgedKeys.map((key) => [key, (truth.get(key) ?? []).slice(1)]));
    const pageJudged = new Map(judgedKeys.map((key) => [key, shown.get(key) ?? []]));
    const result = judgeLatency(judged, pageJudged, sampledUntil, LIMIT_MS, {
      seenWithin: { truth, windowMs: SEEN_WITHIN_MS },
    });
    const activity = pageActivityProblems(result.measured, pageJudged);
    const pageSnapshots: Snapshot[] = snapshots.map((s) => {
      const ids = new Set(s[which].map((id) => identityOf.get(id)));
      return {
        at: s.at,
        values: Object.fromEntries(
          [...truth.keys()].map((key) => [key, ids.has(key) ? SHOWN : ABSENT]),
        ),
      };
    });
    const agreement = snapshotAgreement(pageSnapshots, truth, PACING_MS, 500);
    // The values the truth was seen to hold per key (review MEDIUM 3), as terminal-live.spec.ts.
    const observed = new Map(
      [...truth.keys()].map((key) => [key, new Set(truth.get(key)?.map((c) => c.state))]),
    );
    const values = pageValueProblems(shown, observed, agreement, {
      maxUnobserved: MAX_UNOBSERVED,
      minAgreement: MIN_AGREEMENT,
    });
    const latencies = result.measured.flatMap((m) =>
      m.latencyMs === undefined ? [] : [m.latencyMs],
    );
    const judgement: PageJudgement = {
      keys: truth.size,
      judged: result.measured.filter((m) => m.state === SHOWN).length,
      unjudged: result.unjudged,
      unknown,
      missing,
      latencyMs:
        latencies.length === 0
          ? null
          : {
              max: Math.max(...latencies),
              p95: percentile(latencies, 95),
              p50: percentile(latencies, 50),
            },
      violations: result.violations,
      activityProblems: activity,
      valueProblems: values.problems,
      snapshots: {
        compared: agreement.compared,
        matched: agreement.matched,
        mismatches: agreement.mismatches,
      },
      driftJudged: result.measured.some((m) => m.machine === driftEpisode && m.state === SHOWN),
    };
    return { judgement, result };
  };
  const deskJudged = await judge(desk, 'desk', deskTruth);
  const terminalJudged = await judge(terminal, 'terminal', terminalTruth);

  // The operator signs off at the terminal: the crew row ends (the reconciliation checks it).
  const signOffFrom = (await sim.status()).simTime;
  await terminal.getByTestId('terminal-sign-off').click();
  await expect(terminal.getByTestId('terminal-username')).toHaveValue('');
  const signOffTo = (await sim.status()).simTime;
  const crewWindow = {
    operator: operator.username,
    signOn: { from: signOnFrom, to: signOnTo },
    signOff: { from: signOffFrom, to: signOffTo },
  };
  if (results) await writeFile(join(results, 'crew-window.json'), JSON.stringify(crewWindow));

  const summary = {
    characteristic,
    limitMs: LIMIT_MS,
    polls,
    sampledMs: sampledUntil - startedSampling,
    sampledUntil: sampledSimTime,
    episodes: truthSeen.size,
    baseline: [...truthSeen.values()].filter((s) => s.baseline).length,
    driftEpisode,
    withdrawn,
    desk: deskJudged.judgement,
    terminal: terminalJudged.judgement,
    operator: operator.username,
    crewWindow,
  };
  console.log(`spc latency: ${JSON.stringify(summary)}`);
  if (results) await writeFile(join(results, 'spc-latency.json'), JSON.stringify(summary, null, 2));

  expect(withdrawn, 'withdrawn episodes in an in-order live run').toEqual([]);
  for (const [name, { judgement }] of [
    ['SPC page', deskJudged],
    ['Line A1 terminal', terminalJudged],
  ] as const) {
    expect(judgement.unknown, `${name}: episodes the truth never had`).toEqual([]);
    expect(judgement.missing, `${name}: episodes never shown`).toEqual([]);
    expect(judgement.violations, `${name}: episodes not shown within 2 s`).toEqual([]);
    expect(judgement.activityProblems, `${name}: the page did not follow`).toEqual([]);
    expect(judgement.valueProblems, `${name}: the page did not show the truth`).toEqual([]);
    expect(judgement.judged, `${name}: judged episodes`).toBeGreaterThanOrEqual(MIN_JUDGED);
    expect(judgement.driftJudged, `${name}: the drift's first episode judged`).toBe(true);
  }
});
