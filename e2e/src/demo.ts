/**
 * The demo walkthrough (#281, Phase 10 plan "Demo scenario (P10-06)", docs/demo.md): the whole
 * stack under its own Compose project (docker-compose.yml, e2e/compose.reconcile.yml's ephemeral
 * ports and no restarts, compose.demo.yml: the timeline `demo-v1` in orders mode with the ERP
 * dataset config/erp/demo-v1.yaml), a generated env file with random secrets, one user per role made
 * through the API, then Playwright's project `demo` (e2e/browser/demo): the eight scenes through
 * the real web UI at 60×, each asserting what it shows.
 *
 * The harness only starts what a presenter would find running: it waits for the stack (the MES
 * ready, the orders imported from the ERP, every machine connected and known to the MES), then
 * starts the idle run through the control API. Everything else happens in the browser: the plant
 * changes only through the timeline's own actions; scene 3's pause and resume are infrastructure.
 *
 * Usage: pnpm demo (under the heavy-suite lock). Environment: DEMO_PROJECT (Compose project,
 * default shopfloor-demo-run; never the dev stack's, never `shopfloor-demo`, which docs/demo.md
 * leaves to the owner's hand-run demo), DEMO_TAG (image tag, default demo), DEMO_SKIP_BUILD=1 (use
 * the images already built under that tag), DEMO_KEEP_IMAGES=1 (keep them; by default they are
 * removed at the end, #228). Results (the scene log, Playwright traces on failure, compose.log on
 * failure) go to e2e/results/demo/. SIGINT and SIGTERM remove the stack and the env file.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pruneBuildCache } from '@shopfloor/test-kit/heavy-lock';
import { GatewayClient, MesClient, SimulatorClient, gauge, provisionUsers } from './clients.ts';
import { DEMO, checkSceneLog } from './demo-plan.ts';
import { REPO, Stack, removeImages } from './stack.ts';

const project = process.env.DEMO_PROJECT ?? 'shopfloor-demo-run';
const tag = process.env.DEMO_TAG ?? 'demo';
const skipBuild = process.env.DEMO_SKIP_BUILD === '1';
const keepImages = process.env.DEMO_KEEP_IMAGES === '1';
const RESULTS = join(REPO, 'e2e/results/demo');
/** One user per role besides the bootstrap admin, made through the API. */
const ROLE_USERS = {
  operator: { username: 'demo-operator', roles: ['operator'] },
  maintenance: { username: 'demo-maintenance', roles: ['maintenance'] },
  quality: { username: 'demo-quality', roles: ['quality'] },
  supervisor: { username: 'demo-supervisor', roles: ['supervisor'] },
} as const;

if (
  !/^[a-z0-9][a-z0-9_-]*$/.test(project) ||
  project === 'shopfloor-twin' ||
  project === 'shopfloor-demo'
) {
  console.error(`DEMO_PROJECT must name a disposable Compose project, not "${project}"`);
  process.exit(2);
}
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(tag) || tag === 'dev') {
  console.error(`DEMO_TAG must name images of the run's own, not "${tag}"`);
  process.exit(2);
}

const started = Date.now();
const log = (message: string) => {
  console.log(`[demo ${String(Math.round((Date.now() - started) / 1000))} s] ${message}`);
};

async function until(what: string, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'none';
  for (;;) {
    const ok = await check().catch((error: unknown) => {
      lastError = error instanceof Error ? error.message : String(error);
      return false;
    });
    if (ok) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${String(timeoutMs)} ms: ${what} (last error: ${lastError})`,
      );
    }
    await sleep(500);
  }
}

let browserChild: ChildProcess | undefined;
function runBrowser(env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'playwright', 'test', '--project', 'demo'], {
      cwd: join(REPO, 'e2e'),
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    browserChild = child;
    child.on('exit', (code) => {
      browserChild = undefined;
      resolve(code ?? 1);
    });
    child.on('error', () => {
      browserChild = undefined;
      resolve(1);
    });
  });
}

const stack = new Stack({
  project,
  // The timeline's seed, start, production mode and SIM_AUTOSTART=false come from compose.demo.yml.
  env: { SIM_SPEED: String(DEMO.speed), ERP_POLL_MS: '2000', IMAGE_TAG: tag },
  files: ['compose.demo.yml'],
});
const stop = (signal: NodeJS.Signals) => {
  console.error(`${signal}: removing the stack`);
  browserChild?.kill('SIGTERM');
  void stack
    .destroy()
    .catch((error: unknown) => {
      console.error('could not remove the stack', error);
    })
    // The images too, as the run's own end removes them (#228).
    .then(() => (!keepImages && !skipBuild ? removeImages(tag) : undefined))
    .finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

let failed = false;
let built = false;
try {
  await mkdir(RESULTS, { recursive: true });
  await rm(join(RESULTS, 'scenes.jsonl'), { force: true });
  await stack.prepare();
  await stack.compose(['down', '--volumes', '--remove-orphans']);
  if (!skipBuild) {
    log(`building the images (tag ${tag})`);
    built = true;
    await stack.compose(['build'], 1_200_000);
    await pruneBuildCache(log);
  }
  log(`starting the stack (${DEMO.timeline} loaded, the run idle at ${DEMO.start})`);
  await stack.compose(['up', '--detach', '--wait', '--no-build'], 600_000);
  const mesBase = await stack.url('mes', 4700);
  const trust = await stack.webTrust();
  const simBase = await stack.url('simulator', 4800);
  await until('MES ready', () => new MesClient(mesBase).ready(), 60_000);
  const token = stack.value('SIM_CONTROL_TOKEN');
  const sim = new SimulatorClient(simBase, token);
  const idle = await sim.status();
  if (idle.state !== 'idle' || Date.parse(idle.simTime) !== Date.parse(DEMO.start)) {
    throw new Error(`the run must wait idle at ${DEMO.start}: ${JSON.stringify(idle)}`);
  }
  const loaded = (await (
    await fetch(`${simBase}/api/v1/scenario`, { headers: sim.auth })
  ).json()) as { scenario: { name: string | null } | null };
  if (loaded.scenario?.name !== DEMO.timeline) {
    throw new Error(`the run must have ${DEMO.timeline} loaded: ${JSON.stringify(loaded)}`);
  }

  const users = await provisionUsers(
    mesBase,
    stack.bootstrapAdminPassword,
    Object.values(ROLE_USERS),
  );
  const accounts = Object.fromEntries(
    [
      ['admin', 'admin'] as const,
      ...Object.entries(ROLE_USERS).map(([role, u]) => [role, u.username] as const),
    ].map(([role, username]) => {
      const user = users.get(username);
      if (!user) throw new Error(`${username} was not created`);
      return [role, { username, password: user.password }];
    }),
  );
  log('users made: admin and one per other role');

  // What a presenter finds: the orders imported from the ERP, every machine connected and known.
  const supervisor = users.get(ROLE_USERS.supervisor.username);
  if (!supervisor) throw new Error('the supervisor was not created');
  const mes = new MesClient(mesBase, supervisor.cookie);
  await until(
    `the demo orders (${DEMO.orders.map((o) => o.id).join(', ')}) imported from the ERP`,
    async () => {
      const { orders } = await mes.orders();
      return DEMO.orders.every((o) => orders.some((m) => m.id === o.id && m.status === 'imported'));
    },
    90_000,
  );
  const gateway = new GatewayClient(await stack.url('gateway', 4900));
  await until(
    'gateway ready with every machine connected',
    async () => {
      if (!(await gateway.ready())) return false;
      const connected = gauge(await gateway.metrics(), 'gateway_device_connected');
      return DEMO.machines.every((id) => connected.get(id) === 1);
    },
    90_000,
  );
  await until(
    'every machine known to the MES with a state',
    async () => {
      const { equipment } = await mes.equipment();
      return DEMO.machines.every((id) => equipment.some((e) => e.id === id && e.current !== null));
    },
    90_000,
  );

  const resumed = await sim.resume();
  log(`run started at ${resumed.simTime}, ${String(resumed.speed)}×`);
  const code = await runBrowser({
    ...trust.env,
    RECONCILE_WEB_URL: trust.url,
    RECONCILE_RESULTS: RESULTS,
    RECONCILE_ACCOUNTS: JSON.stringify(accounts),
    DEMO_SIM_URL: simBase,
    DEMO_SIM_TOKEN: token,
  });
  if (code !== 0) throw new Error(`the demo walkthrough failed (exit ${String(code)})`);
  // A skipped walkthrough exits 0 too: DEMO-OK only with every scene recorded, once, in order.
  const scenes = checkSceneLog(
    await readFile(join(RESULTS, 'scenes.jsonl'), 'utf8').catch(() => ''),
  );
  log(`scene log: scenes ${scenes.join(', ')} recorded`);
  log('DEMO-OK');
} catch (error) {
  failed = true;
  console.error(error);
  try {
    await writeFile(join(RESULTS, 'compose.log'), await stack.compose(['logs', '--no-color']));
    console.error(`compose logs: ${join(RESULTS, 'compose.log')}`);
  } catch {
    // the stack never came up
  }
} finally {
  await stack.destroy().catch((error: unknown) => {
    console.error('could not remove the stack', error);
  });
  if (!keepImages && (built || !skipBuild)) await removeImages(tag);
}
process.exit(failed ? 1 : 0);
