/**
 * The performance suite (#245, Phase 9 plan "Performance", exit criterion 6; ADR-0040): the
 * targets T1–T6 at 60× on the hardened stack, each in the run that measures it, every run on its
 * own disposable Compose project with Prometheus (the `observability` profile, never Grafana).
 *
 * A Node script, as `pnpm test:trace-perf`: Node's `fetch` and `WebSocket`, no load-testing tool and
 * no new dependency. It measures and never imports `mes-server` code: the T6 feed is published by
 * the gated `mes-server` Vitest entry `apps/mes-server/src/perf-replay.e2e.test.ts` (Phase 9 plan
 * review round 1, finding 22).
 *
 * Runs:
 * - **P1, steady:** `orders-01`'s Monday shift A at 60× in orders mode (docker-compose.yml with
 *   e2e/compose.reconcile.yml, e2e/compose.reconcile-orders.yml, e2e/compose.perf.yml and
 *   compose.observability.yml). As the resilience suite does, the MES imports the ERP's orders and
 *   the supervisor releases and dispatches them through the API while the simulator waits idle at
 *   06:00, each command confirmed by its device fact; then the scenario's injections and the
 *   resume. Measured from the MES's catch-up (the first moment after the resume with
 *   `mes_ingest_pending_messages` ≤ 100 and the gateway's buffer empty) to 14:00:
 *   - T1: `mes_ingest_lag_seconds` over the window, from the difference of two readings of the
 *     MES's own `/metrics`: p95 ≤ 250 ms, p99 ≤ 1 s and max ≤ 5 s judged exactly on the bucket
 *     edges 0.25, 1 and 5 s (the share of observations at or below each), the max also from
 *     `mes_ingest_lag_max_seconds` sampled every second; the excluded counts beside it;
 *     `gateway_buffer_messages` 0 at every sample of the window (so no replayed delivery is in it);
 *     `mes_ingest_pending_messages` ≤ 100 at every simulated hour boundary, read from `/metrics` by
 *     this script at the first status reading past the boundary (a 5 s scrape could miss a peak).
 *   - T3, client side (Node WebSockets through nginx's HTTPS front, the run's dev CA trusted): the
 *     overview (`states`) and the Line A1 terminal (`terminal:line-a1`) judged with the latency
 *     judge of Phases 4–8 (`latency.ts`) against the simulator's plant events (its control API's
 *     event WebSocket, the truth's wall time being its arrival); the OEE dashboard (`oee:<machine>`)
 *     by the time until a pushed shift bucket counts each cycle the truth completed; the SPC page by
 *     the time until the chart it reads on a `readings` push holds each first-pass reading. p95 ≤
 *     1 s for the overview, ≤ 2 s for the others.
 *   - T4, client side (the MES has no HTTP histogram): 20 virtual users through nginx, 10 desks
 *     reading the overview, the OEE dashboard, the line OEE and the order screens (list, detail,
 *     execution, order OEE, the line's orders) at their screens' rates (30 s, the order detail's
 *     10 s) with the screens' topics open, 5 terminals on their topic (the view read at the screen's
 *     60 s), 5 trace users (a search and a backward trace every 3 s); reads p95 ≤ 200 ms, backward
 *     traces p95 ≤ 100 ms, no 5xx, no WebSocket closed but by this script at the end.
 *   - T5, from the containers' cgroups (`cpu.stat`, `memory.peak`, `memory.max`, `memory.events`)
 *     and `docker inspect`: the MES's CPU averaged over the window ≤ 0.5 core, its CFS throttled
 *     share (`nr_throttled / nr_periods`) ≤ 5 %, every container's peak memory < 80 % of its limit,
 *     no OOM kill, `RestartCount` 0, the gateway's buffer empty at the end.
 * - **P2, drain:** the same start; the MES stopped (`docker stop`, SIGTERM) at 07:00 for 5 minutes
 *   of wall time (five simulated hours) and started. T2: from its session's subscription to its
 *   catch-up (its plant clock within 60 simulated seconds of the simulator's), the messages stored
 *   per second (`mes_ingest_messages_total`, every outcome) ≥ 800, and every machine final again
 *   (its device stream settled in `ingest.source_cursor` through the last fact the simulator's
 *   event log shows it raised before the start) within 3 minutes of wall time of the start.
 * - **P3, headroom:** no simulator and no gateway (e2e/compose.perf-replay.yml publishes the
 *   broker's port): `week-01`'s Monday golden feed (26 simulated hours) published at three times
 *   the 60× rate by the replay entry. T6: the lag p95 ≤ 1 s over the replay, every machine final
 *   (device stream settled through its last fact) within 30 s of the last message, and Monday's
 *   shift OEE (A, B and C: six machines and two work centers each) final and equal to `week-01`'s
 *   golden summary.
 *
 * Results: e2e/results/perf/results.json (each target with its run, value and pass, the VM's CPUs,
 * memory and disk, the host's load average, the image digests, per run the raw figures) and
 * results.md (the table); compose.log on a failed run. A target missed is reported, never
 * relaxed: the exit code is 1 then (Probe Q3 runs the suite on `main` before any tuning).
 *
 * Usage: pnpm test:perf (under the heavy lock). Environment: PERF_RUNS (default `p1,p2,p3`),
 * PERF_PROJECT (Compose project prefix, default shopfloor-perf; each run adds `-p1`, …), PERF_TAG
 * (image tag, default perf), PERF_SKIP_BUILD=1 (use the images already built under that tag),
 * PERF_KEEP_IMAGES=1 (keep them, and Prometheus's image if this run pulled it; removed by
 * default), PERF_LABEL (a name for the results, e.g. `q3-baseline`), PERF_DEADLINE_MS (per run,
 * default 30 minutes). SIGINT and SIGTERM remove the running project and its env file.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { checkDisks, formatGib, pruneBuildCache } from '@shopfloor/test-kit/heavy-lock';
import {
  ErpClient,
  GatewayClient,
  MesClient,
  SimulatorClient,
  gauge,
  groundTruthSchema,
  mesLogin,
  mesWrite,
  provisionUsers,
  type ScenarioInjection,
} from './clients.ts';
import { jsonDifferences, percentile } from './compare.ts';
import { judgeLatency, type Change } from './latency.ts';
import {
  histogram,
  histogramDelta,
  judgeCounts,
  parseMetrics,
  quantile,
  settledThrough,
  shareAtOrBelow,
  total,
  type Range,
  type Sample,
} from './perf-metrics.ts';
import { checkImport, until, type PassContext, type ScenarioDispatch } from './orders-pass.ts';
import { REPO, STACK_IMAGES, Stack, removeImages } from './stack.ts';

const execute = promisify(execFile);

const MINUTE = 60_000;
const HOUR = 3_600_000;
const SPEED = 60;
const RESULTS = join(REPO, 'e2e/results/perf');
const PROMETHEUS_IMAGE = 'prom/prometheus:v3.15.0';
const OBSERVABILITY = 'compose.observability.yml';
const LIVE_FILES = ['e2e/compose.reconcile-orders.yml', 'e2e/compose.perf.yml', OBSERVABILITY];
const REPLAY_FILES = ['e2e/compose.perf-replay.yml', OBSERVABILITY];
const EVENT_LOG = '/tmp/perf-events.jsonl';
const DEVICE_FACTS = new Set(['state', 'cycle-complete', 'alarm', 'job']);
const PENDING_LIMIT = 100;
/** How long after a truth change the judges look for it (wall); later counts as missed. */
const JUDGE_LIMIT_MS = 10_000;
const SUPERVISOR = 'perf-supervisor';
const OPERATOR = 'perf-operator';
const DEADLINE_MS = Number(process.env.PERF_DEADLINE_MS ?? 30 * MINUTE);
const runsWanted = (process.env.PERF_RUNS ?? 'p1,p2,p3').split(',').map((r) => r.trim());
const projectPrefix = process.env.PERF_PROJECT ?? 'shopfloor-perf';
const tag = process.env.PERF_TAG ?? 'perf';
const skipBuild = process.env.PERF_SKIP_BUILD === '1';
const keepImages = process.env.PERF_KEEP_IMAGES === '1';
const label = process.env.PERF_LABEL ?? 'perf';

const started = Date.now();
const log = (message: string) => {
  console.log(`[perf +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
};
const iso = (at: number) => new Date(at).toISOString();
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

// ---- Containers ----

interface Cgroup {
  readonly usageUsec: number;
  readonly nrPeriods: number;
  readonly nrThrottled: number;
  readonly peakBytes: number;
  readonly limitBytes: number | null;
  readonly oomKills: number;
}

/** One container's cgroup v2 figures, read inside it (its own namespace's /sys/fs/cgroup). */
async function cgroup(id: string): Promise<Cgroup> {
  const { stdout } = await execute('docker', [
    'exec',
    id,
    'sh',
    '-c',
    'cd /sys/fs/cgroup && for f in cpu.stat memory.peak memory.max memory.events; do echo "== $f"; cat $f; done',
  ]);
  const sections = new Map<string, string[]>();
  let current = '';
  for (const line of stdout.split('\n')) {
    if (line.startsWith('== ')) {
      current = line.slice(3);
      sections.set(current, []);
    } else if (line.trim() !== '') sections.get(current)?.push(line.trim());
  }
  const keyed = (file: string) =>
    new Map(
      (sections.get(file) ?? []).map((line) => {
        const [key = '', value = '0'] = line.split(/\s+/);
        return [key, Number(value)] as const;
      }),
    );
  const cpu = keyed('cpu.stat');
  const events = keyed('memory.events');
  const max = sections.get('memory.max')?.[0] ?? 'max';
  return {
    usageUsec: cpu.get('usage_usec') ?? 0,
    nrPeriods: cpu.get('nr_periods') ?? 0,
    nrThrottled: cpu.get('nr_throttled') ?? 0,
    peakBytes: Number(sections.get('memory.peak')?.[0] ?? Number.NaN),
    limitBytes: max === 'max' ? null : Number(max),
    oomKills: events.get('oom_kill') ?? 0,
  };
}

/** The project's running containers by service. */
async function containers(stack: Stack): Promise<Map<string, string>> {
  const out = await stack.compose(['ps', '--format', 'json']);
  const map = new Map<string, string>();
  for (const line of out.trim().split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line) as { Service: string; ID: string };
    map.set(row.Service, row.ID);
  }
  return map;
}

async function inspect(id: string): Promise<{ restartCount: number; oomKilled: boolean }> {
  const { stdout } = await execute('docker', [
    'inspect',
    '--format',
    '{{.RestartCount}} {{.State.OOMKilled}}',
    id,
  ]);
  const [count = '0', oom = 'false'] = stdout.trim().split(' ');
  return { restartCount: Number(count), oomKilled: oom === 'true' };
}

// ---- The simulator's event log and the MES's device streams (as the resilience suite) ----

/** Per machine its device stream settled through (every number stored or written off). */
async function settled(stack: Stack): Promise<Map<string, number>> {
  const rows = await stack.sqlJson<{ stream: string; seen: Range[]; reported: Range[] }[]>(
    `SELECT coalesce(json_agg(json_build_object('stream', stream, 'seen', seen,
       'reported', reported)), '[]') FROM ingest.source_cursor WHERE stream LIKE 'device:%'`,
  );
  return new Map(
    rows.map((row) => [
      row.stream.slice('device:'.length),
      settledThrough([...row.seen, ...row.reported]),
    ]),
  );
}

/** Per machine the number of the last device fact it raised at or before `at` (plant time). */
function raisedThrough(text: string, at: number): Map<string, number> {
  const raised = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const event = JSON.parse(line) as { type: string; at: string; machineId?: string };
    if (event.machineId === undefined || !DEVICE_FACTS.has(event.type)) continue;
    if (Date.parse(event.at) > at) continue;
    raised.set(event.machineId, (raised.get(event.machineId) ?? 0) + 1);
  }
  return raised;
}

// ---- Client-side judges (T3) ----

/** The p50, p95 and max of latencies in ms; a missed one (undefined) counts as infinite. */
function latencyStats(latencies: readonly (number | undefined)[]) {
  const values = latencies.map((v) => v ?? Infinity);
  if (values.length === 0) return { judged: 0, missed: 0, p50: null, p95: null, max: null };
  const finite = (v: number) => (Number.isFinite(v) ? round(v) : null);
  return {
    judged: values.length,
    missed: latencies.filter((v) => v === undefined).length,
    p50: finite(percentile(values, 50)),
    p95: finite(percentile(values, 95)),
    max: finite(Math.max(...values)),
  };
}

// ---- WebSockets ----

interface Socket {
  readonly name: string;
  readonly ws: WebSocket;
  readonly opened: Promise<void>;
  /** Closed other than by `close()` of this script: a T4 violation. */
  unexpectedClose: string | undefined;
  closing: boolean;
  messages: number;
  errors: string[];
}

function openSocket(
  name: string,
  url: string,
  headers: Readonly<Record<string, string>>,
  topics: readonly string[],
  onMessage: (message: Record<string, unknown>, at: number) => void,
): Socket {
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  const socket: Socket = {
    name,
    ws,
    opened: new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => {
        resolve();
      });
      ws.addEventListener('error', () => {
        reject(new Error(`${name}: WebSocket error`));
      });
    }),
    unexpectedClose: undefined,
    closing: false,
    messages: 0,
    errors: [],
  };
  ws.addEventListener('open', () => {
    // Paced below the MES's subscription rate, as the web client does.
    void (async () => {
      for (const topic of topics) {
        ws.send(JSON.stringify({ type: 'subscribe', topic }));
        await sleep(100);
      }
    })();
  });
  ws.addEventListener('message', (event) => {
    const at = Date.now();
    socket.messages++;
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (message.type === 'error')
      socket.errors.push(`${String(message.code)}: ${String(message.detail)}`);
    onMessage(message, at);
  });
  ws.addEventListener('close', (event) => {
    if (!socket.closing) socket.unexpectedClose = `${String(event.code)} ${event.reason}`;
  });
  return socket;
}

function closeSocket(socket: Socket): void {
  socket.closing = true;
  socket.ws.close(1000, 'perf run over');
}

// ---- One timed GET (T4) ----

interface ReadLog {
  readonly kind: string;
  readonly ms: number;
  readonly status: number;
}

async function timedGet(
  base: string,
  path: string,
  cookie: string,
  kind: string,
  reads: ReadLog[],
): Promise<string | undefined> {
  const from = performance.now();
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    reads.push({ kind, ms: performance.now() - from, status: response.status });
    return response.ok ? text : undefined;
  } catch {
    reads.push({ kind, ms: performance.now() - from, status: 0 });
    return undefined;
  }
}

// ---- Shared setup of the live runs ----

interface Scenario {
  seed: number;
  start: string;
  injections?: ScenarioInjection[];
  erp?: { dataset: string; release: string[] };
  dispatches?: ScenarioDispatch[];
}

interface Live {
  readonly stack: Stack;
  readonly scenario: Scenario;
  readonly start: number;
  readonly machines: readonly string[];
  readonly sim: SimulatorClient;
  mesBase: string;
  readonly supervisor: { password: string; cookie: string };
  readonly operator: { password: string; cookie: string };
  readonly gateway: GatewayClient;
  readonly web: string;
}

async function startLive(stack: Stack, config: PlantConfig, scenario: Scenario): Promise<Live> {
  const start = Date.parse(scenario.start);
  const machines = config.plant.areas
    .flatMap((a) => a.workCenters)
    .flatMap((wc) => wc.equipment.map((e) => e.id))
    .sort();
  await stack.compose([
    'up',
    '--detach',
    '--wait',
    '--no-build',
    'db',
    'broker',
    'mes',
    'erp',
    'prometheus',
  ]);
  const mesBase = await stack.url('mes', 4700);
  await until('MES ready', () => new MesClient(mesBase).ready(), 120_000);
  const users = await provisionUsers(mesBase, stack.bootstrapAdminPassword, [
    { username: SUPERVISOR, roles: ['supervisor'] },
    { username: OPERATOR, roles: ['operator'] },
  ]);
  const supervisor = users.get(SUPERVISOR);
  const operatorUser = users.get(OPERATOR);
  if (!supervisor || !operatorUser) throw new Error('the run users were not created');
  // The terminals log in as a terminal would (session kind `terminal`).
  const terminal = await mesLogin(mesBase, OPERATOR, operatorUser.password, 'terminal');
  const operator = { password: operatorUser.password, cookie: terminal.cookie };
  await stack.compose(['up', '--detach', '--wait', '--no-build', 'simulator', 'gateway']);
  const sim = new SimulatorClient(
    await stack.url('simulator', 4800),
    stack.value('SIM_CONTROL_TOKEN'),
  );
  const gateway = new GatewayClient(await stack.url('gateway', 4900));
  const idle = await sim.status();
  if (idle.state !== 'idle' || Date.parse(idle.simTime) !== start) {
    throw new Error(`the simulator must wait idle at ${scenario.start}: ${JSON.stringify(idle)}`);
  }
  await until(
    'gateway ready with every machine connected',
    async () => {
      if (!(await gateway.ready())) return false;
      const devices = gauge(await gateway.metrics(), 'gateway_device_connected');
      return machines.every((id) => devices.get(id) === 1);
    },
    120_000,
  );
  const mes = new MesClient(mesBase, supervisor.cookie);
  await until(
    "every machine's start-up state anchored in the MES",
    async () => {
      const { equipment } = await mes.equipment();
      return machines.every((id) => {
        const current = equipment.find((e) => e.id === id)?.current;
        return current !== undefined && current !== null && Date.parse(current.since) === start;
      });
    },
    60_000,
  );
  const failures: string[] = [];
  const context: PassContext = {
    stack,
    mes,
    erp: new ErpClient(await stack.url('erp', 4600), stack.value('ERP_API_TOKEN')),
    sim,
    gateway,
    log,
    fail: (message) => failures.push(message),
  };
  await checkImport(context);
  if (failures.length > 0) throw new Error(`import: ${failures.join('; ')}`);
  for (const id of scenario.erp?.release ?? []) {
    const { order } = await mes.order(id);
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
    const { order } = await mes.order(dispatch.orderId);
    const answer = await mesWrite(
      mesBase,
      'POST',
      `/api/v1/orders/${encodeURIComponent(dispatch.orderId)}/dispatch`,
      { version: order.version },
      supervisor.cookie,
    );
    if (answer.status !== 200) {
      throw new Error(`dispatch ${dispatch.orderId}: ${String(answer.status)} ${answer.text}`);
    }
    await until(
      `${dispatch.commandId} confirmed by its device fact`,
      async () => {
        const { commands } = await mes.order(dispatch.orderId);
        return commands.some((c) => c.commandId === dispatch.commandId && c.confirmed);
      },
      60_000,
    );
  }
  const shiftEnd = start + 8 * HOUR;
  for (const injection of scenario.injections ?? []) {
    if (Date.parse(injection.at) >= shiftEnd) continue;
    const posted = await sim.inject(injection);
    if (posted.status !== 'scheduled') {
      throw new Error(`injection not scheduled: ${JSON.stringify(posted)}`);
    }
  }
  await stack.compose(['up', '--detach', '--wait', '--no-build', 'web']);
  const trust = await stack.webTrust();
  return {
    stack,
    scenario,
    start,
    machines,
    sim,
    mesBase,
    supervisor,
    operator,
    gateway,
    web: trust.url,
  };
}

async function mesMetrics(base: string): Promise<Map<string, Sample[]>> {
  const response = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(3_000) });
  return parseMetrics(await response.text());
}

async function gatewayBuffer(gateway: GatewayClient): Promise<number | undefined> {
  return total(parseMetrics(await gateway.metrics()), 'gateway_buffer_messages');
}

/** Waits until the simulator's time reaches `at`, polling every 250 ms; resolves with it. */
async function untilSimTime(sim: SimulatorClient, at: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = Date.parse((await sim.status()).simTime);
    if (now >= at) return now;
    if (Date.now() > deadline) throw new Error(`the simulator did not reach ${iso(at)}`);
    await sleep(250);
  }
}

async function saveLogs(stack: Stack, dir: string): Promise<void> {
  const logs = await stack
    .compose(['logs', '--no-color', '--timestamps'], 120_000)
    .catch((error: unknown) => `could not read the logs: ${String(error)}`);
  await writeFile(join(dir, 'compose.log'), logs);
}

/** PromQL against the run's Prometheus: the scrape's view beside the direct readings. */
async function promQuery(stack: Stack, query: string): Promise<unknown> {
  try {
    const base = await stack.url('prometheus', 9090);
    const response = await fetch(`${base}/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as { data?: { result?: unknown } };
    return body.data?.result ?? null;
  } catch (error) {
    return `query failed: ${String(error)}`;
  }
}

// ---- Target records ----

interface Target {
  readonly id: string;
  readonly run: string;
  readonly what: string;
  readonly target: string;
  readonly value: string;
  readonly pass: boolean | null;
}

type RunReport = Record<string, unknown> & { failures: string[]; targets: Target[] };

function newReport(run: string, project: string): RunReport {
  return { run, project, failures: [], targets: [] };
}

function judge(
  report: RunReport,
  id: string,
  what: string,
  target: string,
  value: string,
  pass: boolean | null,
): void {
  report.targets.push({ id, run: String(report.run), what, target, value, pass });
  log(
    `${id} ${what}: ${value} (target ${target}) ${pass === null ? 'NOT MEASURED' : pass ? 'pass' : 'MISS'}`,
  );
}

const ms = (value: number | null | undefined) =>
  value === null || value === undefined ? 'n/a' : `${String(round(value))} ms`;
const pct = (value: number) => `${String(round(value * 100, 2))} %`;

// ---- Run P1 ----

async function runP1(config: PlantConfig, scenario: Scenario, dir: string): Promise<RunReport> {
  const project = `${projectPrefix}-p1`;
  const report = newReport('p1', project);
  const stack = liveStack(project, scenario);
  return withStack(stack, report, dir, async () => {
    const live = await startLive(stack, config, scenario);
    const { sim, start } = live;
    const shiftEnd = start + 8 * HOUR;
    const shiftKey = `${scenario.start.slice(0, 10)}/A`;
    const lineA1 = config.plant.areas
      .flatMap((a) => a.workCenters)
      .find((wc) => wc.id === 'line-a1');
    if (!lineA1) throw new Error('no work center line-a1');
    const lineMachines = new Set(lineA1.equipment.map((e) => e.id));
    const wsBase = `${live.web.replace('https', 'wss')}/api/v1/ws`;
    const origin = live.web;
    const desk = { origin, cookie: live.supervisor.cookie };

    // ---- Truth: the simulator's plant events, each at its arrival ----
    const truthStates = new Map<string, Change[]>();
    const truthCycles = new Map<string, number[]>();
    const truthReadings: { at: number; plant: number }[] = [];
    const firstPassParts = new Set<number>();
    let characteristic: { id: string; equipment: string } | undefined;
    const pendingReadings: { at: number; plant: number; partId: number; machine: string }[] = [];
    const events = new WebSocket(`${sim.base.replace('http', 'ws')}/api/v1/events`, {
      headers: sim.auth,
    } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      events.addEventListener('open', () => {
        resolve();
      });
      events.addEventListener('error', () => {
        reject(new Error('the plant event stream did not open'));
      });
    });
    events.addEventListener('message', (message) => {
      const at = Date.now();
      const event = JSON.parse(String(message.data)) as {
        type: string;
        at: string;
        machineId?: string;
        to?: string;
        partId?: number;
        measurement?: unknown;
      };
      const machine = event.machineId;
      if (machine === undefined) return;
      const plant = Date.parse(event.at);
      if (event.type === 'state' && event.to !== undefined) {
        const list = truthStates.get(machine) ?? [];
        list.push({ at, state: event.to });
        truthStates.set(machine, list);
      } else if (event.type === 'cycle-complete' && plant >= start && plant < shiftEnd) {
        const list = truthCycles.get(machine) ?? [];
        list.push(at);
        truthCycles.set(machine, list);
        if (event.measurement !== undefined && event.measurement !== null) {
          pendingReadings.push({ at, plant, partId: event.partId ?? -1, machine });
        }
      }
    });

    // ---- T3 clients: the screens' pushes ----
    const overviewPage = new Map<string, Change[]>();
    const terminalPage = new Map<string, Change[]>();
    const oeePage = new Map<string, { at: number; count: number }[]>();
    const chartSamples: { at: number; newest: number }[] = [];
    const push = (map: Map<string, Change[]>, key: string, at: number, state: string) => {
      const list = map.get(key) ?? [];
      if (list.at(-1)?.state !== state) list.push({ at, state });
      map.set(key, list);
    };
    const t3Sockets: Socket[] = [];
    t3Sockets.push(
      openSocket('overview', wsBase, desk, ['states'], (m, at) => {
        if (m.type === 'snapshot' && m.topic === 'states') {
          for (const s of m.states as { equipment: string; current: { state: string } }[]) {
            push(overviewPage, s.equipment, at, s.current.state);
          }
        } else if (m.type === 'state') {
          const current = m.current as { state: string };
          push(overviewPage, String(m.equipment), at, current.state);
        }
      }),
    );
    t3Sockets.push(
      openSocket(
        'terminal-judge',
        wsBase,
        { origin, cookie: live.operator.cookie },
        ['terminal:line-a1'],
        (m, at) => {
          if ((m.type === 'snapshot' || m.type === 'terminal') && m.topic === 'terminal:line-a1') {
            const view = m.view as { machines: { id: string; state: { state: string } | null }[] };
            for (const machine of view.machines) {
              if (machine.state) push(terminalPage, machine.id, at, machine.state.state);
            }
          }
        },
      ),
    );
    t3Sockets.push(
      openSocket(
        'oee-dashboard',
        wsBase,
        desk,
        live.machines.map((m) => `oee:${m}`),
        (m, at) => {
          if ((m.type === 'oee' || m.type === 'snapshot') && String(m.topic).startsWith('oee:')) {
            const shift = m.shift as
              { key: string; inputs: { cycles: { count: number }[] } } | null | undefined;
            if (shift?.key !== shiftKey) return;
            const machine = String(m.topic).slice('oee:'.length);
            const count = shift.inputs.cycles.reduce((sum, c) => sum + c.count, 0);
            const list = oeePage.get(machine) ?? [];
            list.push({ at, count });
            oeePage.set(machine, list);
          }
        },
      ),
    );
    const t3Reads: ReadLog[] = [];
    {
      const list = await timedGet(
        live.web,
        '/api/v1/quality/characteristics',
        desk.cookie,
        'spc',
        t3Reads,
      );
      const parsed =
        list === undefined
          ? undefined
          : (JSON.parse(list) as {
              characteristics: { id: string; equipment: string }[];
            });
      characteristic = parsed?.characteristics[0];
    }
    let chartBusy = false;
    let chartAgain = false;
    const readChart = async (): Promise<void> => {
      if (characteristic === undefined) return;
      if (chartBusy) {
        chartAgain = true;
        return;
      }
      chartBusy = true;
      try {
        do {
          chartAgain = false;
          const text = await timedGet(
            live.web,
            `/api/v1/quality/characteristics/${encodeURIComponent(characteristic.id)}/chart`,
            desk.cookie,
            'spc-chart',
            t3Reads,
          );
          if (text !== undefined) {
            const chart = JSON.parse(text) as { points: { I: { at: string }[] } };
            const newest = Math.max(0, ...chart.points.I.map((p) => Date.parse(p.at)));
            chartSamples.push({ at: Date.now(), newest });
          }
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set by another task
        } while (chartAgain);
      } finally {
        chartBusy = false;
      }
    };
    t3Sockets.push(
      openSocket('spc-page', wsBase, desk, ['quality'], (m) => {
        if (m.type === 'spc-characteristic' && m.event === 'readings') void readChart();
      }),
    );
    await Promise.all(t3Sockets.map((s) => s.opened));

    // ---- Sampler: the MES's and the gateway's metrics every second ----
    const samples: {
      at: number;
      pending: number | undefined;
      lagMax: number | undefined;
      buffer: number | undefined;
      stored: number | undefined;
    }[] = [];
    let sampling = true;
    const sampler = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set by another task
      while (sampling) {
        const at = Date.now();
        const [m, buffer] = await Promise.all([
          mesMetrics(live.mesBase).catch(() => undefined),
          gatewayBuffer(live.gateway).catch(() => undefined),
        ]);
        samples.push({
          at,
          pending: m && total(m, 'mes_ingest_pending_messages'),
          lagMax: m && total(m, 'mes_ingest_lag_max_seconds'),
          buffer,
          stored: m && total(m, 'mes_ingest_messages_total'),
        });
        await sleep(Math.max(0, 1_000 - (Date.now() - at)));
      }
    })();

    // ---- Resume and catch up ----
    const ids = await containers(stack);
    const mesId = ids.get('mes');
    if (mesId === undefined) throw new Error('no MES container');
    await sim.resume();
    const resumedAt = Date.now();
    log('P1: resumed at 60×');
    const hasPending =
      total(await mesMetrics(live.mesBase), 'mes_ingest_pending_messages') !== undefined;
    let catchUp = Date.now();
    await until(
      'the MES caught up (pending ≤ 100, gateway buffer empty)',
      async () => {
        const m = await mesMetrics(live.mesBase);
        const pending = total(m, 'mes_ingest_pending_messages');
        const buffer = await gatewayBuffer(live.gateway);
        catchUp = Date.now();
        return (pending ?? 0) <= PENDING_LIMIT && buffer === 0;
      },
      60_000,
    );
    const windowStart = catchUp;
    const metrics0 = await mesMetrics(live.mesBase);
    const lag0 = histogram(metrics0, 'mes_ingest_lag_seconds');
    const cpu0 = await cgroup(mesId);
    const windowSim0 = Date.parse((await sim.status()).simTime);
    log(`P1: caught up ${String(catchUp - resumedAt)} ms after the resume, at ${iso(windowSim0)}`);

    // ---- T4: 20 virtual users ----
    const reads: ReadLog[] = [];
    const t4Sockets: Socket[] = [];
    let loading = true;
    const orderIds = scenario.erp?.release ?? [];
    const serials: string[] = [];
    const refreshSerials = async () => {
      const rows = await stack
        .sqlJson<string[] | null>(
          `SELECT json_agg(serial) FROM (SELECT serial FROM genealogy.serial_unit
             WHERE serial IS NOT NULL ORDER BY random() LIMIT 50) AS s`,
        )
        .catch(() => null);
      if (rows && rows.length > 0) serials.splice(0, serials.length, ...rows);
    };
    const fromIso = iso(start);
    const toIso = iso(shiftEnd);
    const desks = Array.from({ length: 10 }, async (_, n) => {
      const machine = live.machines[n % live.machines.length] ?? 'cnc-01';
      const order = orderIds[n % Math.max(1, orderIds.length)] ?? '';
      t4Sockets.push(
        openSocket(
          `desk-${String(n)}`,
          wsBase,
          desk,
          ['states', 'orders', 'oee:line', `oee:${machine}`, `oee:order:${order}`],
          () => undefined,
        ),
      );
      await sleep(Math.random() * 10_000);
      for (let i = 0; loading; i++) {
        const tick = Date.now();
        const get = (path: string, kind: string) =>
          timedGet(live.web, path, desk.cookie, kind, reads);
        if (i % 3 === 0) {
          await get('/api/v1/equipment', 'overview');
          await get(`/api/v1/shifts/${shiftKey}/oee`, 'oee-shift');
          await get(
            `/api/v1/oee?scope=equipment&id=${machine}&bucket=hour&from=${fromIso}&to=${toIso}`,
            'oee-hours',
          );
          await get(`/api/v1/oee/line?bucket=hour&from=${fromIso}&to=${toIso}`, 'line-oee');
          await get(`/api/v1/oee/line/orders?from=${fromIso}&to=${toIso}`, 'line-orders');
          await get('/api/v1/orders', 'orders');
        }
        await get(`/api/v1/orders/${encodeURIComponent(order)}`, 'order');
        await get(`/api/v1/orders/${encodeURIComponent(order)}/execution`, 'order-execution');
        await get(`/api/v1/oee/orders/${encodeURIComponent(order)}`, 'order-oee');
        await sleep(Math.max(0, 10_000 - (Date.now() - tick)));
      }
    });
    const terminals = Array.from({ length: 5 }, async (_, n) => {
      const workCenter = n % 2 === 0 ? 'line-a1' : 'cell-m1';
      t4Sockets.push(
        openSocket(
          `terminal-${String(n)}`,
          wsBase,
          { origin, cookie: live.operator.cookie },
          [`terminal:${workCenter}`],
          () => undefined,
        ),
      );
      await sleep(Math.random() * 5_000);
      while (loading) {
        const tick = Date.now();
        await timedGet(
          live.web,
          `/api/v1/terminal/${workCenter}`,
          live.operator.cookie,
          'terminal',
          reads,
        );
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set by another task
        while (loading && Date.now() - tick < 60_000) await sleep(1_000);
      }
    });
    const tracers = Array.from({ length: 5 }, async () => {
      await sleep(Math.random() * 3_000);
      while (loading) {
        const tick = Date.now();
        const serial = serials[Math.floor(Math.random() * serials.length)];
        if (serial !== undefined) {
          await timedGet(
            live.web,
            `/api/v1/trace/search?q=${encodeURIComponent(serial.slice(0, 6))}`,
            desk.cookie,
            'trace-search',
            reads,
          );
          await timedGet(
            live.web,
            `/api/v1/trace/serials/${encodeURIComponent(serial)}`,
            desk.cookie,
            'trace-backward',
            reads,
          );
        }
        await sleep(Math.max(0, 3_000 - (Date.now() - tick)));
      }
    });
    const serialTimer = setInterval(() => void refreshSerials(), 15_000);
    await refreshSerials();

    // ---- Hour boundaries: pending read straight from /metrics ----
    const boundaries: {
      boundary: string;
      readAt: string;
      pending: number | null;
      buffer: number | null;
    }[] = [];
    for (let hour = start + HOUR; hour <= shiftEnd; hour += HOUR) {
      const reached = await untilSimTime(sim, hour, 3 * MINUTE);
      const [m, buffer] = await Promise.all([
        mesMetrics(live.mesBase).catch(() => undefined),
        gatewayBuffer(live.gateway).catch(() => undefined),
      ]);
      boundaries.push({
        boundary: iso(hour),
        readAt: iso(reached),
        pending: (m && total(m, 'mes_ingest_pending_messages')) ?? null,
        buffer: buffer ?? null,
      });
    }
    const windowEnd = Date.now();
    const metrics1 = await mesMetrics(live.mesBase);
    const cpu1 = await cgroup(mesId);
    loading = false;
    clearInterval(serialTimer);
    await Promise.all([...desks, ...terminals, ...tracers]);
    log('P1: 14:00 reached; load stopped');
    // The tail of the judges' window: pushes for the last changes still arrive.
    await sleep(JUDGE_LIMIT_MS);
    sampling = false;
    await sampler;
    for (const socket of [...t3Sockets, ...t4Sockets]) closeSocket(socket);
    events.close();
    await sim.pause();
    const bufferEnd = await gatewayBuffer(live.gateway).catch(() => undefined);

    // ---- T1 ----
    const lag1 = histogram(metrics1, 'mes_ingest_lag_seconds');
    const windowSamples = samples.filter((s) => s.at >= windowStart && s.at <= windowEnd);
    const bufferMax = Math.max(0, ...windowSamples.map((s) => s.buffer ?? 0));
    const sampledLagMax = windowSamples.reduce<number | undefined>(
      (max, s) => (s.lagMax === undefined ? max : Math.max(max ?? 0, s.lagMax)),
      undefined,
    );
    const excluded: Record<string, number> = {};
    for (const reason of ['retained', 'anchor', 'snapshot', 'duplicate']) {
      const after = total(metrics1, 'mes_ingest_lag_excluded_total', { reason });
      if (after === undefined) continue;
      excluded[reason] =
        after - (total(metrics0, 'mes_ingest_lag_excluded_total', { reason }) ?? 0);
    }
    const t1: Record<string, unknown> = {
      windowStart: iso(windowStart),
      windowEnd: iso(windowEnd),
      windowSim: { from: iso(windowSim0), to: iso(shiftEnd) },
      catchUpMs: catchUp - resumedAt,
      pendingMetric: hasPending,
      gatewayBufferMax: bufferMax,
      boundaries,
      excluded,
    };
    report.t1 = t1;
    if (lag1 === undefined) {
      judge(
        report,
        'T1',
        'ingest lag p95 / p99 / max',
        '≤ 250 ms / ≤ 1 s / ≤ 5 s',
        'no mes_ingest_lag_seconds on this MES',
        null,
      );
    } else {
      const window = histogramDelta(lag1, lag0);
      const share025 = shareAtOrBelow(window, 0.25);
      const share1 = shareAtOrBelow(window, 1);
      const share5 = shareAtOrBelow(window, 5);
      const max = sampledLagMax === undefined ? null : sampledLagMax * 1000;
      Object.assign(t1, {
        observations: window.count,
        meanMs: window.count === 0 ? null : round((window.sum / window.count) * 1000),
        p50Ms: round((quantile(window, 0.5) ?? 0) * 1000),
        p95Ms: round((quantile(window, 0.95) ?? 0) * 1000),
        p99Ms: round((quantile(window, 0.99) ?? 0) * 1000),
        maxMs: max === null ? null : round(max),
        shareAtOrBelow: {
          '0.25': round(share025, 5),
          '1': round(share1, 5),
          '5': round(share5, 5),
        },
      });
      judge(
        report,
        'T1',
        'ingest lag p95',
        '≤ 250 ms (≥ 95 % at or below the 0.25 s edge)',
        `${ms(Number(t1.p95Ms))} (${pct(share025)} ≤ 250 ms, ${String(window.count)} observations)`,
        window.count > 0 && share025 >= 0.95,
      );
      judge(
        report,
        'T1',
        'ingest lag p99',
        '≤ 1 s (≥ 99 % at or below the 1 s edge)',
        `${ms(Number(t1.p99Ms))} (${pct(share1)} ≤ 1 s)`,
        window.count > 0 && share1 >= 0.99,
      );
      judge(
        report,
        'T1',
        'ingest lag max',
        '≤ 5 s (every observation at or below the 5 s edge)',
        `${ms(max)} (${pct(share5)} ≤ 5 s)`,
        window.count > 0 && share5 === 1 && (max === null || max <= 5_000),
      );
    }
    const boundaryPending = boundaries.map((b) => b.pending);
    judge(
      report,
      'T1',
      'pending messages at every hour boundary',
      '≤ 100',
      hasPending
        ? `max ${String(Math.max(...boundaryPending.map((p) => p ?? 0)))} over ${String(boundaries.length)} boundaries`
        : 'no mes_ingest_pending_messages on this MES',
      hasPending ? boundaryPending.every((p) => p !== null && p <= PENDING_LIMIT) : null,
    );
    judge(
      report,
      'T1',
      'gateway buffer over the window',
      '0 at every sample',
      `max ${String(bufferMax)} over ${String(windowSamples.length)} samples`,
      bufferMax === 0,
    );

    // ---- T3 ----
    // The SPC truth: the characteristic's tester's first-pass readings (a retest is pass 2).
    for (const reading of pendingReadings) {
      if (characteristic && reading.machine !== characteristic.equipment) continue;
      if (firstPassParts.has(reading.partId)) continue;
      firstPassParts.add(reading.partId);
      truthReadings.push({ at: reading.at, plant: reading.plant });
    }
    const judgeEnd = windowEnd + JUDGE_LIMIT_MS;
    const inWindow = (map: ReadonlyMap<string, readonly Change[]>, only?: ReadonlySet<string>) =>
      new Map(
        [...map]
          .filter(([key]) => only === undefined || only.has(key))
          .map(
            ([key, list]) =>
              [key, list.filter((c) => c.at >= windowStart && c.at <= windowEnd)] as const,
          ),
      );
    const overview = judgeLatency(inWindow(truthStates), overviewPage, judgeEnd, JUDGE_LIMIT_MS);
    const terminal = judgeLatency(
      inWindow(truthStates, lineMachines),
      terminalPage,
      judgeEnd,
      JUDGE_LIMIT_MS,
    );
    const oeeLatencies: (number | undefined)[] = [];
    let oeeUnjudged = 0;
    for (const machine of live.machines) {
      const truth = truthCycles.get(machine) ?? [];
      const judged = judgeCounts(truth, oeePage.get(machine) ?? [], judgeEnd, JUDGE_LIMIT_MS);
      // Only cycles in the window: the count judge needs every cycle from the shift's start.
      judged.latencies.forEach((latency, i) => {
        const at = truth[i];
        if (at !== undefined && at >= windowStart && at <= windowEnd) oeeLatencies.push(latency);
      });
      oeeUnjudged += judged.unjudged;
    }
    const spcLatencies = truthReadings
      .filter((r) => r.at >= windowStart && r.at + JUDGE_LIMIT_MS <= judgeEnd)
      .map((r) => {
        const shown = chartSamples.find(
          (s) => s.newest >= r.plant && s.at <= r.at + JUDGE_LIMIT_MS,
        );
        return shown === undefined ? undefined : Math.max(0, shown.at - r.at);
      });
    const t3 = {
      overview: latencyStats(overview.measured.map((m) => m.latencyMs)),
      oeeDashboard: { ...latencyStats(oeeLatencies), unjudged: oeeUnjudged },
      spcPage: { ...latencyStats(spcLatencies), characteristic: characteristic?.id ?? null },
      terminal: latencyStats(terminal.measured.map((m) => m.latencyMs)),
      sockets: t3Sockets.map((s) => ({
        name: s.name,
        messages: s.messages,
        errors: s.errors,
        unexpectedClose: s.unexpectedClose ?? null,
      })),
    };
    report.t3 = t3;
    for (const [what, stats, budget] of [
      ['overview state push p95', t3.overview, 1_000],
      ['OEE dashboard push p95', t3.oeeDashboard, 2_000],
      ['SPC page push p95', t3.spcPage, 2_000],
      ['terminal push p95', t3.terminal, 2_000],
    ] as const) {
      judge(
        report,
        'T3',
        what,
        `≤ ${String(budget / 1000)} s`,
        `${ms(stats.p95)} (p50 ${ms(stats.p50)}, max ${ms(stats.max)}, ${String(stats.judged)} judged, ${String(stats.missed)} missed)`,
        stats.judged > 0 && stats.p95 !== null && stats.p95 <= budget,
      );
    }

    // ---- T4 ----
    const byKind: Record<string, unknown> = {};
    for (const kind of [...new Set(reads.map((r) => r.kind))].sort()) {
      const times = reads.filter((r) => r.kind === kind).map((r) => r.ms);
      byKind[kind] = {
        requests: times.length,
        p50: round(percentile(times, 50)),
        p95: round(percentile(times, 95)),
        max: round(Math.max(...times)),
        errors: reads.filter((r) => r.kind === kind && r.status !== 200).length,
      };
    }
    const plain = reads.filter((r) => r.kind !== 'trace-backward').map((r) => r.ms);
    const backward = reads.filter((r) => r.kind === 'trace-backward').map((r) => r.ms);
    const fiveXx = reads.filter((r) => r.status >= 500 || r.status === 0);
    const closed = t4Sockets.filter((s) => s.unexpectedClose !== undefined);
    report.t4 = {
      users: { desks: 10, terminals: 5, tracers: 5 },
      requests: reads.length,
      byKind,
      fiveXx: fiveXx.length,
      non200: reads.filter((r) => r.status !== 200).length,
      sockets: t4Sockets.map((s) => ({
        name: s.name,
        messages: s.messages,
        errors: s.errors,
        unexpectedClose: s.unexpectedClose ?? null,
      })),
    };
    const plainP95 = plain.length === 0 ? null : percentile(plain, 95);
    const backwardP95 = backward.length === 0 ? null : percentile(backward, 95);
    judge(
      report,
      'T4',
      'reads p95 (20 users)',
      '≤ 200 ms',
      `${ms(plainP95)} over ${String(plain.length)} reads`,
      plainP95 !== null && plainP95 <= 200,
    );
    judge(
      report,
      'T4',
      'backward traces p95',
      '≤ 100 ms',
      `${ms(backwardP95)} over ${String(backward.length)} traces`,
      backwardP95 !== null && backwardP95 <= 100,
    );
    judge(
      report,
      'T4',
      'no 5xx, no socket closed by the server',
      '0 and 0',
      `${String(fiveXx.length)} 5xx or failed, ${String(closed.length)} sockets closed`,
      fiveXx.length === 0 && closed.length === 0,
    );

    // ---- T5 ----
    const elapsedUsec = (windowEnd - windowStart) * 1000;
    const cpuCores = (cpu1.usageUsec - cpu0.usageUsec) / elapsedUsec;
    const periods = cpu1.nrPeriods - cpu0.nrPeriods;
    const throttled = periods === 0 ? 0 : (cpu1.nrThrottled - cpu0.nrThrottled) / periods;
    const memory: Record<string, unknown> = {};
    const memoryProblems: string[] = [];
    const restarts: string[] = [];
    for (const [service, id] of await containers(stack)) {
      const group = await cgroup(id);
      const state = await inspect(id);
      const share = group.limitBytes === null ? null : group.peakBytes / group.limitBytes;
      memory[service] = {
        peakMiB: round(group.peakBytes / 2 ** 20, 1),
        limitMiB: group.limitBytes === null ? null : round(group.limitBytes / 2 ** 20, 1),
        share: share === null ? null : round(share, 4),
        oomKills: group.oomKills,
        restartCount: state.restartCount,
        oomKilled: state.oomKilled,
      };
      if (share === null || share >= 0.8)
        memoryProblems.push(`${service} ${share === null ? 'no limit' : pct(share)}`);
      if (group.oomKills > 0 || state.oomKilled || state.restartCount > 0) restarts.push(service);
    }
    report.t5 = {
      mesCpuCores: round(cpuCores, 4),
      mesThrottledShare: round(throttled, 5),
      mesPeriods: periods,
      memory,
      gatewayBufferEnd: bufferEnd ?? null,
    };
    judge(
      report,
      'T5',
      'MES CPU averaged over the shift',
      '≤ 0.5 core',
      `${String(round(cpuCores, 3))} core`,
      cpuCores <= 0.5,
    );
    judge(
      report,
      'T5',
      'MES CFS throttled share',
      '≤ 5 %',
      `${pct(throttled)} of ${String(periods)} periods`,
      throttled <= 0.05,
    );
    judge(
      report,
      'T5',
      'peak memory of every container',
      '< 80 % of its limit',
      memoryProblems.length === 0 ? `highest ${highestShare(memory)}` : memoryProblems.join(', '),
      memoryProblems.length === 0,
    );
    judge(
      report,
      'T5',
      'no OOM kill, RestartCount 0',
      'none',
      restarts.length === 0 ? 'none' : restarts.join(', '),
      restarts.length === 0,
    );
    judge(
      report,
      'T5',
      'gateway buffer at the end',
      '0',
      String(bufferEnd ?? 'unknown'),
      bufferEnd === 0,
    );

    report.prometheus = {
      lagP95Shift: await promQuery(
        stack,
        `histogram_quantile(0.95, sum by (le) (increase(mes_ingest_lag_seconds_bucket[${String(Math.ceil((windowEnd - windowStart) / 1000))}s])))`,
      ),
      pendingMax: await promQuery(stack, 'max_over_time(mes_ingest_pending_messages[15m])'),
      targetsUp: await promQuery(stack, 'up'),
    };
  });
}

function highestShare(memory: Record<string, unknown>): string {
  let best = { service: 'none', share: -1 };
  for (const [service, value] of Object.entries(memory)) {
    const share = (value as { share: number | null }).share ?? -1;
    if (share > best.share) best = { service, share };
  }
  return `${best.service} ${pct(best.share)}`;
}

// ---- Run P2 ----

async function runP2(config: PlantConfig, scenario: Scenario, dir: string): Promise<RunReport> {
  const project = `${projectPrefix}-p2`;
  const report = newReport('p2', project);
  const stack = liveStack(project, scenario);
  return withStack(stack, report, dir, async () => {
    const live = await startLive(stack, config, scenario);
    const { sim, start } = live;
    await sim.resume();
    log('P2: resumed at 60×');
    const stopSim = await untilSimTime(sim, start + HOUR, 3 * MINUTE);
    const mesId = (await containers(stack)).get('mes');
    if (mesId === undefined) throw new Error('no MES container');
    await execute('docker', ['stop', '--time', '15', mesId]);
    const stoppedAt = Date.now();
    log(`P2: MES stopped at ${iso(stopSim)}; waiting 5 minutes`);
    await sleep(Math.max(0, 5 * MINUTE - (Date.now() - stoppedAt)));
    const gatewayPublished = total(
      parseMetrics(await live.gateway.metrics()),
      'gateway_published_messages',
    );
    await execute('docker', ['start', mesId]);
    const startedAt = Date.now();
    const startSim = Date.parse((await sim.status()).simTime);
    log(`P2: MES started at ${iso(startSim)}`);
    live.mesBase = await stack.url('mes', 4700);
    const raised = raisedThrough(
      await stack.compose(['exec', '-T', 'simulator', 'cat', EVENT_LOG]),
      startSim,
    );
    const mes = new MesClient(live.mesBase, live.supervisor.cookie);
    const series: {
      at: number;
      stored: number;
      handled: number;
      subscribed: number;
      pending: number | undefined;
    }[] = [];
    let subscribedAt: number | undefined;
    let caughtUpAt: number | undefined;
    let finalAt: number | undefined;
    let lastProblem = '';
    const deadline = startedAt + 6 * MINUTE;
    while (Date.now() < deadline && (caughtUpAt === undefined || finalAt === undefined)) {
      const at = Date.now();
      const m = await mesMetrics(live.mesBase).catch(() => undefined);
      if (m) {
        // Stored: new facts, the target's count; handled: every outcome (duplicates, anchors).
        const stored = total(m, 'mes_ingest_messages_total', { outcome: 'stored' }) ?? 0;
        const handled = total(m, 'mes_ingest_messages_total') ?? 0;
        const subscribed = total(m, 'mes_ingest_subscribed') ?? 0;
        series.push({
          at,
          stored,
          handled,
          subscribed,
          pending: total(m, 'mes_ingest_pending_messages'),
        });
        if (subscribed === 1) subscribedAt ??= at;
        if (subscribedAt !== undefined && caughtUpAt === undefined) {
          const [plant, status] = await Promise.all([
            mes.plant().catch(() => undefined),
            sim.status(),
          ]);
          const watermark = plant?.clock ? Date.parse(plant.clock.watermark) : 0;
          if (Date.parse(status.simTime) - watermark <= MINUTE) caughtUpAt = Date.now();
        }
      }
      if (finalAt === undefined) {
        const through = await settled(stack).catch(() => new Map<string, number>());
        const behind = live.machines.filter((id) => (through.get(id) ?? 0) < (raised.get(id) ?? 0));
        if (behind.length === 0) finalAt = Date.now();
        else
          lastProblem = behind
            .map((id) => `${id} ${String(through.get(id) ?? 0)}/${String(raised.get(id) ?? 0)}`)
            .join(', ');
      }
      await sleep(Math.max(0, 500 - (Date.now() - at)));
    }
    await sim.pause();
    const at = (t: number | undefined) =>
      t === undefined ? undefined : series.findLast((s) => s.at <= t);
    const drained = at(caughtUpAt)?.stored;
    const drainMs =
      caughtUpAt !== undefined && subscribedAt !== undefined
        ? caughtUpAt - subscribedAt
        : undefined;
    const rate =
      drained !== undefined && drainMs !== undefined && drainMs > 0
        ? drained / (drainMs / 1000)
        : undefined;
    const fromStartRate =
      drained !== undefined && caughtUpAt !== undefined
        ? drained / ((caughtUpAt - startedAt) / 1000)
        : undefined;
    report.t2 = {
      stoppedAt: iso(stopSim),
      startedAt: iso(startSim),
      stoppedWallMs: startedAt - stoppedAt,
      gatewayPublishedAtStart: gatewayPublished ?? null,
      subscribedMs: subscribedAt === undefined ? null : subscribedAt - startedAt,
      caughtUpMs: caughtUpAt === undefined ? null : caughtUpAt - startedAt,
      drainMs: drainMs ?? null,
      messagesDrained: drained ?? null,
      messagesHandled: at(caughtUpAt)?.handled ?? null,
      ratePerSecond: rate === undefined ? null : round(rate, 1),
      ratePerSecondFromStart: fromStartRate === undefined ? null : round(fromStartRate, 1),
      finalMs: finalAt === undefined ? null : finalAt - startedAt,
      notFinal: finalAt === undefined ? lastProblem : null,
      pendingMax: Math.max(0, ...series.map((s) => s.pending ?? 0)),
      raisedAtStart: Object.fromEntries(raised),
    };
    judge(
      report,
      'T2',
      'backlog drain rate after a 5-minute MES stop',
      '≥ 800 msg/s',
      rate === undefined
        ? 'did not catch up'
        : `${String(round(rate, 1))} msg/s (${String(drained)} messages in ${String(drainMs)} ms)`,
      rate !== undefined && rate >= 800,
    );
    judge(
      report,
      'T2',
      'every machine final again',
      '≤ 3 min of wall time after the start',
      finalAt === undefined
        ? `not final: ${lastProblem}`
        : `${String(round((finalAt - startedAt) / 1000, 1))} s`,
      finalAt !== undefined && finalAt - startedAt <= 3 * MINUTE,
    );
  });
}

// ---- Run P3 ----

async function runP3(config: PlantConfig, dir: string): Promise<RunReport> {
  const project = `${projectPrefix}-p3`;
  const report = newReport('p3', project);
  const stack = new Stack({
    project,
    env: { IMAGE_TAG: tag, SIM_AUTOSTART: 'false', ...observabilityEnv() },
    files: REPLAY_FILES,
    profiles: ['observability'],
  });
  return withStack(stack, report, dir, async () => {
    await stack.compose([
      'up',
      '--detach',
      '--wait',
      '--no-build',
      'db',
      'broker',
      'mes',
      'erp',
      'prometheus',
    ]);
    const mesBase = await stack.url('mes', 4700);
    await until('MES ready', () => new MesClient(mesBase).ready(), 120_000);
    const users = await provisionUsers(mesBase, stack.bootstrapAdminPassword, [
      { username: SUPERVISOR, roles: ['supervisor'] },
    ]);
    const cookie = users.get(SUPERVISOR)?.cookie;
    if (cookie === undefined) throw new Error(`${SUPERVISOR} was not created`);
    const mes = new MesClient(mesBase, cookie);
    const brokerUrl = (await stack.url('broker', 1883)).replace('http', 'mqtt');
    const skew = await clockSkew(stack);
    const before = histogram(await mesMetrics(mesBase), 'mes_ingest_lag_seconds');
    const replayReport = join(dir, 'replay.json');
    await rm(replayReport, { force: true });
    log('P3: publishing week-01 Monday at 180×');
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
          'src/perf-replay.e2e.test.ts',
        ],
        {
          cwd: REPO,
          env: {
            ...process.env,
            PERF_REPLAY_BROKER_URL: brokerUrl,
            PERF_REPLAY_PASSWORD: stack.value('MQTT_GATEWAY_PASSWORD'),
            PERF_REPLAY_REPORT: replayReport,
            PERF_REPLAY_SPEED: String(SPEED * 3),
          },
          stdio: 'inherit',
        },
      );
      child.on('exit', (exit) => {
        resolve(exit ?? 1);
      });
      child.on('error', () => {
        resolve(1);
      });
    });
    const replay = await readFile(replayReport, 'utf8').then(
      (text) =>
        JSON.parse(text) as {
          lastSeq: Record<string, number>;
          lastAt: string;
          messages: number;
          wallMs: number;
          start: string;
        },
      () => undefined,
    );
    if (code !== 0 || replay === undefined)
      throw new Error(`the replay failed or was skipped (exit ${String(code)})`);
    report.replay = replay;
    const lastAt = Date.parse(replay.lastAt);
    let finalAt: number | undefined;
    let behind = '';
    const deadline = Date.now() + 3 * MINUTE;
    while (Date.now() < deadline) {
      const through = await settled(stack);
      const open = Object.entries(replay.lastSeq).filter(
        ([id, seq]) => (through.get(id) ?? 0) < seq,
      );
      if (open.length === 0) {
        finalAt = Date.now();
        break;
      }
      behind = open
        .map(([id, seq]) => `${id} ${String(through.get(id) ?? 0)}/${String(seq)}`)
        .join(', ');
      await sleep(250);
    }
    const after = histogram(await mesMetrics(mesBase), 'mes_ingest_lag_seconds');

    // Monday's shift OEE, final and equal to the golden summary.
    const golden = JSON.parse(
      await readFile(join(REPO, 'apps/simulator/golden/week-01/summary.json'), 'utf8'),
    ) as { oee: unknown };
    const truth = groundTruthSchema.shape.oee.parse(golden.oee);
    const day = replay.start.slice(0, 10);
    const shiftIds = config.shifts.shifts.map((s) => s.id);
    const workCenters = config.plant.areas.flatMap((a) => a.workCenters.map((wc) => wc.id)).sort();
    const machines = Object.keys(replay.lastSeq).sort();
    const oee: Record<string, unknown> = {};
    const differences: string[] = [];
    let compared = 0;
    const oeeFrom = Date.now();
    for (const shift of shiftIds) {
      const key = `${day}/${shift}`;
      let read = await mes.shiftOee(key);
      await until(
        `${key} OEE final for every machine`,
        async () => {
          read = await mes.shiftOee(key);
          return machines.every((id) => read.equipment.find((b) => b.id === id)?.final === true);
        },
        2 * MINUTE,
      ).catch(() => undefined);
      for (const id of machines) {
        const bucket = read.equipment.find((b) => b.id === id);
        const expected = truth.machines[id]?.shifts[key];
        if (expected === undefined || bucket === undefined) {
          differences.push(
            `${key} ${id}: missing (truth ${String(expected !== undefined)}, MES ${String(bucket !== undefined)})`,
          );
          continue;
        }
        compared++;
        const diffs = jsonDifferences(expected, {
          inputs: { stateMs: bucket.inputs.stateMs, cycles: bucket.inputs.cycles },
          result: bucket.result,
        });
        if (!bucket.final) diffs.push('not final');
        differences.push(...diffs.map((d) => `${key} ${id} ${d}`));
      }
      for (const id of workCenters) {
        const bucket = read.workCenters.find((b) => b.id === id);
        const expected = truth.workCenters[id]?.shifts[key];
        if (expected === undefined || bucket === undefined) {
          differences.push(`${key} ${id}: missing`);
          continue;
        }
        compared++;
        const diffs = jsonDifferences(expected, bucket.result);
        if (!bucket.final) diffs.push('not final');
        differences.push(...diffs.map((d) => `${key} ${id} ${d}`));
      }
      oee[key] = Object.fromEntries(
        read.equipment.map((b) => [b.id, b.result.oee?.decimal ?? null]),
      );
    }
    const window = after === undefined ? undefined : histogramDelta(after, before);
    const share1 = window === undefined ? undefined : shareAtOrBelow(window, 1);
    report.t6 = {
      clockSkewMs: skew,
      messages: replay.messages,
      messagesPerSecond: round(replay.messages / (replay.wallMs / 1000), 1),
      lag:
        window === undefined
          ? null
          : {
              observations: window.count,
              p50Ms: round((quantile(window, 0.5) ?? 0) * 1000),
              p95Ms: round((quantile(window, 0.95) ?? 0) * 1000),
              p99Ms: round((quantile(window, 0.99) ?? 0) * 1000),
              shareAtOrBelow1s: share1 === undefined ? null : round(share1, 5),
            },
      finalAfterLastMs: finalAt === undefined ? null : finalAt - lastAt,
      notFinal: finalAt === undefined ? behind : null,
      oee,
      oeeCompared: compared,
      oeeWaitedMs: Date.now() - oeeFrom,
      oeeDifferences: differences.slice(0, 40),
    };
    if (window === undefined || share1 === undefined) {
      judge(
        report,
        'T6',
        'replay at 3× ingest lag p95',
        '≤ 1 s',
        'no mes_ingest_lag_seconds on this MES',
        null,
      );
    } else {
      judge(
        report,
        'T6',
        'replay at 3× ingest lag p95',
        '≤ 1 s (≥ 95 % at or below the 1 s edge)',
        `${ms((quantile(window, 0.95) ?? 0) * 1000)} (${pct(share1)} ≤ 1 s, ${String(window.count)} observations)`,
        window.count > 0 && share1 >= 0.95,
      );
    }
    judge(
      report,
      'T6',
      'every machine final after the last message',
      '≤ 30 s',
      finalAt === undefined
        ? `not final: ${behind}`
        : `${String(round((finalAt - lastAt) / 1000, 1))} s`,
      finalAt !== undefined && finalAt - lastAt <= 30_000,
    );
    const expectedComparisons = shiftIds.length * (machines.length + workCenters.length);
    judge(
      report,
      'T6',
      "Monday's shift OEE equal to the truth",
      `final and equal, ${String(expectedComparisons)} buckets`,
      differences.length === 0
        ? `${String(compared)} buckets equal`
        : `${String(differences.length)} differences, e.g. ${differences[0] ?? ''}`,
      differences.length === 0 && compared === expectedComparisons,
    );
  });
}

/** Host clock minus the VM's (ms), from the round trip with the smallest delay of five reads. */
async function clockSkew(stack: Stack): Promise<{ skewMs: number; uncertaintyMs: number } | null> {
  let best: { skewMs: number; uncertaintyMs: number } | null = null;
  for (let i = 0; i < 5; i++) {
    const before = Date.now();
    const out = await stack
      .compose(['exec', '-T', 'mes', 'node', '-e', 'console.log(Date.now())'])
      .catch(() => '');
    const after = Date.now();
    const vm = Number(out.trim());
    if (!Number.isFinite(vm) || vm === 0) continue;
    const candidate = { skewMs: (before + after) / 2 - vm, uncertaintyMs: (after - before) / 2 };
    if (best === null || candidate.uncertaintyMs < best.uncertaintyMs) best = candidate;
  }
  return best;
}

// ---- Stacks ----

function observabilityEnv(): Record<string, string> {
  return {
    // Compose interpolates Grafana's service too (compose.observability.yml); it never starts.
    GRAFANA_ADMIN_PASSWORD:
      Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    PROMETHEUS_PORT: '0',
    GRAFANA_PORT: '0',
  };
}

function liveStack(project: string, scenario: Scenario): Stack {
  return new Stack({
    project,
    env: {
      SIM_SEED: String(scenario.seed),
      SIM_START: scenario.start,
      SIM_SPEED: String(SPEED),
      SIM_AUTOSTART: 'false',
      SIM_PRODUCTION: 'orders',
      ERP_POLL_MS: '1000',
      IMAGE_TAG: tag,
      ...observabilityEnv(),
    },
    files: LIVE_FILES,
    profiles: ['observability'],
  });
}

let current: Stack | undefined;

async function withStack(
  stack: Stack,
  report: RunReport,
  dir: string,
  body: () => Promise<void>,
): Promise<RunReport> {
  await mkdir(dir, { recursive: true });
  const runStarted = Date.now();
  current = stack;
  let timer: NodeJS.Timeout | undefined;
  try {
    await stack.prepare();
    await stack.compose(['down', '--volumes', '--remove-orphans']);
    await Promise.race([
      body(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`the run exceeded ${String(DEADLINE_MS)} ms`));
        }, DEADLINE_MS);
      }),
    ]);
  } catch (error) {
    report.failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
    console.error(`run ${String(report.run)} failed`, error);
    await saveLogs(stack, dir).catch(() => undefined);
  } finally {
    clearTimeout(timer);
    report.wallMs = Date.now() - runStarted;
    await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await stack.destroy().catch((error: unknown) => {
      console.error('could not remove the stack', error);
    });
    current = undefined;
  }
  return report;
}

// ---- The environment of the measurement ----

async function environment(): Promise<Record<string, unknown>> {
  const text = async (command: string, args: readonly string[]) =>
    (await execute(command, args).catch(() => ({ stdout: '' }))).stdout.trim();
  const info = JSON.parse((await text('docker', ['info', '--format', '{{json .}}'])) || '{}') as {
    NCPU?: number;
    MemTotal?: number;
    KernelVersion?: string;
    OperatingSystem?: string;
    ServerVersion?: string;
  };
  const colima = await text('colima', ['list', '--json']);
  const disks = await checkDisks(REPO).catch(() => undefined);
  return {
    label,
    commit: await text('git', ['rev-parse', 'HEAD']),
    dirty: (await text('git', ['status', '--porcelain'])) !== '',
    vm: {
      cpus: info.NCPU ?? null,
      memoryGiB: info.MemTotal === undefined ? null : round(info.MemTotal / 2 ** 30, 2),
      kernel: info.KernelVersion ?? null,
      os: info.OperatingSystem ?? null,
      docker: info.ServerVersion ?? null,
      colima: colima === '' ? null : (JSON.parse(colima.split('\n')[0] ?? '{}') as unknown),
    },
    host: {
      cpus: cpus().length,
      memoryGiB: round(totalmem() / 2 ** 30, 1),
      loadAverage: loadavg().map((l) => round(l, 2)),
      freeDisk: disks === undefined ? null : formatGib(disks.host),
      dockerFreeDisk: disks === undefined ? null : formatGib(disks.docker),
    },
    node: process.version,
  };
}

async function imageDigests(): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const image of [
    ...STACK_IMAGES.map((i) => `shopfloor-twin/${i}:${tag}`),
    PROMETHEUS_IMAGE,
  ]) {
    const { stdout } = await execute('docker', [
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      image,
    ]).catch(() => ({ stdout: 'absent' }));
    digests[image] = stdout.trim();
  }
  return digests;
}

function markdown(results: { environment: Record<string, unknown>; targets: Target[] }): string {
  const env = results.environment as {
    label: string;
    commit: string;
    vm: Record<string, unknown>;
    host: Record<string, unknown>;
  };
  const lines = [
    `# Performance results: ${env.label}`,
    '',
    `Commit \`${env.commit}\`. VM: ${String(env.vm.cpus)} CPUs, ${String(env.vm.memoryGiB)} GiB (Colima: \`${JSON.stringify(env.vm.colima)}\`). Host load average ${JSON.stringify(env.host.loadAverage)}, free disk ${String(env.host.freeDisk)}.`,
    '',
    '| Target | Run | What | Target value | Measured | Result |',
    '| ------ | --- | ---- | ------------ | -------- | ------ |',
    ...results.targets.map(
      (t) =>
        `| ${t.id} | ${t.run.toUpperCase()} | ${t.what} | ${t.target} | ${t.value} | ${t.pass === null ? 'not measured' : t.pass ? 'pass' : 'miss'} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

async function main(): Promise<boolean> {
  await mkdir(RESULTS, { recursive: true });
  const stop = (signal: NodeJS.Signals) => {
    console.error(`${signal}: removing the stack`);
    void (current?.destroy() ?? Promise.resolve())
      .catch(() => undefined)
      .finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const loaded = await loadPlantConfig(join(REPO, 'config/plant'));
  if (!loaded.ok) throw new Error('the plant configuration does not load');
  const config = loaded.config;
  const scenario = JSON.parse(
    await readFile(join(REPO, 'apps/simulator/golden/orders-01/scenario.json'), 'utf8'),
  ) as Scenario;
  const env = await environment();
  log(`environment: ${JSON.stringify(env)}`);
  const prometheusPresent = await execute('docker', ['image', 'inspect', PROMETHEUS_IMAGE]).then(
    () => true,
    () => false,
  );
  const reports: Record<string, RunReport> = {};
  let built = false;
  try {
    if (!skipBuild) {
      const builder = liveStack(`${projectPrefix}-build`, scenario);
      await builder.prepare();
      log(`building the images (${tag})`);
      try {
        await builder.compose(['build'], 1_800_000);
        built = true;
      } finally {
        await builder.destroy().catch(() => undefined);
      }
      await pruneBuildCache(log);
    }
    for (const run of runsWanted) {
      const dir = join(RESULTS, run);
      log(`run ${run}`);
      if (run === 'p1') reports.p1 = await runP1(config, scenario, dir);
      else if (run === 'p2') reports.p2 = await runP2(config, scenario, dir);
      else if (run === 'p3') reports.p3 = await runP3(config, dir);
      else throw new Error(`unknown run ${run}`);
    }
  } finally {
    const digests = await imageDigests();
    const targets = Object.values(reports).flatMap((r) => r.targets);
    const failures = Object.values(reports).flatMap((r) =>
      r.failures.map((f) => `${String(r.run)}: ${f}`),
    );
    const results = {
      environment: {
        ...env,
        finishedLoadAverage: loadavg().map((l) => round(l, 2)),
        images: digests,
      },
      targets,
      failures,
      runs: reports,
      wallMs: Date.now() - started,
    };
    await writeFile(join(RESULTS, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
    await writeFile(join(RESULTS, 'results.md'), markdown(results));
    if (built && !keepImages) await removeImages(tag);
    if (!prometheusPresent && !keepImages) {
      await execute('docker', ['image', 'rm', PROMETHEUS_IMAGE]).catch(() => undefined);
    }
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  const all = Object.values(reports).flatMap((r) => r.targets);
  const failures = Object.values(reports).flatMap((r) => r.failures);
  console.log(markdown({ environment: env, targets: all }));
  const ok =
    failures.length === 0 &&
    all.length > 0 &&
    all.every((t) => t.pass === true) &&
    runsWanted.length === Object.keys(reports).length;
  console.log(
    ok
      ? 'PERF-OK'
      : `PERF-FAILED: ${[...failures, ...all.filter((t) => t.pass !== true).map((t) => `${t.id} ${t.what}`)].join('; ')}`,
  );
  return ok;
}

process.exit((await main()) ? 0 : 1);
