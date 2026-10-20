/**
 * The console Playwright run (#237, Phase 9 plan P9-10, security checklist S3 and S10): the whole
 * stack under its own Compose project (docker-compose.yml with e2e/compose.reconcile.yml: ephemeral
 * ports, no restarts, a generated env file with random secrets, SIM_CONTROL_TOKEN among them), the
 * simulator idle at Monday 06:00 with seed 20261012 (the committed timeline
 * `monday-breakdown-and-recovery`'s), then Playwright's `console` project
 * (e2e/browser/console):
 *
 * - every refusal: `/sim/` 401 anonymous, 403 for the four other roles, 403 for a write from
 *   another origin (or without one) and for a method a route doesn't allow, 404 outside the
 *   allowlist (the ground truth and the recorded run included, exact routes only); the control API
 *   401 without its token or with another; the token never reaches the browser;
 * - every console action through `/console` as admin, each seen in the simulator's own reads: a
 *   timeline load while idle with its progress, start, pause, step, speed, a failure injection, a
 *   leak-test drift, OPC UA offline and back, Modbus silent and back, a lot blocked and released,
 *   operators marked absent for a later shift, a tool breakage, the action list and the live plant
 *   event stream through nginx;
 * - the other roles see neither the console nor its link;
 * - a logout ends the event stream within its lifetime (4 s here, `SIM_EVENTS_LIFETIME_MS`) with
 *   4100, and the reconnect is refused;
 * - the HTTPS front (P9-14, checklist S4, browser/tls): the page over TLS 1.3 with the pki step's
 *   certificate, Chromium pinned to that key alone (another certificate refused), plain HTTP to the
 *   port refused, the session cookie `__Host-` and `Secure`.
 * - each action's effect seen in the MES (#270, P9-F3, exit criterion 4; browser/console/
 *   4-effects.spec.ts): every lot of OP10's material blocked starves an OP10 machine with
 *   `MATERIAL:`, and an injected failure raises its alarm at the time it was applied.
 *
 * Then a second simulator run (#270): the simulator alone is recreated idle at Monday 13:40 (same
 * seed, a new device epoch; the MES, gateway and web keep running), the gateway reconnected and
 * every OPC UA machine anchored in the MES in the new epoch, and Playwright's `console-shift` project
 * (e2e/browser/console-shift): both ASM-01 operators of shift B marked absent through the console
 * leave ASM-01 `Idle` `NO-OPERATOR` from 14:00 in the MES. The first run can't show it in bounded
 * time: its timeline already marks shift B absent, and shift C starts 16 simulated hours later.
 *
 * The users are made through the API by the bootstrap admin (generated passwords, never written to
 * a file): `admin` and one user per other role.
 *
 * Usage: pnpm test:console. Environment: CONSOLE_PROJECT (Compose project, default
 * shopfloor-console), CONSOLE_TAG (image tag, default console), CONSOLE_SKIP_BUILD=1 (use the
 * images already built under that tag), CONSOLE_KEEP_IMAGES=1 (keep them; by default they are
 * removed at the end, #228). Results (Playwright traces, compose.log on failure) go to
 * e2e/results/console/. SIGINT and SIGTERM remove the stack and the env file before exiting.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pruneBuildCache } from '@shopfloor/test-kit/heavy-lock';
import { GatewayClient, MesClient, SimulatorClient, gauge, provisionUsers } from './clients.ts';
import { REPO, Stack, removeImages } from './stack.ts';

const project = process.env.CONSOLE_PROJECT ?? 'shopfloor-console';
const tag = process.env.CONSOLE_TAG ?? 'console';
const skipBuild = process.env.CONSOLE_SKIP_BUILD === '1';
const keepImages = process.env.CONSOLE_KEEP_IMAGES === '1';
const RESULTS = join(REPO, 'e2e/results/console');
/** The committed timeline's seed and start (config/scenarios/monday-breakdown-and-recovery.yaml). */
const SEED = '20261012';
const START = '2026-10-12T06:00:00+03:00';
/** The second run's start (#270): 20 simulated minutes, 20 s at 60×, before shift B. */
const SHIFT_RUN_START = '2026-10-12T13:40:00+03:00';
const EVENTS_LIFETIME_MS = 4_000;
/** One user per role besides the bootstrap admin. */
const ROLE_USERS = {
  operator: { username: 'console-operator', roles: ['operator'] },
  maintenance: { username: 'console-maintenance', roles: ['maintenance'] },
  quality: { username: 'console-quality', roles: ['quality'] },
  supervisor: { username: 'console-supervisor', roles: ['supervisor'] },
} as const;

if (!/^[a-z0-9][a-z0-9_-]*$/.test(project) || project === 'shopfloor-twin') {
  console.error(`CONSOLE_PROJECT must name a disposable Compose project, not "${project}"`);
  process.exit(2);
}
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(tag) || tag === 'dev') {
  console.error(`CONSOLE_TAG must name images of the run's own, not "${tag}"`);
  process.exit(2);
}

const started = Date.now();
const log = (message: string) => {
  console.log(`[console ${String(Math.round((Date.now() - started) / 1000))} s] ${message}`);
};

async function until(what: string, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms: ${what}`);
    await sleep(500);
  }
}

let browserChild: ChildProcess | undefined;
function runBrowser(project: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'playwright', 'test', '--project', project], {
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
  env: {
    SIM_SEED: SEED,
    SIM_START: START,
    SIM_SPEED: '60',
    SIM_AUTOSTART: 'false',
    // A short event-stream lifetime (#237 review), so 3-stream-lifetime.spec.ts sees a logout end
    // the stream within seconds.
    SIM_EVENTS_LIFETIME_MS: String(EVENTS_LIFETIME_MS),
    IMAGE_TAG: tag,
  },
});
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

let failed = false;
let built = false;
try {
  await mkdir(RESULTS, { recursive: true });
  await stack.prepare();
  await stack.compose(['down', '--volumes', '--remove-orphans']);
  if (!skipBuild) {
    log(`building the images (tag ${tag})`);
    built = true;
    await stack.compose(['build'], 1_200_000);
    await pruneBuildCache(log);
  }
  log('starting the stack (simulator idle at Monday 06:00)');
  await stack.compose(['up', '--detach', '--wait', '--no-build'], 600_000);
  const mesBase = await stack.url('mes', 4700);
  // HTTPS (P9-14): the served certificate checked against the pki step's; Playwright gets
  // NODE_EXTRA_CA_CERTS and Chromium the SPKI pin of this stack's certificate.
  const trust = await stack.webTrust({ sibling: true });
  const web = trust.url;
  const simBase = await stack.url('simulator', 4800);
  await until('MES ready', () => new MesClient(mesBase).ready(), 60_000);
  const sim = new SimulatorClient(simBase, stack.value('SIM_CONTROL_TOKEN'));
  const idle = await sim.status();
  if (idle.state !== 'idle')
    throw new Error(`the simulator must wait idle: ${JSON.stringify(idle)}`);

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

  const browserEnv = {
    ...trust.env,
    RECONCILE_WEB_URL: web,
    RECONCILE_RESULTS: RESULTS,
    RECONCILE_ACCOUNTS: JSON.stringify(accounts),
    CONSOLE_SIM_TOKEN: stack.value('SIM_CONTROL_TOKEN'),
    CONSOLE_MES_URL: mesBase,
    CONSOLE_EVENTS_LIFETIME_MS: String(EVENTS_LIFETIME_MS),
  };
  const code = await runBrowser('console', { ...browserEnv, CONSOLE_SIM_URL: simBase });
  if (code !== 0) throw new Error(`the console Playwright run failed (exit ${String(code)})`);

  // The second simulator run (#270): only the simulator recreated, idle at 13:40. The shell's
  // SIM_START takes precedence over the env file's in Compose's interpolation.
  log(`recreating the simulator idle at ${SHIFT_RUN_START} (a second run, a new epoch)`);
  process.env.SIM_START = SHIFT_RUN_START;
  await stack.compose(
    ['up', '--detach', '--wait', '--no-build', '--no-deps', '--force-recreate', 'simulator'],
    300_000,
  );
  const shiftSimBase = await stack.url('simulator', 4800);
  const shiftSim = new SimulatorClient(shiftSimBase, stack.value('SIM_CONTROL_TOKEN'));
  const shiftIdle = await shiftSim.status();
  if (shiftIdle.state !== 'idle' || Date.parse(shiftIdle.simTime) !== Date.parse(SHIFT_RUN_START))
    throw new Error(
      `the second run must wait idle at ${SHIFT_RUN_START}: ${JSON.stringify(shiftIdle)}`,
    );
  const truth = await shiftSim.groundTruth();
  const machines = Object.keys(truth.machines).sort();
  const gateway = new GatewayClient(await stack.url('gateway', 4900));
  await until(
    'gateway ready with every machine connected to the second run',
    async () => {
      if (!(await gateway.ready())) return false;
      const connected = gauge(await gateway.metrics(), 'gateway_device_connected');
      return machines.every((id) => connected.get(id) === 1);
    },
    60_000,
  );
  const supervisor = users.get(ROLE_USERS.supervisor.username);
  if (!supervisor) throw new Error('the supervisor was not created');
  const mes = new MesClient(mesBase, supervisor.cookie);
  // The OPC UA machines (ASM-01 among them) are anchored at once from their servers' start-up
  // state; the washer (Modbus) keeps its old epoch in the MES until its first fact of the new
  // run, so it isn't waited for here.
  let anchors = 'not read';
  await until(
    `every OPC UA machine anchored in the MES in the second run's epoch ${String(truth.epoch)}`,
    async () => {
      const { equipment } = await mes.equipment().catch((error: unknown) => {
        anchors = `read failed: ${String(error)}`;
        throw error;
      });
      anchors = JSON.stringify(equipment.map((e) => [e.id, e.current]));
      const opcua = equipment.filter((e) => e.interface === 'opcua');
      return opcua.length > 0 && opcua.every((e) => e.current?.epoch === truth.epoch);
    },
    60_000,
  ).catch((error: unknown) => {
    throw new Error(`${String(error)}; the MES holds ${anchors}`);
  });
  log('second run ready');
  const shiftCode = await runBrowser('console-shift', {
    ...browserEnv,
    CONSOLE_SIM_URL: shiftSimBase,
  });
  if (shiftCode !== 0)
    throw new Error(`the console-shift Playwright run failed (exit ${String(shiftCode)})`);
  log('CONSOLE-OK');
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
