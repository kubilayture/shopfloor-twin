/**
 * The merge gate (#178, Phase 7 plan "Local gate"): the local equivalent of every CI job, on the
 * checked-out commit, in the plan's order, one heavy job at a time:
 *
 * 1. `verify`: `pnpm verify --concurrency=1` (format, Dockerfiles, lint, typecheck, tests, build);
 * 2. `golden`: `pnpm test:golden`;
 * 3. `e2e`: `pnpm test:e2e`;
 * 4. `smoke`: the stack smoke (`scripts/stack-smoke.sh`, `SMOKE_WRITES=1`) on a disposable Compose
 *    project with a throw-away env file made from `.env.example`, every `*_PASSWORD` and `*_TOKEN`
 *    a random value generated here (the required secrets appended when missing); the repository's
 *    own `.env` is neither read nor touched. Its host ports are ephemeral
 *    (`SMOKE_EPHEMERAL_PORTS=1`, `e2e/compose.ephemeral-ports.yml`, #228), so a dev stack on the
 *    default ports can stay up;
 * 5. `reconcile`: `pnpm test:reconcile` (all three passes, #204) with the smoke's images
 *    (`RECONCILE_SKIP_BUILD=1`, the same tag).
 *
 * The output of the smoke and the reconciliation, the two jobs that run the stack with the
 * generated secrets, is also kept in the gate's temporary directory and searched for every one of
 * them afterwards; a hit fails the job (checklist S7, #242).
 *
 * Before the first job it takes the host-wide heavy-suite lock (#228,
 * `~/.cache/shopfloor-twin/heavy.lock`, `@shopfloor/test-kit/heavy-lock`), waiting its turn
 * (first come, first served, #348) up to `HEAVY_LOCK_TIMEOUT_MS` (default 3 hours); its jobs
 * inherit the lock through `SHOPFLOOR_HEAVY_LOCK`. Holding it, it refuses to start below 25 GiB
 * free on the host or 15 GiB in Docker's data root (exit 2, saying which). The BuildKit cache is
 * pruned to 10 GiB after the smoke's build and at the end.
 *
 * Then it removes the project's volumes, the images it built and the env file, and prints one
 * record for the pull request's "Gate" section: the commit (and whether the tree was clean), each
 * job with its duration and result, Node and Docker versions, the free disk space at the start and
 * the image digests the smoke and the reconciliation ran. The record also goes to
 * e2e/results/gate.json.
 *
 * Usage: pnpm gate. Environment: GATE_STEPS (comma list of the jobs above, default all, for a rerun
 * after a later commit: runbook "Merge gate"), GATE_PROJECT (Compose project of the smoke, default
 * shopfloor-gate), GATE_TAG (image tag of the smoke and the reconciliation, default gate),
 * RECONCILE_PROJECT (the reconciliation's project prefix, default <GATE_PROJECT>-reconcile),
 * GATE_KEEP_IMAGES=1 (keep the images).
 * A failed job stops the gate; the cleanup and the record still run. On SIGINT, SIGTERM or SIGHUP it
 * passes the signal to the running job's process group, waits for it, cleans up the same way and
 * exits 130, 143 or 129; a second signal kills the job's group (SIGKILL); none reaches the
 * cleanup. It refuses GATE_PROJECT `shopfloor-twin` (the dev stack's) and GATE_TAG `dev`.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  HeavyLockTimeoutError,
  acquireHeavyLock,
  checkDisks,
  formatGib,
  pruneBuildCache,
} from '@shopfloor/test-kit/heavy-lock';
import { gateComposeEnv, gateSmokeEnv } from './gate-smoke-env.ts';
import { envFromExample } from './required-secrets.ts';

const REPO = resolve(import.meta.dirname, '..');
const STEPS = ['verify', 'golden', 'e2e', 'smoke', 'reconcile'] as const;
type Step = (typeof STEPS)[number];
const SERVICES = ['simulator', 'edge-gateway', 'mes-server', 'erp-mock', 'web'] as const;

const selected = (process.env.GATE_STEPS ?? STEPS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is Step => (STEPS as readonly string[]).includes(s));
const project = process.env.GATE_PROJECT ?? 'shopfloor-gate';
const tag = process.env.GATE_TAG ?? 'gate';
// The gate removes its project's volumes and its tag's images: never the dev stack's (the Compose
// file's own name, `shopfloor-twin`, and the default tag `dev`).
if (!/^[a-z0-9][a-z0-9_-]*$/.test(project) || project === 'shopfloor-twin') {
  console.error(`GATE_PROJECT must name a disposable Compose project, not "${project}"`);
  process.exit(2);
}
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(tag) || tag === 'dev') {
  console.error(`GATE_TAG must name images of the gate's own, not "${tag}"`);
  process.exit(2);
}

interface JobRecord {
  readonly job: Step;
  readonly command: string;
  readonly result: 'passed' | 'failed' | 'skipped';
  readonly seconds: number;
}

const output = (command: string, args: readonly string[]): string => {
  try {
    return execFileSync(command, args, { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return '(unavailable)';
  }
};

/** The job running now, so a signal can wait for it (and pass a SIGTERM on). */
let current: { child: ChildProcess; exited: Promise<number> } | undefined;

/**
 * Runs a command with inherited output; resolves with its exit code. With `capture`, its output
 * is also written to that file (checklist S7: the jobs that see the generated secrets are searched
 * for them afterwards).
 */
function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
  capture?: string,
): Promise<number> {
  // Its own process group, so a signal reaches the whole job (pnpm, turbo and every test
  // runner), never pnpm alone with orphans left running.
  const child = spawn(command, args, {
    cwd: REPO,
    stdio: capture === undefined ? 'inherit' : ['inherit', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, ...env },
  });
  /** The captured output on disk: both pipes ended (or 10 s after the exit), the file closed. */
  let flushed: (() => Promise<void>) | undefined;
  if (capture !== undefined) {
    const file = createWriteStream(capture, { mode: 0o600 });
    const closed = new Promise<void>((done) => file.on('close', done));
    let open = 2;
    const tee = (from: NodeJS.ReadableStream | null, to: NodeJS.WritableStream) => {
      from?.on('data', (chunk: Buffer) => {
        to.write(chunk);
        if (!file.writableEnded) file.write(chunk);
      });
      from?.on('end', () => {
        if (--open === 0 && !file.writableEnded) file.end();
      });
    };
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    // A process the job left behind may hold a pipe open: the file is closed anyway.
    flushed = () =>
      Promise.race([closed, new Promise<void>((done) => setTimeout(done, 10_000).unref())]).then(
        () => {
          if (!file.writableEnded) file.end();
          return closed;
        },
      );
  }
  const exited = new Promise<number>((done) => {
    child.on('error', () => {
      done(1);
    });
    child.on('exit', (code) => {
      done(code ?? 1);
    });
  });
  const running = { child, exited };
  current = running;
  // Each job's process group keeps the heavy-suite lock alive (#228), also if the gate itself is
  // killed while the job runs.
  if (child.pid !== undefined) lock.recordGroup(child.pid);
  return exited
    .then(async (code) => {
      await flushed?.();
      return code;
    })
    .finally(() => {
      if (current === running) current = undefined;
    });
}

/** Every secret the gate generated for the env file (checklist S7: searched for in the output). */
const generated: string[] = [];

/** The throw-away env file: `.env.example` with generated secrets, mode 600, in a temp dir. */
function envFile(dir: string): string {
  const secret = () => {
    const value = randomBytes(18).toString('hex');
    generated.push(value);
    return value;
  };
  // The same keys as scripts/stack-init.sh writes (#277, e2e/src/stack-init.test.ts).
  const lines = envFromExample(readFileSync(join(REPO, '.env.example'), 'utf8'), secret);
  lines.push(`COMPOSE_PROJECT_NAME=${project}`, `IMAGE_TAG=${tag}`, '');
  const path = join(dir, 'gate.env');
  writeFileSync(path, lines.join('\n'), { mode: 0o600 });
  return path;
}

const digests = (): Record<string, string> =>
  Object.fromEntries(
    SERVICES.map((service) => [
      service,
      output('docker', [
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        `shopfloor-twin/${service}:${tag}`,
      ]),
    ]),
  );

// One heavy suite at a time on the machine (#228): the gate holds the lock for all its jobs, which
// inherit it through SHOPFLOOR_HEAVY_LOCK (set in this process's environment, which `run` passes
// on).
const lock = await acquireHeavyLock({ command: `pnpm gate in ${REPO}` }).catch((error: unknown) => {
  console.error(error instanceof HeavyLockTimeoutError ? `gate: ${error.message}` : error);
  process.exit(1);
});
process.on('exit', () => {
  lock.release();
});
Object.assign(process.env, lock.env);
const disks = await checkDisks(REPO);
if (disks.problems.length > 0) {
  for (const problem of disks.problems) console.error(`gate: refusing to start: ${problem}`);
  process.exit(2);
}
console.log(`gate: free disk: host ${formatGib(disks.host)}, Docker ${formatGib(disks.docker)}`);

const dir = mkdtempSync(join(tmpdir(), 'shopfloor-gate-'));
const env = envFile(dir);
const commit = output('git', ['rev-parse', 'HEAD']);
const clean = output('git', ['status', '--porcelain']) === '';
const jobs: JobRecord[] = [];
let images: Record<string, string> = {};
let failed = false;

const commands: Readonly<Record<Step, [string, string[], NodeJS.ProcessEnv]>> = {
  verify: ['pnpm', ['verify', '--concurrency=1'], {}],
  golden: ['pnpm', ['test:golden'], {}],
  e2e: ['pnpm', ['test:e2e'], {}],
  smoke: ['sh', ['scripts/stack-smoke.sh'], gateSmokeEnv(env, project, tag)],
  reconcile: [
    'pnpm',
    ['test:reconcile'],
    {
      RECONCILE_TAG: tag,
      RECONCILE_PROJECT: process.env.RECONCILE_PROJECT ?? `${project}-reconcile`,
      // The gate records the images' digests after the run and removes them itself (cleanup).
      RECONCILE_KEEP_IMAGES: '1',
      // The smoke built the images under the same tag; without the smoke the run builds them.
      ...(selected.includes('smoke') ? { RECONCILE_SKIP_BUILD: '1' } : {}),
    },
  ],
};

const compose = (...args: string[]) =>
  run('docker', ['compose', '--env-file', env, ...args], gateComposeEnv(project, tag));

let cleaned: Promise<void> | undefined;
/** The project down with its volumes, the tag's images removed, the env file deleted; once. */
function cleanup(): Promise<void> {
  cleaned ??= (async () => {
    try {
      if (selected.includes('smoke')) {
        await compose('down', '--volumes', '--remove-orphans', '--timeout', '15');
      }
      if (
        process.env.GATE_KEEP_IMAGES !== '1' &&
        (selected.includes('smoke') || selected.includes('reconcile'))
      ) {
        for (const service of SERVICES) {
          await run('docker', ['image', 'rm', '--force', `shopfloor-twin/${service}:${tag}`]);
        }
      }
      await pruneBuildCache((message) => {
        console.log(`gate: ${message}`);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  return cleaned;
}

// Ctrl+C, SIGTERM or SIGHUP: passed on to the running job's process group (never once the
// cleanup has started: its own `docker compose` and `docker image rm` must finish), then wait for
// the job to end (the reconciliation removes its own projects), clean up and exit 128 + the
// signal's number (130, 143, 129). A second signal while the job still runs kills its process
// group (SIGKILL); a signal during the cleanup changes nothing.
const EXIT_CODES: Readonly<Partial<Record<NodeJS.Signals, number>>> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};
/** Set by a signal (an object: TypeScript can't see a closure assign a plain `let`). */
const signals = { stopping: false };
/** Sends `signal` to the running job's process group, unless the cleanup has started. */
const signalJob = (signal: NodeJS.Signals): void => {
  const pid = current?.child.pid;
  if (cleaned !== undefined || pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // the job ended meanwhile
  }
};
const stop = (signal: NodeJS.Signals) => {
  if (signals.stopping) {
    if (cleaned === undefined) {
      console.error(`\n${signal} again: killing the running job`);
      signalJob('SIGKILL');
    }
    return;
  }
  signals.stopping = true;
  console.error(`\n${signal}: waiting for the running job, then cleaning up`);
  const running = cleaned === undefined ? current : undefined;
  signalJob(signal);
  void (running?.exited ?? Promise.resolve(0))
    .then(() => cleanup())
    .catch((error: unknown) => {
      console.error('cleanup failed', error);
    })
    .finally(() => {
      process.exit(EXIT_CODES[signal] ?? 1);
    });
};
for (const signal of Object.keys(EXIT_CODES) as NodeJS.Signals[]) process.on(signal, stop);

try {
  for (const job of STEPS) {
    const [command, args, extra] = commands[job];
    const text = [command, ...args].join(' ');
    if (signals.stopping) await new Promise(() => undefined); // the signal handler owns the exit
    if (failed || !selected.includes(job)) {
      jobs.push({ job, command: text, result: 'skipped', seconds: 0 });
      continue;
    }
    console.log(`\n=== gate: ${job} (${text}) ===`);
    const started = Date.now();
    // The smoke and the reconciliation run the stack with the generated secrets: their output is
    // kept and searched for every one of them (checklist S7, #242); a hit fails the job.
    const capture = job === 'smoke' || job === 'reconcile' ? join(dir, `${job}.log`) : undefined;
    let code = await run(command, args, extra, capture);
    if (capture !== undefined) {
      const logged = readFileSync(capture, 'utf8');
      const leaked = generated.filter((value) => logged.includes(value)).length;
      if (leaked > 0) {
        console.error(`gate: ${String(leaked)} generated secret(s) appeared in the ${job} output`);
        code = code === 0 ? 1 : code;
      } else {
        console.log(
          `gate: none of the ${String(generated.length)} generated secrets in the ${job} output`,
        );
      }
    }
    if (signals.stopping) await new Promise(() => undefined); // the signal handler owns the rest
    if (job === 'smoke') {
      images = digests();
      await compose('down', '--volumes', '--remove-orphans', '--timeout', '15');
      await pruneBuildCache((message) => {
        console.log(`gate: ${message}`);
      });
    }
    if (job === 'reconcile' && Object.keys(images).length === 0) images = digests();
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    jobs.push({ job, command: text, result: code === 0 ? 'passed' : 'failed', seconds });
    if (code !== 0) failed = true;
  }
} finally {
  if (signals.stopping) await new Promise(() => undefined); // the signal handler owns the exit
  await cleanup();
}

const gibValue = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;
const record = {
  commit,
  clean,
  node: process.version,
  docker: output('docker', ['version', '--format', '{{.Server.Version}}']),
  compose: output('docker', ['compose', 'version', '--short']),
  project,
  tag,
  freeDisk: { hostGiB: gibValue(disks.host), dockerGiB: gibValue(disks.docker) },
  jobs,
  images,
  result: failed ? 'failed' : 'passed',
};
mkdirSync(join(REPO, 'e2e/results'), { recursive: true });
writeFileSync(join(REPO, 'e2e/results/gate.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log('\n=== gate record ===');
console.log(`commit ${commit}${clean ? '' : ' (uncommitted changes)'}`);
console.log(`node ${record.node}, docker ${record.docker}, compose ${record.compose}`);
console.log(
  `free disk at the start: host ${formatGib(disks.host)}, Docker ${formatGib(disks.docker)}`,
);
for (const job of jobs) {
  console.log(
    `${job.job.padEnd(10)} ${job.result.padEnd(8)} ${String(job.seconds).padStart(7)} s  ${job.command}`,
  );
}
for (const [service, id] of Object.entries(images)) console.log(`image ${service}:${tag} ${id}`);
console.log(failed ? 'GATE-FAILED' : 'GATE-OK');
process.exit(failed ? 1 : 0);
