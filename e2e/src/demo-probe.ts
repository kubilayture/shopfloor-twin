/**
 * Probe D1 of the demo (#281, Phase 10 plan "Demo scenario (P10-06)" and "Probes before code"):
 * headless runs of `config/scenarios/demo-v1-probe.yaml`, demo-v1's entries plus a `dispatch`
 * entry per order the walkthrough releases, in acceptance-time variants. A job accepted at T on an
 * idle CNC starts at T (its changeover first), as one given at the start with NotBefore T does, so a
 * variant moves each dispatch's NotBefore to the later of the order's planned start and T.
 *
 * - Inside the envelope (`ENVELOPE`): accepted at the run's start, between, and at the timeline's
 *   pause (06:14), the latest the walkthrough can accept a job, since the run waits paused there
 *   until scene 3 resumes it. The walkthrough fails a run whose jobs were accepted later.
 * - Outside it (`BEYOND`, reported only): what a later acceptance would do to each margin.
 *
 * Each scene's facts are read from the variant's ground truth (summary.json, trace.json and the
 * event log) and compared with the plant time the walkthrough opens the scene (`SCENES`, src/
 * demo-plan.ts): the margin is how long before it the fact exists. A missing fact, or a negative
 * margin inside the envelope, fails the probe (exit 1).
 *
 * Usage: pnpm demo:probe. Writes e2e/results/demo-probe/d1.json and prints the table recorded in
 * docs/demo.md. Light: one headless run of about 0.1 s per variant, no stack, no lock.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';
import { CLOSE_AT, CODE_AT, DEMO, SCENES, plantClock, plantTime, sceneAt } from './demo-plan.ts';
import { REPO } from './stack.ts';

const run = promisify(execFile);

/** Acceptance times inside the envelope: the earliest, between, the latest (the pause). */
export const ENVELOPE = ['06:00', '06:07', '06:14'] as const;
/** Acceptance times after the pause, reported only. */
export const BEYOND = ['06:20', '06:30', '06:45'] as const;

interface TimelineEntry {
  readonly action: string;
  readonly notBefore?: string;
  readonly [key: string]: unknown;
}
interface TimelineDocument {
  readonly timeline: readonly TimelineEntry[];
  readonly [key: string]: unknown;
}

/** The probe with every dispatch accepted at `accepted` (ms): NotBefore the later of the two. */
export function variant(probe: TimelineDocument, accepted: number): TimelineDocument {
  return {
    ...probe,
    description: `${typeof probe.description === 'string' ? probe.description : DEMO.probe} (accepted at ${plantClock(accepted)})`,
    timeline: probe.timeline.map((entry) =>
      entry.action === 'dispatch' && entry.notBefore !== undefined
        ? {
            ...entry,
            notBefore: new Date(Math.max(Date.parse(entry.notBefore), accepted)).toISOString(),
          }
        : entry,
    ),
  };
}

interface Event {
  readonly type: string;
  readonly at: string;
  readonly machineId?: string;
  readonly partId?: number;
  readonly orderId?: string;
  readonly transition?: string;
  readonly cause?: string;
  readonly to?: string;
}

/** The facts each scene shows, as plant times (ms) or values; null when the run has none. */
export interface Facts {
  /** The CNCs' first changeover: the jobs' start (the planned start inside the envelope). */
  readonly productionStart: number | null;
  /** The first job's first blank, after its changeover. */
  readonly firstJobStarted: number | null;
  readonly alarmRaised: number | null;
  readonly alarmCleared: number | null;
  readonly starvedMaterial: number | null;
  readonly toolChange: number | null;
  readonly firstCompletedOrder: { readonly id: string; readonly at: number } | null;
  readonly firstClosedCarton: { readonly id: string; readonly at: number } | null;
  /** Scene 8's own carton: the first completed order's first carton (`…-C01`), closed. */
  readonly sceneCarton: { readonly id: string; readonly at: number } | null;
  readonly baselineEnd: number | null;
  readonly driftStart: { readonly at: number; readonly firstPassBefore: number } | null;
  readonly episode: {
    readonly at: number;
    readonly chart: string;
    readonly rule: number;
    readonly baseline: boolean;
    readonly latency: number;
    readonly lastPart: number;
  } | null;
  readonly heldOrder: { readonly id: string; readonly completedAt: number | null } | null;
  readonly bottleneck: readonly string[] | null;
}

interface Summary {
  readonly alarms: {
    readonly occurrences: readonly {
      equipment: string;
      code: string;
      raisedAt: string;
      clearedAt?: string | null;
    }[];
  };
  readonly orders: { readonly jobs: readonly { startedAt?: string | null }[] };
}
interface TraceDocument {
  readonly orders: readonly { orderId: string; completedAt: string | null }[];
  readonly cartons: readonly { id: string; status: string; closedAt?: string | null }[];
  readonly spc: { readonly limits: readonly { version: number; createdAt: string }[] };
  readonly drifts: readonly {
    readonly start?: { at: string; firstPassBefore: number } | null;
    readonly firstEpisode?: {
      at: string;
      chart: string;
      rule: number;
      baseline: boolean;
      latency: number;
      last: { partId: number };
    } | null;
  }[];
}
interface LineOee {
  readonly bottlenecks: Readonly<Record<string, { equipment: readonly string[] }>>;
}

const min = (values: readonly number[]): number | null =>
  values.length === 0 ? null : Math.min(...values);

/** Reads the scene facts of one headless run's outputs. */
export function factsOf(
  summary: Summary,
  trace: TraceDocument,
  lineOee: LineOee,
  events: readonly Event[],
): Facts {
  const alarm = summary.alarms.occurrences.find(
    (o) => o.equipment === DEMO.failure.machine && o.code === DEMO.failure.code,
  );
  const completed = trace.orders
    .filter((o) => o.completedAt !== null)
    .map((o) => ({ id: o.orderId, at: Date.parse(o.completedAt ?? '') }))
    .sort((a, b) => a.at - b.at);
  const cartons = trace.cartons
    .filter((c) => c.status === 'closed' && c.closedAt)
    .map((c) => ({ id: c.id, at: Date.parse(c.closedAt ?? '') }))
    .sort((a, b) => a.at - b.at);
  const drift = trace.drifts[0];
  const episode = drift?.firstEpisode ?? null;
  // The order of each part: the job its CNC was running when the part's blank was consumed.
  const running = new Map<string, string>();
  const orderOfPart = new Map<number, string>();
  for (const event of events) {
    if (event.type === 'job' && event.transition === 'started' && event.machineId) {
      running.set(event.machineId, event.orderId ?? '');
    }
    if (
      event.type === 'material-consumed' &&
      event.machineId?.startsWith('cnc-') === true &&
      event.partId !== undefined
    ) {
      const order = running.get(event.machineId);
      if (order !== undefined && !orderOfPart.has(event.partId)) {
        orderOfPart.set(event.partId, order);
      }
    }
  }
  const heldId = episode ? orderOfPart.get(episode.last.partId) : undefined;
  const held = heldId === undefined ? undefined : trace.orders.find((o) => o.orderId === heldId);
  return {
    productionStart: min(
      events
        .filter(
          (e) =>
            e.type === 'state' &&
            e.machineId?.startsWith('cnc-') === true &&
            e.to === 'Setup' &&
            e.cause?.startsWith('CHANGEOVER') === true,
        )
        .map((e) => Date.parse(e.at)),
    ),
    firstJobStarted: min(
      summary.orders.jobs.flatMap((j) => (j.startedAt ? [Date.parse(j.startedAt)] : [])),
    ),
    alarmRaised: alarm ? Date.parse(alarm.raisedAt) : null,
    alarmCleared: alarm?.clearedAt ? Date.parse(alarm.clearedAt) : null,
    starvedMaterial: min(
      events
        .filter(
          (e) =>
            e.type === 'state' &&
            e.to === 'Starved' &&
            e.machineId?.startsWith('cnc-') === true &&
            e.cause === `MATERIAL:${DEMO.blockedMaterial}`,
        )
        .map((e) => Date.parse(e.at)),
    ),
    toolChange: min(
      events
        .filter(
          (e) =>
            e.type === 'state' &&
            e.machineId === DEMO.toolBreakage.machine &&
            e.to === 'Setup' &&
            e.cause === 'TOOL-CHANGE' &&
            Date.parse(e.at) >= DEMO.toolBreakage.at,
        )
        .map((e) => Date.parse(e.at)),
    ),
    firstCompletedOrder: completed[0] ?? null,
    firstClosedCarton: cartons[0] ?? null,
    sceneCarton:
      completed[0] === undefined
        ? null
        : (cartons.find((c) => c.id === `${completed[0]?.id ?? ''}-C01`) ?? null),
    baselineEnd: min(
      trace.spc.limits.filter((l) => l.version === 1).map((l) => Date.parse(l.createdAt)),
    ),
    driftStart: drift?.start
      ? { at: Date.parse(drift.start.at), firstPassBefore: drift.start.firstPassBefore }
      : null,
    episode: episode
      ? {
          at: Date.parse(episode.at),
          chart: episode.chart,
          rule: episode.rule,
          baseline: episode.baseline,
          latency: episode.latency,
          lastPart: episode.last.partId,
        }
      : null,
    heldOrder:
      heldId === undefined
        ? null
        : {
            id: heldId,
            completedAt: held?.completedAt ? Date.parse(held.completedAt) : null,
          },
    bottleneck: lineOee.bottlenecks['VB-100']?.equipment ?? null,
  };
}

/** One margin: the fact, the plant time it is needed by, and how long before (ms; null: missing). */
export interface Margin {
  readonly scene: number;
  readonly fact: string;
  readonly needed: number;
  readonly at: number | null;
  readonly marginMs: number | null;
}

const need = (id: Parameters<typeof sceneAt>[0]): number => {
  const at = sceneAt(id);
  if (at === null) throw new Error(`scene ${id} has no time`);
  return at;
};

/** Every scene fact with a time, and its margin before the scene needs it. */
export function marginsOf(facts: Facts): Margin[] {
  const margin = (scene: number, fact: string, needed: number, at: number | null): Margin => ({
    scene,
    fact,
    needed,
    at,
    marginMs: at === null ? null : needed - at,
  });
  const alarms = need('alarms');
  const oee = need('oee');
  const spc = need('spc');
  const close = plantTime(CLOSE_AT);
  return [
    margin(4, `${DEMO.failure.code} raised on ${DEMO.failure.machine}`, alarms, facts.alarmRaised),
    margin(4, 'its repair ends (breakdown record closed)', plantTime(CODE_AT), facts.alarmCleared),
    margin(5, 'availability loss on CNC-01 (the breakdown)', oee, facts.alarmRaised),
    margin(5, 'first order completed', oee, facts.firstCompletedOrder?.at ?? null),
    margin(5, `OP10 starved MATERIAL:${DEMO.blockedMaterial}`, oee, facts.starvedMaterial),
    margin(6, 'SPC baseline complete (limit version 1)', DEMO.drift.at, facts.baselineEnd),
    margin(6, "drift's first episode after its start", spc, facts.episode?.at ?? null),
    margin(
      7,
      'held order (episode’s last unit) completed',
      close,
      facts.heldOrder?.completedAt ?? null,
    ),
    margin(
      8,
      `its carton closed (${facts.sceneCarton?.id ?? 'the first completed order’s -C01'})`,
      close,
      facts.sceneCarton?.at ?? null,
    ),
  ];
}

/** Problems that make a variant unusable for the walkthrough. */
export function problemsOf(facts: Facts, margins: readonly Margin[]): string[] {
  const problems: string[] = [];
  if (facts.productionStart !== DEMO.plannedStart) {
    problems.push(
      `the jobs start at ${facts.productionStart === null ? 'no time' : plantClock(facts.productionStart)}, not at the planned start ${plantClock(DEMO.plannedStart)}`,
    );
  }
  for (const m of margins) {
    if (m.at === null) problems.push(`scene ${String(m.scene)}: no ${m.fact}`);
    else if ((m.marginMs ?? 0) < 0) {
      problems.push(
        `scene ${String(m.scene)}: ${m.fact} at ${plantClock(m.at)}, after ${plantClock(m.needed)}`,
      );
    }
  }
  if (facts.episode?.baseline !== false) problems.push('the first episode is a baseline one');
  if ((facts.driftStart?.firstPassBefore ?? 0) < 100) {
    problems.push('the drift starts inside the SPC baseline (fewer than 100 readings before it)');
  }
  if (JSON.stringify(facts.bottleneck) !== JSON.stringify([DEMO.bottleneck])) {
    problems.push(`bottleneck ${JSON.stringify(facts.bottleneck)}, not ${DEMO.bottleneck}`);
  }
  return problems;
}

interface VariantResult {
  readonly accepted: string;
  readonly facts: Facts;
  readonly margins: Margin[];
  readonly problems: string[];
}

async function runVariant(
  probe: TimelineDocument,
  accepted: string,
  dir: string,
): Promise<VariantResult> {
  const file = join(dir, `accepted-${accepted.replace(':', '')}.yaml`);
  const out = join(dir, `out-${accepted.replace(':', '')}`);
  await writeFile(file, stringify(variant(probe, plantTime(accepted))));
  await run(
    process.execPath,
    ['apps/simulator/src/headless/cli.ts', '--timeline', file, '--out', out],
    { cwd: REPO, maxBuffer: 64 * 1024 * 1024 },
  );
  const json = async <T>(name: string) => JSON.parse(await readFile(join(out, name), 'utf8')) as T;
  const events = (await readFile(join(out, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line) as Event);
  const facts = factsOf(
    await json<Summary>('summary.json'),
    await json<TraceDocument>('trace.json'),
    await json<LineOee>('line-oee.json'),
    events,
  );
  const margins = marginsOf(facts);
  return { accepted, facts, margins, problems: problemsOf(facts, margins) };
}

const minutes = (ms: number | null): string =>
  ms === null ? 'missing' : `${(ms / 60_000).toFixed(1)} min`;

async function main(): Promise<void> {
  const probe = parse(
    await readFile(join(REPO, 'config/scenarios', `${DEMO.probe}.yaml`), 'utf8'),
  ) as TimelineDocument;
  const dir = await mkdtemp(join(tmpdir(), 'shopfloor-demo-probe-'));
  try {
    const inside: VariantResult[] = [];
    for (const accepted of ENVELOPE) inside.push(await runVariant(probe, accepted, dir));
    const beyond: VariantResult[] = [];
    for (const accepted of BEYOND) beyond.push(await runVariant(probe, accepted, dir));

    console.log(`Probe D1 (${DEMO.probe}): scene facts per acceptance time (plant time)\n`);
    const all = [...inside, ...beyond];
    const header = ['Scene', 'Fact', 'Needed by', ...all.map((v) => `accepted ${v.accepted}`)];
    console.log(`| ${header.join(' | ')} |`);
    console.log(`| ${header.map(() => '---').join(' | ')} |`);
    const rows = inside[0]?.margins ?? [];
    rows.forEach((row, index) => {
      const cells = all.map((v) => {
        const m = v.margins[index];
        return m?.at === null || m === undefined
          ? 'missing'
          : `${plantClock(m.at)} (${minutes(m.marginMs)})`;
      });
      console.log(
        `| ${String(row.scene)} | ${row.fact} | ${plantClock(row.needed)} | ${cells.join(' | ')} |`,
      );
    });
    const worst = rows.map((row, index) => {
      const values = inside.map((v) => v.margins[index]?.marginMs ?? null);
      const known = values.filter((v): v is number => v !== null);
      return {
        scene: row.scene,
        fact: row.fact,
        worstMarginMs: known.length === values.length ? Math.min(...known) : null,
      };
    });
    console.log('\nWorst margin inside the envelope (accepted by the pause):');
    for (const w of worst) {
      console.log(`  scene ${String(w.scene)}: ${w.fact}: ${minutes(w.worstMarginMs)}`);
    }
    for (const v of all) {
      const f = v.facts;
      console.log(
        `accepted ${v.accepted}: changeovers from ${f.productionStart === null ? '-' : plantClock(f.productionStart)}, first order ${f.firstCompletedOrder?.id ?? '-'}, scene 8's carton ${
          f.sceneCarton?.id ?? '-'
        }, episode ${f.episode ? `${f.episode.chart} rule ${String(f.episode.rule)} latency ${String(f.episode.latency)}` : '-'}, held order ${f.heldOrder?.id ?? '-'}, bottleneck ${JSON.stringify(f.bottleneck)}${
          v.problems.length > 0 ? `; PROBLEMS: ${v.problems.join('; ')}` : ''
        }`,
      );
    }
    const results = join(REPO, 'e2e/results/demo-probe');
    await mkdir(results, { recursive: true });
    await writeFile(
      join(results, 'd1.json'),
      `${JSON.stringify({ envelope: inside, beyond, worst, scenes: SCENES }, null, 2)}\n`,
    );
    const failed = inside.filter((v) => v.problems.length > 0);
    if (failed.length > 0) {
      console.error(`D1 FAILED inside the envelope: ${failed.map((v) => v.accepted).join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log(
        'D1-OK: every scene fact exists before its scene in every variant of the envelope',
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
