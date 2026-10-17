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
 *    own `.env` is neither read nor touched;
 * 5. `reconcile`: `pnpm test:reconcile` (both passes) with the smoke's images
 *    (`RECONCILE_SKIP_BUILD=1`, the same tag).
 *
 * Then it removes the project's volumes, the images it built and the env file, and prints one
 * record for the pull request's "Gate" section: the commit (and whether the tree was clean), each
 * job with its duration and result, Node and Docker versions, and the image digests the smoke and
 * the reconciliation ran. The record also goes to e2e/results/gate.json.
 *
 * Usage: pnpm gate. Environment: GATE_STEPS (comma list of the jobs above, default all, for a rerun
 * after a later commit: runbook "Merge gate"), GATE_PROJECT (Compose project of the smoke, default
 * shopfloor-gate), GATE_TAG (image tag of the smoke and the reconciliation, default gate),
 * RECONCILE_PROJECT (the reconciliation's project prefix, default <GATE_PROJECT>-reconcile),
 * GATE_KEEP_IMAGES=1 (keep the images).
 * A failed job stops the gate; the cleanup and the record still run.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const STEPS = ['verify', 'golden', 'e2e', 'smoke', 'reconcile'] as const;
type Step = (typeof STEPS)[number];
const SERVICES = ['simulator', 'edge-gateway', 'mes-server', 'erp-mock', 'web'] as const;
/** Secrets the stack requires (Compose `:?`) plus the bootstrap admin's, appended when missing. */
const REQUIRED_SECRETS = [
  'DB_PASSWORD',
  'DB_APP_PASSWORD',
  'MQTT_HEALTHCHECK_PASSWORD',
  'MQTT_DEV_PASSWORD',
  'MQTT_GATEWAY_PASSWORD',
  'MQTT_MES_PASSWORD',
  'ERP_API_TOKEN',
  'MES_BOOTSTRAP_ADMIN_PASSWORD',
];

const selected = (process.env.GATE_STEPS ?? STEPS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is Step => (STEPS as readonly string[]).includes(s));
const project = process.env.GATE_PROJECT ?? 'shopfloor-gate';
const tag = process.env.GATE_TAG ?? 'gate';

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

/** Runs a command with inherited output; resolves with its exit code. */
function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<number> {
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd: REPO,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('error', () => {
      done(1);
    });
    child.on('exit', (code) => {
      done(code ?? 1);
    });
  });
}

/** The throw-away env file: `.env.example` with generated secrets, mode 600, in a temp dir. */
function envFile(dir: string): string {
  const secret = () => randomBytes(18).toString('hex');
  const seen = new Set<string>();
  const lines = readFileSync(join(REPO, '.env.example'), 'utf8')
    .split('\n')
    .map((line) => {
      const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
      if (key === undefined) return line;
      seen.add(key);
      return /_(PASSWORD|TOKEN)$/.test(key) ? `${key}=${secret()}` : line;
    });
  for (const key of REQUIRED_SECRETS) if (!seen.has(key)) lines.push(`${key}=${secret()}`);
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
  smoke: ['sh', ['scripts/stack-smoke.sh'], { SMOKE_ENV_FILE: env, SMOKE_WRITES: '1' }],
  reconcile: [
    'pnpm',
    ['test:reconcile'],
    {
      RECONCILE_TAG: tag,
      RECONCILE_PROJECT: process.env.RECONCILE_PROJECT ?? `${project}-reconcile`,
      // The smoke built the images under the same tag; without the smoke the run builds them.
      ...(selected.includes('smoke') ? { RECONCILE_SKIP_BUILD: '1' } : {}),
    },
  ],
};

const compose = (...args: string[]) =>
  run('docker', ['compose', '--env-file', env, ...args], { COMPOSE_PROJECT_NAME: project });

try {
  for (const job of STEPS) {
    const [command, args, extra] = commands[job];
    const text = [command, ...args].join(' ');
    if (failed || !selected.includes(job)) {
      jobs.push({ job, command: text, result: 'skipped', seconds: 0 });
      continue;
    }
    console.log(`\n=== gate: ${job} (${text}) ===`);
    const started = Date.now();
    const code = await run(command, args, extra);
    if (job === 'smoke') {
      images = digests();
      await compose('down', '--volumes', '--remove-orphans', '--timeout', '15');
    }
    if (job === 'reconcile' && Object.keys(images).length === 0) images = digests();
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    jobs.push({ job, command: text, result: code === 0 ? 'passed' : 'failed', seconds });
    if (code !== 0) failed = true;
  }
} finally {
  if (selected.includes('smoke'))
    await compose('down', '--volumes', '--remove-orphans', '--timeout', '15');
  if (
    process.env.GATE_KEEP_IMAGES !== '1' &&
    (selected.includes('smoke') || selected.includes('reconcile'))
  ) {
    for (const service of SERVICES) {
      await run('docker', ['image', 'rm', '--force', `shopfloor-twin/${service}:${tag}`]);
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

const record = {
  commit,
  clean,
  node: process.version,
  docker: output('docker', ['version', '--format', '{{.Server.Version}}']),
  compose: output('docker', ['compose', 'version', '--short']),
  project,
  tag,
  jobs,
  images,
  result: failed ? 'failed' : 'passed',
};
mkdirSync(join(REPO, 'e2e/results'), { recursive: true });
writeFileSync(join(REPO, 'e2e/results/gate.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log('\n=== gate record ===');
console.log(`commit ${commit}${clean ? '' : ' (uncommitted changes)'}`);
console.log(`node ${record.node}, docker ${record.docker}, compose ${record.compose}`);
for (const job of jobs) {
  console.log(
    `${job.job.padEnd(10)} ${job.result.padEnd(8)} ${String(job.seconds).padStart(7)} s  ${job.command}`,
  );
}
for (const [service, id] of Object.entries(images)) console.log(`image ${service}:${tag} ${id}`);
console.log(failed ? 'GATE-FAILED' : 'GATE-OK');
process.exit(failed ? 1 : 0);
