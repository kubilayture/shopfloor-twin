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
 * - the other roles see neither the console nor its link.
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
import { MesClient, SimulatorClient, provisionUsers } from './clients.ts';
import { REPO, Stack, removeImages } from './stack.ts';

const project = process.env.CONSOLE_PROJECT ?? 'shopfloor-console';
const tag = process.env.CONSOLE_TAG ?? 'console';
const skipBuild = process.env.CONSOLE_SKIP_BUILD === '1';
const keepImages = process.env.CONSOLE_KEEP_IMAGES === '1';
const RESULTS = join(REPO, 'e2e/results/console');
/** The committed timeline's seed and start (config/scenarios/monday-breakdown-and-recovery.yaml). */
const SEED = '20261012';
const START = '2026-10-12T06:00:00+03:00';
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
function runBrowser(env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'playwright', 'test', '--project', 'console'], {
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
  const web = await stack.url('web', 8080);
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

  const code = await runBrowser({
    RECONCILE_WEB_URL: web,
    RECONCILE_RESULTS: RESULTS,
    RECONCILE_ACCOUNTS: JSON.stringify(accounts),
    CONSOLE_SIM_URL: simBase,
    CONSOLE_SIM_TOKEN: stack.value('SIM_CONTROL_TOKEN'),
    CONSOLE_MES_URL: mesBase,
  });
  if (code !== 0) throw new Error(`the console Playwright run failed (exit ${String(code)})`);
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
