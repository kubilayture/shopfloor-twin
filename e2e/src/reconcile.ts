/**
 * Full-shift reconciliation through the whole chain (#100; Phase 4 exit criteria 1 and 3).
 *
 * Builds the images and starts the Compose stack under its own project in the plan's order: the
 * database and the broker, the MES ready, the simulator idle (`SIM_AUTOSTART=false`) and the
 * gateway connected with every machine's start-up state anchored in the MES, the web app; then
 * resumes the simulator at 60× from 06:00, the start of shift A. While the shift runs, Playwright
 * checks the live overview (browser/3-overview.spec.ts) and the live OEE dashboard
 * (browser/1-oee-live.spec.ts, #123). After shift end plus a margin, the run goes
 * on until every machine has sent a fact after the shift end (#113: a machine Down, in Setup or in
 * Maintenance across the shift end, or one without telemetry, keeps its last shift bucket
 * provisional until then), with a bounded wait that the report records. Then the simulator is
 * paused, the MES drains, and shift A must be final (`provisionalMs = 0`, `revision = 0`,
 * `incidents = 0` for every machine), its time per state must equal the simulator's live ground
 * truth to the millisecond, every stored piece must lie inside one UTC hour and one shift bucket,
 * and no data may have been lost (no gap incidents). Its OEE (`GET /api/v1/shifts/{date}/A/oee`,
 * #120) must be final for all six machines (`final`, `provisionalMs = 0`, `revision = 0`,
 * `incidents = 0`) and equal the live ground truth's OEE exactly: inputs, fractions, four-decimal
 * strings, totals, losses and `unplanned`, per machine and per work center; the comparison count
 * (six machines and two work centers, as in the plant configuration) is asserted.
 *
 * Phase 6 (#147): the run is the golden scenario `alarms-01` (the week-01 seed and start with
 * injected failures). Before the resume, shift A's injections are posted through the control API
 * 1.3 (`POST /faults/failure/{machine}` with their `at`), in the scenario's order, exactly as the
 * headless run schedules them; the injected flood, chattering and fleeting alarms then come through
 * the whole chain. `alarms-01`'s event log equals week-01's up to the first injection (the prefix
 * test in apps/simulator/src/headless/alarms-01.test.ts), so week-01's live evidence carries over,
 * and every Phase 4/5 check above keeps comparing with the live ground truth. Shift A's alarm KPIs
 * (`GET /api/v1/alarms/kpi`) for the plant and both operator positions, per hour and per shift,
 * must be final (`provisional` false, revision 0, incidents 0) and equal the live ground truth's
 * `alarms` section and `alarms-01`'s golden summary exactly (counts asserted). Shift A's report
 * (`GET /shifts/{date}/A/report`) must be final with `revision.inputs = 0`, its OEE section the
 * shift's OEE byte for byte, its alarm sections `GET /alarms/kpi`'s and the ground truth's, its
 * production the OEE inputs and the ground truth. During the shift, Playwright also judges
 * `/alarms` (every raise within 2 s, the flood banner) and the `/alarms/kpi` cards
 * (browser/2-alarms-live.spec.ts). After the drain, Playwright acknowledges, comments, shelves and
 * unshelves alarms (browser/final/alarm-actions.spec.ts), recodes and splits one of shift A's
 * downtime records (browser/final/downtime-coding.spec.ts, #123: the audit and the Pareto change,
 * OEE does not) and writes a handover note (browser/final/shift-report.spec.ts); the alarm KPIs and
 * OEE stay byte-identical across all of it, and the audit tables refuse UPDATE and DELETE.
 *
 * Identity (#170, MES_AUTH=on): the env file carries a generated MES_BOOTSTRAP_ADMIN_PASSWORD; once
 * the MES is ready, the bootstrap admin changes it and creates the run's supervisor
 * (`reconcile-supervisor`, generated password) through the API. Every API read of the run sends
 * its session cookie, and the Playwright checks log in as it through `/login`.
 *
 * Phase 7 (#178): a second pass runs orders-01's shift A in orders mode (SIM_PRODUCTION=orders) on
 * a Compose project of its own, with the ERP mock serving orders-01's dataset
 * (e2e/compose.reconcile-orders.yml). Before the resume, while the simulator waits idle at the
 * start, Playwright checks the roles (an operator and an admin see no order action and are refused
 * with 403) and the supervisor releases and dispatches the orders through the UI in the scenario's
 * order, each command confirmed by its device fact before the next (ADR-0030, B3); the commands
 * must equal the scenario's `dispatches`, each with exactly one `accepted` job fact, and the CNC
 * queues the golden run's. Then the injections, the resume and every check above against the live
 * ground truth and orders-01's golden summary, with the OEE dashboard, the alarm list and the Line
 * A1 terminal live in the browser (browser/orders/live: counts within 2 s, start, pause, resume).
 * After the drain (src/orders-pass.ts): at least three orders completed in shift A, each `completed`
 * in the ERP with one final confirmation per operation equal to the MES's and the ground truth's;
 * the new refusals on the order path; the paused simulator stepped on to orders-01's first scrap;
 * the sign-off at both terminals, a second operator who sees none of the first one's drafts and
 * codes the scrap, the supervisor's close (`closed` in the ERP) and the audit log; finally the
 * MES's outbox posted again after an MES restart, leaving the ERP unchanged.
 *
 * Phase 8 (#204): a third pass runs quality-01's shift A in orders mode on its own project, with the
 * scenario's ERP dataset and stock (e2e/compose.reconcile-quality.yml: ERP_DATASET, SIM_STOCK). The
 * import and the release and dispatch through the UI are the orders pass's; then the scenario's
 * leak drift is posted through the control API 1.5 (`POST /faults/drift/lkt-01`) before the resume.
 * During the shift Playwright judges every SPC episode on the SPC page and the Line A1 terminal
 * within 2 s (browser/quality/live), an operator signed on to Line A1 throughout. After the drain
 * and the Phase 4–7 comparisons above (src/quality-pass.ts): three projections of shift A at T =
 * Monday 14:00 Istanbul through `traceAsOf` are equal: the headless reference run with `end` at T,
 * the live ground truth `?asOf=T` and the MES's answers (a forward trace of every lot of the ERP's
 * list, a backward trace of each serial, the SPC chart API), the MES's final; then through the UI
 * (browser/quality/final) a serial's trace page with its crew, holds from the drift's episode and a
 * lot, the terminal's banners, the close refused (`quality-hold`) while held and allowed after the
 * release; each ERP notification held exactly once; the audit; the MES's outbox posted again after
 * an MES restart (replayed +N, created +0, the ERP unchanged, notifications included).
 *
 * Usage: pnpm test:reconcile. Results (per pass: report.json, compose.log on failure, Playwright
 * traces) go to e2e/results/<pass>/. Environment: RECONCILE_PASSES (default
 * `alarms,orders,quality`), RECONCILE_PROJECT (Compose project prefix, default
 * shopfloor-reconcile; each pass adds `-alarms`, `-orders` or `-quality`),
 * RECONCILE_TAG (image tag, default reconcile; give parallel runs their own),
 * RECONCILE_SKIP_BUILD=1 (use the images already built), RECONCILE_KEEP_IMAGES=1 (keep the images
 * it built; by default they are removed at the end, #228), RECONCILE_BROWSER=0 (no Playwright),
 * OVERVIEW_SAMPLE_MS and OEE_SAMPLE_MS (how long each live check samples, default 90000 each; the
 * `live` files run in name order: the OEE dashboard first, from the shift's start as in Phase 5,
 * ending 15 simulated minutes before the first injection at the latest; then the alarm check,
 * up to about 205 s; then the overview, which must end before the shift does, about 480 s),
 * RECONCILE_DEADLINE_MS (overall limit, default
 * 25 minutes), RECONCILE_SILENT_WAIT_MS (how long past the margin, in simulated time, the run may go
 * on for a silent machine's next fact; default 2 hours, 2 wall minutes at 60×). SIGINT and SIGTERM remove the stack and the env file before exiting.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  alarmKpiListSchema,
  shiftReportSchema,
  type AlarmKpiBucketDto,
} from '@shopfloor/contracts/mes-api';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { shiftSegments } from '@shopfloor/shift-calendar';
import {
  ErpClient,
  GatewayClient,
  MesClient,
  ordersTruthSchema,
  SimulatorClient,
  provisionUsers,
  gauge,
  groundTruthSchema,
  type Drift,
  type GroundTruth,
  type Injection,
  type ScenarioDrift,
  type ScenarioInjection,
} from './clients.ts';
import {
  differences,
  formatDifferences,
  jsonDifferences,
  mesTotals,
  percentile,
  pieceViolations,
  type Piece,
  type StateMs,
} from './compare.ts';
import {
  checkAuditAndClose,
  checkDispatch,
  checkImport,
  checkOrdersAfterDrain,
  checkRefusals,
  repostOutbox,
  stepToScrap,
  stepUntil,
  MAX_STEPS,
  type PassContext,
  type ScenarioDispatch,
} from './orders-pass.ts';
import {
  checkNotifications,
  checkTraceAsOf,
  mesTrace,
  referenceRun,
  checkCrew,
  type CrewWindow,
} from './quality-pass.ts';
import { pruneBuildCache } from '@shopfloor/test-kit/heavy-lock';
import { REPO, Stack, removeImages } from './stack.ts';
import { episodeIdentity, traceConfigOf, type TraceSectionJson } from './trace-shapes.ts';

const SPEED = 60;
/** Simulated time past shift end before the simulator is paused (5 wall seconds at 60×). */
const MARGIN_MS = 5 * 60_000;
const RESULTS = join(REPO, 'e2e/results');
/** The two passes (#178), each a golden scenario the live run reproduces on its own project. */
type PassName = 'alarms' | 'orders' | 'quality';
const PASS_NAMES: readonly PassName[] = ['alarms', 'orders', 'quality'];
const PASSES: Readonly<
  Record<PassName, { golden: string; evidence: string; injections: number; drifts: number }>
> = {
  // #147: week-01's seed with injected failures; its event log equals week-01's up to the first
  // injection (headless, #140).
  alarms: {
    golden: 'alarms-01',
    evidence:
      'apps/simulator/src/headless/alarms-01.test.ts: logs exactly what week-01 logs up to the first injection',
    // Shift A's failure injections: 13 on Cell M1, the fleeting one on LKT-01.
    injections: 14,
    drifts: 0,
  },
  // #178: orders mode, the jobs dispatched through LoadOrder at the idle start (#172, B3).
  orders: {
    golden: 'orders-01',
    evidence:
      'apps/simulator/src/opcua/live-dispatch.test.ts: reproduces headless orders-01 when the jobs are dispatched through LoadOrder at the idle start, then injected',
    injections: 14,
    drifts: 0,
  },
  // #204: orders mode on the scenario's stock and ERP dataset, one leak drift in shift A, no
  // failure injection; its shift-A reference run is a prefix of the full run (#208).
  quality: {
    golden: 'quality-01',
    evidence:
      'apps/simulator/src/headless/quality-01.test.ts: the shift-A reference run (end 14:00) logs a prefix of the full run, its trace is traceAsOf 14:00; apps/simulator/src/opcua/live-dispatch.test.ts: dispatch through LoadOrder at the idle start reproduces headless',
    injections: 0,
    drifts: 1,
  },
};
/** The ERP's dataset override of the orders pass. */
const ORDERS_COMPOSE = 'e2e/compose.reconcile-orders.yml';
/** The ERP's dataset and the simulator's stock of the quality pass (#204). */
const QUALITY_COMPOSE = 'e2e/compose.reconcile-quality.yml';
/**
 * The quality pass (#204): the lot held from its trace page and the order of shift A it covers
 * (quality-01: SK1-Q01-01, consumed by PO-2610-101 and PO-2610-102, both completed in shift A),
 * whose close is refused while held; the characteristic; the live SPC check's end (simulated), 5
 * minutes before the end of shift A, after the drift's end (10:50 UTC).
 */
const QUALITY_LOT = 'SK1-Q01-01';
const QUALITY_CLOSE_ORDER = 'PO-2610-101';
const CHARACTERISTIC = 'leak-rate';
const SPC_BEFORE_END_MS = 5 * 60_000;
/**
 * The live check's operator signs on this long (simulated) after the start of shift A (#204
 * review MEDIUM 2), so units whose OP30 ran before it test the crew's absence too.
 */
const CREW_FROM_MS = 60 * 60_000;
/** Orders mode: a completed order to sign off and close, and the one whose scrap is coded. */
const CLOSE_ORDER = 'PO-2610-001';
const SCRAP_ORDER = 'PO-2610-007';
const RUNNING_ORDER = 'PO-2610-005';
const UNRELEASED_ORDER = 'PO-2610-008';
/** Sampling of /alarms runs this long (simulated) past the last injection of the shift. */
const ALARMS_SAMPLE_PAST_MS = 3 * 60_000;
/** The OEE check stops sampling this long (simulated) before the first injection: 15 s at 60×. */
const OEE_BEFORE_INJECTION_MS = 15 * 60_000;
/**
 * The audit tables that must refuse UPDATE and DELETE (append-only by trigger), with a column to
 * set: the alarm module's transition log and, since #169, the one audit log the note writes go to
 * (shifts.handover_audit is frozen legacy and stays empty on a fresh stack).
 */
const AUDIT_TABLES = {
  'alarms.alarm_transition': 'actor',
  'identity.audit_log': 'username',
} as const;
/** Incident types that mean lost data: none may occur with the plan's start order. */
const LOSS_INCIDENTS = new Set(['sequence-gap', 'ring-overrun', 'buffer-overflow']);

/** How long (simulated) the run may go on past the margin until every machine sent a fact. */
const SILENT_WAIT_MS = Number(process.env.RECONCILE_SILENT_WAIT_MS ?? 2 * 3_600_000);

/** Wall time without the simulation clock moving after which the run fails at once. */
const STALL_MS = 30_000;

/** How long the MES may take to report shift A's OEE final after the drain (refresh debounce). */
const OEE_FINAL_MS = 30_000;

/** Overall limit of a run, below the CI job's timeout (30 minutes). */
const DEADLINE_MS = Number(process.env.RECONCILE_DEADLINE_MS ?? 25 * 60_000);

const projectPrefix = process.env.RECONCILE_PROJECT ?? 'shopfloor-reconcile';
const passNames = (process.env.RECONCILE_PASSES ?? PASS_NAMES.join(','))
  .split(',')
  .map((p) => p.trim())
  .filter((p): p is PassName => (PASS_NAMES as readonly string[]).includes(p));
/** The run's supervisor (#170): created per run, with a generated password. */
const RECONCILE_USER = 'reconcile-supervisor';
/** The orders pass's other users (#178), by what they are for, each with a generated password. */
const ORDER_USERS = {
  operator: { username: 'reconcile-operator', roles: ['operator'] },
  operator2: { username: 'reconcile-operator-2', roles: ['operator'] },
  quality: { username: 'reconcile-quality', roles: ['quality'] },
  maintenance: { username: 'reconcile-maintenance', roles: ['maintenance'] },
} as const;
const skipBuild = process.env.RECONCILE_SKIP_BUILD === '1';
const imageTag = process.env.RECONCILE_TAG ?? 'reconcile';
const withBrowser = process.env.RECONCILE_BROWSER !== '0';

const started = Date.now();
const log = (message: string) => {
  console.log(`[reconcile +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
};

/** Polls `check` until it returns true; fails with `what` after `timeoutMs`. */
async function until(what: string, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(timeoutMs)} ms: ${what}`, { cause: last });
    }
    // Jittered (#178): a fixed period can phase-lock with a periodic source, such as the
    // gateway's Modbus poller every 250 ms, and see its one message in flight at every poll.
    await sleep(250 + Math.floor(Math.random() * 500));
  }
}

/**
 * Runs one Playwright project against the stack (playwright.config.ts): `live` during the shift
 * (overview and OEE dashboard), `final` after the drain (downtime coding). Resolves with its exit
 * code.
 */
let browserChild: ChildProcess | undefined;

function runBrowser(project: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'playwright', 'test', '--project', project], {
      cwd: join(REPO, 'e2e'),
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    browserChild = child;
    child.on('error', (error) => {
      console.error(error);
      resolve(1);
    });
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

interface Report {
  pass: PassName;
  project: string;
  seed?: number;
  shiftKey?: string;
  phasesMs: Record<string, number>;
  shift?: {
    wallMs: number;
    simulatedMs: number;
    effectiveSpeed: number;
    lagMs: { samples: number; max: number; p95: number; mean: number };
  };
  /**
   * The run past the margin until every machine had sent a fact after the shift end: wall and
   * simulated time waited, and per machine how long after the shift end its first fact came.
   */
  silentWait?: {
    wallMs: number;
    simulatedMs: number;
    firstFactAfterEndMs: Record<string, number>;
  };
  drain?: { wallMs: number; watermark: string; simTime: string };
  machines?: Record<
    string,
    {
      truthMs: StateMs;
      equal: boolean;
      provisionalMs: number;
      revision: number;
      incidents: number;
      totalMs: number;
    }
  >;
  goldenShiftEqual?: boolean;
  /** Shift A's OEE in the live ground truth equals alarms-01's golden summary (#147). */
  goldenOeeEqual?: boolean;
  /** The scenario's shift A injections posted before the resume, and how they were applied. */
  injections?: {
    scenario: string;
    posted: number;
    prefixEvidence: string;
    applied: Pick<
      Injection,
      'id' | 'machine' | 'code' | 'at' | 'status' | 'heldAt' | 'appliedAt'
    >[];
  };
  /** Shift A's alarm KPIs from the MES against the live ground truth (#142, #147). */
  alarms?: {
    waitedMs: number;
    /** Shift buckets compared: the plant and both positions. */
    compared: number;
    /** Hour buckets of shift A compared, over the plant and both positions. */
    hoursCompared: number;
    goldenEqual: boolean;
    /** Raises of shift A per scope, and the flood, chattering and fleeting counts asserted. */
    raises: Record<string, number>;
    scopes: Record<
      string,
      {
        equal: boolean;
        final: boolean;
        revision: number;
        incidents: number;
        raises: number;
        differences: string[];
      }
    >;
  };
  /** Shift A's OEE from the MES against the live ground truth (#120). */
  oee?: {
    waitedMs: number;
    /** Buckets compared with the ground truth: six machines and two work centers. */
    compared: number;
    machines: Record<
      string,
      {
        equal: boolean;
        final: boolean;
        provisionalMs: number;
        revision: number;
        incidents: number;
        oee: string | null;
        differences: string[];
      }
    >;
    workCenters: Record<
      string,
      {
        equal: boolean;
        final: boolean;
        provisionalMs: number;
        revision: number;
        incidents: number;
        oee: string | null;
        differences: string[];
      }
    >;
  };
  /** Shift A's report (#144) against OEE, `/alarms/kpi` and the ground truth (#147). */
  shiftReport?: {
    waitedMs: number;
    final: boolean;
    revision: { inputs: number; content: number; contentAtFinal: number | null };
    incidents: number;
    oeeSectionIdentical: boolean;
    alarmScopesCompared: number;
    productionCompared: number;
    finished: { equipment: string | null; good: number };
    paretoMs: number;
    availabilityLossMs: number;
    instance: { start: string; end: string; breaks: number; calendarEqual: boolean };
    failures: string[];
  };
  pieces?: { count: number; violations: string[] };
  /** The orders pass (#178): import, dispatch, orders after the drain, refusals, terminal, ERP. */
  orders?: Record<string, unknown>;
  /** The quality pass (#204): the drift, the time cut, the trace page, holds, close, ERP. */
  quality?: Record<string, unknown>;
  incidents?: unknown[];
  rejectedMessages?: number;
  /** The live checks: the overview (#100), the OEE dashboard (#123) and the alarms (#147). */
  browser?: { exitCode: number; report?: unknown; oee?: unknown; alarms?: unknown };
  /**
   * The checks after the drain: alarm actions and the handover note (#147), the downtime coding
   * (#123), with the alarm KPIs and OEE byte-identical across them and the audits append-only.
   */
  coding?: {
    exitCode: number;
    report?: unknown;
    alarmActions?: unknown;
    shiftReport?: unknown;
    alarmKpiIdentical?: boolean;
    oeeIdentical?: boolean;
    auditRefusals?: Record<
      string,
      {
        rows: number;
        update: { refused: boolean; message: string };
        delete: { refused: boolean; message: string };
      }
    >;
  };
  totalMs?: number;
  failures: string[];
}

async function main(): Promise<boolean> {
  await rm(RESULTS, { recursive: true, force: true });
  if (passNames.length === 0) {
    throw new Error(`RECONCILE_PASSES names no pass (${PASS_NAMES.join(', ')})`);
  }
  const outcomes: [PassName, boolean][] = [];
  try {
    for (const [n, name] of passNames.entries()) {
      // The images are built once, by the first pass.
      outcomes.push([name, await runPass(name, n === 0 && !skipBuild)]);
    }
  } finally {
    // The images it built go too, pass or fail (#228), unless the caller keeps them (the gate
    // records their digests and removes them itself); images it didn't build are the caller's.
    if (!skipBuild && process.env.RECONCILE_KEEP_IMAGES !== '1') {
      log(`removing the images it built (${imageTag})`);
      await removeImages(imageTag);
    }
  }
  log(`passes: ${outcomes.map(([name, ok]) => `${name} ${ok ? 'OK' : 'FAILED'}`).join(', ')}`);
  return outcomes.every(([, ok]) => ok);
}

async function runPass(pass: PassName, build: boolean): Promise<boolean> {
  const RESULTS_DIR = join(RESULTS, pass);
  const GOLDEN = join(REPO, 'apps/simulator/golden', PASSES[pass].golden);
  const goldenName = PASSES[pass].golden;
  const quality = pass === 'quality';
  /** Orders mode: the orders pass and the quality pass (#204) run orders-mode scenarios. */
  const orders = pass === 'orders' || quality;
  const project = `${projectPrefix}-${pass}`;
  await mkdir(RESULTS_DIR, { recursive: true });
  log(`pass ${pass}: ${goldenName} on project ${project}`);
  const report: Report = { pass, project, phasesMs: {}, failures: [] };
  const fail = (message: string) => {
    report.failures.push(message);
    console.error(`FAIL: ${message}`);
  };
  /**
   * A report a Playwright check of the orders pass writes at its end (#178 review): missing means
   * the check was skipped or stopped early, which is a failure, never a pass.
   */
  const requiredJson = async (name: string): Promise<unknown> => {
    const value = await readJson(join(RESULTS_DIR, name));
    if (value === undefined)
      fail(`${name} is missing: its Playwright check did not run to its end`);
    return value;
  };
  let phaseStart = Date.now();
  const phase = (name: string) => {
    const now = Date.now();
    report.phasesMs[name] = now - phaseStart;
    phaseStart = now;
  };

  // The scenario's seed and start (week-01's: Monday 06:00 Istanbul, the start of shift A).
  const scenario = JSON.parse(await readFile(join(GOLDEN, 'scenario.json'), 'utf8')) as {
    seed: number;
    start: string;
    injections?: (ScenarioInjection | ScenarioDrift)[];
    production?: 'orders';
    erp?: { dataset: string; release: string[] };
    dispatches?: ScenarioDispatch[];
  };
  if (orders !== (scenario.production === 'orders')) {
    throw new Error(`${goldenName} is not a scenario for the ${pass} pass`);
  }
  // A scenario entry with a `kind` (#196) is a leak drift, posted to `/faults/drift/{machine}`;
  // any other kind is refused here, not misread as a failure injection.
  const unknownKinds = (scenario.injections ?? []).filter(
    (i) => 'kind' in i && (i as { kind: unknown }).kind !== 'leak-drift',
  );
  if (unknownKinds.length > 0) {
    throw new Error(
      `${goldenName}: injections of an unknown kind: ${JSON.stringify(unknownKinds)}`,
    );
  }
  const loaded = await loadPlantConfig(join(REPO, 'config/plant'));
  if (!loaded.ok) throw new Error(formatIssues(loaded.issues));
  const shifts = loaded.config.shifts;
  // The plant's machines and work centers: every one must be reconciled (exit criterion 3).
  const plantWorkCenters = loaded.config.plant.areas.flatMap((area) => area.workCenters);
  const plantMachines = plantWorkCenters.flatMap((wc) => wc.equipment.map((e) => e.id)).sort();
  const workCenterIds = plantWorkCenters.map((wc) => wc.id).sort();
  const start = Date.parse(scenario.start);
  const [shift] = shiftSegments(shifts, start, start + 24 * 3_600_000);
  if (shift?.from !== start || shift.key === 'no-shift') {
    throw new Error(`${scenario.start} is not the start of a shift`);
  }
  const shiftKey = shift.key;
  const stopAt = shift.to + MARGIN_MS;
  // Shift A's injections and drifts, in the scenario's order (the order fixes the queue's
  // tie-breaking; drifts and failure injections share one numbering, control API 1.5).
  const scheduled = (scenario.injections ?? []).filter(
    (i) => Date.parse(i.at) >= shift.from && Date.parse(i.at) < shift.to,
  );
  const isDrift = (i: ScenarioInjection | ScenarioDrift): i is ScenarioDrift => 'kind' in i;
  const injections = scheduled.filter((i): i is ScenarioInjection => !isDrift(i));
  const drifts = scheduled.filter(isDrift);
  // Exactly the scenario's: alarms-01 and orders-01 14 failures in shift A (13 on Cell M1, the
  // fleeting one on LKT-01), quality-01 one drift and no failure.
  if (injections.length !== PASSES[pass].injections || drifts.length !== PASSES[pass].drifts) {
    throw new Error(
      `${GOLDEN}: ${String(injections.length)} injections and ${String(drifts.length)} drifts in ${shift.key}, not ${String(PASSES[pass].injections)} and ${String(PASSES[pass].drifts)}`,
    );
  }
  const injectionTimes = injections.map((i) => Date.parse(i.at));
  const alarmsUntil =
    injectionTimes.length === 0 ? shift.to : Math.max(...injectionTimes) + ALARMS_SAMPLE_PAST_MS;
  // The OEE check (first) ends this long (simulated) before the first injection, so the alarm
  // check has time to start before it, however slow the environment.
  const oeeUntil =
    injectionTimes.length === 0 ? shift.to : Math.min(...injectionTimes) - OEE_BEFORE_INJECTION_MS;
  report.seed = scenario.seed;
  report.shiftKey = shiftKey;

  const stack = new Stack({
    project,
    env: {
      SIM_SEED: String(scenario.seed),
      SIM_START: scenario.start,
      SIM_SPEED: String(SPEED),
      SIM_AUTOSTART: 'false',
      // Its own image tags: the run never replaces the dev stack's images, and RECONCILE_TAG
      // keeps parallel runs (other worktrees) from building over each other's.
      IMAGE_TAG: imageTag,
      // Orders mode (#178): the CNCs run only LoadOrder jobs; the MES pulls the ERP every second.
      ...(orders ? { SIM_PRODUCTION: 'orders', ERP_POLL_MS: '1000' } : {}),
    },
    files: quality ? [QUALITY_COMPOSE] : orders ? [ORDERS_COMPOSE] : [],
  });
  let browser: Promise<number> | undefined;
  // Ctrl+C or a cancelled job: remove the stack and the env file with its passwords, then exit.
  const stop = (signal: NodeJS.Signals) => {
    console.error(`${signal}: removing the stack`);
    browserChild?.kill('SIGTERM');
    stack
      .destroy()
      .catch((error: unknown) => {
        console.error('could not remove the stack', error);
      })
      .finally(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // An overall deadline below the CI job's limit: a slow run fails here, with its report and
  // logs, instead of being cancelled without them.
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      browserChild?.kill('SIGTERM');
      reject(new Error(`the run exceeded its deadline of ${String(DEADLINE_MS)} ms`));
    }, DEADLINE_MS);
  });
  try {
    await Promise.race([
      (async () => {
        await stack.prepare();
        // Leftovers of an aborted run: start from empty volumes.
        await stack.compose(['down', '--volumes', '--remove-orphans']);
        if (build) {
          log('building the images');
          await stack.compose(['build'], 1_200_000);
          // The BuildKit cache kept to 10 GiB after each build (#228).
          await pruneBuildCache(log);
        }
        phase('build');

        // 1. Database and broker, then the MES ready (migrated, subscribed to the UNS).
        log('starting db, broker and mes');
        await stack.compose([
          'up',
          '--detach',
          '--wait',
          '--no-build',
          'db',
          'broker',
          'mes',
          // Orders mode (#178): the ERP mock with orders-01's dataset, which the MES pulls.
          ...(orders ? ['erp'] : []),
        ]);
        const mesBase = await stack.url('mes', 4700);
        await until('MES ready', () => new MesClient(mesBase).ready(), 60_000);
        // Identity (#170, MES_AUTH=on): the bootstrap admin (generated password, must change it)
        // creates the run's supervisor through the API; every read and the browser log in as it.
        const users = await provisionUsers(mesBase, stack.bootstrapAdminPassword, [
          { username: RECONCILE_USER, roles: ['supervisor'] },
          ...(orders ? Object.values(ORDER_USERS) : []),
        ]);
        const supervisor = users.get(RECONCILE_USER);
        if (!supervisor) throw new Error(`${RECONCILE_USER} was not created`);
        const mes = new MesClient(mesBase, supervisor.cookie);
        // The orders pass's other users for the browser (#178): passwords generated this run.
        const accounts = Object.fromEntries(
          [
            ...Object.entries(ORDER_USERS).map(([name, u]) => [name, u.username] as const),
            ['admin', 'admin'] as const,
          ].flatMap(([name, username]) => {
            const user = users.get(username);
            return orders && user ? [[name, { username, password: user.password }]] : [];
          }),
        );
        const browserLogin = {
          RECONCILE_USERNAME: RECONCILE_USER,
          RECONCILE_PASSWORD: supervisor.password,
          RECONCILE_ACCOUNTS: JSON.stringify(accounts),
        };
        log(`logged in as ${RECONCILE_USER} (supervisor, made by the bootstrap admin)`);
        phase('mesReady');

        // 2. The simulator, idle at 06:00, and the gateway connected to it and to the broker. The
        //    gateway reads every machine's start-up state (Off at 06:00) and publishes it as a snapshot,
        //    which the MES anchors: it knows every machine's state from the first instant of the shift.
        log('starting the simulator (idle) and the gateway');
        await stack.compose(['up', '--detach', '--wait', '--no-build', 'simulator', 'gateway']);
        const sim = new SimulatorClient(await stack.url('simulator', 4800));
        const gateway = new GatewayClient(await stack.url('gateway', 4900));
        const idle = await sim.status();
        if (idle.state !== 'idle' || Date.parse(idle.simTime) !== start) {
          throw new Error(
            `the simulator must wait idle at ${scenario.start}: ${JSON.stringify(idle)}`,
          );
        }
        const initial = await sim.groundTruth();
        const machines = Object.keys(initial.machines).sort();
        if (JSON.stringify(machines) !== JSON.stringify(plantMachines)) {
          throw new Error(
            `the ground truth's machines ${machines.join(', ')} are not the plant's ${plantMachines.join(', ')}`,
          );
        }
        await until(
          'gateway ready with every machine connected',
          async () => {
            if (!(await gateway.ready())) return false;
            const connected = gauge(await gateway.metrics(), 'gateway_device_connected');
            return machines.every((id) => connected.get(id) === 1);
          },
          60_000,
        );
        await until(
          "every machine's start-up state anchored in the MES",
          async () => {
            const { equipment } = await mes.equipment();
            return machines.every((id) => {
              const current = equipment.find((e) => e.id === id)?.current;
              return current?.epoch === initial.epoch && Date.parse(current.since) === start;
            });
          },
          60_000,
        );
        phase('gatewayConnected');

        // Orders mode (#178): the ERP's orders imported, then the roles and the supervisor's
        // release and dispatch through the UI while the simulator waits idle at the start, each
        // command confirmed by its device fact before the next: the order headless applies them
        // in (ADR-0030, B3). Only then the injections and the resume.
        let webUrl = '';
        let ctx: PassContext | undefined;
        const ordersReport: Record<string, unknown> = {};
        const goldenOrders = orders
          ? ordersTruthSchema.parse(
              (
                JSON.parse(await readFile(join(GOLDEN, 'summary.json'), 'utf8')) as {
                  orders: unknown;
                }
              ).orders,
            )
          : undefined;
        if (orders) {
          report.orders = ordersReport;
          if (!withBrowser)
            throw new Error(
              'the orders pass dispatches through the UI: RECONCILE_BROWSER=0 is not possible',
            );
          const erp = new ErpClient(await stack.url('erp', 4600), stack.value('ERP_API_TOKEN'));
          ctx = { stack, mes, erp, sim, gateway, log, fail };
          log('starting web');
          await stack.compose(['up', '--detach', '--wait', '--no-build', 'web']);
          webUrl = await stack.url('web', 8080);
          ordersReport.import = await checkImport(ctx);
          log(`the MES imported the ERP's orders: ${JSON.stringify(ordersReport.import)}`);
          const exitCode = await runBrowser('orders-dispatch', {
            RECONCILE_WEB_URL: webUrl,
            RECONCILE_MES_URL: mes.base,
            RECONCILE_RESULTS: RESULTS_DIR,
            RECONCILE_RELEASE: JSON.stringify(scenario.erp?.release ?? []),
            RECONCILE_DISPATCHES: JSON.stringify(scenario.dispatches ?? []),
            RECONCILE_ROLE_ORDER: scenario.erp?.release[0] ?? '',
            ...browserLogin,
          });
          ordersReport.roles = await requiredJson('roles.json');
          ordersReport.dispatchTimings = await requiredJson('dispatch.json');
          if (exitCode !== 0) {
            throw new Error(
              `the roles or the release and dispatch through the UI failed (Playwright exit ${String(exitCode)})`,
            );
          }
          ordersReport.dispatch = await checkDispatch(
            ctx,
            scenario.dispatches ?? [],
            goldenOrders?.jobs ?? [],
          );
          const still = await sim.status();
          if (still.state !== 'idle' || Date.parse(still.simTime) !== start) {
            throw new Error(`the simulator moved during the dispatch: ${JSON.stringify(still)}`);
          }
          log(`dispatched through the UI: ${JSON.stringify(ordersReport.dispatch)}`);
          phase('dispatch');
        }

        // The scenario's shift A injections, before the resume, in its order: the same events in
        // the queue as in the headless run (control API 1.3, "Determinism").
        // Drifts (#204) go to `/faults/drift/{machine}` (control API 1.5), in the same order.
        const posted: (Injection | Drift)[] = [];
        for (const entry of scheduled) {
          posted.push(isDrift(entry) ? await sim.drift(entry) : await sim.inject(entry));
        }
        const expectedPosted = scheduled.map((i, n) =>
          isDrift(i)
            ? [n + 1, i.machine, 'leak-drift', Date.parse(i.at), i.shift, Date.parse(i.until)]
            : [n + 1, i.machine, i.code, Date.parse(i.at), i.repairMs ?? null],
        );
        const actualPosted = posted.map((i) =>
          'shift' in i
            ? [i.id, i.machine, 'leak-drift', Date.parse(i.at), i.shift, Date.parse(i.until)]
            : [i.id, i.machine, i.code, Date.parse(i.at), i.repairMs ?? null],
        );
        if (
          JSON.stringify(actualPosted) !== JSON.stringify(expectedPosted) ||
          posted.some((i) => i.status !== 'scheduled')
        ) {
          throw new Error(`injections not scheduled as posted: ${JSON.stringify(posted)}`);
        }
        log(
          `scheduled ${String(injections.length)} injections and ${String(drifts.length)} drifts of ${shiftKey}`,
        );

        if (!orders) {
          log('starting web');
          await stack.compose(['up', '--detach', '--wait', '--no-build', 'web']);
          webUrl = await stack.url('web', 8080);
        }
        phase('webReady');

        // 3. Go: shift A at 60×.
        log(
          `resuming the simulator at ${String(SPEED)}× from ${scenario.start} (seed ${String(scenario.seed)})`,
        );
        const resumedAt = Date.now();
        await sim.resume();
        if (withBrowser) {
          browser = runBrowser(quality ? 'quality-live' : orders ? 'orders-live' : 'live', {
            RECONCILE_WEB_URL: webUrl,
            RECONCILE_SIM_URL: sim.base,
            RECONCILE_MES_URL: mes.base,
            RECONCILE_RESULTS: RESULTS_DIR,
            RECONCILE_TERMINAL_ORDER: RUNNING_ORDER,
            RECONCILE_SHIFT: shiftKey,
            RECONCILE_ALARMS_UNTIL: new Date(alarmsUntil).toISOString(),
            RECONCILE_OEE_UNTIL: new Date(oeeUntil).toISOString(),
            ...(quality
              ? {
                  RECONCILE_CHARACTERISTIC: CHARACTERISTIC,
                  RECONCILE_SPC_UNTIL: new Date(shift.to - SPC_BEFORE_END_MS).toISOString(),
                  RECONCILE_DRIFT_EPISODE: await goldenDriftEpisode(GOLDEN),
                  RECONCILE_CREW_FROM: new Date(shift.from + CREW_FROM_MS).toISOString(),
                }
              : {}),
            ...browserLogin,
          });
        }

        const lags: number[] = [];
        let lastProgress = 0;
        const nominalWallMs = (stopAt - start) / SPEED;
        // Per machine, how long after the shift end its first fact came (as the MES stored it), at
        // least fleetingMs (1 s) after it: alarm KPI buckets are final from there (#142).
        const shiftEnd = new Date(shift.to).toISOString();
        const factsAfterEnd = () =>
          stack.sqlJson<Record<string, number>>(
            `SELECT coalesce(json_object_agg(equipment, ms), '{}') FROM (
               SELECT equipment,
                 (extract(epoch FROM min(source_time) - '${shiftEnd}'::timestamptz) * 1000)::bigint AS ms
               FROM ingest.equipment_event
               WHERE epoch = ${String(initial.epoch)}
                 AND source_time >= '${shiftEnd}'::timestamptz + interval '1 second'
               GROUP BY equipment) AS t`,
          );
        let waitFrom: { wall: number; sim: number } | undefined;
        // The simulation must keep moving while the run waits for silent machines.
        let lastMove = { wall: Date.now(), sim: start };
        let afterEnd: Record<string, number> = {};
        for (;;) {
          const status = await sim.status();
          lags.push(status.lagMs);
          const simNow = Date.parse(status.simTime);
          if (status.state !== 'running')
            throw new Error(`simulator ${status.state} during the shift`);
          if (simNow > lastMove.sim) lastMove = { wall: Date.now(), sim: simNow };
          if (Date.now() - lastMove.wall > STALL_MS) {
            throw new Error(
              `simulation time stalled at ${status.simTime} for ${String(STALL_MS)} ms of wall time`,
            );
          }
          if (simNow >= stopAt) {
            // #113: each machine's last shift bucket is final only after its next fact.
            waitFrom ??= { wall: Date.now(), sim: simNow };
            afterEnd = await factsAfterEnd();
            const silent = machines.filter((id) => afterEnd[id] === undefined);
            if (silent.length === 0) break;
            // Orders mode (#178): a CNC without a job stays Idle NO-ORDER for hours after the
            // shift (CNC-02 from 08:55 to the shift B break at 18:00 in orders-01), so the run is
            // paused and stepped on, event by event, until every machine has sent its fact: the
            // same events as paced, without minutes of waiting.
            if (orders && ctx) {
              await sim.pause();
              const silentSteps = await stepUntil(
                ctx,
                'a fact of every machine after the shift end',
                async () => {
                  afterEnd = await factsAfterEnd();
                  return machines.every((id) => afterEnd[id] !== undefined);
                },
              );
              ordersReport.silentSteps = { steps: silentSteps, maxSteps: MAX_STEPS };
              break;
            }
            // Its own wall budget too: twice its nominal wall time, plus a minute.
            const waitedMs = Date.now() - waitFrom.wall;
            if (
              simNow >= stopAt + SILENT_WAIT_MS ||
              waitedMs > (2 * SILENT_WAIT_MS) / SPEED + 60_000
            ) {
              throw new Error(
                `no fact after the shift end within ${String(SILENT_WAIT_MS)} ms of simulated time (or its wall budget): ${silent.join(', ')}`,
              );
            }
          } else {
            const elapsed = Date.now() - resumedAt;
            if (elapsed - lastProgress >= 60_000) {
              lastProgress = elapsed;
              log(`simulation at ${status.simTime}, lag ${String(status.lagMs)} ms`);
            }
            if (elapsed > 2 * nominalWallMs) {
              throw new Error(
                `the shift takes too long: ${status.simTime} after ${String(elapsed)} ms`,
              );
            }
          }
          await sleep(1_000);
        }
        const paused = await sim.pause();
        const pausedAt = Date.now();
        report.silentWait = {
          wallMs: pausedAt - waitFrom.wall,
          simulatedMs: Date.parse(paused.simTime) - waitFrom.sim,
          firstFactAfterEndMs: afterEnd,
        };
        log(`every machine sent a fact after the shift end: ${JSON.stringify(report.silentWait)}`);
        const simulatedMs = Date.parse(paused.simTime) - start;
        report.shift = {
          wallMs: pausedAt - resumedAt,
          simulatedMs,
          effectiveSpeed: Math.round((simulatedMs / (pausedAt - resumedAt)) * 100) / 100,
          lagMs: {
            samples: lags.length,
            max: Math.max(...lags),
            p95: percentile(lags, 95),
            mean: Math.round((lags.reduce((a, b) => a + b, 0) / lags.length) * 10) / 10,
          },
        };
        phase('shift');
        log(`paused at ${paused.simTime}: ${JSON.stringify(report.shift)}`);

        // 4. Drain: the MES has every fact (each machine's current state equals the simulator's), its
        //    watermark is past shift end and the gateway's buffer is empty. Shift A is then final:
        //    no "totals stable" wait any more (#113), the totals are read once.
        const truth: GroundTruth = await sim.groundTruth();
        let watermark = '';
        await until(
          'MES drained',
          async () => {
            const [plant, { equipment }, metrics] = await Promise.all([
              mes.plant(),
              mes.equipment(),
              gateway.metrics(),
            ]);
            if (plant.clock?.epoch !== truth.epoch) return false;
            watermark = plant.clock.watermark;
            const current = machines.every((id) => {
              const known = equipment.find((e) => e.id === id)?.current;
              const expected = truth.current[id];
              return (
                known?.state === expected?.state &&
                Date.parse(known?.since ?? '') === Date.parse(expected?.since ?? '')
              );
            });
            const buffered = gauge(metrics, 'gateway_buffer_messages').get('');
            return current && buffered === 0 && Date.parse(watermark) >= shift.to;
          },
          120_000,
        );
        const totals = await mes.shiftTotals(shiftKey);
        report.drain = { wallMs: Date.now() - pausedAt, watermark, simTime: truth.simTime };
        phase('drain');

        // 5. Compare.
        if (truth.buckets[shiftKey]?.complete !== true) fail(`${shiftKey} is not complete`);
        const expected = Object.fromEntries(
          machines.map((id) => [id, truth.machines[id]?.byShift[shiftKey] ?? {}]),
        );
        const recorded = mesTotals(totals.totals, truth.epoch, machines);
        const diffs = differences(expected, recorded.byMachine);
        report.machines = Object.fromEntries(
          machines.map((id) => {
            const truthMs = expected[id] ?? {};
            return [
              id,
              {
                truthMs,
                equal: diffs.every((d) => d.machine !== id),
                provisionalMs: recorded.provisionalMs[id] ?? 0,
                revision: recorded.revision[id] ?? 0,
                incidents: recorded.incidents[id] ?? 0,
                totalMs: Object.values(truthMs).reduce((a, b) => a + b, 0),
              },
            ];
          }),
        );
        if (diffs.length > 0) {
          fail(
            `time per state in ${shiftKey} differs from the ground truth:\n${formatDifferences(diffs)}`,
          );
        }
        if (recorded.unexpected.length > 0) {
          fail(
            `unexpected MES totals (other epochs or unknown machines): ${JSON.stringify(recorded.unexpected)}`,
          );
        }
        for (const [id, machine] of Object.entries(report.machines)) {
          if (machine.totalMs !== shift.to - shift.from)
            fail(`${id}: ground truth covers ${String(machine.totalMs)} ms`);
          // #113: the completed shift is final, unchanged since, and had no gap.
          if (machine.provisionalMs !== 0 || machine.revision !== 0 || machine.incidents !== 0) {
            fail(
              `${id}: ${shiftKey} not final (provisionalMs ${String(machine.provisionalMs)}, revision ${String(machine.revision)}, incidents ${String(machine.incidents)})`,
            );
          }
        }

        // OEE (#120, exit criterion 3): shift A final for every machine, equal to the live truth.
        const oeeFrom = Date.now();
        let shiftOee = await mes.shiftOee(shiftKey);
        const allFinal = () =>
          machines.every((id) => shiftOee.equipment.find((b) => b.id === id)?.final === true);
        await until(
          `${shiftKey} OEE final for every machine`,
          async () => {
            shiftOee = await mes.shiftOee(shiftKey);
            return allFinal();
          },
          OEE_FINAL_MS,
        ).catch((error: unknown) => {
          fail(error instanceof Error ? error.message : String(error));
        });
        report.oee = {
          waitedMs: Date.now() - oeeFrom,
          compared: 0,
          machines: {},
          workCenters: {},
        };
        // Exactly the plant's machines and work centers, on both sides.
        const ids = (list: readonly { id: string }[]) =>
          list
            .map((b) => b.id)
            .sort()
            .join(', ');
        for (const [what, actual, expected] of [
          ['MES machines', ids(shiftOee.equipment), machines.join(', ')],
          ['MES work centers', ids(shiftOee.workCenters), workCenterIds.join(', ')],
          [
            'ground-truth work centers',
            Object.keys(truth.oee.workCenters).sort().join(', '),
            workCenterIds.join(', '),
          ],
        ] as const) {
          if (actual !== expected) fail(`${shiftKey} OEE: ${what} are ${actual}, not ${expected}`);
        }
        for (const id of machines) {
          const bucket = shiftOee.equipment.find((b) => b.id === id);
          const expectedOee = truth.oee.machines[id]?.shifts[shiftKey];
          const diffs = jsonDifferences(
            expectedOee ?? null,
            bucket
              ? {
                  inputs: { stateMs: bucket.inputs.stateMs, cycles: bucket.inputs.cycles },
                  result: bucket.result,
                }
              : null,
          );
          if (expectedOee && bucket) report.oee.compared++;
          report.oee.machines[id] = {
            equal: diffs.length === 0,
            final: bucket?.final ?? false,
            provisionalMs: bucket?.provisionalMs ?? -1,
            revision: bucket?.revision ?? -1,
            incidents: bucket?.incidents ?? -1,
            oee: bucket?.result.oee?.decimal ?? null,
            differences: diffs,
          };
          if (diffs.length > 0) {
            fail(`${id}: ${shiftKey} OEE differs from the ground truth:\n  ${diffs.join('\n  ')}`);
          }
          if (
            !bucket?.final ||
            bucket.provisionalMs !== 0 ||
            bucket.revision !== 0 ||
            bucket.incidents !== 0
          ) {
            fail(
              `${id}: ${shiftKey} OEE not final (final ${String(bucket?.final)}, provisionalMs ${String(bucket?.provisionalMs)}, revision ${String(bucket?.revision)}, incidents ${String(bucket?.incidents)})`,
            );
          }
        }
        for (const id of workCenterIds) {
          const bucket = shiftOee.workCenters.find((b) => b.id === id);
          const expectedOee = truth.oee.workCenters[id]?.shifts[shiftKey];
          // A work center's inputs are its machines' sums, compared above; here its result.
          const diffs = jsonDifferences(expectedOee ?? null, bucket?.result ?? null);
          if (expectedOee && bucket) report.oee.compared++;
          report.oee.workCenters[id] = {
            equal: diffs.length === 0,
            final: bucket?.final ?? false,
            provisionalMs: bucket?.provisionalMs ?? -1,
            revision: bucket?.revision ?? -1,
            incidents: bucket?.incidents ?? -1,
            oee: bucket?.result.oee?.decimal ?? null,
            differences: diffs,
          };
          if (diffs.length > 0) {
            fail(`${id}: ${shiftKey} OEE differs from the ground truth:\n  ${diffs.join('\n  ')}`);
          }
          if (
            !bucket?.final ||
            bucket.provisionalMs !== 0 ||
            bucket.revision !== 0 ||
            bucket.incidents !== 0
          ) {
            fail(
              `${id}: ${shiftKey} OEE not final (final ${String(bucket?.final)}, provisionalMs ${String(bucket?.provisionalMs)}, revision ${String(bucket?.revision)}, incidents ${String(bucket?.incidents)})`,
            );
          }
        }
        // Every bucket compared: six machines and two work centers in the golden plant.
        const comparisons = plantMachines.length + workCenterIds.length;
        if (report.oee.compared !== comparisons || comparisons !== 8) {
          fail(
            `${shiftKey} OEE: ${String(report.oee.compared)} buckets compared, not ${String(comparisons)} (6 machines and 2 work centers)`,
          );
        }

        // The live run reproduces the headless scenario's shift A: pacing never changes the run.
        const golden = JSON.parse(await readFile(join(GOLDEN, 'summary.json'), 'utf8')) as {
          machines: Record<string, { byShift: Record<string, StateMs> }>;
          oee: unknown;
          alarms: {
            scopes: Record<
              string,
              { shifts: Record<string, unknown>; hours: Record<string, unknown> }
            >;
          };
        };

        // The drifts (#204): applied at their start, ended by their `until`, inside shift A.
        if (drifts.length > 0) {
          const listed = await sim.drifts();
          report.quality = {
            ...report.quality,
            drifts: listed,
          };
          for (const [n, drift] of listed.entries()) {
            const expected = drifts[n];
            if (
              !expected ||
              drift.status !== 'ended' ||
              drift.endedBy !== 'until' ||
              Date.parse(drift.appliedAt ?? '') !== Date.parse(expected.at) ||
              Date.parse(drift.endedAt ?? '') !== Date.parse(expected.until)
            ) {
              fail(
                `drift ${String(drift.id)} not applied and ended as scheduled: ${JSON.stringify(drift)}`,
              );
            }
          }
          if (listed.length !== drifts.length) {
            fail(`${String(listed.length)} drifts listed, ${String(drifts.length)} posted`);
          }
        }

        // The injections: every one of shift A applied inside it (held ones a little later).
        const applied = await sim.injections();
        report.injections = {
          scenario: GOLDEN.slice(REPO.length + 1),
          posted: injections.length,
          prefixEvidence: PASSES[pass].evidence,
          applied: applied.map(({ id, machine, code, at, status, heldAt, appliedAt }) => ({
            id,
            machine,
            code,
            at,
            status,
            ...(heldAt === undefined ? {} : { heldAt }),
            ...(appliedAt === undefined ? {} : { appliedAt }),
          })),
        };
        for (const injection of applied) {
          const appliedAt = Date.parse(injection.appliedAt ?? '');
          if (
            injection.status !== 'applied' ||
            !(appliedAt >= shift.from && appliedAt < shift.to)
          ) {
            fail(
              `injection ${String(injection.id)} not applied in ${shiftKey}: ${JSON.stringify(injection)}`,
            );
          }
        }
        if (applied.length !== injections.length) {
          fail(`${String(applied.length)} injections listed, ${String(injections.length)} posted`);
        }

        // Alarm KPIs (#142, #147): shift A of the plant and of each position, per shift and per
        // hour, final and equal to the live ground truth and to the scenario's golden summary.
        const alarmFrom = Date.now();
        const alarmScopes = Object.keys(truth.alarms.scopes).sort();
        const readAlarms = () =>
          Promise.all(
            alarmScopes.map(async (id) => {
              const scope = id === 'plant' ? 'plant' : 'position';
              const [shifts, hours] = await Promise.all([
                mes.alarmShifts(scope, id, shift.from, shift.to),
                mes
                  .alarmKpiText(scope, id, 'hour', shift.from, shift.to)
                  .then((text) => alarmKpiListSchema.parse(JSON.parse(text))),
              ]);
              return {
                id,
                bucket: shifts.buckets.find((b) => b.key === shiftKey),
                hours: hours.buckets.filter(
                  (b) => Date.parse(b.from) >= shift.from && Date.parse(b.to) <= shift.to,
                ),
              };
            }),
          );
        let alarmBuckets = await readAlarms();
        await until(
          `${shiftKey} alarm KPIs final for the plant and every position, per shift and hour`,
          async () => {
            alarmBuckets = await readAlarms();
            return alarmBuckets.every(
              ({ bucket, hours }) => bucket?.final === true && hours.every((h) => h.final),
            );
          },
          OEE_FINAL_MS,
        ).catch((error: unknown) => {
          fail(error instanceof Error ? error.message : String(error));
        });
        report.alarms = {
          waitedMs: Date.now() - alarmFrom,
          compared: 0,
          hoursCompared: 0,
          goldenEqual: true,
          raises: {},
          scopes: {},
        };
        const notFinal = (b: AlarmKpiBucketDto | undefined) =>
          !b?.final || b.provisional || b.revision !== 0 || b.incidents !== 0;
        for (const { id, bucket, hours } of alarmBuckets) {
          const scopeTruth = truth.alarms.scopes[id];
          const scopeGolden = golden.alarms.scopes[id];
          const expected = scopeTruth?.shifts[shiftKey];
          const diffs = jsonDifferences(expected ?? null, bucket ? alarmTruthShape(bucket) : null);
          const goldenDiffs = jsonDifferences(
            scopeGolden?.shifts[shiftKey] ?? null,
            expected ?? null,
          );
          if (expected && bucket) report.alarms.compared++;
          // Hours of the shift: the same hours listed (where something happened), each equal.
          const truthHours = Object.keys(scopeTruth?.hours ?? {})
            .filter((h) => Date.parse(h) >= shift.from && Date.parse(h) < shift.to)
            .sort();
          const mesHours = hours.map((h) => h.key).sort();
          if (JSON.stringify(truthHours) !== JSON.stringify(mesHours)) {
            diffs.push(`hours: MES ${mesHours.join(', ')}, truth ${truthHours.join(', ')}`);
          }
          const goldenHours = Object.keys(scopeGolden?.hours ?? {})
            .filter((h) => Date.parse(h) >= shift.from && Date.parse(h) < shift.to)
            .sort();
          if (JSON.stringify(goldenHours) !== JSON.stringify(mesHours)) {
            goldenDiffs.push(`hours: golden ${goldenHours.join(', ')}, MES ${mesHours.join(', ')}`);
          }
          for (const hour of hours) {
            const truthHour = scopeTruth?.hours[hour.key];
            if (truthHour === undefined) continue;
            report.alarms.hoursCompared++;
            for (const d of jsonDifferences(truthHour, alarmTruthShape(hour))) {
              diffs.push(`${hour.key}: ${d}`);
            }
            for (const d of jsonDifferences(scopeGolden?.hours[hour.key] ?? null, truthHour)) {
              goldenDiffs.push(`${hour.key}: ${d}`);
            }
            if (notFinal(hour)) {
              diffs.push(
                `${hour.key} not final (final ${String(hour.final)}, provisional ${String(hour.provisional)}, revision ${String(hour.revision)}, incidents ${String(hour.incidents)})`,
              );
            }
          }
          if (goldenDiffs.length > 0) report.alarms.goldenEqual = false;
          report.alarms.raises[id] = bucket?.raises ?? -1;
          report.alarms.scopes[id] = {
            equal: diffs.length === 0,
            final: bucket?.final ?? false,
            revision: bucket?.revision ?? -1,
            incidents: bucket?.incidents ?? -1,
            raises: bucket?.raises ?? -1,
            differences: diffs,
          };
          if (diffs.length > 0) {
            fail(
              `${id}: ${shiftKey} alarm KPIs differ from the ground truth:\n  ${diffs.join('\n  ')}`,
            );
          }
          if (goldenDiffs.length > 0) {
            fail(
              `${id}: the live ground truth's ${shiftKey} alarm KPIs differ from ${goldenName}'s:\n  ${goldenDiffs.join('\n  ')}`,
            );
          }
          if (notFinal(bucket)) {
            fail(
              `${id}: ${shiftKey} alarm KPIs not final (final ${String(bucket?.final)}, provisional ${String(bucket?.provisional)}, revision ${String(bucket?.revision)}, incidents ${String(bucket?.incidents)})`,
            );
          }
        }
        if (report.alarms.compared !== 3 || alarmScopes.length !== 3) {
          fail(
            `${shiftKey} alarm KPIs: ${String(report.alarms.compared)} buckets compared, not 3 (the plant and 2 positions)`,
          );
        }
        // Not vacuous: the injected flood, chattering and fleeting alarms are in the buckets, and
        // the hours were compared too.
        const cell = alarmBuckets.find((b) => b.id === 'cell-m1')?.bucket;
        const line = alarmBuckets.find((b) => b.id === 'line-a1')?.bucket;
        const injected = {
          raises: ['plant', 'cell-m1', 'line-a1'].map((id) => report.alarms?.raises[id]),
          floods: cell?.floods.length ?? 0,
          chattering: cell?.chatteringPoints.includes('cnc-01/COOLANT-PRESSURE') ?? false,
          fleeting: line?.fleeting ?? 0,
          hours: report.alarms.hoursCompared,
        };
        // quality-01 injects no failure (its alarms are compared above, not counted here).
        if (
          !quality &&
          (JSON.stringify(injected.raises) !== JSON.stringify([14, 13, 1]) ||
            injected.floods < 1 ||
            !injected.chattering ||
            injected.fleeting < 1 ||
            injected.hours < 4)
        ) {
          fail(`${shiftKey} alarm KPIs miss the injected alarms: ${JSON.stringify(injected)}`);
        }

        const goldenShift = Object.fromEntries(
          machines.map((id) => [id, golden.machines[id]?.byShift[shiftKey] ?? {}]),
        );
        const goldenDiffs = differences(goldenShift, expected);
        report.goldenShiftEqual = goldenDiffs.length === 0;
        if (goldenDiffs.length > 0) {
          fail(
            `the live ground truth differs from ${goldenName}'s ${shiftKey} (truth = golden, MES = live):\n${formatDifferences(goldenDiffs)}`,
          );
        }
        // Its OEE too: the injected breakdowns change availability (Phase 5 checks on the scenario).
        // The golden summary is read through the live answer's schema, so both hold the same fields.
        const goldenOee = groundTruthSchema.shape.oee.parse(golden.oee);
        const goldenOeeDiffs = [
          ...machines.flatMap((id) =>
            jsonDifferences(
              goldenOee.machines[id]?.shifts[shiftKey] ?? null,
              truth.oee.machines[id]?.shifts[shiftKey] ?? null,
            ).map((d) => `${id}: ${d}`),
          ),
          ...workCenterIds.flatMap((id) =>
            jsonDifferences(
              goldenOee.workCenters[id]?.shifts[shiftKey] ?? null,
              truth.oee.workCenters[id]?.shifts[shiftKey] ?? null,
            ).map((d) => `${id}: ${d}`),
          ),
        ];
        report.goldenOeeEqual = goldenOeeDiffs.length === 0;
        if (goldenOeeDiffs.length > 0) {
          fail(
            `the live ground truth's ${shiftKey} OEE differs from ${goldenName}'s:\n  ${goldenOeeDiffs.join('\n  ')}`,
          );
        }

        // Shift A's report (#144, exit criterion 4): final with no input revision, its sections
        // the OEE, the alarm KPIs and the ground truth.
        report.shiftReport = await checkShiftReport(mes, truth, shiftKey, shift, machines);
        for (const failure of report.shiftReport.failures) fail(`${shiftKey} report: ${failure}`);

        // Every stored piece inside one UTC hour and one shift bucket (the shared calendar).
        const pieces = await stack.sqlJson<Piece[]>(
          `SELECT coalesce(json_agg(json_build_object(
             'equipment', equipment,
             'start', (extract(epoch FROM start_time) * 1000)::bigint,
             'end', (extract(epoch FROM end_time) * 1000)::bigint,
             'hour', (extract(epoch FROM hour) * 1000)::bigint,
             'shiftKey', shift_key)), '[]') FROM equipment.equipment_state_interval`,
        );
        const violations = pieceViolations(pieces, (from, to) => shiftSegments(shifts, from, to));
        report.pieces = { count: pieces.length, violations: violations.slice(0, 50) };
        if (pieces.length === 0) fail('no stored intervals');
        if (violations.length > 0) {
          fail(
            `${String(violations.length)} pieces outside one hour and one shift:\n${violations.slice(0, 20).join('\n')}`,
          );
        }

        const incidents = await stack.sqlJson<{ type: string; origin: string; stream: string }[]>(
          `SELECT coalesce(json_agg(json_build_object('origin', origin, 'type', type,
             'stream', stream, 'equipment', equipment, 'seqFrom', seq_from, 'seqTo', seq_to,
             'lost', lost, 'message', message, 'resolution', resolution) ORDER BY id), '[]')
           FROM ingest.data_quality_incident`,
        );
        report.incidents = incidents;
        const lost = incidents.filter((i) => LOSS_INCIDENTS.has(i.type));
        if (lost.length > 0) fail(`data-quality incidents of lost data: ${JSON.stringify(lost)}`);
        report.rejectedMessages = await stack.sqlJson<number>(
          'SELECT count(*) FROM ingest.rejected_message',
        );
        if (report.rejectedMessages !== 0) {
          fail(`${String(report.rejectedMessages)} rejected UNS messages`);
        }
        phase('compare');

        if (browser) {
          const exitCode = await browser;
          browser = undefined;
          report.browser = {
            exitCode,
            report: await readJson(join(RESULTS_DIR, 'overview-latency.json')),
            oee: await readJson(join(RESULTS_DIR, 'oee-latency.json')),
            alarms: await readJson(join(RESULTS_DIR, 'alarms-latency.json')),
            ...(quality
              ? { spc: await requiredJson('spc-latency.json') }
              : orders
                ? { terminal: await requiredJson('terminal-latency.json') }
                : {}),
          };
          if (exitCode !== 0) {
            fail(
              `the live ${quality ? 'SPC and terminal' : orders ? 'alarms, OEE or terminal' : 'alarms, overview or OEE'} check failed (Playwright exit ${String(exitCode)})`,
            );
          }
        }
        phase('browser');

        // 6. Orders mode (#178, exit criteria 4 and 5), after the drain: the orders, the refusals,
        //    the step to a scrap, the terminals and the close, the audit, the outbox posted again.
        if (pass === 'orders' && ctx) {
          const operations = loaded.config.products.operations;
          ordersReport.afterDrain = await checkOrdersAfterDrain(
            ctx,
            truth,
            goldenOrders ?? { jobs: [], orders: {}, units: { count: 0, sha256: '' } },
            shift.to,
            operations,
          );
          log(`orders after the drain: ${JSON.stringify(ordersReport.afterDrain)}`);
          const operator = users.get(ORDER_USERS.operator.username);
          const operator2 = users.get(ORDER_USERS.operator2.username);
          const maintenance = users.get(ORDER_USERS.maintenance.username);
          if (!operator || !operator2 || !maintenance) throw new Error('order users missing');
          ordersReport.refusals = await checkRefusals(
            ctx,
            {
              supervisor: supervisor.cookie,
              operator: { username: ORDER_USERS.operator.username, password: operator.password },
              operator2: { username: ORDER_USERS.operator2.username, password: operator2.password },
              maintenance: {
                username: ORDER_USERS.maintenance.username,
                password: maintenance.password,
              },
            },
            { completed: CLOSE_ORDER, running: RUNNING_ORDER, unreleased: UNRELEASED_ORDER },
          );
          phase('ordersChecked');
          ordersReport.step = await stepToScrap(ctx, SCRAP_ORDER);
          log(`stepped to ${SCRAP_ORDER}'s scrap: ${JSON.stringify(ordersReport.step)}`);
          phase('stepToScrap');
          const exitCode = await runBrowser('orders-final', {
            RECONCILE_WEB_URL: webUrl,
            RECONCILE_MES_URL: mes.base,
            RECONCILE_RESULTS: RESULTS_DIR,
            RECONCILE_CLOSE_ORDER: CLOSE_ORDER,
            RECONCILE_SCRAP_ORDER: SCRAP_ORDER,
            ...browserLogin,
          });
          ordersReport.terminal = await requiredJson('terminal-close.json');
          if (exitCode !== 0) {
            fail(
              `the terminal sign-off, scrap coding or close failed (Playwright exit ${String(exitCode)})`,
            );
          }
          ordersReport.audit = await checkAuditAndClose(
            ctx,
            CLOSE_ORDER,
            {
              supervisor: RECONCILE_USER,
              operator: ORDER_USERS.operator.username,
              operator2: ORDER_USERS.operator2.username,
            },
            shiftKey,
          );
          phase('terminal');
          const ids = Object.keys(goldenOrders?.orders ?? {})
            .concat(UNRELEASED_ORDER)
            .sort();
          ordersReport.repost = await repostOutbox(ctx, ids);
          log(`outbox posted again: ${JSON.stringify(ordersReport.repost)}`);
          phase('repost');
        }

        // 6. The quality pass (#204, exit criterion 5), after the drain: the time cut at the end
        //    of shift A, the trace page, the holds and the close, the ERP's notifications, the
        //    audit, the outbox posted again.
        if (quality && ctx) {
          const qualityReport: Record<string, unknown> = { ...report.quality };
          report.quality = qualityReport;
          const cut = shift.to;
          const cutIso = new Date(cut).toISOString();
          const reference = await referenceRun(goldenName, cutIso);
          const liveJson = await sim.groundTruthJson(cutIso);
          if (liveJson.traceAsOf !== cutIso) {
            fail(
              `the live truth was not cut at ${cutIso}: traceAsOf ${String(liveJson.traceAsOf)}`,
            );
          }
          const config = traceConfigOf(loaded.config);
          const side = await mesTrace(
            ctx,
            config,
            loaded.config.process.leakTest.resolution,
            truth.epoch,
            reference.section.orders.map((o) => o.orderId),
          );
          qualityReport.traceAsOf = await checkTraceAsOf(ctx, {
            cut,
            reference,
            live: liveJson.trace as TraceSectionJson,
            mes: side,
            characteristic: CHARACTERISTIC,
          });
          log(`time cut at ${cutIso}: ${JSON.stringify(qualityReport.traceAsOf)}`);
          phase('traceAsOf');

          // The live check's operator at Line A1 by the simulator's clock (crew-window.json):
          // in the OP30 crew of every unit packed before T exactly while signed on; the trace
          // page's serial by that rule. Then the drift's first episode and its triggering unit.
          const crewWindow = (await requiredJson('crew-window.json')) as CrewWindow | undefined;
          const crew = crewWindow
            ? checkCrew(ctx, side, cut, crewWindow, loaded.config.process.leakTest.operation)
            : undefined;
          qualityReport.crew = crew?.report;
          const traceCase = crew?.traceCase;
          const chart = await mes.spcChart(CHARACTERISTIC);
          const driftKey = (
            qualityReport.traceAsOf as { drift: { mesFirstEpisode: string | null } }
          ).drift.mesFirstEpisode;
          const signal = chart.signals.find(
            (s) =>
              episodeIdentity({
                chart: s.chart,
                rule: s.rule,
                version: s.version,
                partId: s.first.partId,
                pass: s.first.pass,
              }) === driftKey,
          );
          const signalSerial = side.serials
            .flatMap((a) => a.units)
            .find((u) => u.partId === signal?.first.partId)?.serial;
          if (!signal || !signalSerial)
            fail(`the drift's episode ${String(driftKey)} or its serial`);
          const exitCode = await runBrowser('quality-final', {
            RECONCILE_WEB_URL: webUrl,
            RECONCILE_MES_URL: mes.base,
            RECONCILE_RESULTS: RESULTS_DIR,
            RECONCILE_SIM_URL: sim.base,
            RECONCILE_TRACE_CASE: JSON.stringify(traceCase ?? null),
            RECONCILE_SIGNAL: String(signal?.id ?? ''),
            RECONCILE_SIGNAL_SERIAL: signalSerial ?? '',
            RECONCILE_LOT_HOLD: QUALITY_LOT,
            RECONCILE_CLOSE_ORDER: QUALITY_CLOSE_ORDER,
            ...browserLogin,
          });
          const final = (await requiredJson('quality-final.json')) as
            { holds: string[] } | undefined;
          qualityReport.final = final;
          if (exitCode !== 0) {
            fail(`the trace page, holds or close failed (Playwright exit ${String(exitCode)})`);
          }
          phase('qualityFinal');

          const holds = (final?.holds ?? []).filter((id) => id !== '');
          await until(
            'the outbox posted every quality notification',
            async () =>
              (await stack.sqlJson<number>(
                `SELECT count(*) FROM orders.erp_message_log WHERE direction = 'out' AND status <> 'sent'`,
              )) === 0,
            60_000,
          ).catch((error: unknown) => {
            fail(error instanceof Error ? error.message : String(error));
          });
          qualityReport.notifications = await checkNotifications(ctx, holds);
          qualityReport.audit = await qualityAudit(stack, {
            quality: ORDER_USERS.quality.username,
            supervisor: RECONCILE_USER,
            closeOrder: QUALITY_CLOSE_ORDER,
            holds,
            fail,
          });
          const orderIds = reference.section.orders.map((o) => o.orderId).sort();
          qualityReport.repost = await repostOutbox(
            ctx,
            orderIds,
            [QUALITY_LOT],
            ['quality-notification'],
          );
          log(`outbox posted again: ${JSON.stringify(qualityReport.repost)}`);
          phase('repost');
        }

        // 6. Through the UI, after the drain: alarm actions (#147), the downtime recode (#123) and
        //    a handover note (#147). Shift A is final and the simulator paused, so nothing but these
        //    writes can change anything, and neither the alarm KPIs nor OEE may change at all.
        if (withBrowser && !orders) {
          const kpiTexts = () =>
            Promise.all(
              alarmScopes.flatMap((id) =>
                (['hour', 'shift'] as const).map((bucket) =>
                  mes.alarmKpiText(
                    id === 'plant' ? 'plant' : 'position',
                    id,
                    bucket,
                    shift.from,
                    shift.to,
                  ),
                ),
              ),
            );
          const kpiBefore = await kpiTexts();
          const oeeBefore = await mes.shiftOeeText(shiftKey);
          browser = runBrowser('final', {
            RECONCILE_WEB_URL: webUrl,
            RECONCILE_RESULTS: RESULTS_DIR,
            RECONCILE_SHIFT: shiftKey,
            ...browserLogin,
          });
          const exitCode = await browser;
          browser = undefined;
          const read = (name: string) =>
            readFile(join(RESULTS_DIR, name), 'utf8').then(
              (text) => JSON.parse(text) as unknown,
              () => undefined,
            );
          const kpiAfter = await kpiTexts();
          const alarmKpiIdentical = JSON.stringify(kpiAfter) === JSON.stringify(kpiBefore);
          const oeeIdentical = (await mes.shiftOeeText(shiftKey)) === oeeBefore;
          const audits = await auditRefusals(stack);
          report.coding = {
            exitCode,
            report: await read('downtime-coding.json'),
            alarmActions: await read('alarm-actions.json'),
            shiftReport: await read('shift-report.json'),
            alarmKpiIdentical,
            oeeIdentical,
            auditRefusals: audits,
          };
          if (exitCode !== 0) {
            fail(
              `the alarm actions, downtime coding or handover note check failed (Playwright exit ${String(exitCode)})`,
            );
          }
          if (!alarmKpiIdentical) fail(`${shiftKey} alarm KPIs changed through the UI writes`);
          if (!oeeIdentical) fail(`${shiftKey} OEE changed through the UI writes`);
          for (const [table, audit] of Object.entries(audits)) {
            if (audit.rows === 0 || !audit.update.refused || !audit.delete.refused) {
              fail(`${table} is not append-only, or empty: ${JSON.stringify(audit)}`);
            }
          }
        }
        phase('coding');
      })(),
      deadline,
    ]);
  } catch (error) {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
    if (browser) await browser;
  } finally {
    const failed = report.failures.length > 0;
    if (failed) {
      try {
        const logs = await stack.compose(['logs', '--no-color', '--timestamps']);
        await writeFile(join(RESULTS_DIR, 'compose.log'), logs);
        const tail = await stack.compose(['logs', '--no-color', '--tail', '60']);
        console.error(
          `--- service logs (last 60 lines each; all in e2e/results/compose.log) ---\n${tail}`,
        );
      } catch (error) {
        console.error('could not read the service logs', error);
      }
    }
    report.totalMs = Date.now() - started;
    await writeFile(join(RESULTS_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    clearTimeout(deadlineTimer);
    await stack.destroy().catch((error: unknown) => {
      console.error('could not remove the stack', error);
    });
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  summarize(report);
  return report.failures.length === 0;
}

/** A JSON file a Playwright check wrote, or undefined when it wrote none. */
function readJson(path: string): Promise<unknown> {
  return readFile(path, 'utf8').then(
    (text) => JSON.parse(text) as unknown,
    () => undefined,
  );
}

/** The drift's first episode in a golden scenario's `trace.json` (#208), as an identity. */
async function goldenDriftEpisode(golden: string): Promise<string> {
  const trace = JSON.parse(await readFile(join(golden, 'trace.json'), 'utf8')) as TraceSectionJson;
  const first = trace.drifts?.[0]?.firstEpisode;
  if (!first) throw new Error(`${golden}/trace.json has no drift with a first episode`);
  return episodeIdentity(first);
}

/**
 * The quality pass's audit (#204, exit criterion 4 live): the quality user's two hold openings and
 * one release and the supervisor's close of the order are in `identity.audit_log` with the user, a
 * role of theirs, `authenticated` and the request id, on the holds and the order.
 */
async function qualityAudit(
  stack: Stack,
  input: {
    readonly quality: string;
    readonly supervisor: string;
    readonly closeOrder: string;
    readonly holds: readonly string[];
    readonly fail: (message: string) => void;
  },
): Promise<Record<string, unknown>> {
  const rows = await stack.sqlJson<
    {
      action: string;
      username: string;
      roles: string[];
      authenticated: boolean;
      requestId: string | null;
      entity: string;
    }[]
  >(
    `SELECT coalesce(json_agg(json_build_object('action', action, 'username', username,
       'roles', roles, 'authenticated', authenticated, 'requestId', request_id,
       'entity', entity_type || ':' || entity_id) ORDER BY id), '[]')
     FROM identity.audit_log
     WHERE action IN ('hold.open', 'hold.release', 'hold.reject', 'hold.comment', 'order.close')`,
  );
  const tally = (action: string, user: string) =>
    rows.filter((r) => r.action === action && r.username === user).length;
  const found = {
    open: tally('hold.open', input.quality),
    release: tally('hold.release', input.quality),
    close: tally('order.close', input.supervisor),
    others: rows.filter(
      (r) =>
        !(
          (r.username === input.quality && ['hold.open', 'hold.release'].includes(r.action)) ||
          (r.username === input.supervisor && r.action === 'order.close')
        ),
    ).length,
  };
  if (found.open !== 2 || found.release !== 1 || found.close !== 1 || found.others !== 0) {
    input.fail(`quality audit: ${JSON.stringify({ found, rows })}`);
  }
  const holdEntities = new Set(
    rows
      .filter((r) => r.action.startsWith('hold.'))
      .map((r) => r.entity.split(':').slice(1).join(':')),
  );
  if (input.holds.some((id) => !holdEntities.has(id))) {
    input.fail(
      `quality audit: holds ${input.holds.join(', ')}, audited ${[...holdEntities].join(', ')}`,
    );
  }
  const closed = rows.find((r) => r.action === 'order.close');
  if (closed && !closed.entity.endsWith(`:${input.closeOrder}`)) {
    input.fail(`quality audit: the close is on ${closed.entity}, not ${input.closeOrder}`);
  }
  const bad = rows.filter(
    (r) =>
      !r.authenticated ||
      r.requestId === null ||
      !r.roles.includes(r.username === input.supervisor ? 'supervisor' : 'quality'),
  );
  if (bad.length > 0)
    input.fail(`quality audit rows without user, role or request: ${JSON.stringify(bad)}`);
  return { ...found, rows: rows.length };
}

/** An alarm KPI bucket of the MES in the ground truth's shape (`AlarmKpisJson`, sim-summary/3). */
function alarmTruthShape(bucket: AlarmKpiBucketDto): Record<string, unknown> {
  return {
    from: bucket.from,
    to: bucket.to,
    raises: bucket.raises,
    byPriority: bucket.byPriority,
    averageRate: bucket.averageRate,
    windows: bucket.windows,
    peak10: bucket.peak10,
    floodWindows: bucket.floodWindows,
    floods: bucket.floods,
    floodMs: bucket.floodMs,
    activeAtEnd: bucket.activeAtEnd,
    standing: bucket.standing.map(({ equipment, code, raisedAt }) => ({
      equipment,
      code,
      raisedAt,
    })),
    chatteringRaises: bucket.chatteringRaises,
    chatteringPoints: bucket.chatteringPoints,
    fleeting: bucket.fleeting,
    fleetingUndecided: bucket.fleetingUndecided,
    activeMs: bucket.activeMs,
    provisional: bucket.provisional,
  };
}

/**
 * Shift A's report (#144; exit criterion 4, #147): waits until it is final, then checks it is
 * `final` with `revision.inputs = 0` and no incident; its OEE section is `GET /shifts/{date}/{shift}/oee`
 * byte for byte; each alarm scope's KPIs are `GET /alarms/kpi`'s shift bucket and the ground
 * truth's; production per machine equals the OEE inputs and the ground truth's cycles, finished
 * parts PCK-01's good cycles; the downtime Pareto sums to the availability loss; and its instance
 * has the calendar's start, end and breaks. Returns what it found, with the failures.
 */
async function checkShiftReport(
  mes: MesClient,
  truth: GroundTruth,
  shiftKey: string,
  shift: { from: number; to: number },
  machines: readonly string[],
): Promise<NonNullable<Report['shiftReport']>> {
  const failures: string[] = [];
  const from = Date.now();
  let text = await mes.shiftReportText(shiftKey);
  await until(
    `${shiftKey} report final`,
    async () => {
      text = await mes.shiftReportText(shiftKey);
      return shiftReportSchema.parse(JSON.parse(text)).final;
    },
    OEE_FINAL_MS,
  ).catch((error: unknown) => {
    failures.push(error instanceof Error ? error.message : String(error));
  });
  const waitedMs = Date.now() - from;
  const raw = JSON.parse(text) as { oee: unknown; alarms: { scopes: { kpis: unknown }[] } };
  const parsed = shiftReportSchema.parse(raw);
  if (!parsed.final || parsed.status !== 'final') {
    failures.push(`not final (status ${parsed.status})`);
  }
  if (parsed.revision.inputs !== 0 || parsed.incidents !== 0) {
    failures.push(
      `revision.inputs ${String(parsed.revision.inputs)}, incidents ${String(parsed.incidents)}`,
    );
  }
  if (parsed.revision.contentAtFinal === null) failures.push('no contentAtFinal');

  // OEE: the body of GET /shifts/{date}/{shift}/oee, byte for byte.
  const oeeText = await mes.shiftOeeText(shiftKey);
  const oeeSectionIdentical = JSON.stringify(raw.oee) === oeeText;
  if (!oeeSectionIdentical) failures.push('the OEE section is not GET …/oee byte for byte');

  // Alarms: per scope the shift bucket of GET /alarms/kpi (byte for byte) and the ground truth.
  let alarmScopesCompared = 0;
  for (const [n, scope] of parsed.alarms.scopes.entries()) {
    const kind = scope.scope === 'plant' ? 'plant' : 'position';
    const list = JSON.parse(
      await mes.alarmKpiText(kind, scope.id, 'shift', shift.from, shift.to),
    ) as { buckets: { key: string }[] };
    const served = list.buckets.find((b) => b.key === shiftKey);
    if (JSON.stringify(raw.alarms.scopes[n]?.kpis) !== JSON.stringify(served)) {
      failures.push(`${scope.id}: the alarm section is not GET /alarms/kpi's shift bucket`);
    }
    const diffs = jsonDifferences(
      truth.alarms.scopes[scope.id]?.shifts[shiftKey] ?? null,
      scope.kpis ? alarmTruthShape(scope.kpis) : null,
    );
    if (diffs.length > 0) {
      failures.push(
        `${scope.id}: the alarm section differs from the ground truth: ${diffs.join('; ')}`,
      );
    }
    if (scope.kpis) alarmScopesCompared++;
  }
  if (alarmScopesCompared !== 3) {
    failures.push(`${String(alarmScopesCompared)} alarm scopes compared, not 3`);
  }

  // Production: per machine the OEE inputs and the ground truth's cycles.
  const count = (cycles: readonly { result: string; count: number }[], result?: string) =>
    cycles
      .filter((c) => result === undefined || c.result === result)
      .reduce((a, c) => a + c.count, 0);
  let productionCompared = 0;
  for (const id of machines) {
    const row = parsed.production.machines.find((m) => m.equipment === id);
    const inputs = parsed.oee.equipment.find((b) => b.id === id)?.inputs.cycles;
    const truthCycles = truth.oee.machines[id]?.shifts[shiftKey]?.inputs.cycles;
    if (!row || !inputs || !truthCycles) {
      failures.push(`${id}: no production row, OEE inputs or truth cycles`);
      continue;
    }
    const actual = [row.produced, row.good, row.scrap, row.rework];
    for (const [what, cycles] of [
      ['OEE inputs', inputs],
      ['ground truth', truthCycles],
    ] as const) {
      const expected = [
        count(cycles),
        count(cycles, 'good'),
        count(cycles, 'scrap'),
        count(cycles, 'rework'),
      ];
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push(
          `${id}: produced/good/scrap/rework ${actual.join('/')}, ${what} ${expected.join('/')}`,
        );
      }
    }
    productionCompared++;
  }
  if (productionCompared !== machines.length) {
    failures.push(`${String(productionCompared)} machines' production compared`);
  }
  const finished = parsed.production.finished;
  const pckGood = parsed.production.machines.find((m) => m.equipment === 'pck-01')?.good;
  if (finished.equipment !== 'pck-01' || finished.good !== pckGood) {
    failures.push(`finished parts ${JSON.stringify(finished)}, PCK-01 good ${String(pckGood)}`);
  }
  const scrap = parsed.production.machines.reduce((a, m) => a + m.scrap, 0);
  if (parsed.production.scrap !== scrap) {
    failures.push(`total scrap ${String(parsed.production.scrap)}, rows ${String(scrap)}`);
  }

  // Downtime: the Pareto by reason sums to the own plus external availability loss.
  const paretoMs = parsed.downtime.reasons.reduce((a, r) => a + r.ms, 0);
  const availabilityLossMs =
    parsed.downtime.availability.own + parsed.downtime.availability.external;
  if (paretoMs <= 0) failures.push('the Pareto is empty: nothing to compare');
  if (paretoMs !== availabilityLossMs) {
    failures.push(
      `Pareto ${String(paretoMs)} ms, availability loss ${String(availabilityLossMs)} ms`,
    );
  }

  // The instance: the calendar's start, end and breaks.
  const record = await mes.shiftRecord(shiftKey);
  const calendar = (await mes.shifts(shift.from, shift.to)).shifts.find((s) => s.key === shiftKey);
  const calendarEqual =
    calendar !== undefined &&
    JSON.stringify([record.start, record.end, record.breaks]) ===
      JSON.stringify([calendar.start, calendar.end, calendar.breaks]) &&
    Date.parse(record.start) === shift.from &&
    Date.parse(record.end) === shift.to &&
    record.epoch === truth.epoch;
  if (!calendarEqual) {
    failures.push(
      `instance ${JSON.stringify(record)} is not the calendar's ${JSON.stringify(calendar)}`,
    );
  }

  return {
    waitedMs,
    final: parsed.final,
    revision: parsed.revision,
    incidents: parsed.incidents,
    oeeSectionIdentical,
    alarmScopesCompared,
    productionCompared,
    finished,
    paretoMs,
    availabilityLossMs,
    instance: {
      start: record.start,
      end: record.end,
      breaks: record.breaks.length,
      calendarEqual,
    },
    failures,
  };
}

/** The append-only triggers' message (migrations 0013, 0016). */
const APPEND_ONLY = /append-only \((UPDATE|DELETE) refused\)/;

/**
 * The audit tables refuse UPDATE and DELETE (exit criterion 3): each statement runs inside
 * `BEGIN; …; ROLLBACK`, so an accepted one changes nothing, and counts as refused only when it
 * fails with the trigger's own message (`append-only (UPDATE refused)`); success, or any other
 * error (a missing table or trigger, a typo), is not a refusal. The table must also hold rows (the
 * actions of the `final` project), or the triggers would have nothing to refuse.
 */
async function auditRefusals(
  stack: Stack,
): Promise<NonNullable<NonNullable<Report['coding']>['auditRefusals']>> {
  const refusals: NonNullable<NonNullable<Report['coding']>['auditRefusals']> = {};
  for (const [table, column] of Object.entries(AUDIT_TABLES)) {
    const rows = await stack.sqlJson<number>(`SELECT count(*) FROM ${table}`);
    const attempt = async (operation: 'UPDATE' | 'DELETE', statement: string) =>
      stack.sql(`BEGIN; ${statement}; ROLLBACK;`).then(
        (out) => ({ refused: false, message: `accepted: ${out.trim().replace(/\s+/g, ' ')}` }),
        (error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          const message = /ERROR:\s*([^\n]*)/.exec(text)?.[1] ?? text.slice(0, 200);
          return { refused: APPEND_ONLY.exec(message)?.[1] === operation, message };
        },
      );
    refusals[table] = {
      rows,
      update: await attempt('UPDATE', `UPDATE ${table} SET ${column} = ${column}`),
      delete: await attempt('DELETE', `DELETE FROM ${table}`),
    };
  }
  return refusals;
}

function summarize(report: Report): void {
  log('results');
  console.log(
    `  phases (ms): ${JSON.stringify(report.phasesMs)}, total ${String(report.totalMs)} ms`,
  );
  if (report.shift) console.log(`  shift: ${JSON.stringify(report.shift)}`);
  if (report.silentWait) console.log(`  silent wait: ${JSON.stringify(report.silentWait)}`);
  if (report.drain) console.log(`  drain: ${JSON.stringify(report.drain)}`);
  for (const [id, m] of Object.entries(report.machines ?? {})) {
    const states = Object.entries(m.truthMs)
      .filter(([, ms]) => ms > 0)
      .map(([state, ms]) => `${state} ${String(ms)}`)
      .join(', ');
    console.log(
      `  ${id}: ${m.equal ? 'equal' : 'DIFFERENT'} (${states}; provisional ${String(m.provisionalMs)}, revision ${String(m.revision)}, incidents ${String(m.incidents)})`,
    );
  }
  for (const [id, m] of Object.entries(report.oee?.machines ?? {})) {
    console.log(
      `  OEE ${id}: ${m.equal ? 'equal' : 'DIFFERENT'} (OEE ${String(m.oee)}; final ${String(m.final)}, provisional ${String(m.provisionalMs)}, revision ${String(m.revision)}, incidents ${String(m.incidents)})`,
    );
  }
  for (const [id, wc] of Object.entries(report.oee?.workCenters ?? {})) {
    console.log(
      `  OEE ${id}: ${wc.equal ? 'equal' : 'DIFFERENT'} (OEE ${String(wc.oee)}; final ${String(wc.final)}, provisional ${String(wc.provisionalMs)}, revision ${String(wc.revision)}, incidents ${String(wc.incidents)})`,
    );
  }
  if (report.oee) {
    console.log(
      `  OEE final after ${String(report.oee.waitedMs)} ms, ${String(report.oee.compared)} buckets compared`,
    );
  }
  for (const [id, a] of Object.entries(report.alarms?.scopes ?? {})) {
    console.log(
      `  alarms ${id}: ${a.equal ? 'equal' : 'DIFFERENT'} (raises ${String(a.raises)}; final ${String(a.final)}, revision ${String(a.revision)}, incidents ${String(a.incidents)})`,
    );
  }
  if (report.alarms) {
    console.log(
      `  alarm KPIs final after ${String(report.alarms.waitedMs)} ms, ${String(report.alarms.compared)} shift and ${String(report.alarms.hoursCompared)} hour buckets compared, golden equal: ${String(report.alarms.goldenEqual)}`,
    );
  }
  if (report.goldenShiftEqual !== undefined) {
    console.log(
      `  live ground truth equals alarms-01's shift: states ${String(report.goldenShiftEqual)}, OEE ${String(report.goldenOeeEqual)}`,
    );
  }
  if (report.injections) {
    console.log(
      `  injections: ${String(report.injections.posted)} posted, ${String(report.injections.applied.filter((i) => i.status === 'applied').length)} applied; prefix: ${report.injections.prefixEvidence}`,
    );
  }
  if (report.shiftReport) {
    const { failures, ...rest } = report.shiftReport;
    console.log(`  shift report: ${JSON.stringify(rest)}, failures ${String(failures.length)}`);
  }
  if (report.pieces)
    console.log(
      `  stored pieces: ${String(report.pieces.count)}, violations ${String(report.pieces.violations.length)}`,
    );
  if (report.incidents) console.log(`  incidents: ${JSON.stringify(report.incidents)}`);
  if (report.browser) console.log(`  browser: ${JSON.stringify(report.browser)}`);
  if (report.coding) console.log(`  coding: ${JSON.stringify(report.coding)}`);
  console.log(
    report.failures.length === 0
      ? 'RECONCILE-OK'
      : `RECONCILE-FAILED (${String(report.failures.length)})`,
  );
}

// Exit explicitly: after a deadline the abandoned steps may still hold timers.
process.exit((await main()) ? 0 : 1);
