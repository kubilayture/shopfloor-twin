/**
 * The fresh-clone test (#277, P10-02; Phase 10 plan "The fresh-clone test", success criterion 1):
 * the README's quick-start block, run verbatim on a clone of the commit under test, in a disposable
 * directory and Compose project, with no Node.js on the PATH.
 *
 * 1. `git clone --no-local` of the repository at HEAD (the committed tree, never the working tree)
 *    into a new directory under ~/.cache/shopfloor-twin/fresh-clone, outside the repository (the OS
 *    temporary directory is not shared with a Colima VM, so the clone's bind mounts would be
 *    empty). A dirty checkout is refused unless FRESH_CLONE_ALLOW_DIRTY=1, which marks the record
 *    "not of record"; the record says whether the commit is contained in `origin/main` (required
 *    for the closing run). The clone must have no `.env`.
 * 2. Isolation by process environment, never by editing a file: `COMPOSE_PROJECT_NAME` and
 *    `IMAGE_TAG` `fresh-<hex>` and a free host port in every port variable (five contiguous ones
 *    for `SIM_OPCUA_HOST_PORTS`, each checked). Every Compose call after the README line (this
 *    harness's, the clone's smoke, the cleanup) gets that environment.
 * 3. Before the README line, with that environment: `docker compose --env-file
 *    <tmp>/placeholder.env config --format json` (every secret the literal `placeholder`; the file
 *    outside the clone, which has no `.env` yet), parsed in memory and never printed: the project
 *    must be `fresh-<hex>` and every built image tagged `fresh-<hex>`. If it fails nothing is
 *    built, started or removed. FRESH_CLONE_NO_CACHE=1 then builds with `--no-cache --pull` and
 *    the placeholder env (no build takes a secret).
 * 4. The README's block (between the `<!-- quick-start -->` markers, the `git clone` and `cd` lines
 *    excepted) runs verbatim with `sh -e -c` in the clone, its PATH a fresh directory of links to
 *    exactly `sh`, `git`, `docker`, the init's utilities (its header) and any credential helper
 *    the Docker configuration names; `command -v node` and `command -v pnpm` must fail there
 *    first. HOME, DOCKER_CONFIG, DOCKER_HOST and DOCKER_CONTEXT are kept (Compose and the CLI
 *    plugins are found through `~/.docker`).
 * 5. After `up`: the project from the containers' labels (`docker compose ls`, `docker ps --filter
 *    label=…`); every long-running service healthy, `pki` and `migrate` exited 0, `opcua-tools`
 *    not created; the published container ports exactly checklist S8's, each on 127.0.0.1 at the
 *    chosen host port, 4700, 4900 and 5442 unpublished.
 * 6. Before the smoke: the placeholder-env check again, `docker compose ps --all` listing only
 *    containers labelled `fresh-<hex>`, and no `shopfloor-twin` container created or recreated
 *    since the run began. Then the clone's own `scripts/stack-smoke.sh` in the clone, with
 *    `SMOKE_ENV_FILE` = the clone's `.env`, without `SMOKE_WRITES`, under the isolation
 *    environment.
 * 7. The bootstrap admin logs in over HTTPS, trusting only the clone's dev CA, and is told to
 *    change the password (403 `password-change-required`); the harness changes it in the throwaway
 *    stack and, with that session, the plant overview's API lists all six machines with a state.
 * 8. Checklist S7: none of the clone's generated passwords and tokens, nor the new admin password,
 *    in anything this run printed (the harness's own lines and every child's output).
 * 9. Cleanup, also on failure and on SIGINT, SIGTERM or SIGHUP: `docker compose -p fresh-<hex>
 *    down --volumes` (the project named explicitly), the `fresh-<hex>` images removed, the clone
 *    deleted, the BuildKit cache pruned to 10 GiB; refused for the project `shopfloor-twin` or the
 *    tag `dev`. In the checkout it writes only e2e/results/fresh-clone/, never runs Compose there
 *    and never reads or touches `.env`.
 * 10. Record: e2e/results/fresh-clone/result.json.
 *
 * Usage: pnpm test:fresh-clone (under the heavy lock). Environment: FRESH_CLONE_NO_CACHE=1,
 * FRESH_CLONE_ALLOW_DIRTY=1, FRESH_CLONE_TMPDIR (the clone's base directory; one the Docker VM shares).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setDefaultCACertificates } from 'node:tls';
import { equipmentListSchema } from '@shopfloor/contracts';
import { pruneBuildCache } from '@shopfloor/test-kit/heavy-lock';
import { portIsFree, freePort } from '@shopfloor/test-kit/ports';
import { generatedPassword, mesLogin, mesWrite, rawRequest } from './clients.ts';
import {
  BUILT_IMAGES,
  baseInside,
  FORBIDDEN_TOOLS,
  OWNER_PROJECT,
  assertDisposable,
  cleanupCommands,
  configProblems,
  disposableName,
  foreignRows,
  isolationEnv,
  leakedCount,
  nodeFreeTools,
  parsePs,
  placeholderEnv,
  portProblems,
  quickStartLines,
  secretValues,
  serviceProblems,
  type HostPorts,
} from './fresh-clone-checks.ts';

const REPO = resolve(import.meta.dirname, '../..');
const RESULTS = join(REPO, 'e2e/results/fresh-clone');
const noCache = process.env.FRESH_CLONE_NO_CACHE === '1';
const allowDirty = process.env.FRESH_CLONE_ALLOW_DIRTY === '1';

const started = Date.now();
/** Everything this run printed, its own lines and its children's output (checklist S7). */
const transcript: string[] = [];
const log = (message: string) => {
  const line = `[fresh-clone ${String(Math.round((Date.now() - started) / 1000))} s] ${message}`;
  transcript.push(`${line}\n`);
  console.log(line);
};
const fail = (message: string): never => {
  throw new Error(message);
};

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
const quiet = (command: string, args: readonly string[]): string => {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '(unavailable)';
  }
};

// The commit under test: the committed tree, never the working tree.
const commit = git('rev-parse', 'HEAD');
const clean = git('status', '--porcelain') === '';
if (!clean && !allowDirty) {
  console.error(
    'fresh-clone: the checkout has uncommitted changes; the test clones the commit, so commit them first (or FRESH_CLONE_ALLOW_DIRTY=1 for a run not of record)',
  );
  process.exit(2);
}
let inOriginMain = false;
try {
  execFileSync('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], {
    cwd: REPO,
    stdio: 'ignore',
  });
  inOriginMain = true;
} catch {
  // not contained (or no origin/main): recorded
}

const hex = randomBytes(4).toString('hex');
const project = disposableName(hex);
const tag = project;
assertDisposable(project, tag);

// Under the home directory, not the OS temporary directory: Compose bind-mounts files of the clone
// (config/mosquitto), and Colima (like Docker Desktop's defaults) shares only the home directory
// with its VM, so a clone under /var/folders started a broker with an empty configuration (#277,
// first run). FRESH_CLONE_TMPDIR names another base, one the Docker VM can see.
const base =
  process.env.FRESH_CLONE_TMPDIR ?? join(homedir(), '.cache', 'shopfloor-twin', 'fresh-clone');
// Checked before it is made (nothing created in a checkout), and again with links resolved after.
if (baseInside(resolve(base), [REPO, resolve(REPO, git('rev-parse', '--git-common-dir'), '..')])) {
  console.error(`fresh-clone: the clone's base ${base} is inside a checkout of the repository`);
  process.exit(2);
}
mkdirSync(base, { recursive: true, mode: 0o700 });
// Never inside this checkout or the main one (#277 review m2), symbolic links resolved.
const mainCheckout = realpathSync(resolve(REPO, git('rev-parse', '--git-common-dir'), '..'));
const insideCheckout = baseInside(realpathSync(base), [realpathSync(REPO), mainCheckout]);
if (insideCheckout !== undefined) {
  console.error(`fresh-clone: the clone's base ${base} is inside the checkout ${insideCheckout}`);
  process.exit(2);
}
const tmp = mkdtempSync(join(base, 'run-'));
const clone = join(tmp, 'shopfloor-twin');
const placeholderFile = join(tmp, 'placeholder.env');
const bin = join(tmp, 'bin');

/** Five contiguous free host ports for the OPC UA servers, each checked, below the ephemeral range. */
async function freeBlock(taken: ReadonlySet<number>): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const base = 20_000 + 5 * Math.floor(Math.random() * 2_000);
    let free = true;
    for (let port = base; port < base + 5; port++) {
      if (taken.has(port) || !(await portIsFree(port))) {
        free = false;
        break;
      }
    }
    if (free) return base;
  }
  return fail('no block of five free host ports for OPC UA');
}

async function choosePorts(): Promise<HostPorts> {
  const taken = new Set<number>();
  const one = async () => {
    for (;;) {
      const port = await freePort();
      if (!taken.has(port)) {
        taken.add(port);
        return port;
      }
    }
  };
  const mqtt = await one();
  const simControl = await one();
  const modbus = await one();
  const erp = await one();
  const web = await one();
  const opcuaBase = await freeBlock(taken);
  return { mqtt, simControl, opcuaBase, modbus, erp, web };
}

/** The process environment without anything that would choose Compose files or profiles. */
function baseEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('COMPOSE_') && !key.startsWith('SMOKE_') && key !== 'IMAGE_TAG',
    ),
  );
}

let current: ChildProcess | undefined;
interface RunResult {
  readonly code: number;
  readonly stdout: string;
}
/**
 * Runs a command. `tee` (default): its output goes to this process's output and the transcript;
 * `quiet`: its standard output stays in memory only (the placeholder-env `config`), its errors are
 * shown.
 */
function run(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly mode?: 'tee' | 'quiet';
    readonly onLine?: (line: string) => void;
  },
): Promise<RunResult> {
  // After a signal nothing new starts (#277 review m3), except the cleanup's own commands.
  if (signals.stopping && cleaned === undefined) return Promise.resolve({ code: 130, stdout: '' });
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    current = child;
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (options.mode !== 'quiet') {
        transcript.push(chunk);
        process.stdout.write(chunk);
      }
      if (options.onLine !== undefined) for (const line of chunk.split('\n')) options.onLine(line);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      transcript.push(chunk);
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      transcript.push(`${error.message}\n`);
      console.error(error.message);
    });
    child.on('close', (code) => {
      if (current === child) current = undefined;
      done({ code: code ?? 1, stdout });
    });
  });
}

let isolation: Record<string, string> | undefined;
/** Compose in the clone with the isolation environment (never without it). */
function compose(args: readonly string[], mode: 'tee' | 'quiet' = 'tee'): Promise<RunResult> {
  if (isolation === undefined) return fail('compose before the isolation environment was set');
  return run('docker', ['compose', ...args], {
    cwd: clone,
    env: { ...baseEnv(), ...isolation },
    mode,
  });
}

/**
 * The placeholder-env resolution check (plan step 4): only while the output can hold no real
 * secret: the file given is the placeholder env, so Compose reads no `.env`. Parsed in memory,
 * never printed.
 */
async function resolutionCheck(when: string): Promise<void> {
  const result = await compose(
    ['--env-file', placeholderFile, 'config', '--format', 'json'],
    'quiet',
  );
  if (result.code !== 0)
    fail(`${when}: docker compose config failed (exit ${String(result.code)})`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail(`${when}: docker compose config gave no JSON`);
  }
  const problems = configProblems(parsed, project, tag);
  if (problems.length > 0) fail(`${when}: ${problems.join('; ')}`);
  log(`${when}: the configuration resolves to project ${project}, every built image :${tag}`);
}

/** The developer's own project's containers (id and creation time), compared before and after. */
const ownerContainers = (): string =>
  execFileSync(
    'docker',
    [
      'ps',
      '-a',
      '--filter',
      `label=com.docker.compose.project=${OWNER_PROJECT}`,
      '--format',
      '{{.ID}} {{.CreatedAt}}',
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .sort()
    .join('\n');

async function labelChecks(when: string, ownerBefore: string): Promise<void> {
  const listed = await compose(['ls', '--all', '--format', 'json'], 'quiet');
  const projects = (JSON.parse(listed.stdout || '[]') as { Name?: string }[]).map((p) => p.Name);
  if (!projects.includes(project)) fail(`${when}: docker compose ls does not list ${project}`);
  const labelled = execFileSync(
    'docker',
    ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((line) => line !== '');
  const ps = parsePs((await compose(['ps', '--all', '--format', 'json'], 'quiet')).stdout);
  if (ps.length === 0) fail(`${when}: docker compose ps lists no container`);
  const foreign = foreignRows(ps, project);
  if (foreign.length > 0) fail(`${when}: containers of another project: ${foreign.join(', ')}`);
  if (labelled.length !== ps.length) {
    fail(
      `${when}: ${String(labelled.length)} containers labelled ${project}, docker compose ps lists ${String(ps.length)}`,
    );
  }
  if (ownerContainers() !== ownerBefore) {
    fail(`${when}: a ${OWNER_PROJECT} container was created, removed or recreated during the run`);
  }
  log(
    `${when}: ${String(ps.length)} containers, all labelled ${project}; no ${OWNER_PROJECT} container created or recreated`,
  );
}

/** The fresh directory of links the README line runs with (plan step 3). */
function nodeFreePath(): string {
  const tools = nodeFreeTools(
    readFileSync(join(clone, 'scripts/stack-init.sh'), 'utf8'),
    (() => {
      const dir = process.env.DOCKER_CONFIG ?? join(homedir(), '.docker');
      try {
        return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as unknown;
      } catch {
        return {};
      }
    })(),
  );
  const find = (tool: string): string | undefined => {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (dir === '' || dir === bin) continue;
      const path = join(dir, tool);
      try {
        accessSync(path, constants.X_OK);
        if (statSync(path).isFile()) return path;
      } catch {
        // not here
      }
    }
    return undefined;
  };
  mkdirSync(bin, { mode: 0o700 });
  const linked: string[] = [];
  for (const tool of [...tools.required, ...tools.optional]) {
    const path = find(tool);
    if (path === undefined) {
      if (tools.required.includes(tool)) fail(`${tool} is not on the PATH`);
      continue;
    }
    symlinkSync(path, join(bin, tool));
    linked.push(tool);
  }
  log(`Node-free PATH: ${bin} with ${linked.join(', ')}`);
  return bin;
}

/** The README line's shell environment: the isolation variables, the Node-free PATH, Docker's. */
function readmeEnv(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: path };
  for (const key of [
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'DOCKER_CONFIG',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...isolation };
}

const imageId = (image: string): string =>
  quiet('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
const repoDigests = (image: string): string =>
  quiet('docker', ['image', 'inspect', '--format', '{{join .RepoDigests ","}}', image]);

// ---- cleanup and signals -------------------------------------------------------------------------

/** Set once the resolution check passed: only then may the cleanup run Compose or remove images. */
let composeAllowed = false;
let cleaned: Promise<void> | undefined;
function cleanup(): Promise<void> {
  cleaned ??= (async () => {
    try {
      if (composeAllowed && isolation !== undefined && existsSync(clone)) {
        const [down, ...images] = cleanupCommands(project, tag, placeholderFile);
        log(`cleanup: docker compose -p ${project} down --volumes, images :${tag} removed`);
        if (down !== undefined) {
          await run('docker', down, { cwd: clone, env: { ...baseEnv(), ...isolation } });
        }
        for (const image of images) {
          await run('docker', image, { cwd: tmp, env: baseEnv() });
        }
        await pruneBuildCache((message) => {
          log(message);
        });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  })();
  return cleaned;
}

const EXIT_CODES: Readonly<Partial<Record<NodeJS.Signals, number>>> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};
const signals = { stopping: false };
for (const signal of Object.keys(EXIT_CODES) as NodeJS.Signals[]) {
  process.on(signal, () => {
    if (signals.stopping) return;
    signals.stopping = true;
    console.error(`\nfresh-clone: ${signal}: stopping the running command, then cleaning up`);
    const child = current;
    if (cleaned === undefined && child !== undefined) child.kill(signal);
    void (async () => {
      if (child?.exitCode === null && child.signalCode === null) {
        await new Promise((done) => child.once('close', done));
      }
      await cleanup().catch((error: unknown) => {
        console.error('cleanup failed', error);
      });
      process.exit(EXIT_CODES[signal] ?? 1);
    })();
  });
}

// ---- the run -------------------------------------------------------------------------------------

const durations: Record<string, number> = {};
const timed = async <T>(name: string, step: () => Promise<T>): Promise<T> => {
  const at = Date.now();
  try {
    return await step();
  } finally {
    durations[name] = Math.round((Date.now() - at) / 100) / 10;
  }
};
let failure: string | undefined;
/** The clone's generated passwords and tokens and the admin's new password (checklist S7). */
const secrets: string[] = [];
let ports: HostPorts | undefined;
const images: Record<string, string> = {};

try {
  log(
    `commit ${commit}${clean ? '' : ' (uncommitted changes: not of record)'}, project ${project}`,
  );
  const ownerBefore = ownerContainers();

  // 1. The clone of the commit, outside the repository.
  await timed('clone', async () => {
    const cloned = await run(
      'git',
      ['clone', '--quiet', '--no-local', '--no-checkout', REPO, clone],
      {
        cwd: tmp,
        env: baseEnv(),
      },
    );
    if (cloned.code !== 0) fail('git clone failed');
    const checkout = await run('git', ['checkout', '--quiet', '--detach', commit], {
      cwd: clone,
      env: baseEnv(),
    });
    if (checkout.code !== 0) fail(`git checkout ${commit} failed`);
  });
  if (existsSync(join(clone, '.env'))) fail('the clone has a .env before the init');
  log(`cloned into ${clone}; no .env`);

  // 2. The isolation environment.
  ports = await choosePorts();
  isolation = isolationEnv(project, tag, ports);
  log(
    `isolation: ${Object.entries(isolation)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')}`,
  );

  // 3. The placeholder-env resolution check, before any build, up or down.
  writeFileSync(
    placeholderFile,
    placeholderEnv(readFileSync(join(clone, '.env.example'), 'utf8')),
    {
      mode: 0o600,
    },
  );
  if (existsSync(join(clone, '.env'))) fail('the clone has a .env before the resolution check');
  await resolutionCheck('before the README line');
  composeAllowed = true;
  if (noCache) {
    const built = await timed('noCacheBuild', () =>
      compose(['--env-file', placeholderFile, 'build', '--no-cache', '--pull']),
    );
    if (built.code !== 0) fail(`the --no-cache build failed (exit ${String(built.code)})`);
  }

  // 4. The README's quick-start block, verbatim, Node-free.
  const lines = quickStartLines(readFileSync(join(clone, 'README.md'), 'utf8'));
  const path = nodeFreePath();
  const env = readmeEnv(path);
  for (const tool of FORBIDDEN_TOOLS) {
    const found = await run('sh', ['-c', `command -v ${tool}`], { cwd: clone, env });
    if (found.code === 0) fail(`${tool} is reachable from the Node-free PATH`);
  }
  log(`command -v ${FORBIDDEN_TOOLS.join(', ')} fail in the README shell`);
  log(`README quick-start block: ${lines.join(' / ')}`);
  const lineStarted = Date.now();
  let initDone: number | undefined;
  const readme = await run('sh', ['-e', '-c', lines.join('\n')], {
    cwd: clone,
    env,
    onLine: (line) => {
      if (initDone === undefined && line.startsWith('stack-init: wrote .env'))
        initDone = Date.now();
    },
  });
  durations.readmeLine = Math.round((Date.now() - lineStarted) / 100) / 10;
  if (initDone !== undefined) {
    durations.init = Math.round((initDone - lineStarted) / 100) / 10;
    durations.upWithBuild = Math.round((Date.now() - initDone) / 100) / 10;
  }
  if (readme.code !== 0)
    fail(`the README's quick-start block failed (exit ${String(readme.code)})`);
  const envPath = join(clone, '.env');
  const mode = statSync(envPath).mode & 0o777;
  if (mode !== 0o600) fail(`the init wrote .env with mode ${mode.toString(8)}, not 600`);
  // Read in memory only: the admin's password to log in and every secret for the S7 search.
  const envText = readFileSync(envPath, 'utf8');
  secrets.push(...secretValues(envText));
  const bootstrap = /^MES_BOOTSTRAP_ADMIN_PASSWORD=(.*)$/m.exec(envText)?.[1] ?? '';
  if (bootstrap === '') fail('the init wrote no MES_BOOTSTRAP_ADMIN_PASSWORD');

  // 5. Labels, services and ports after up.
  await labelChecks('after up', ownerBefore);
  const rows = parsePs((await compose(['ps', '--all', '--format', 'json'], 'quiet')).stdout);
  const serviceIssues = serviceProblems(rows);
  if (serviceIssues.length > 0) fail(`services: ${serviceIssues.join('; ')}`);
  log('every long-running service healthy; pki and migrate exited 0; opcua-tools not started');
  const portIssues = portProblems(rows, ports);
  if (portIssues.length > 0) fail(`ports: ${portIssues.join('; ')}`);
  log(
    'published: exactly S8 (8443, 1883, 4800, 4841-4845, 5020, 4600) on 127.0.0.1 at the chosen ports; 4700, 4900, 5442 unpublished',
  );
  for (const image of BUILT_IMAGES) images[image] = imageId(`shopfloor-twin/${image}:${tag}`);

  // 6. Before the smoke: the checks again; then the clone's own smoke.
  await resolutionCheck('before the smoke');
  await labelChecks('before the smoke', ownerBefore);
  const smokeEnv: NodeJS.ProcessEnv = {
    ...baseEnv(),
    ...isolation,
    SMOKE_ENV_FILE: envPath,
  };
  const smoke = await timed('smoke', () =>
    run('sh', ['scripts/stack-smoke.sh'], { cwd: clone, env: smokeEnv }),
  );
  if (smoke.code !== 0) fail(`the clone's stack smoke failed (exit ${String(smoke.code)})`);
  await labelChecks('after the smoke', ownerBefore);

  // 7. The bootstrap admin over HTTPS, trusting only the clone's dev CA.
  await timed('admin', async () => {
    const ca = await compose(['exec', '-T', 'web', 'cat', '/etc/nginx/tls/ca.pem'], 'quiet');
    if (ca.code !== 0 || !ca.stdout.includes('BEGIN CERTIFICATE')) fail('no dev CA from the web');
    setDefaultCACertificates([ca.stdout]);
    const base = `https://127.0.0.1:${String(ports?.web)}`;
    const first = await mesLogin(base, 'admin', bootstrap);
    if (!first.mustChangePassword) fail('the bootstrap admin was not told to change its password');
    const refused = await rawRequest('GET', `${base}/api/v1/equipment`, { cookie: first.cookie });
    const type = (JSON.parse(refused.text || '{}') as { type?: string }).type;
    if (refused.status !== 403 || type !== 'urn:shopfloor:password-change-required') {
      fail(`the bootstrap admin's first read answered ${String(refused.status)} ${String(type)}`);
    }
    log(
      'the bootstrap admin logged in over HTTPS (only the dev CA trusted): 403 password-change-required',
    );
    const password = generatedPassword();
    secrets.push(password);
    const changed = await mesWrite(
      base,
      'POST',
      '/api/v1/account/password',
      { currentPassword: bootstrap, newPassword: password },
      first.cookie,
    );
    if (changed.status !== 200) fail(`the password change answered ${String(changed.status)}`);
    const session = await mesLogin(base, 'admin', password);
    const deadline = Date.now() + 120_000;
    for (;;) {
      const answer = await rawRequest('GET', `${base}/api/v1/equipment`, {
        cookie: session.cookie,
      });
      const list =
        answer.status === 200 ? equipmentListSchema.parse(JSON.parse(answer.text)) : undefined;
      const withState = list?.equipment.filter((machine) => machine.current !== null) ?? [];
      if (list?.equipment.length === 6 && withState.length === 6) {
        log(
          `password changed; the plant overview lists six machines with a state: ${withState
            .map((machine) => `${machine.id} ${machine.current?.state ?? '?'}`)
            .join(', ')}`,
        );
        break;
      }
      if (Date.now() > deadline) {
        fail(
          `the plant overview listed ${String(list?.equipment.length ?? 0)} machines, ${String(withState.length)} with a state (answer ${String(answer.status)})`,
        );
      }
      await sleep(2_000);
    }
  });
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  log(`FAILED: ${failure}`);
} finally {
  if (signals.stopping) await new Promise(() => undefined); // the signal handler owns the exit
  // 9. Cleanup first, so its output is searched too (#277 review n2).
  await cleanup().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    transcript.push(`cleanup failed: ${message}\n`);
    console.error('cleanup failed', error);
  });
  // 8. Checklist S7: no generated secret in anything this run printed (cleanup included), pass or
  // fail.
  if (secrets.length > 0) {
    const leaked = leakedCount(transcript.join(''), secrets);
    if (leaked > 0) {
      failure ??= `${String(leaked)} generated secret(s) appeared in the output`;
      log(`FAILED: ${String(leaked)} generated secret(s) appeared in the output`);
    } else if (secrets.length < 12) {
      failure ??= `only ${String(secrets.length)} secrets to search for`;
    } else {
      log(`none of the ${String(secrets.length)} generated secrets in this run's output`);
    }
  }
  durations.total = Math.round((Date.now() - started) / 100) / 10;
  const docker = (() => {
    try {
      return JSON.parse(quiet('docker', ['info', '--format', '{{json .}}'])) as Record<
        string,
        unknown
      >;
    } catch {
      return {};
    }
  })();
  const record = {
    commit,
    clean,
    ofRecord: clean,
    inOriginMain,
    project,
    noCache,
    startedAt: new Date(started).toISOString(),
    durationsSeconds: durations,
    hostPorts: ports ?? null,
    docker: {
      server: quiet('docker', ['version', '--format', '{{.Server.Version}}']),
      compose: quiet('docker', ['compose', 'version', '--short']),
      vm: {
        operatingSystem: docker.OperatingSystem ?? null,
        kernel: docker.KernelVersion ?? null,
        cpus: docker.NCPU ?? null,
        memoryBytes: docker.MemTotal ?? null,
      },
    },
    images,
    baseImages: {
      db: {
        image: 'timescale/timescaledb:2.30.2-pg18',
        id: imageId('timescale/timescaledb:2.30.2-pg18'),
        digests: repoDigests('timescale/timescaledb:2.30.2-pg18'),
      },
      broker: {
        image: 'eclipse-mosquitto:2.1.2-alpine',
        id: imageId('eclipse-mosquitto:2.1.2-alpine'),
        digests: repoDigests('eclipse-mosquitto:2.1.2-alpine'),
      },
    },
    notes: [
      'The db and broker images are used as they are on the machine (never pulled by this run); their digests are recorded above.',
      noCache
        ? 'FRESH_CLONE_NO_CACHE=1: built with --no-cache --pull before the README line (the build bases re-pulled).'
        : 'Built from the BuildKit cache on the machine (FRESH_CLONE_NO_CACHE not set).',
      'A truly clean Docker host is not simulated: images of other projects stay on the machine.',
    ],
    secretsSearched: secrets.length,
    result: failure === undefined ? 'passed' : 'failed',
    failure: failure ?? null,
  };
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, 'result.json'), `${JSON.stringify(record, null, 2)}\n`);
  log(`record: ${join(RESULTS, 'result.json')}`);
  console.log(failure === undefined ? 'FRESH-CLONE-OK' : 'FRESH-CLONE-FAILED');
  process.exit(failure === undefined ? 0 : 1);
}
