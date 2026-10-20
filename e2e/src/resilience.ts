/**
 * The resilience suite (#243, Phase 9 plan P9-16 "Resilience suite", exit criterion 5):
 * infrastructure and process faults during a live shift at 60×, each run on its own disposable
 * Compose project, every fault driven by this test at its scheduled simulated time.
 *
 * Each run is `orders-01`'s Monday shift A in orders mode (docker-compose.yml with
 * e2e/compose.reconcile.yml, e2e/compose.reconcile-orders.yml and e2e/compose.resilience.yml:
 * ephemeral host ports, nothing restarts by itself, the ERP serving orders-01's dataset, the
 * simulator writing its live event log). As in the reconciliation's orders pass the MES imports the
 * ERP's orders and the supervisor releases and dispatches them in the scenario's order while the
 * simulator waits idle at 06:00 (here through the API, each command confirmed by its device fact),
 * the scenario's shift A injections are posted, then the run resumes at 60×.
 *
 * Runs and schedules (Monday, Istanbul time):
 * - R1, no loss, infrastructure: broker restart at 07:00, database restart at 08:30, ERP mock
 *   stopped 09:45–10:45, WSH-01's Modbus device silent 11:45–12:00;
 * - R2, no loss, MES: SIGTERM at 07:00 and started at 08:00, SIGKILL at 10:00 and started at 11:00;
 * - R3, detected loss: CNC-01's OPC UA server offline 07:00–08:30, the gateway killed (SIGKILL) at
 *   10:45 and started at 10:50 (moved from the plan's 07:00–07:30 and 10:00–10:05, which lose
 *   nothing; ADR-0009 amendment; `RESILIENCE_R3_SCHEDULE=plan` runs that variant).
 * Infrastructure faults go through the control API, process faults through Docker on the
 * project's own containers (`docker restart`, `stop`, `kill` and `start` by container id, so no
 * dependency is started again and the `pki` step never reruns mid-run, #265). The simulated time
 * is read from the control API every 250 ms; an action is taken at the first reading at or past
 * its time, and its simulated time is the one read.
 *
 * Settled before each fault: at its scheduled time the system must have settled from the previous
 * one (from the run's start for the first), sampled for up to 5 s of wall time, else the run fails
 * naming the fault and every unsettled condition: readiness (MES, gateway with every device
 * connected, ERP mock); the gateway's buffer empty; ingest caught up: `mes_ingest_pending_messages`
 * ≤ 100 once the MES has that gauge (P9-18), until then its stand-in, the MES's plant clock at most
 * 60 simulated seconds behind the simulator with the UNS session subscribed, and per machine
 * every fact raised up to 60 simulated seconds ago settled in the MES; and every machine
 * final through the previous fault's end: its device stream settled (stored, or written off as a
 * reported gap, `ingest.source_cursor`) at least up to the last fact it raised at or before that
 * end (from the live event log), so a machine silent since before the fault counts as final.
 * Faults are at least 60 simulated minutes apart, from one fault's end to the next one's start:
 * a restart ends at the readiness of the whole system, a window at its scheduled end.
 *
 * After each fault: readiness within 30 s of wall time of the restart or the undo; the MES caught
 * up (the settled conditions through the fault's end); the metrics show the outage (gateway buffer
 * depth or broker session for the broker, `mes_ingest_suspensions_total` or readiness for the
 * database, the device's connection for the OPC UA and Modbus faults, the service's absence for a
 * stopped or killed one); and Playwright (e2e/browser/resilience) sees the overview reconnect, be
 * current within 2 s and stay live.
 *
 * No loss (R1, R2), after the drain: time per state, OEE per machine and work center, alarm KPIs,
 * the shift report, order and line OEE, units, quantities and confirmations, and the trace at 14:00
 * equal the live truth and are final (the reconciliation's own checks); every device fact the
 * simulator raised is stored exactly once; no `sequence-gap`, `ring-overrun` or `buffer-overflow`
 * incident; every MES message to the ERP sent and held by the ERP exactly once. R1 also asserts
 * that WSH-01 raised fewer facts in its silence than its 64-entry ring holds.
 *
 * Detected loss (R3), after the drain and the gap write-off: per machine the numbers in the MES's
 * `sequence-gap` incidents equal (raised − stored); every lost fact's time lies in
 * [outage start − ε, resync] with ε = 2 simulated minutes and its number at most the resync's
 * `asOfSeq`, the outage start being the simulated time read when the fault was taken and the resync
 * `asOfSeq` taken from the gateway's first resync snapshot after the session returned (its own
 * record), its time read from the simulator's event log, never from the system under test; the
 * observed maximum lead is recorded; the state resyncs (a new state anchor in the MES equal to the
 * simulator's state) within 10 s of wall time of the session's return; nothing stored twice; every
 * machine final; and the MES's shift A OEE and totals equal the golden harness's on the facts the MES
 * stored (apps/mes-server/src/resilience-replay.e2e.test.ts, after the stack is gone).
 *
 * Usage: pnpm test:resilience (under the heavy-suite lock). Environment: RESILIENCE_RUNS (default
 * `r1,r2,r3`), RESILIENCE_PROJECT (Compose project prefix, default shopfloor-resilience; each run
 * adds `-r1`, …), RESILIENCE_TAG (image tag, default resilience), RESILIENCE_SKIP_BUILD=1 (use the
 * images already built under that tag), RESILIENCE_KEEP_IMAGES=1 (keep them; removed by default),
 * RESILIENCE_DEADLINE_MS (per run, default 35 minutes). Results: e2e/results/resilience/results.json
 * (the VM, the host, the images, per run and fault the timings, the observed ε lead and the resync
 * times) and per run report.json, recovery.json, Playwright traces and compose.log on failure.
 * SIGINT, SIGTERM and SIGHUP stop every further Docker action, remove the running project, its env
 * file and the images this process built.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { formatIssues, loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { shiftSegments } from '@shopfloor/shift-calendar';
import { checkDisks, formatGib, pruneBuildCache } from '@shopfloor/test-kit/heavy-lock';
import {
  ErpClient,
  GatewayClient,
  MesClient,
  SimulatorClient,
  gauge,
  mesLogin,
  mesWrite,
  ordersTruthSchema,
  provisionUsers,
  type GroundTruth,
  type ScenarioInjection,
} from './clients.ts';
import {
  checkDispatch,
  checkImport,
  checkOrderOee,
  checkOrdersAfterDrain,
  lineOeeTruthSchema,
  stepUntil,
  until,
  type PassContext,
  type ScenarioDispatch,
} from './orders-pass.ts';
import { checkTraceAsOf, mesTrace, referenceRun } from './quality-pass.ts';
import {
  checkAlarmKpis,
  checkShiftOee,
  checkShiftReport,
  checkShiftStates,
  FINAL_WAIT_MS,
  type GoldenAlarmScopes,
} from './shift-checks.ts';
import { REPO, STACK_IMAGES, Stack, removeImages } from './stack.ts';
import { traceConfigOf, type TraceSectionJson } from './trace-shapes.ts';

const run = promisify(execFile);

const SPEED = 60;
const MINUTE = 60_000;
/** The scenario every run plays: its seed, start, dataset, dispatches and injections. */
const GOLDEN = 'orders-01';
const GOLDEN_DIR = join(REPO, 'apps/simulator/golden', GOLDEN);
const RESULTS = join(REPO, 'e2e/results/resilience');
const COMPOSE_FILES = ['e2e/compose.reconcile-orders.yml', 'e2e/compose.resilience.yml'];
const EVENT_LOG = '/tmp/resilience-events.jsonl';
/** Device facts: each takes its machine's next sequence number (machine servers, the golden feed). */
const DEVICE_FACTS = new Set(['state', 'cycle-complete', 'alarm', 'job']);
/** Incident types that mean lost data. */
const LOSS_INCIDENTS = new Set(['sequence-gap', 'ring-overrun', 'buffer-overflow']);
/** From one fault's end to the next one's start, in simulated time. */
const SPACING_MS = 60 * MINUTE;
/** The detected-loss window's lead before the outage start (2 s of wall time at 60×). */
const EPSILON_MS = 2 * MINUTE;
/** Wall time: readiness after a restart, the state's resync after the session returns. */
const READY_MS = 30_000;
const RESYNC_MS = 10_000;
/** How long the settled check at a fault's time may sample (wall). */
const SETTLE_MS = 5_000;
/** Ingest's stand-in for `mes_ingest_pending_messages` ≤ 100 (simulated, 1 s of wall time). */
const WATERMARK_LAG_MS = MINUTE;
const PENDING_LIMIT = 100;
/** WSH-01's ring of facts (docs/contracts/modbus-register-map.md). */
const WASHER_RING = 64;
/** Simulated time past the shift's end before the run pauses (5 wall seconds). */
const MARGIN_MS = 5 * MINUTE;
const STALL_MS = 30_000;
const DEADLINE_MS = Number(process.env.RESILIENCE_DEADLINE_MS ?? 35 * MINUTE);
const SUPERVISOR = 'resilience-supervisor';
const CHARACTERISTIC = 'leak-rate';

const istanbul = (hhmm: string) => Date.parse(`2026-10-12T${hhmm}:00+03:00`);
const iso = (at: number) => new Date(at).toISOString();

type Service = 'broker' | 'db' | 'erp' | 'mes' | 'gateway';
type FaultSpec =
  | { readonly kind: 'restart'; readonly service: 'broker' | 'db' }
  | { readonly kind: 'stop'; readonly service: 'erp' }
  | {
      readonly kind: 'kill';
      readonly service: 'mes' | 'gateway';
      readonly signal: 'SIGTERM' | 'SIGKILL';
    }
  | { readonly kind: 'opcua-offline'; readonly machine: string }
  | { readonly kind: 'modbus-silent' };

interface Fault {
  readonly name: string;
  readonly at: number;
  /** A window's scheduled end; none for a restart, which ends at readiness. */
  readonly until?: number;
  readonly spec: FaultSpec;
}

interface RunPlan {
  readonly title: string;
  readonly loss: 'none' | 'detected';
  readonly faults: readonly Fault[];
}

const RUNS = {
  r1: {
    title: 'no loss, infrastructure',
    loss: 'none',
    faults: [
      {
        name: 'broker restart',
        at: istanbul('07:00'),
        spec: { kind: 'restart', service: 'broker' },
      },
      { name: 'database restart', at: istanbul('08:30'), spec: { kind: 'restart', service: 'db' } },
      {
        name: 'ERP mock stopped',
        at: istanbul('09:45'),
        until: istanbul('10:45'),
        spec: { kind: 'stop', service: 'erp' },
      },
      {
        name: 'WSH-01 silent',
        at: istanbul('11:45'),
        until: istanbul('12:00'),
        spec: { kind: 'modbus-silent' },
      },
    ],
  },
  r2: {
    title: 'no loss, MES',
    loss: 'none',
    faults: [
      {
        name: 'MES SIGTERM',
        at: istanbul('07:00'),
        until: istanbul('08:00'),
        spec: { kind: 'kill', service: 'mes', signal: 'SIGTERM' },
      },
      {
        name: 'MES SIGKILL',
        at: istanbul('10:00'),
        until: istanbul('11:00'),
        spec: { kind: 'kill', service: 'mes', signal: 'SIGKILL' },
      },
    ],
  },
  r3: {
    title: 'detected loss',
    loss: 'detected',
    faults: [
      {
        name: 'CNC-01 OPC UA offline',
        at: istanbul('07:00'),
        until: istanbul('08:30'),
        spec: { kind: 'opcua-offline', machine: 'cnc-01' },
      },
      {
        name: 'gateway SIGKILL',
        at: istanbul('10:45'),
        until: istanbul('10:50'),
        spec: { kind: 'kill', service: 'gateway', signal: 'SIGKILL' },
      },
    ],
  },
} as const satisfies Record<string, RunPlan>;
type RunName = keyof typeof RUNS;

/**
 * R3 as the Phase 9 plan first scheduled it (`RESILIENCE_R3_SCHEDULE=plan`), a variant that loses
 * nothing: an OPC UA server offline keeps the gateway's session and subscription, which republish
 * every queued event on the reconnect (neither 30 s nor 90 s of wall time lost an event), and its
 * gateway kill at 10:00–10:05 lies in shift A's break (10:00–10:30), when no machine raises a fact.
 * The default R3 (the coordinator's decision on #243, ADR-0009 amendment) kills the gateway at
 * 10:45 while the line runs, so its new sessions start past the facts raised meanwhile and the
 * detected-loss assertions judge real gaps; it must lose at least one fact. This variant is
 * reported with `exercised: false` and is not a pass of exit criterion 5.
 */
const R3_PLAN: RunPlan = {
  title: 'detected loss (the plan’s first schedule, loses nothing)',
  loss: 'detected',
  faults: [
    {
      name: 'CNC-01 OPC UA offline',
      at: istanbul('07:00'),
      until: istanbul('07:30'),
      spec: { kind: 'opcua-offline', machine: 'cnc-01' },
    },
    {
      name: 'gateway SIGKILL',
      at: istanbul('10:00'),
      until: istanbul('10:05'),
      spec: { kind: 'kill', service: 'gateway', signal: 'SIGKILL' },
    },
  ],
};
const r3Schedule = process.env.RESILIENCE_R3_SCHEDULE ?? 'default';
if (r3Schedule !== 'default' && r3Schedule !== 'plan') {
  console.error(`RESILIENCE_R3_SCHEDULE must be default or plan, not "${r3Schedule}"`);
  process.exit(2);
}
const planOf = (name: RunName): RunPlan =>
  name === 'r3' && r3Schedule === 'plan' ? R3_PLAN : RUNS[name];
const RUN_NAMES = Object.keys(RUNS) as RunName[];

const projectPrefix = process.env.RESILIENCE_PROJECT ?? 'shopfloor-resilience';
const imageTag = process.env.RESILIENCE_TAG ?? 'resilience';
const skipBuild = process.env.RESILIENCE_SKIP_BUILD === '1';
const keepImages = process.env.RESILIENCE_KEEP_IMAGES === '1';
const runNames = (process.env.RESILIENCE_RUNS ?? RUN_NAMES.join(','))
  .split(',')
  .map((r) => r.trim())
  .filter((r): r is RunName => (RUN_NAMES as string[]).includes(r));

if (!/^[a-z0-9][a-z0-9_-]*$/.test(projectPrefix) || projectPrefix === 'shopfloor-twin') {
  console.error(`RESILIENCE_PROJECT must name disposable Compose projects, not "${projectPrefix}"`);
  process.exit(2);
}
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(imageTag) || imageTag === 'dev') {
  console.error(`RESILIENCE_TAG must name images of the suite's own, not "${imageTag}"`);
  process.exit(2);
}

const started = Date.now();
/** Set once this process starts building the images, so a signal removes them too. */
let imagesBuilt = false;
/** True while a run's own signal handler (stack, env file, images) is installed. */
let runSignals = false;
const log = (message: string) => {
  console.log(`[resilience +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
};

/** Polls `check` every `periodMs` until it holds; resolves with the wall ms it took, or rejects. */
async function poll(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
  periodMs = 250,
): Promise<number> {
  const from = Date.now();
  let last: unknown;
  for (;;) {
    try {
      if (await check()) return Date.now() - from;
    } catch (error) {
      last = error;
    }
    if (Date.now() - from > timeoutMs) {
      throw new Error(`timed out after ${String(timeoutMs)} ms: ${what}`, { cause: last });
    }
    await sleep(periodMs);
  }
}

// ---- The simulator's event log: what each machine raised ----

interface RaisedFact {
  readonly seq: number;
  readonly at: number;
  readonly type: string;
  readonly state?: string;
}

/** Per machine its device facts in order: the i-th is device sequence number i + 1. */
type Raised = ReadonlyMap<string, readonly RaisedFact[]>;

function raisedFacts(text: string): Map<string, RaisedFact[]> {
  const raised = new Map<string, RaisedFact[]>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const event = JSON.parse(line) as { type: string; at: string; machineId?: string; to?: string };
    if (event.machineId === undefined || !DEVICE_FACTS.has(event.type)) continue;
    const list = raised.get(event.machineId) ?? [];
    list.push({
      seq: list.length + 1,
      at: Date.parse(event.at),
      type: event.type,
      ...(event.to === undefined ? {} : { state: event.to }),
    });
    raised.set(event.machineId, list);
  }
  return raised;
}

/** The last fact a machine raised at or before `at` (its number), 0 for none. */
function lastSeqBy(facts: readonly RaisedFact[] | undefined, at: number): number {
  let seq = 0;
  for (const fact of facts ?? []) {
    if (fact.at > at) break;
    seq = fact.seq;
  }
  return seq;
}

// ---- The MES's device streams ----

interface StreamState {
  readonly epoch: number;
  /** Every number up to it stored or written off (a reported gap). */
  readonly settled: number;
  readonly seenMax: number;
}

type Range = readonly [number, number];

/** The end of the first contiguous run of `ranges` (seen ∪ reported). */
export function settledThrough(ranges: readonly Range[]): number {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let settled: number | undefined;
  for (const [from, to] of sorted) {
    if (settled === undefined) settled = to;
    else if (from <= settled + 1) settled = Math.max(settled, to);
    else break;
  }
  return settled ?? 0;
}

async function streams(stack: Stack): Promise<Map<string, StreamState>> {
  const rows = await stack.sqlJson<
    { stream: string; epoch: number; seen: Range[]; reported: Range[] }[]
  >(
    `SELECT coalesce(json_agg(json_build_object('stream', stream, 'epoch', epoch, 'seen', seen,
       'reported', reported)), '[]') FROM ingest.source_cursor WHERE stream LIKE 'device:%'`,
  );
  return new Map(
    rows.map((row) => [
      row.stream.slice('device:'.length),
      {
        epoch: row.epoch,
        settled: settledThrough([...row.seen, ...row.reported]),
        seenMax: Math.max(0, ...row.seen.map(([, to]) => to)),
      },
    ]),
  );
}

// ---- One run ----

interface Signals {
  samples: number;
  gatewayBufferMax: number;
  gatewayMqttDown: boolean;
  gatewayUnreachable: boolean;
  devicesDown: string[];
  mesUnready: boolean;
  mesUnreachable: boolean;
  erpUnready: boolean;
  suspensionsBefore: number | null;
  suspensionsMax: number | null;
  /** `mes_ingest_store_errors_total` before the fault and its highest value while it lasted. */
  storeErrorsBefore: number | null;
  storeErrorsMax: number | null;
  /**
   * Deliveries ingest dropped as duplicates (`mes_ingest_messages_total{outcome="duplicate"}`)
   * before the fault and at most while it lasted; the counter restarts with the MES. Recorded, not
   * asserted: the count may be 0 or more. A redelivery happens when the MES is killed between its
   * commit and its acknowledgement, or the broker restarts with QoS 1 messages in flight, and no
   * fault here forces either.
   */
  duplicatesBefore: number | null;
  duplicatesMax: number | null;
}

interface Resync {
  machine: string;
  /** Wall ms from the undo (or the gateway's start) until the gateway's session to it was up. */
  sessionBackMs: number | null;
  /** Wall ms from the session's return until the MES stored the new state anchor. */
  stateResyncMs: number | null;
  stateAnchor: { state: string; sourceTime: string; truthState: string | null } | null;
  /** The gateway's resync record: the first alarm snapshot after the return. */
  asOfSeq: number | null;
  /** The gateway's own time of that fact (the snapshot's `sourceTime`), for the record only. */
  asOfTime: string | null;
  /** The time of fact `asOfSeq` in the simulator's event log: the window's end. */
  asOfFactTime: string | null;
}

interface FaultReport {
  name: string;
  scheduled: { at: string; until?: string };
  settled?: {
    since: string;
    waitedMs: number;
    problems: string[];
    finalThrough: Record<string, string | null>;
    ingest: string;
  };
  spacingMs?: number;
  start?: { sim: string; wall: number };
  end?: { sim: string; wall: number };
  readinessMs?: number;
  readyAt?: number;
  caughtUp?: { wallMs: number; sim: string };
  exit?: { code: number | null; oomKilled: boolean; exitedMs: number };
  signals?: Signals;
  /** The outage's start (simulated, read at the action) and per machine its resync's `asOfSeq`. */
  outage?: { start: string; resync: Record<string, number | null> };
  resync?: Resync[];
}

type RunReport = Record<string, unknown> & { failures: string[]; faults: FaultReport[] };

/** The run's clients of the services a fault restarts (their host ports change). */
interface Clients {
  mes: MesClient;
  gateway: GatewayClient;
  erp: ErpClient;
}

async function runOne(
  name: RunName,
  plan: RunPlan,
  build: boolean,
  config: PlantConfig,
): Promise<RunReport> {
  const results = join(RESULTS, name);
  await mkdir(results, { recursive: true });
  const marks = join(results, 'marks.jsonl');
  await writeFile(marks, '');
  const project = `${projectPrefix}-${name}`;
  const report: RunReport = {
    run: name,
    title: plan.title,
    project,
    phasesMs: {},
    faults: [],
    failures: [],
  };
  const phases = report.phasesMs as Record<string, number>;
  let phaseStart = Date.now();
  const phase = (what: string) => {
    phases[what] = Date.now() - phaseStart;
    phaseStart = Date.now();
  };
  const fail = (message: string) => {
    report.failures.push(message);
    console.error(`FAIL ${name}: ${message}`);
  };
  log(`run ${name} (${plan.title}) on project ${project}`);

  const scenario = JSON.parse(await readFile(join(GOLDEN_DIR, 'scenario.json'), 'utf8')) as {
    seed: number;
    start: string;
    injections?: ScenarioInjection[];
    erp?: { dataset: string; release: string[] };
    dispatches?: ScenarioDispatch[];
  };
  const goldenSummary = JSON.parse(await readFile(join(GOLDEN_DIR, 'summary.json'), 'utf8')) as {
    orders: unknown;
    alarms: { scopes: GoldenAlarmScopes };
  };
  const goldenOrders = ordersTruthSchema.parse(goldenSummary.orders);
  const goldenLineOee = lineOeeTruthSchema.parse(
    JSON.parse(await readFile(join(GOLDEN_DIR, 'line-oee.json'), 'utf8')),
  );
  const start = Date.parse(scenario.start);
  const [shift] = shiftSegments(config.shifts, start, start + 24 * 3_600_000);
  if (shift?.from !== start || shift.key === 'no-shift') {
    throw new Error(`${scenario.start} is not the start of a shift`);
  }
  const shiftKey = shift.key;
  const workCenters = config.plant.areas.flatMap((area) => area.workCenters);
  const machines = workCenters.flatMap((wc) => wc.equipment.map((e) => e.id)).sort();
  const workCenterIds = workCenters.map((wc) => wc.id).sort();
  const injections = (scenario.injections ?? []).filter(
    (i) => Date.parse(i.at) >= shift.from && Date.parse(i.at) < shift.to,
  );
  // The schedule itself: in shift A, in order, each window inside it.
  let previousAt = start;
  for (const fault of plan.faults) {
    if (
      fault.at <= previousAt ||
      fault.at >= shift.to ||
      (fault.until !== undefined && (fault.until <= fault.at || fault.until >= shift.to))
    ) {
      throw new Error(`${name}: ${fault.name} is out of order or outside ${shiftKey}`);
    }
    previousAt = fault.until ?? fault.at;
  }

  const stack = new Stack({
    project,
    env: {
      SIM_SEED: String(scenario.seed),
      SIM_START: scenario.start,
      SIM_SPEED: String(SPEED),
      SIM_AUTOSTART: 'false',
      SIM_PRODUCTION: 'orders',
      ERP_POLL_MS: '1000',
      IMAGE_TAG: imageTag,
    },
    files: COMPOSE_FILES,
  });
  let browser: ChildProcess | undefined;
  let browserExit: Promise<number> | undefined;
  // A signal (#243 review): no Docker action of the run starts after it (`act`), so no late `up`
  // or `start` races the removal; then the stack, its env file and the images this process built.
  let aborted = false;
  const stop = (signal: NodeJS.Signals) => {
    if (aborted) return;
    aborted = true;
    console.error(`${signal}: removing the stack`);
    browser?.kill('SIGTERM');
    void stack
      .destroy()
      .catch((error: unknown) => {
        console.error('could not remove the stack', error);
      })
      .then(() => (imagesBuilt && !keepImages ? removeImages(imageTag) : undefined))
      .finally(() => {
        process.exit({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal as string] ?? 143);
      });
  };
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of SIGNALS) process.once(signal, stop);
  runSignals = true;
  /** A Compose call of the run, refused once a signal began the removal. */
  const compose = (args: readonly string[], timeoutMs?: number) =>
    aborted
      ? Promise.reject(new Error(`stopping: not running docker compose ${args.join(' ')}`))
      : stack.compose(args, timeoutMs);
  /** A Docker call of the run, refused the same way. */
  const docker = (args: readonly string[]) =>
    aborted
      ? Promise.reject(new Error(`stopping: not running docker ${args.join(' ')}`))
      : run('docker', args);
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      reject(new Error(`the run exceeded its deadline of ${String(DEADLINE_MS)} ms`));
    }, DEADLINE_MS);
  });
  const replayDir = join(results, 'replay');
  const replay = { ready: false };

  try {
    await Promise.race([
      deadline,
      (async () => {
        await stack.prepare();
        await compose(['down', '--volumes', '--remove-orphans']);
        if (build) {
          log('building the images');
          // Before the build (#268 re-review): a signal during it removes what it made so far.
          imagesBuilt = true;
          await compose(['build'], 1_200_000);
          await pruneBuildCache(log);
        }
        phase('build');

        // ---- Start, as the reconciliation's orders pass ----
        await compose(['up', '--detach', '--wait', '--no-build', 'db', 'broker', 'mes', 'erp']);
        const container = async (service: Service | 'simulator' | 'web') => {
          const id = (await compose(['ps', '--all', '--quiet', service])).trim();
          if (id === '' || id.includes('\n')) throw new Error(`no single ${service} container`);
          return id;
        };
        let mesBase = await stack.url('mes', 4700);
        await until('MES ready', () => new MesClient(mesBase).ready(), 60_000);
        const users = await provisionUsers(mesBase, stack.bootstrapAdminPassword, [
          { username: SUPERVISOR, roles: ['supervisor'] },
        ]);
        const supervisor = users.get(SUPERVISOR);
        if (!supervisor) throw new Error(`${SUPERVISOR} was not created`);
        const clients: Clients = {
          mes: new MesClient(mesBase, supervisor.cookie),
          gateway: new GatewayClient('http://127.0.0.1:1'),
          erp: new ErpClient(await stack.url('erp', 4600), stack.value('ERP_API_TOKEN')),
        };
        await compose(['up', '--detach', '--wait', '--no-build', 'simulator', 'gateway']);
        const sim = new SimulatorClient(
          await stack.url('simulator', 4800),
          stack.value('SIM_CONTROL_TOKEN'),
        );
        clients.gateway = new GatewayClient(await stack.url('gateway', 4900));
        const idle = await sim.status();
        if (idle.state !== 'idle' || Date.parse(idle.simTime) !== start) {
          throw new Error(
            `the simulator must wait idle at ${scenario.start}: ${JSON.stringify(idle)}`,
          );
        }
        const initial = await sim.groundTruth();
        const epoch = initial.epoch;
        const connected = async () => {
          if (!(await clients.gateway.ready())) return false;
          const devices = gauge(await clients.gateway.metrics(), 'gateway_device_connected');
          return machines.every((id) => devices.get(id) === 1);
        };
        await until('gateway ready with every machine connected', connected, 60_000);
        await until(
          "every machine's start-up state anchored in the MES",
          async () => {
            const { equipment } = await clients.mes.equipment();
            return machines.every((id) => {
              const current = equipment.find((e) => e.id === id)?.current;
              return current?.epoch === epoch && Date.parse(current.since) === start;
            });
          },
          60_000,
        );
        // History: what each machine raised before the gateway joined it (the run's start-up
        // states, before any dispatch). The gateway takes it as its baseline and the MES writes it
        // off as history without an incident (ADR-0017 amendment), so it is neither lost nor owed.
        const history = Object.fromEntries(
          [
            ...raisedFacts(await compose(['exec', '-T', 'simulator', 'cat', EVENT_LOG])).entries(),
          ].map(([id, facts]) => [id, facts.length]),
        );
        report.history = history;
        const context = (): PassContext => ({
          stack,
          mes: clients.mes,
          erp: clients.erp,
          sim,
          gateway: clients.gateway,
          log,
          fail,
        });
        report.import = await checkImport(context());
        // Release and dispatch through the API in the scenario's order, each command confirmed
        // by its `accepted` job fact before the next (ADR-0030, B3), as the UI does in the orders
        // pass.
        for (const id of scenario.erp?.release ?? []) {
          const { order } = await clients.mes.order(id);
          const answer = await mesWrite(
            mesBase,
            'POST',
            `/api/v1/orders/${encodeURIComponent(id)}/release`,
            { version: order.version },
            supervisor.cookie,
          );
          if (answer.status !== 200)
            throw new Error(`release ${id}: ${String(answer.status)} ${answer.text}`);
        }
        for (const dispatch of scenario.dispatches ?? []) {
          const { order } = await clients.mes.order(dispatch.orderId);
          const answer = await mesWrite(
            mesBase,
            'POST',
            `/api/v1/orders/${encodeURIComponent(dispatch.orderId)}/dispatch`,
            { version: order.version },
            supervisor.cookie,
          );
          if (answer.status !== 200) {
            throw new Error(
              `dispatch ${dispatch.orderId}: ${String(answer.status)} ${answer.text}`,
            );
          }
          await until(
            `${dispatch.commandId} confirmed by its device fact`,
            async () => {
              const { commands } = await clients.mes.order(dispatch.orderId);
              return (
                JSON.stringify(
                  commands.map((c) => [c.commandId, c.equipment, c.confirmed, c.state]),
                ) === JSON.stringify([[dispatch.commandId, dispatch.machine, true, 'accepted']])
              );
            },
            60_000,
          );
        }
        report.dispatch = await checkDispatch(
          context(),
          scenario.dispatches ?? [],
          goldenOrders.jobs,
        );
        for (const injection of injections) {
          const posted = await sim.inject(injection);
          if (posted.status !== 'scheduled')
            throw new Error(`injection not scheduled: ${JSON.stringify(posted)}`);
        }
        await compose(['up', '--detach', '--wait', '--no-build', 'web']);
        const trust = await stack.webTrust();
        phase('ready');

        // ---- The browser: the overview open through the whole run ----
        browser = spawn('pnpm', ['exec', 'playwright', 'test', '--project', 'resilience'], {
          cwd: join(REPO, 'e2e'),
          env: {
            ...process.env,
            ...trust.env,
            RECONCILE_WEB_URL: trust.url,
            RECONCILE_SIM_URL: sim.base,
            RECONCILE_SIM_TOKEN: stack.value('SIM_CONTROL_TOKEN'),
            RECONCILE_RESULTS: results,
            RECONCILE_USERNAME: SUPERVISOR,
            RECONCILE_PASSWORD: supervisor.password,
            RESILIENCE_MARKS: marks,
          },
          stdio: 'inherit',
        });
        const child = browser;
        browserExit = new Promise<number>((resolve) => {
          child.on('exit', (code) => {
            resolve(code ?? 1);
          });
          child.on('error', () => {
            resolve(1);
          });
        });
        const mark = (entry: Record<string, unknown>) =>
          appendFile(marks, `${JSON.stringify(entry)}\n`);

        // ---- Helpers bound to this run ----
        const eventLog = async (): Promise<Raised> =>
          raisedFacts(await compose(['exec', '-T', 'simulator', 'cat', EVENT_LOG]));
        const mesMetrics = async () => {
          const response = await fetch(`${clients.mes.base}/metrics`, {
            signal: AbortSignal.timeout(2_000),
          });
          return response.text();
        };
        const resolveUrls = async (service: Service) => {
          if (service === 'mes') {
            mesBase = await stack.url('mes', 4700);
            const login = await mesLogin(mesBase, SUPERVISOR, supervisor.password);
            clients.mes = new MesClient(mesBase, login.cookie);
          } else if (service === 'gateway') {
            clients.gateway = new GatewayClient(await stack.url('gateway', 4900));
          } else if (service === 'erp') {
            clients.erp = new ErpClient(await stack.url('erp', 4600), stack.value('ERP_API_TOKEN'));
          }
        };
        /** Every unsettled condition, measured once (empty: settled through `since`). */
        const unsettled = async (since: number, raised: Raised) => {
          const problems: string[] = [];
          const safe = <T>(promise: Promise<T>) => promise.catch(() => undefined);
          const [mesReady, gwReady, gwText, erpReady, plant, status, mesText, cursor] =
            await Promise.all([
              clients.mes.ready(),
              clients.gateway.ready(),
              safe(clients.gateway.metrics()),
              safe(
                fetch(`${clients.erp.base}/health/ready`, {
                  signal: AbortSignal.timeout(2_000),
                }).then((r) => r.ok),
              ),
              safe(clients.mes.plant()),
              sim.status(),
              safe(mesMetrics()),
              streams(stack),
            ]);
          if (!mesReady) problems.push('readiness: the MES is not ready');
          if (!gwReady) problems.push('readiness: the gateway is not ready');
          if (erpReady !== true) problems.push('readiness: the ERP mock is not ready');
          const devices = gauge(gwText ?? '', 'gateway_device_connected');
          const down = machines.filter((id) => devices.get(id) !== 1);
          if (down.length > 0)
            problems.push(`readiness: not connected at the gateway: ${down.join(', ')}`);
          const buffered = gauge(gwText ?? '', 'gateway_buffer_messages').get('');
          if (buffered !== 0)
            problems.push(`gateway buffer: ${String(buffered)} messages not acknowledged`);
          const pending = gauge(mesText ?? '', 'mes_ingest_pending_messages').get('');
          let ingest: string;
          if (pending !== undefined) {
            ingest = `mes_ingest_pending_messages ${String(pending)}`;
            if (pending > PENDING_LIMIT)
              problems.push(`ingest: ${ingest} > ${String(PENDING_LIMIT)}`);
          } else {
            const subscribed = gauge(mesText ?? '', 'mes_ingest_subscribed').get('');
            const lag =
              plant?.clock?.epoch === epoch
                ? Date.parse(status.simTime) - Date.parse(plant.clock.watermark)
                : Number.POSITIVE_INFINITY;
            ingest = `watermark ${plant?.clock?.watermark ?? 'none'} at ${status.simTime} (lag ${String(lag)} ms), subscribed ${String(subscribed)}`;
            if (subscribed !== 1) problems.push('ingest: the MES is not subscribed to the UNS');
            if (lag > WATERMARK_LAG_MS) {
              problems.push(
                `ingest: the MES's plant clock is ${String(lag / 1000)} simulated s behind (${ingest})`,
              );
            }
            // The clock is an aggregate (#243 review): per machine too, every fact raised up to
            // 60 simulated seconds ago (1 s of wall time) settled in the MES.
            const fresh = await eventLog();
            const recent = Date.parse(status.simTime) - WATERMARK_LAG_MS;
            for (const id of machines) {
              const needed = lastSeqBy(fresh.get(id), recent);
              const stream = cursor.get(id);
              const settled = stream?.epoch === epoch ? stream.settled : 0;
              if (settled < needed) {
                problems.push(
                  `ingest: ${id} is settled through seq ${String(settled)}, its facts up to ${iso(recent)} (60 simulated s ago) run to seq ${String(needed)}`,
                );
              }
            }
          }
          const finalThrough: Record<string, string | null> = {};
          for (const id of machines) {
            const facts = raised.get(id);
            const needed = lastSeqBy(facts, since);
            const stream = cursor.get(id);
            const settled = stream?.epoch === epoch ? stream.settled : 0;
            const at = facts?.[settled - 1]?.at;
            finalThrough[id] = at === undefined ? null : iso(at);
            if (settled < needed) {
              problems.push(
                `final-through: ${id} is settled through seq ${String(settled)} (${finalThrough[id] ?? 'nothing'}), its facts up to ${iso(since)} run to seq ${String(needed)}`,
              );
            }
          }
          return { problems, finalThrough, ingest };
        };
        const ready = async (affected?: string) => {
          const [mesReady, gwReady, gwText, erpReady] = await Promise.all([
            clients.mes.ready(),
            clients.gateway.ready(),
            clients.gateway.metrics().catch(() => ''),
            fetch(`${clients.erp.base}/health/ready`, { signal: AbortSignal.timeout(2_000) }).then(
              (r) => r.ok,
              () => false,
            ),
          ]);
          const devices = gauge(gwText, 'gateway_device_connected');
          return (
            mesReady &&
            gwReady &&
            erpReady &&
            (affected === undefined
              ? machines.every((id) => devices.get(id) === 1)
              : devices.get(affected) === 1)
          );
        };

        // ---- The outage's signals, sampled in the background while a fault is active ----
        let active: Signals | undefined;
        let sampling = false;
        const sample = () => {
          const signals = active;
          if (!signals || sampling) return;
          sampling = true;
          void (async () => {
            try {
              signals.samples++;
              const gw = await clients.gateway.metrics().catch(() => undefined);
              if (gw === undefined) signals.gatewayUnreachable = true;
              else {
                const buffered = gauge(gw, 'gateway_buffer_messages').get('') ?? 0;
                signals.gatewayBufferMax = Math.max(signals.gatewayBufferMax, buffered);
                if (gauge(gw, 'gateway_mqtt_connected').get('') === 0)
                  signals.gatewayMqttDown = true;
                const devices = gauge(gw, 'gateway_device_connected');
                for (const id of machines) {
                  if (devices.get(id) === 0 && !signals.devicesDown.includes(id))
                    signals.devicesDown.push(id);
                }
              }
              if (!(await clients.mes.ready())) signals.mesUnready = true;
              const text = await mesMetrics().catch(() => undefined);
              if (text === undefined) signals.mesUnreachable = true;
              else {
                const suspensions = gauge(text, 'mes_ingest_suspensions_total').get('') ?? 0;
                signals.suspensionsMax = Math.max(signals.suspensionsMax ?? 0, suspensions);
                const errors = gauge(text, 'mes_ingest_store_errors_total').get('') ?? 0;
                signals.storeErrorsMax = Math.max(signals.storeErrorsMax ?? 0, errors);
                const dropped = gauge(text, 'mes_ingest_messages_total').get('duplicate') ?? 0;
                signals.duplicatesMax = Math.max(signals.duplicatesMax ?? 0, dropped);
              }
              const erpOk = await fetch(`${clients.erp.base}/health/ready`, {
                signal: AbortSignal.timeout(1_000),
              }).then(
                (r) => r.ok,
                () => false,
              );
              if (!erpOk) signals.erpUnready = true;
            } finally {
              sampling = false;
            }
          })();
        };

        let lastMove = { wall: Date.now(), sim: start };
        let progressAt = 0;
        /** Waits until the simulation reaches `target`; resolves with the simulated time read. */
        const waitSim = async (target: number): Promise<number> => {
          for (;;) {
            const status = await sim.status();
            const now = Date.parse(status.simTime);
            if (status.state !== 'running')
              throw new Error(`simulator ${status.state} at ${status.simTime}`);
            if (now > lastMove.sim) lastMove = { wall: Date.now(), sim: now };
            if (Date.now() - lastMove.wall > STALL_MS) {
              throw new Error(
                `simulation time stalled at ${status.simTime} for ${String(STALL_MS)} ms`,
              );
            }
            if (Date.now() - progressAt > 60_000) {
              progressAt = Date.now();
              log(`${name}: simulation at ${status.simTime}, lag ${String(status.lagMs)} ms`);
            }
            if (now >= target) return now;
            await sleep(250);
          }
        };

        // ---- R3's resync record: anchors and alarm snapshots of the MES, per machine ----
        const anchorsNow = () =>
          stack.sqlJson<Record<string, { arrival: number }>>(
            `SELECT coalesce(json_object_agg(equipment, json_build_object('arrival', arrival)), '{}')
             FROM (SELECT equipment, max(arrival) AS arrival FROM ingest.state_anchor GROUP BY equipment) t`,
          );
        const snapshotsNow = () =>
          stack.sqlJson<
            Record<string, { epoch: number; seq: number; asOfSeq: number; sourceTime: string }>
          >(
            `SELECT coalesce(json_object_agg(equipment, json_build_object('epoch', epoch, 'seq', seq,
               'asOfSeq', as_of_seq, 'sourceTime', source_time)), '{}')
             FROM ingest.alarm_snapshot WHERE device_epoch = ${String(epoch)}`,
          );
        /** Per machine the first state snapshot the MES stored after `after`'s arrival. */
        const newAnchors = async (after: Record<string, { arrival: number }>) => {
          const from = Math.min(...machines.map((id) => after[id]?.arrival ?? 0));
          const rows = await stack.sqlJson<
            { equipment: string; arrival: number; state: string; sourceTime: string }[]
          >(
            `SELECT coalesce(json_agg(json_build_object('equipment', equipment, 'arrival', arrival,
               'state', state, 'sourceTime', source_time) ORDER BY arrival), '[]')
             FROM ingest.state_anchor WHERE kind = 'snapshot' AND arrival > ${String(from)}`,
          );
          const first: Record<string, { state: string; sourceTime: string }> = {};
          for (const row of rows) {
            if (row.arrival > (after[row.equipment]?.arrival ?? 0)) {
              first[row.equipment] ??= { state: row.state, sourceTime: row.sourceTime };
            }
          }
          return first;
        };

        // ---- Go ----
        log(`${name}: resuming at ${String(SPEED)}× from ${scenario.start}`);
        await sim.resume();
        let previousEnd = start;
        let previousName = 'the run start';
        for (const fault of plan.faults) {
          const record: FaultReport = {
            name: fault.name,
            scheduled: {
              at: iso(fault.at),
              ...(fault.until === undefined ? {} : { until: iso(fault.until) }),
            },
          };
          report.faults.push(record);
          await waitSim(fault.at);
          // Settled from the previous fault: the event log is complete far beyond its end.
          const raisedBefore = await eventLog();
          const settleFrom = Date.now();
          let settled = await unsettled(previousEnd, raisedBefore);
          while (settled.problems.length > 0 && Date.now() - settleFrom < SETTLE_MS) {
            await sleep(250);
            settled = await unsettled(previousEnd, raisedBefore);
          }
          record.settled = {
            since: iso(previousEnd),
            waitedMs: Date.now() - settleFrom,
            problems: settled.problems,
            finalThrough: settled.finalThrough,
            ingest: settled.ingest,
          };
          if (settled.problems.length > 0) {
            throw new Error(
              `${fault.name}: the system has not settled from ${previousName} at ${iso(fault.at)}: ${settled.problems.join('; ')}`,
            );
          }
          record.spacingMs = fault.at - previousEnd;
          if (record.spacingMs < SPACING_MS) {
            throw new Error(
              `${fault.name}: starts ${String(record.spacingMs / MINUTE)} simulated minutes after ${previousName} ended, not at least 60`,
            );
          }
          const signals: Signals = {
            samples: 0,
            gatewayBufferMax: 0,
            gatewayMqttDown: false,
            gatewayUnreachable: false,
            devicesDown: [],
            mesUnready: false,
            mesUnreachable: false,
            erpUnready: false,
            suspensionsBefore: null,
            suspensionsMax: null,
            storeErrorsBefore: null,
            storeErrorsMax: null,
            duplicatesBefore: null,
            duplicatesMax: null,
          };
          // The counters before the fault, then a sample every 250 ms until the MES caught up.
          const before = await mesMetrics().catch(() => '');
          signals.suspensionsBefore = gauge(before, 'mes_ingest_suspensions_total').get('') ?? 0;
          signals.storeErrorsBefore = gauge(before, 'mes_ingest_store_errors_total').get('') ?? 0;
          signals.duplicatesBefore =
            gauge(before, 'mes_ingest_messages_total').get('duplicate') ?? 0;
          record.signals = signals;
          active = signals;
          const sampler = setInterval(sample, 250);
          const spec = fault.spec;
          const affected =
            spec.kind === 'opcua-offline'
              ? spec.machine
              : spec.kind === 'modbus-silent'
                ? 'wsh-01'
                : undefined;
          const resyncMachines =
            spec.kind === 'opcua-offline'
              ? [spec.machine]
              : spec.kind === 'kill' && spec.service === 'gateway'
                ? machines
                : [];
          const anchorsBefore = resyncMachines.length > 0 ? await anchorsNow() : {};
          const snapshotsBefore = resyncMachines.length > 0 ? await snapshotsNow() : {};

          // The fault.
          const startStatus = await sim.status();
          record.start = { sim: startStatus.simTime, wall: Date.now() };
          log(`${name}: ${fault.name} at ${startStatus.simTime}`);
          let back: number;
          if (spec.kind === 'restart') {
            await docker(['restart', '--time', '15', await container(spec.service)]);
            back = record.start.wall;
          } else {
            if (spec.kind === 'stop') {
              await docker(['stop', '--time', '10', await container(spec.service)]);
            } else if (spec.kind === 'kill') {
              const id = await container(spec.service);
              await docker(['kill', '--signal', spec.signal, id]);
              const exitedMs = await poll(
                `${spec.service} exited after ${spec.signal}`,
                async () =>
                  (
                    await docker(['inspect', '--format', '{{.State.Running}}', id])
                  ).stdout.trim() === 'false',
                30_000,
              );
              const state = JSON.parse(
                (await docker(['inspect', '--format', '{{json .State}}', id])).stdout,
              ) as { ExitCode: number; OOMKilled: boolean };
              record.exit = { code: state.ExitCode, oomKilled: state.OOMKilled, exitedMs };
            } else if (spec.kind === 'opcua-offline') {
              await sim.opcuaOffline(spec.machine, true);
            } else {
              await sim.modbusSilent(true);
            }
            await waitSim(fault.until ?? fault.at);
            if (spec.kind === 'stop' || spec.kind === 'kill') {
              await docker(['start', await container(spec.service)]);
            } else if (spec.kind === 'opcua-offline') {
              await sim.opcuaOffline(spec.machine, false);
            } else {
              await sim.modbusSilent(false);
            }
            back = Date.now();
          }
          const undone = await sim.status();
          // Readiness: the restarted service's new host port, then every service (or the device).
          const service = 'service' in spec ? spec.service : undefined;
          if (service !== undefined) {
            await poll(
              `${service}'s host port`,
              async () => {
                await resolveUrls(service);
                return true;
              },
              60_000,
              500,
            );
          }
          const sessionBack = new Map<string, number>();
          await poll(
            `${fault.name}: every service ready again`,
            async () => {
              if (resyncMachines.length > 0) {
                const devices = gauge(
                  await clients.gateway.metrics().catch(() => ''),
                  'gateway_device_connected',
                );
                for (const id of resyncMachines) {
                  if (devices.get(id) === 1 && !sessionBack.has(id))
                    sessionBack.set(id, Date.now());
                }
              }
              return ready(affected);
            },
            120_000,
          ).catch((error: unknown) => {
            throw new Error(`${fault.name}: ${String(error)}`, { cause: error });
          });
          const readyAt = Date.now();
          record.readyAt = readyAt;
          record.readinessMs = readyAt - back;
          const readyStatus = await sim.status();
          // A restart ends at the readiness of the whole system, a window at its scheduled end.
          const endSim =
            spec.kind === 'restart' ? Date.parse(readyStatus.simTime) : (fault.until ?? fault.at);
          record.end = {
            sim: spec.kind === 'restart' ? readyStatus.simTime : undone.simTime,
            wall: readyAt,
          };
          if (record.readinessMs > READY_MS) {
            fail(
              `${fault.name}: ready again ${String(record.readinessMs)} ms after ${spec.kind === 'restart' ? 'the restart' : 'it was undone'}, not within ${String(READY_MS)} ms`,
            );
          }

          // R3: the session's return, the state's resync and the gateway's record of it.
          if (resyncMachines.length > 0) {
            const resyncs: Resync[] = [];
            const anchorAt = new Map<
              string,
              { state: string; sourceTime: string; seenAt: number }
            >();
            const snapshotAt = new Map<string, { asOfSeq: number; sourceTime: string }>();
            // A machine that raised a fact since its last snapshot owes a new one (#243 review: the
            // window's end must not be missed by a poll that saw the anchor first).
            const raisedAtReturn = await eventLog();
            const owed = resyncMachines.filter((id) => {
              const before = snapshotsBefore[id];
              return (raisedAtReturn.get(id)?.length ?? 0) > (before?.asOfSeq ?? 0);
            });
            await poll(
              `${fault.name}: a resync snapshot and state anchor of ${resyncMachines.join(', ')}`,
              async () => {
                const devices = gauge(
                  await clients.gateway.metrics().catch(() => ''),
                  'gateway_device_connected',
                );
                for (const id of resyncMachines) {
                  if (devices.get(id) === 1 && !sessionBack.has(id))
                    sessionBack.set(id, Date.now());
                }
                const [anchors, snapshots] = await Promise.all([
                  newAnchors(anchorsBefore),
                  snapshotsNow(),
                ]);
                for (const id of resyncMachines) {
                  const anchor = anchors[id];
                  if (anchor && !anchorAt.has(id))
                    anchorAt.set(id, { ...anchor, seenAt: Date.now() });
                  const before = snapshotsBefore[id];
                  const now = snapshots[id];
                  if (
                    now &&
                    !snapshotAt.has(id) &&
                    (now.epoch !== before?.epoch || now.seq !== before.seq)
                  ) {
                    snapshotAt.set(id, { asOfSeq: now.asOfSeq, sourceTime: now.sourceTime });
                  }
                }
                // A machine whose number did not move since the last snapshot keeps that one.
                return (
                  resyncMachines.every((id) => anchorAt.has(id)) &&
                  owed.every((id) => snapshotAt.has(id))
                );
              },
              60_000,
            ).catch((error: unknown) => {
              fail(error instanceof Error ? error.message : String(error));
            });
            const raisedNow = await eventLog();
            for (const id of resyncMachines) {
              const session = sessionBack.get(id);
              const anchor = anchorAt.get(id);
              const snapshot = snapshotAt.get(id);
              const facts = raisedNow.get(id) ?? [];
              let truthState: string | null = null;
              if (anchor) {
                const at = Date.parse(anchor.sourceTime);
                const lastState = [...facts]
                  .reverse()
                  .find((f) => f.type === 'state' && f.at <= at);
                truthState = lastState?.state ?? 'Off';
              }
              const resync: Resync = {
                machine: id,
                sessionBackMs: session === undefined ? null : session - back,
                stateResyncMs:
                  session === undefined || anchor === undefined
                    ? null
                    : Math.max(0, anchor.seenAt - session),
                stateAnchor: anchor
                  ? { state: anchor.state, sourceTime: anchor.sourceTime, truthState }
                  : null,
                asOfSeq: snapshot?.asOfSeq ?? null,
                asOfTime: snapshot ? new Date(snapshot.sourceTime).toISOString() : null,
                asOfFactTime:
                  snapshot && facts[snapshot.asOfSeq - 1]
                    ? iso(facts[snapshot.asOfSeq - 1]?.at ?? 0)
                    : null,
              };
              resyncs.push(resync);
              if (resync.stateResyncMs === null || resync.stateResyncMs > RESYNC_MS) {
                fail(
                  `${fault.name}: ${id}'s state resynced ${String(resync.stateResyncMs)} ms after its session returned, not within ${String(RESYNC_MS)} ms`,
                );
              }
              if (anchor && anchor.state !== truthState) {
                fail(
                  `${fault.name}: ${id}'s resync anchor says ${anchor.state} at ${anchor.sourceTime}, the simulator ${String(truthState)}`,
                );
              }
            }
            record.resync = resyncs;
            record.outage = {
              start: record.start.sim,
              resync: Object.fromEntries(resyncs.map((r) => [r.machine, r.asOfSeq])),
            };
          }

          // Caught up: settled through the fault's end, as before the next one.
          await sleep(1_000);
          const raisedAfter = await eventLog();
          let last: Awaited<ReturnType<typeof unsettled>> | undefined;
          await poll(
            `${fault.name}: the MES caught up`,
            async () => {
              last = await unsettled(endSim, raisedAfter);
              return last.problems.length === 0;
            },
            180_000,
            500,
          ).catch((error: unknown) => {
            throw new Error(`${String(error)}: ${last?.problems.join('; ') ?? ''}`, {
              cause: error,
            });
          });
          const caughtUpAt = Date.now();
          record.caughtUp = { wallMs: caughtUpAt - readyAt, sim: (await sim.status()).simTime };
          active = undefined;
          clearInterval(sampler);
          await mark({ fault: fault.name, readyAt, caughtUpAt });
          // The metrics show the outage.
          const shown =
            spec.kind === 'restart' && spec.service === 'broker'
              ? signals.gatewayBufferMax > 0 || signals.gatewayMqttDown
              : spec.kind === 'restart'
                ? signals.mesUnready ||
                  (signals.suspensionsMax ?? 0) > signals.suspensionsBefore ||
                  (signals.storeErrorsMax ?? 0) > signals.storeErrorsBefore
                : spec.kind === 'stop'
                  ? signals.erpUnready
                  : spec.kind === 'kill'
                    ? spec.service === 'mes'
                      ? signals.mesUnreachable
                      : signals.gatewayUnreachable
                    : signals.devicesDown.includes(affected ?? '');
          if (!shown)
            fail(`${fault.name}: the metrics did not show the outage: ${JSON.stringify(signals)}`);
          log(
            `${name}: ${fault.name} over: ${JSON.stringify({ readinessMs: record.readinessMs, caughtUp: record.caughtUp, signals })}`,
          );
          previousEnd = endSim;
          previousName = fault.name;
        }

        // ---- The rest of the shift, then a fact of every machine after its end ----
        await waitSim(shift.to + MARGIN_MS);
        await sim.pause();
        const shiftEnd = iso(shift.to);
        const factsAfterEnd = () =>
          stack.sqlJson<Record<string, number>>(
            `SELECT coalesce(json_object_agg(equipment, ms), '{}') FROM (
               SELECT equipment,
                 (extract(epoch FROM min(source_time) - '${shiftEnd}'::timestamptz) * 1000)::bigint AS ms
               FROM ingest.equipment_event
               WHERE epoch = ${String(epoch)}
                 AND source_time >= '${shiftEnd}'::timestamptz + interval '1 second'
               GROUP BY equipment) AS t`,
          );
        report.silentSteps = await stepUntil(
          context(),
          'a fact of every machine after the shift end',
          async () => {
            const after = await factsAfterEnd();
            return machines.every((id) => after[id] !== undefined);
          },
        ).catch((error: unknown) => {
          // R3: a machine whose current state the MES never learned may hold stepUntil's check.
          if (plan.loss === 'none') throw error;
          fail(String(error));
          return -1;
        });
        await mark({ done: true });
        phase('shift');

        // ---- Drain: everything raised settled, the buffer empty, the clock past the shift ----
        const raisedFinal = await eventLog();
        const paused = await sim.status();
        let drainProblems: string[] = [];
        await poll(
          'the MES drained',
          async () => {
            drainProblems = (await unsettled(Date.parse(paused.simTime), raisedFinal)).problems;
            return drainProblems.length === 0;
          },
          180_000,
          500,
        ).catch((error: unknown) => {
          throw new Error(`${String(error)}: ${drainProblems.join('; ')}`, { cause: error });
        });
        phase('drain');
        const truth: GroundTruth = await sim.groundTruth();
        if (truth.buckets[shiftKey]?.complete !== true) fail(`${shiftKey} is not complete`);

        // ---- What every run asserts: raised against stored, duplicates, the browser ----
        const stored = await stack.sqlJson<Record<string, number[]>>(
          `SELECT coalesce(json_object_agg(equipment, seqs), '{}') FROM (
             SELECT equipment, json_agg(seq ORDER BY seq) AS seqs FROM ingest.equipment_event
             WHERE epoch = ${String(epoch)} GROUP BY equipment) t`,
        );
        // Two rows of one (equipment, epoch, seq), whatever their times: the table's unique key
        // includes `source_time` (a hypertable's key must), so a copy with another time would
        // pass it; this count does not.
        const duplicates = await stack.sqlJson<number>(
          `SELECT count(*) - count(DISTINCT (equipment, epoch, seq)) FROM ingest.equipment_event`,
        );
        if (duplicates !== 0) fail(`${String(duplicates)} device facts stored more than once`);
        const lost: Record<string, number[]> = {};
        const unexpected: Record<string, number[]> = {};
        for (const id of machines) {
          const storedSet = new Set(stored[id] ?? []);
          const raised = raisedFinal.get(id) ?? [];
          lost[id] = raised
            .filter((f) => f.seq > (history[id] ?? 0) && !storedSet.has(f.seq))
            .map((f) => f.seq);
          unexpected[id] = [...storedSet].filter((seq) => seq < 1 || seq > raised.length);
          if ((unexpected[id] ?? []).length > 0) {
            fail(
              `${id}: stored numbers the simulator never raised: ${JSON.stringify(unexpected[id])}`,
            );
          }
        }
        const incidents = await stack.sqlJson<
          {
            origin: string;
            type: string;
            equipment: string | null;
            seqFrom: number;
            seqTo: number;
            lost: number | null;
            message: string;
          }[]
        >(
          `SELECT coalesce(json_agg(json_build_object('origin', origin, 'type', type,
             'equipment', equipment, 'seqFrom', seq_from, 'seqTo', seq_to, 'lost', lost,
             'message', message, 'resolution', resolution) ORDER BY id), '[]')
           FROM ingest.data_quality_incident`,
        );
        const lossIncidents = incidents.filter((i) => LOSS_INCIDENTS.has(i.type));
        const simMetrics = await fetch(`${sim.base}/metrics`).then((r) => r.text());
        if (gauge(simMetrics, 'sim_event_log_failed').get('') === 1)
          fail('the live event log failed to write');
        const dedup = await mesMetrics()
          .then((text) => gauge(text, 'mes_ingest_messages_total'))
          .catch(() => undefined);
        report.facts = {
          raised: Object.fromEntries(machines.map((id) => [id, raisedFinal.get(id)?.length ?? 0])),
          stored: Object.fromEntries(machines.map((id) => [id, stored[id]?.length ?? 0])),
          lost: Object.fromEntries(Object.entries(lost).map(([id, l]) => [id, l.length])),
          duplicatesStored: duplicates,
          // Deliveries by outcome since the MES's last start (duplicates dropped by dedup).
          deliveries: dedup === undefined ? null : Object.fromEntries(dedup),
        };
        report.incidents = incidents.map(({ origin, type, equipment, seqFrom, seqTo, lost }) => ({
          origin,
          type,
          equipment,
          seqFrom,
          seqTo,
          lost,
        }));
        phase('facts');

        const noLossChecks = async () => {
          const ctx = context();
          const totals = await clients.mes.shiftTotals(shiftKey);
          report.states = checkShiftStates(totals.totals, truth, machines, shift, fail).machines;
          report.oee = await checkShiftOee(
            clients.mes,
            truth,
            machines,
            workCenterIds,
            shiftKey,
            fail,
          );
          report.alarms = (
            await checkAlarmKpis(
              clients.mes,
              truth,
              goldenSummary.alarms.scopes,
              GOLDEN,
              shift,
              fail,
            )
          ).report;
          const shiftReport = await checkShiftReport(clients.mes, truth, shiftKey, shift, machines);
          for (const failure of shiftReport.failures) fail(`${shiftKey} report: ${failure}`);
          report.shiftReport = shiftReport;
          phase('shiftChecks');
          report.orders = await checkOrdersAfterDrain(
            ctx,
            truth,
            goldenOrders,
            shift.to,
            config.products.operations,
          );
          report.orderOee = (
            await checkOrderOee(ctx, { from: shift.from, to: shift.to, shiftKey }, goldenLineOee)
          ).report;
          phase('orders');
          // The trace at 14:00 (the quality pass's time cut, on orders-01: no drift).
          const cutIso = iso(shift.to);
          const reference = await referenceRun(GOLDEN, cutIso);
          const liveJson = await sim.groundTruthJson(cutIso);
          if (liveJson.traceAsOf !== cutIso) fail(`the live truth was not cut at ${cutIso}`);
          const side = await mesTrace(
            ctx,
            traceConfigOf(config),
            config.process.leakTest.resolution,
            epoch,
            reference.section.orders.map((o) => o.orderId),
          );
          report.trace = await checkTraceAsOf(ctx, {
            cut: shift.to,
            reference,
            live: liveJson.trace as TraceSectionJson,
            mes: side,
            characteristic: CHARACTERISTIC,
            drift: false,
            unreleased: (await clients.mes.orders()).orders
              .map((o) => o.id)
              .filter((id) => !(scenario.erp?.release ?? []).includes(id)),
            minimum: { orders: 5, firstPass: 100, episodes: 0 },
          });
          phase('trace');
          // Every MES message to the ERP sent, and held by the ERP exactly once.
          await until(
            'the outbox sent every message',
            async () =>
              (await stack.sqlJson<number>(
                `SELECT count(*) FROM orders.erp_message_log WHERE direction = 'out' AND status <> 'sent'`,
              )) === 0,
            120_000,
          ).catch((error: unknown) => {
            fail(error instanceof Error ? error.message : String(error));
          });
          const mesKeys = await stack.sqlJson<string[]>(
            `SELECT coalesce(json_agg(idempotency_key ORDER BY idempotency_key), '[]')
             FROM orders.erp_message_log WHERE direction = 'out'`,
          );
          const [confirmations, statuses] = await Promise.all([
            clients.erp.confirmations(),
            clients.erp.statusMessages(),
          ]);
          const erpKeys = [
            ...confirmations.confirmations.map((c) => c.receipt.idempotencyKey),
            ...statuses.messages.map((m) => m.receipt.idempotencyKey),
          ].sort();
          const posts = await clients.erp.postCounts();
          report.erp = {
            mesMessages: mesKeys.length,
            erpMessages: erpKeys.length,
            confirmations: confirmations.confirmations.length,
            statuses: statuses.messages.length,
            posts,
          };
          if (new Set(erpKeys).size !== erpKeys.length)
            fail('the ERP holds a message more than once');
          if (JSON.stringify(erpKeys) !== JSON.stringify(mesKeys)) {
            fail(
              `the ERP's messages are not the MES's: MES ${String(mesKeys.length)}, ERP ${String(erpKeys.length)}`,
            );
          }
        };

        const detectedLossChecks = async () => {
          // Loss only as gaps: no ring overrun, no buffer overflow, nothing rejected.
          const otherLoss = lossIncidents.filter((i) => i.type !== 'sequence-gap');
          if (otherLoss.length > 0) fail(`incidents of lost data: ${JSON.stringify(otherLoss)}`);
          const rejected = await stack.sqlJson<number>(
            'SELECT count(*) FROM ingest.rejected_message',
          );
          if (rejected !== 0) fail(`${String(rejected)} rejected UNS messages`);
          // Per machine: the numbers in the MES's gap incidents = raised − stored.
          const gaps: Record<string, number[]> = {};
          for (const incident of incidents) {
            if (
              incident.origin !== 'mes' ||
              incident.type !== 'sequence-gap' ||
              !incident.equipment
            )
              continue;
            const list = (gaps[incident.equipment] ??= []);
            for (let n = incident.seqFrom; n <= incident.seqTo; n++) list.push(n);
          }
          const windows = report.faults
            .filter((f) => f.outage)
            .map((f) => ({
              name: f.name,
              start: Date.parse(f.outage?.start ?? ''),
              resync: f.outage?.resync ?? {},
            }));
          let maxLeadMs = 0;
          const perMachine: Record<string, unknown> = {};
          let lostTotal = 0;
          for (const id of machines) {
            const expected = [...(lost[id] ?? [])].sort((a, b) => a - b);
            // As a multiset: a number in two incidents (a gap recorded twice) fails too.
            const found = [...(gaps[id] ?? [])].sort((a, b) => a - b);
            lostTotal += expected.length;
            if (JSON.stringify(found) !== JSON.stringify(expected)) {
              fail(
                `${id}: gap incidents name ${JSON.stringify(found)}, raised − stored is ${JSON.stringify(expected)}`,
              );
            }
            const facts = raisedFinal.get(id) ?? [];
            const outside: string[] = [];
            const leads: number[] = [];
            // The window's end is the resync's `asOfSeq`, judged on the simulator's own event log
            // (#243 review): the lost number at most `asOfSeq`, its time at most that fact's.
            for (const seq of expected) {
              const at = facts[seq - 1]?.at ?? Number.NaN;
              const window = windows.find((w) => {
                const asOfSeq = w.resync[id];
                const end = typeof asOfSeq === 'number' ? facts[asOfSeq - 1]?.at : undefined;
                return (
                  typeof asOfSeq === 'number' &&
                  end !== undefined &&
                  seq <= asOfSeq &&
                  at >= w.start - EPSILON_MS &&
                  at <= end
                );
              });
              if (!window) outside.push(`${String(seq)} at ${Number.isNaN(at) ? '?' : iso(at)}`);
              else if (at < window.start) leads.push(window.start - at);
            }
            const lead = Math.max(0, ...leads);
            maxLeadMs = Math.max(maxLeadMs, lead);
            perMachine[id] = {
              lost: expected.length,
              gapNumbers: found.length,
              maxLeadMs: lead,
              outside,
            };
            if (outside.length > 0) {
              fail(
                `${id}: lost facts outside every outage window [start − ε, the resync's asOfSeq fact]: ${outside.join(', ')}`,
              );
            }
          }
          report.detectedLoss = {
            epsilonMs: EPSILON_MS,
            maxLeadMs,
            lost: lostTotal,
            perMachine,
            windows,
          };
          // The class is exercised only when facts were lost: the default R3 must lose at least
          // one (R3_PLAN, the non-loss variant, is reported and not held to it).
          (report.detectedLoss as Record<string, unknown>).exercised = lostTotal > 0;
          if (lostTotal === 0 && plan !== R3_PLAN) {
            fail('R3 lost no fact on any machine: the detected-loss class was not exercised');
          }
          // Every machine final once the gaps are written off (the refresh may take a moment).
          let shiftOee = await clients.mes.shiftOee(shiftKey);
          await until(
            `${shiftKey} OEE final for every machine`,
            async () => {
              shiftOee = await clients.mes.shiftOee(shiftKey);
              return shiftOee.equipment.every((b) => b.final);
            },
            FINAL_WAIT_MS,
          ).catch(() => undefined);
          const notFinal = shiftOee.equipment.filter((b) => !b.final).map((b) => b.id);
          if (notFinal.length > 0 || shiftOee.equipment.length !== machines.length) {
            fail(
              `${shiftKey} OEE not final for ${notFinal.join(', ')} after the gaps were written off`,
            );
          }
          // The replay's input: what the MES stored and answered.
          await mkdir(replayDir, { recursive: true });
          const facts = await stack.sqlJson<unknown[]>(
            `SELECT coalesce(json_agg(json_build_object('topic', topic, 'payload', payload::text)
               ORDER BY source_time, equipment, seq), '[]')
             FROM ingest.equipment_event WHERE epoch = ${String(epoch)}`,
          );
          const anchors = await stack.sqlJson<unknown[]>(
            `SELECT coalesce(json_agg(json_build_object('topic', (SELECT e.topic FROM ingest.equipment_event e
                 WHERE e.equipment = a.equipment AND e.event_type = 'state' LIMIT 1),
               'payload', a.payload::text, 'retained', a.retained) ORDER BY a.arrival), '[]')
             FROM ingest.state_anchor a WHERE a.device_epoch = ${String(epoch)}`,
          );
          await writeFile(join(replayDir, 'facts.json'), JSON.stringify(facts));
          await writeFile(join(replayDir, 'anchors.json'), JSON.stringify(anchors));
          await writeFile(
            join(replayDir, 'live.json'),
            JSON.stringify({
              epoch,
              shiftKey,
              oee: JSON.parse(await clients.mes.shiftOeeText(shiftKey)) as unknown,
              totals: JSON.parse(
                await clients.mes.text(`/api/v1/shifts/${shiftKey}/totals`),
              ) as unknown,
            }),
          );
          replay.ready = true;
        };

        if (plan.loss === 'none') {
          for (const id of machines) {
            if ((lost[id] ?? []).length > 0) {
              fail(
                `${id}: ${String(lost[id]?.length)} raised facts never stored: ${JSON.stringify(lost[id]?.slice(0, 20))}`,
              );
            }
          }
          if (lossIncidents.length > 0)
            fail(`incidents of lost data: ${JSON.stringify(lossIncidents)}`);
          const rejected = await stack.sqlJson<number>(
            'SELECT count(*) FROM ingest.rejected_message',
          );
          if (rejected !== 0) fail(`${String(rejected)} rejected UNS messages`);
          // WSH-01's silence held fewer facts than its ring.
          const silence = plan.faults.find((f) => f.spec.kind === 'modbus-silent');
          if (silence) {
            const from = Date.parse(
              report.faults.find((f) => f.name === silence.name)?.start?.sim ?? '',
            );
            const to = Date.parse(
              report.faults.find((f) => f.name === silence.name)?.end?.sim ?? '',
            );
            const inSilence = (raisedFinal.get('wsh-01') ?? []).filter(
              (f) => f.at >= from && f.at <= to,
            ).length;
            report.washerSilence = {
              from: iso(from),
              to: iso(to),
              facts: inSilence,
              ring: WASHER_RING,
            };
            if (!(inSilence < WASHER_RING)) {
              fail(
                `WSH-01 raised ${String(inSilence)} facts in its silence, not fewer than its ${String(WASHER_RING)}-entry ring`,
              );
            }
          }
          await noLossChecks();
        } else {
          await detectedLossChecks();
        }

        // ---- The browser's verdict ----
        const exit = await browserExit;
        browserExit = undefined;
        report.recovery = JSON.parse(
          await readFile(join(results, 'recovery.json'), 'utf8').catch(() => 'null'),
        ) as unknown;
        if (exit !== 0)
          fail(`the recovery checks in the browser failed (Playwright exit ${String(exit)})`);
        report.containers = await containerStates(stack);
        phase('checks');
      })(),
    ]);
  } catch (error) {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
  } finally {
    clearTimeout(deadlineTimer);
    await appendFile(marks, `${JSON.stringify({ done: true })}\n`).catch(() => undefined);
    if (browserExit) {
      const exited = await Promise.race([browserExit, sleep(60_000).then(() => undefined)]);
      if (exited === undefined) browser?.kill('SIGTERM');
    }
    if (report.failures.length > 0) {
      try {
        report.containers ??= await containerStates(stack);
        await writeFile(
          join(results, 'compose.log'),
          await stack.compose(['logs', '--no-color', '--timestamps']),
        );
      } catch (error) {
        console.error('could not read the service logs', error);
      }
    }
    await stack.destroy().catch((error: unknown) => {
      console.error('could not remove the stack', error);
    });
    for (const signal of SIGNALS) process.off(signal, stop);
    runSignals = false;
  }

  // R3: the golden harness on the stored facts, once the stack is gone.
  if (replay.ready) {
    log(`${name}: replaying the stored facts through the golden harness`);
    const code = await new Promise<number>((resolve) => {
      const child = spawn(
        'pnpm',
        [
          '--filter',
          '@shopfloor/mes-server',
          'exec',
          'vitest',
          'run',
          '--config',
          'vitest.e2e.config.ts',
          'src/resilience-replay.e2e.test.ts',
        ],
        { cwd: REPO, env: { ...process.env, RESILIENCE_REPLAY_DIR: replayDir }, stdio: 'inherit' },
      );
      child.on('exit', (c) => {
        resolve(c ?? 1);
      });
      child.on('error', () => {
        resolve(1);
      });
    });
    const result = JSON.parse(
      await readFile(join(replayDir, 'replay.json'), 'utf8').catch(() => 'null'),
    ) as { facts: number; anchors: number; incidentsRecorded: number; oeeEqual: boolean } | null;
    report.replay = result && {
      facts: result.facts,
      anchors: result.anchors,
      incidentsRecorded: result.incidentsRecorded,
      oeeEqual: result.oeeEqual,
      exitCode: code,
    };
    if (code !== 0) fail("the MES's answers differ from the golden harness's on the stored facts");
  }
  report.totalMs = Date.now() - started;
  await writeFile(join(results, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  log(
    `${name}: ${report.failures.length === 0 ? 'OK' : `FAILED (${String(report.failures.length)})`}`,
  );
  return report;
}

/** Every container's state at the end: restarts, OOM kills, exit codes. */
async function containerStates(stack: Stack): Promise<Record<string, unknown>> {
  const ids = (await stack.compose(['ps', '--all', '--quiet'])).trim().split('\n').filter(Boolean);
  if (ids.length === 0) return {};
  const { stdout } = await run('docker', [
    'inspect',
    '--format',
    '{{.Name}} {{.RestartCount}} {{.State.OOMKilled}} {{.State.Status}} {{.State.ExitCode}}',
    ...ids,
  ]);
  return Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [container = '', restarts, oom, status, exit] = line.split(' ');
        return [
          container.replace(/^\//, ''),
          { restarts: Number(restarts), oomKilled: oom === 'true', status, exitCode: Number(exit) },
        ];
      }),
  );
}

/** The VM, the host and the images the suite ran on (plan "Entry condition for P9-16"). */
async function environment(): Promise<Record<string, unknown>> {
  const info = JSON.parse(
    (await run('docker', ['info', '--format', '{{json .}}'])).stdout,
  ) as Record<string, unknown>;
  const disks = await checkDisks(REPO);
  const colima = await run('colima', ['list', '--json'])
    .then(({ stdout }) =>
      stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
    )
    .catch(() => null);
  const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: REPO })).stdout.trim();
  return {
    commit,
    vm: {
      cpus: info.NCPU,
      memoryBytes: info.MemTotal,
      memory: formatGib(Number(info.MemTotal)),
      kernel: info.KernelVersion,
      os: info.OperatingSystem,
      docker: info.ServerVersion,
      dockerFree: formatGib(disks.docker),
      colima,
    },
    host: {
      cpus: cpus().length,
      memory: formatGib(totalmem()),
      free: formatGib(disks.host),
      loadAverage: loadavg().map((l) => Math.round(l * 100) / 100),
    },
  };
}

/**
 * Signals outside a run's own handler (#268 re-review): between runs, or during R3's replay (its
 * vitest child is in the same process group and gets the signal too), the images this process
 * built are removed before the exit; during a run its handler does that after the stack.
 */
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (runSignals) return;
    console.error(`${signal}: removing the images this run built`);
    void (imagesBuilt && !keepImages ? removeImages(imageTag) : Promise.resolve()).finally(() => {
      process.exit({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal]);
    });
  });
}

async function main(): Promise<boolean> {
  if (runNames.length === 0)
    throw new Error(`RESILIENCE_RUNS names no run (${RUN_NAMES.join(', ')})`);
  await rm(RESULTS, { recursive: true, force: true });
  await mkdir(RESULTS, { recursive: true });
  const loaded = await loadPlantConfig(join(REPO, 'config/plant'));
  if (!loaded.ok) throw new Error(formatIssues(loaded.issues));
  const results: Record<string, unknown> = {
    startedAt: new Date(started).toISOString(),
    scenario: GOLDEN,
    speed: SPEED,
    // `plan`: the non-loss R3 variant, which does not satisfy exit criterion 5.
    r3Schedule,
    ...(await environment()),
    runs: {},
  };
  const runs = results.runs as Record<string, unknown>;
  let built = false;
  try {
    for (const [n, name] of runNames.entries()) {
      const build = n === 0 && !skipBuild;
      if (build) built = true;
      const report = await runOne(name, planOf(name), build, loaded.config);
      if (build) {
        results.images = Object.fromEntries(
          await Promise.all(
            STACK_IMAGES.map(async (image) => [
              image,
              await run('docker', [
                'image',
                'inspect',
                '--format',
                '{{.Id}}',
                `shopfloor-twin/${image}:${imageTag}`,
              ])
                .then(({ stdout }) => stdout.trim())
                .catch(() => null),
            ]),
          ),
        );
      }
      runs[name] = summary(report);
    }
  } finally {
    if (built && !keepImages) {
      log(`removing the images it built (${imageTag})`);
      await removeImages(imageTag);
    }
    results.endedAt = new Date().toISOString();
    results.loadAverageAtEnd = loadavg().map((l) => Math.round(l * 100) / 100);
    results.passed = Object.values(runs).every((r) => (r as { passed: boolean }).passed);
    await writeFile(join(RESULTS, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  }
  log(`results: ${join(RESULTS, 'results.json')}`);
  for (const [name, r] of Object.entries(runs)) log(`${name}: ${JSON.stringify(r)}`);
  const passed = results.passed === true;
  const variant = runNames.includes('r3') && r3Schedule === 'plan';
  console.log(
    passed
      ? variant
        ? 'RESILIENCE-OK (non-loss R3 variant; does not satisfy exit criterion 5)'
        : 'RESILIENCE-OK'
      : 'RESILIENCE-FAILED',
  );
  return passed;
}

/** A run's results for results.json: per fault its timings, signals and resyncs. */
function summary(report: RunReport) {
  return {
    passed: report.failures.length === 0,
    title: report.title,
    failures: report.failures,
    phasesMs: report.phasesMs,
    faults: report.faults.map((f) => ({
      name: f.name,
      scheduled: f.scheduled,
      start: f.start?.sim,
      end: f.end?.sim,
      spacingMinutes: f.spacingMs === undefined ? null : f.spacingMs / MINUTE,
      settledWaitMs: f.settled?.waitedMs,
      ingestAtStart: f.settled?.ingest,
      readinessMs: f.readinessMs,
      caughtUp: f.caughtUp,
      exit: f.exit,
      signals: f.signals,
      resync: f.resync,
    })),
    facts: report.facts,
    detectedLoss: report.detectedLoss,
    replay: report.replay,
    washerSilence: report.washerSilence,
    recovery: report.recovery,
    containers: report.containers,
  };
}

process.exit((await main()) ? 0 : 1);
