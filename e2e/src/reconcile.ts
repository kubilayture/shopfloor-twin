/**
 * Full-shift reconciliation through the whole chain (#100; Phase 4 exit criteria 1 and 3).
 *
 * Builds the images and starts the Compose stack under its own project in the plan's order: the
 * database and the broker, the MES ready, the simulator idle (`SIM_AUTOSTART=false`) and the
 * gateway connected with every machine's start-up state anchored in the MES, the web app; then
 * resumes the simulator at 60× from 06:00, the start of shift A. While the shift runs, Playwright
 * checks the live overview (browser/overview.spec.ts) and the live OEE dashboard
 * (browser/oee-live.spec.ts, #123). After shift end plus a margin, the run goes
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
 * (six machines and two work centers, as in the plant configuration) is asserted. Then Playwright
 * recodes and splits one of shift A's downtime records through the UI
 * (browser/final/downtime-coding.spec.ts, #123): the audit and the Pareto change, OEE does not.
 *
 * Usage: pnpm test:reconcile. Results (report.json, compose.log on failure, Playwright traces) go
 * to e2e/results/. Environment: RECONCILE_PROJECT (Compose project, default shopfloor-reconcile),
 * RECONCILE_SKIP_BUILD=1 (use the images already built), RECONCILE_BROWSER=0 (no Playwright),
 * OVERVIEW_SAMPLE_MS and OEE_SAMPLE_MS (how long each live check samples, default 90000 each; they
 * run one after the other and together must stay below about 400 s, the shift's wall time after
 * the browser starts, less the pages' start-up), RECONCILE_DEADLINE_MS (overall limit, default
 * 25 minutes), RECONCILE_SILENT_WAIT_MS (how long past the margin, in simulated time, the run may go
 * on for a silent machine's next fact; default 2 hours, 2 wall minutes at 60×). SIGINT and SIGTERM remove the stack and the env file before exiting.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { shiftSegments } from '@shopfloor/shift-calendar';
import { GatewayClient, MesClient, SimulatorClient, gauge, type GroundTruth } from './clients.ts';
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
import { REPO, Stack } from './stack.ts';

const SPEED = 60;
/** Simulated time past shift end before the simulator is paused (5 wall seconds at 60×). */
const MARGIN_MS = 5 * 60_000;
const RESULTS = join(REPO, 'e2e/results');
const GOLDEN = join(REPO, 'apps/simulator/golden/week-01');
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

const project = process.env.RECONCILE_PROJECT ?? 'shopfloor-reconcile';
const skipBuild = process.env.RECONCILE_SKIP_BUILD === '1';
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
    await sleep(500);
  }
}

/**
 * Runs one Playwright project against the stack (playwright.config.ts): `live` during the shift
 * (overview and OEE dashboard), `final` after the drain (downtime coding). Resolves with its exit
 * code.
 */
let browserChild: ChildProcess | undefined;

function runBrowser(project: 'live' | 'final', env: Record<string, string>): Promise<number> {
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
  pieces?: { count: number; violations: string[] };
  incidents?: unknown[];
  rejectedMessages?: number;
  /** The live checks: the overview (#100) and the OEE dashboard (#123). */
  browser?: { exitCode: number; report?: unknown; oee?: unknown };
  /** The downtime coding through the UI after the drain (#123). */
  coding?: { exitCode: number; report?: unknown };
  failures: string[];
}

async function main(): Promise<boolean> {
  await rm(RESULTS, { recursive: true, force: true });
  await mkdir(RESULTS, { recursive: true });
  const report: Report = { project, phasesMs: {}, failures: [] };
  const fail = (message: string) => {
    report.failures.push(message);
    console.error(`FAIL: ${message}`);
  };
  let phaseStart = Date.now();
  const phase = (name: string) => {
    const now = Date.now();
    report.phasesMs[name] = now - phaseStart;
    phaseStart = now;
  };

  // The golden week's seed and start (Monday 06:00 Istanbul, the start of shift A).
  const scenario = JSON.parse(await readFile(join(GOLDEN, 'scenario.json'), 'utf8')) as {
    seed: number;
    start: string;
  };
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
  report.seed = scenario.seed;
  report.shiftKey = shiftKey;

  const stack = new Stack({
    project,
    env: {
      SIM_SEED: String(scenario.seed),
      SIM_START: scenario.start,
      SIM_SPEED: String(SPEED),
      SIM_AUTOSTART: 'false',
      // Its own image tags: the run never replaces the dev stack's images.
      IMAGE_TAG: 'reconcile',
    },
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
        if (!skipBuild) {
          log('building the images');
          await stack.compose(['build'], 1_200_000);
        }
        phase('build');

        // 1. Database and broker, then the MES ready (migrated, subscribed to the UNS).
        log('starting db, broker and mes');
        await stack.compose(['up', '--detach', '--wait', '--no-build', 'db', 'broker', 'mes']);
        const mes = new MesClient(await stack.url('mes', 4700));
        await until('MES ready', () => mes.ready(), 60_000);
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

        log('starting web');
        await stack.compose(['up', '--detach', '--wait', '--no-build', 'web']);
        const webUrl = await stack.url('web', 8080);
        phase('webReady');

        // 3. Go: shift A at 60×.
        log(
          `resuming the simulator at ${String(SPEED)}× from ${scenario.start} (seed ${String(scenario.seed)})`,
        );
        const resumedAt = Date.now();
        await sim.resume();
        if (withBrowser) {
          browser = runBrowser('live', {
            RECONCILE_WEB_URL: webUrl,
            RECONCILE_SIM_URL: sim.base,
            RECONCILE_MES_URL: mes.base,
            RECONCILE_RESULTS: RESULTS,
          });
        }

        const lags: number[] = [];
        let lastProgress = 0;
        const nominalWallMs = (stopAt - start) / SPEED;
        // Per machine, how long after the shift end its first fact came (as the MES stored it).
        const shiftEnd = new Date(shift.to).toISOString();
        const factsAfterEnd = () =>
          stack.sqlJson<Record<string, number>>(
            `SELECT coalesce(json_object_agg(equipment, ms), '{}') FROM (
               SELECT equipment,
                 (extract(epoch FROM min(source_time) - '${shiftEnd}'::timestamptz) * 1000)::bigint AS ms
               FROM ingest.equipment_event
               WHERE epoch = ${String(initial.epoch)} AND source_time >= '${shiftEnd}'
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

        // The live run reproduces the headless golden week's shift A: pacing never changes the run.
        const golden = JSON.parse(await readFile(join(GOLDEN, 'summary.json'), 'utf8')) as {
          machines: Record<string, { byShift: Record<string, StateMs> }>;
        };
        const goldenShift = Object.fromEntries(
          machines.map((id) => [id, golden.machines[id]?.byShift[shiftKey] ?? {}]),
        );
        const goldenDiffs = differences(goldenShift, expected);
        report.goldenShiftEqual = goldenDiffs.length === 0;
        if (goldenDiffs.length > 0) {
          fail(
            `the live ground truth differs from the golden week's ${shiftKey} (truth = golden, MES = live):\n${formatDifferences(goldenDiffs)}`,
          );
        }

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
          const browserReport = await readFile(join(RESULTS, 'overview-latency.json'), 'utf8').then(
            (text) => JSON.parse(text) as unknown,
            () => undefined,
          );
          const oeeReport = await readFile(join(RESULTS, 'oee-latency.json'), 'utf8').then(
            (text) => JSON.parse(text) as unknown,
            () => undefined,
          );
          report.browser = { exitCode, report: browserReport, oee: oeeReport };
          if (exitCode !== 0)
            fail(`the live overview or OEE check failed (Playwright exit ${String(exitCode)})`);
        }
        phase('browser');

        // 6. Exit criterion 4 through the UI (#123): shift A is final and the simulator paused, so
        //    nothing but the recode can change the Pareto, and OEE must not change at all.
        if (withBrowser) {
          browser = runBrowser('final', {
            RECONCILE_WEB_URL: webUrl,
            RECONCILE_RESULTS: RESULTS,
            RECONCILE_SHIFT: shiftKey,
          });
          const exitCode = await browser;
          browser = undefined;
          const codingReport = await readFile(join(RESULTS, 'downtime-coding.json'), 'utf8').then(
            (text) => JSON.parse(text) as unknown,
            () => undefined,
          );
          report.coding = { exitCode, report: codingReport };
          if (exitCode !== 0)
            fail(`the downtime coding check failed (Playwright exit ${String(exitCode)})`);
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
        await writeFile(join(RESULTS, 'compose.log'), logs);
        const tail = await stack.compose(['logs', '--no-color', '--tail', '60']);
        console.error(
          `--- service logs (last 60 lines each; all in e2e/results/compose.log) ---\n${tail}`,
        );
      } catch (error) {
        console.error('could not read the service logs', error);
      }
    }
    await writeFile(join(RESULTS, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    clearTimeout(deadlineTimer);
    await stack.destroy().catch((error: unknown) => {
      console.error('could not remove the stack', error);
    });
  }
  summarize(report);
  return report.failures.length === 0;
}

function summarize(report: Report): void {
  log('results');
  console.log(`  phases (ms): ${JSON.stringify(report.phasesMs)}`);
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
  if (report.goldenShiftEqual !== undefined) {
    console.log(
      `  live ground truth equals the golden week's shift: ${String(report.goldenShiftEqual)}`,
    );
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
