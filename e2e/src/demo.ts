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
 *
 * `pnpm demo:record` (#282, `--record`) is the same run with Playwright's video on the
 * walkthrough's one page and a screenshot per scene (e2e/results/demo/record/). It refuses a tree
 * whose sources differ from HEAD. Once the walkthrough has passed with every scene it stages in
 * e2e/results/demo/record/publish/ (src/demo-record.ts) the video, re-encoded by the scripted
 * fallback only when over the size limit, the screenshots and the WebVTT captions from the scene
 * log; checks the staged files (size, length, resolution, the screenshots' total, no secret of the
 * run in the captions or the record, every view a scene asserts held at least 1 s by the view log,
 * #303); and only then replaces docs/demo/'s files. A refused
 * recording leaves docs/demo/ as it was. DEMO_RECORD_PROBE_S (the 60 s size probe) records scenes 1
 * to 3 and the run until the video is that long, prints the size extrapolated to the walkthrough's
 * length, stages and checks scenes 1 to 3, and publishes nothing.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { pruneBuildCache } from '@shopfloor/test-kit/heavy-lock';
import { GatewayClient, MesClient, SimulatorClient, gauge, provisionUsers } from './clients.ts';
import { DEMO, SCENES, checkSceneLog } from './demo-plan.ts';
import {
  REENCODE_ARGS,
  RECORDING,
  bundledFfmpeg,
  captionsFromSceneLog,
  heldViewsFromLog,
  probeInfo,
  publishStaged,
  recordingProblems,
  screenshotName,
} from './demo-record.ts';
import { REPO, Stack, removeImages } from './stack.ts';

const project = process.env.DEMO_PROJECT ?? 'shopfloor-demo-run';
const tag = process.env.DEMO_TAG ?? 'demo';
const skipBuild = process.env.DEMO_SKIP_BUILD === '1';
const keepImages = process.env.DEMO_KEEP_IMAGES === '1';
const RESULTS = join(REPO, 'e2e/results/demo');
const record = process.argv.includes('--record');
const probeSeconds = Number(process.env.DEMO_RECORD_PROBE_S ?? '0');
const RECORD_DIR = join(RESULTS, 'record');
const execFileP = promisify(execFile);
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

/** `ffmpeg -i <video>`'s report: its duration and size (ffmpeg exits 1 without an output). */
async function videoInfo(file: string) {
  const result = await execFileP(bundledFfmpeg(), ['-hide_banner', '-i', file]).catch(
    (error: unknown) => error as { stderr?: string },
  );
  return probeInfo(result.stderr ?? '');
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

/** The size probe's measure: the video's size, extrapolated to the walkthrough's length. */
async function reportProbe() {
  const file = join(RECORD_DIR, 'walkthrough.webm');
  const { size } = await stat(file);
  const info = await videoInfo(file);
  const perMinute = (size / info.seconds) * 60;
  log(
    `PROBE: ${String(info.width)}×${String(info.height)}, ${info.seconds.toFixed(1)} s, ${mib(size)}; ` +
      `${mib(perMinute)} per minute; 6.5 min ≈ ${mib(perMinute * 6.5)}, 7 min ≈ ${mib(perMinute * 7)} ` +
      `(limit ${mib(RECORDING.limits.videoBytes)})`,
  );
}

/**
 * The source files the walkthrough and its images are built from, changed since HEAD (tracked
 * files outside `docs/` and Markdown): `pnpm demo:record` refuses to record over any, so a
 * recording's commit is what it shows.
 */
async function changedSources(): Promise<string> {
  const { stdout } = await execFileP(
    'git',
    [
      'status',
      '--porcelain',
      '--untracked-files=no',
      '--',
      '.',
      ':(exclude)docs',
      ':(exclude)*.md',
    ],
    { cwd: REPO },
  );
  return stdout.trim();
}

/**
 * Stages the passed walkthrough's recording in `RECORD_DIR/publish/`: the video (re-encoded with
 * REENCODE_ARGS only when over the size limit), a screenshot per scene of `scenes` and the
 * captions from the scene log; measures it, writes the record (`e2e/results/demo/recording.json`,
 * with each held view's place in the video and dwell)
 * and returns what must stop it being published (none: it may be). Nothing in docs/demo/ is
 * touched here.
 */
async function stageRecording(
  scenes: readonly (typeof SCENES)[number][],
  secrets: readonly string[],
): Promise<{ staged: string; problems: string[] }> {
  const staged = join(RECORD_DIR, 'publish');
  await rm(staged, { recursive: true, force: true });
  await mkdir(staged, { recursive: true });
  const recorded = join(RECORD_DIR, 'walkthrough.webm');
  const recordedSize = (await stat(recorded)).size;
  const video = join(staged, RECORDING.videoFile);
  let reencoded = false;
  if (recordedSize > RECORDING.limits.videoBytes) {
    log(`video ${mib(recordedSize)}: over the limit, re-encoding (${REENCODE_ARGS.join(' ')})`);
    await execFileP(
      bundledFfmpeg(),
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', recorded, ...REENCODE_ARGS, video],
      { timeout: 1_800_000 },
    );
    reencoded = true;
  } else {
    await copyFile(recorded, video);
  }
  const bytes = await readFile(video);
  const info = await videoInfo(video);
  let screenshotBytes = 0;
  for (const s of scenes) {
    const name = screenshotName(s.n, s.id);
    await copyFile(join(RECORD_DIR, name), join(staged, name));
    screenshotBytes += (await stat(join(staged, name))).size;
  }
  const { videoStart } = JSON.parse(
    await readFile(join(RECORD_DIR, 'video-start.json'), 'utf8'),
  ) as { videoStart: string };
  const captions = captionsFromSceneLog(
    await readFile(join(RESULTS, 'scenes.jsonl'), 'utf8'),
    Date.parse(videoStart),
    scenes.map((s) => s.n),
  );
  await writeFile(join(staged, RECORDING.captionsFile), captions);
  // Each asserted view's hold (#303): where it is in the video and how long it was held.
  const views = heldViewsFromLog(
    await readFile(join(RECORD_DIR, 'views.jsonl'), 'utf8').catch(() => ''),
    Date.parse(videoStart),
  );
  const commit = (await execFileP('git', ['rev-parse', 'HEAD'], { cwd: REPO })).stdout.trim();
  const summary = {
    commit,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    seconds: Number(info.seconds.toFixed(1)),
    resolution: `${String(info.width)}x${String(info.height)}`,
    recordedBytes: recordedSize,
    reencoded,
    screenshotBytes,
    views,
  };
  const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
  await writeFile(join(RESULTS, 'recording.json'), summaryText);
  log(`recording staged: ${JSON.stringify(summary)}`);
  const problems = recordingProblems(
    {
      ...info,
      bytes: bytes.length,
      screenshotBytes,
      texts: [captions, summaryText],
      scenes: scenes.map((s) => s.n),
      views,
    },
    secrets,
  );
  return { staged, problems };
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
  await rm(RECORD_DIR, { recursive: true, force: true });
  if (record) {
    // Playwright's ffmpeg, installed with its Chromium: missing, nothing is built or started.
    await stat(bundledFfmpeg());
    // A recording names the commit it shows: nothing it is built from may differ from it.
    const changed = await changedSources();
    if (changed !== '') {
      throw new Error(
        `pnpm demo:record refuses a changed tree; commit or stash first:\n${changed}`,
      );
    }
  }
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
    ...(record ? { DEMO_RECORD_DIR: RECORD_DIR } : {}),
    ...(record && probeSeconds > 0 ? { DEMO_RECORD_PROBE_MS: String(probeSeconds * 1000) } : {}),
  });
  if (code !== 0) throw new Error(`the demo walkthrough failed (exit ${String(code)})`);
  // Every secret of the run that a page or the test could ever have held.
  const secrets = [...Object.values(accounts).map((a) => a.password), ...stack.secretValues()];
  if (record && probeSeconds > 0) {
    // Scenes 1 to 3 only: a size measure, never a demo run (no DEMO-OK). It stages and checks
    // its recording as a full one would, and publishes nothing.
    await reportProbe();
    const { staged, problems } = await stageRecording(SCENES.slice(0, 3), secrets);
    log(
      `probe staged in ${staged}: ${problems.length === 0 ? 'no problem' : problems.join('; ')}; nothing published`,
    );
    log('PROBE-OK');
  } else {
    // A skipped walkthrough exits 0 too: DEMO-OK only with every scene recorded, once, in order.
    const scenes = checkSceneLog(
      await readFile(join(RESULTS, 'scenes.jsonl'), 'utf8').catch(() => ''),
    );
    log(`scene log: scenes ${scenes.join(', ')} recorded`);
    log('DEMO-OK');
  }
  if (record && probeSeconds <= 0) {
    const { staged, problems } = await stageRecording(SCENES, secrets);
    // Only a recording without a problem replaces docs/demo/'s files; a refused one leaves them.
    await publishStaged(staged, join(REPO, RECORDING.dir), problems, {
      mkdir: (dir) => mkdir(dir, { recursive: true }),
      readdir: (dir) => readdir(dir),
      rm: (path) => rm(path),
      copyFile: (from, to) => copyFile(from, to),
    });
    log(`published to ${RECORDING.dir}/`);
    log('RECORD-OK');
  }
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
