/**
 * Trace performance through the stack (#204; Phase 8 plan "Genealogy", performance target, review
 * rounds 2 MEDIUM F and 3 LOW; exit criterion 6).
 *
 * On a disposable Compose project (docker-compose.yml, e2e/compose.reconcile.yml and
 * e2e/compose.trace-perf.yml, a generated env file): the database and the `migrate` step; then the
 * golden harness's loader (`apps/mes-server/src/trace-perf-load.e2e.test.ts`, a `mes-server` Vitest
 * entry run with `pnpm --filter`) replays `week-01` in order into that database as `mes_app`,
 * through the port the override publishes for this run only; then the project's ERP mock, MES and
 * web start on it, and the bootstrap admin makes the run's supervisor (generated passwords).
 *
 * The measurement, from the host through nginx (`web`) to `/api/v1/trace/…` with the supervisor's
 * session, one request at a time, Node's `fetch` and `performance.now()` (each request timed to the
 * last byte of its body): 200 backward traces of serials drawn at random (seeded, the seed in the
 * report) from every serial the forward traces return, and 200 forward traces of the largest lot
 * (by units). Before each series, 5 requests not counted (connection and caches warm), as the
 * report says. Recorded in e2e/results/trace-perf/report.json: p50, p95 and max per series, the
 * response payload sizes (min, median, max bytes), the database's size and the genealogy tables'.
 * Passes when both p95 are under 100 ms.
 *
 * Usage: pnpm test:trace-perf. Environment: TRACE_PERF_PROJECT (Compose project, default
 * shopfloor-trace-perf), TRACE_PERF_TAG (image tag, default RECONCILE_TAG or `reconcile`),
 * TRACE_PERF_SKIP_BUILD=1 (use the images already built under the tag), TRACE_PERF_SEED (the serial
 * draw, default 204). It removes the project, its volumes and the env file at the end; the images
 * stay (the caller's tag).
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { lotTraceSchema, serialTraceSchema } from '@shopfloor/contracts/mes-api';
import { ErpClient, MesClient, provisionUsers } from './clients.ts';
import { percentile } from './compare.ts';
import { REPO, Stack } from './stack.ts';

const REQUESTS = 200;
const WARM_UP = 5;
const TARGET_P95_MS = 100;
const project = process.env.TRACE_PERF_PROJECT ?? 'shopfloor-trace-perf';
const tag = process.env.TRACE_PERF_TAG ?? process.env.RECONCILE_TAG ?? 'reconcile';
const skipBuild = process.env.TRACE_PERF_SKIP_BUILD === '1';
const seed = Number(process.env.TRACE_PERF_SEED ?? 204);
const RESULTS = join(REPO, 'e2e/results/trace-perf');
const SUPERVISOR = 'trace-perf-supervisor';

const started = Date.now();
const log = (message: string) => {
  console.log(`[trace-perf +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
};

/** A small seeded generator (mulberry32): the serial draw is repeatable from the report's seed. */
function random(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Polls `check` until true; rejects after `timeoutMs`. */
async function until(what: string, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`, { cause: last });
    await sleep(500);
  }
}

/** Runs a command with the given environment, its output passed through; resolves with stdout. */
function run(command: string, args: readonly string[], env: Record<string, string>) {
  return new Promise<{ code: number; stdout: string }>((resolve) => {
    const child = spawn(command, args, {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.on('error', () => {
      resolve({ code: 1, stdout });
    });
    child.on('exit', (code) => {
      resolve({ code: code ?? 1, stdout });
    });
  });
}

interface Series {
  readonly requests: number;
  readonly warmUp: number;
  readonly ms: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly bytes: { readonly min: number; readonly median: number; readonly max: number };
}

const round = (ms: number) => Math.round(ms * 100) / 100;

/** Times `paths` one at a time through `base` with `cookie`, each to the last byte of its body. */
async function measure(
  base: string,
  cookie: string,
  paths: readonly string[],
  check: (text: string) => void,
): Promise<Series> {
  const get = async (path: string) => {
    const from = performance.now();
    const response = await fetch(`${base}${path}`, { headers: { cookie } });
    const text = await response.text();
    const ms = performance.now() - from;
    if (response.status !== 200) throw new Error(`${path}: ${String(response.status)} ${text}`);
    return { ms, bytes: Buffer.byteLength(text), text };
  };
  for (const path of paths.slice(0, WARM_UP)) check((await get(path)).text);
  const times: number[] = [];
  const sizes: number[] = [];
  for (const path of paths) {
    const { ms, bytes, text } = await get(path);
    check(text);
    times.push(ms);
    sizes.push(bytes);
  }
  return {
    requests: times.length,
    warmUp: WARM_UP,
    ms: {
      p50: round(percentile(times, 50)),
      p95: round(percentile(times, 95)),
      max: round(Math.max(...times)),
    },
    bytes: { min: Math.min(...sizes), median: percentile(sizes, 50), max: Math.max(...sizes) },
  };
}

async function main(): Promise<boolean> {
  await mkdir(RESULTS, { recursive: true });
  const stack = new Stack({
    project,
    env: { IMAGE_TAG: tag, SIM_AUTOSTART: 'false' },
    files: ['e2e/compose.trace-perf.yml'],
  });
  const report: Record<string, unknown> = { project, tag, seed, failures: [] as string[] };
  const failures = report.failures as string[];
  const stop = (signal: NodeJS.Signals) => {
    void stack.destroy().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await stack.prepare();
    await stack.compose(['down', '--volumes', '--remove-orphans']);
    if (!skipBuild) {
      log(`building mes-server, erp-mock and web (${tag})`);
      await stack.compose(['build', 'mes', 'erp', 'web'], 1_200_000);
    }
    log('starting db and the migrate step');
    await stack.compose(['up', '--detach', '--no-build', 'migrate']);
    await until(
      'migrate exited',
      async () => {
        const out = await stack.compose(['ps', '--all', '--format', 'json', 'migrate']);
        const state = JSON.parse(out.trim().split('\n')[0] ?? '{}') as {
          State?: string;
          ExitCode?: number;
        };
        if (state.State === 'exited' && state.ExitCode !== 0) {
          throw new Error(`migrate exited with ${String(state.ExitCode)}`);
        }
        return state.State === 'exited';
      },
      180_000,
    );
    const dbPort = new URL(await stack.url('db', 5432)).port;
    const url = `postgres://mes_app:${stack.value('DB_APP_PASSWORD')}@127.0.0.1:${dbPort}/shopfloor`;

    log('loading week-01 through the golden harness as mes_app');
    const loadReport = join(RESULTS, 'load.json');
    await rm(loadReport, { force: true });
    const loadFrom = Date.now();
    const loader = await run(
      'pnpm',
      [
        '--filter',
        '@shopfloor/mes-server',
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.e2e.config.ts',
        'src/trace-perf-load.e2e.test.ts',
      ],
      { TRACE_PERF_DATABASE_URL: url, TRACE_PERF_LOAD_REPORT: loadReport },
    );
    report.loadMs = Date.now() - loadFrom;
    // Run, not skipped: the loader's own report (a skipped or failed load writes none).
    const loaded = await readFile(loadReport, 'utf8').then(
      (text) => JSON.parse(text) as unknown,
      () => undefined,
    );
    if (loader.code !== 0 || loaded === undefined) {
      throw new Error(`the loader failed or was skipped (exit ${String(loader.code)})`);
    }
    report.load = loaded;

    log('starting erp, mes and web on the loaded database');
    await stack.compose(['up', '--detach', '--wait', '--no-build', 'erp', 'mes', 'web']);
    const mesBase = await stack.url('mes', 4700);
    await until('MES ready', () => new MesClient(mesBase).ready(), 120_000);
    const users = await provisionUsers(mesBase, stack.bootstrapAdminPassword, [
      { username: SUPERVISOR, roles: ['supervisor'] },
    ]);
    const cookie = users.get(SUPERVISOR)?.cookie;
    if (cookie === undefined) throw new Error(`${SUPERVISOR} was not created`);
    const web = await stack.url('web', 8080);
    const erp = new ErpClient(await stack.url('erp', 4600), stack.value('ERP_API_TOKEN'));

    // Every lot of the ERP's list, forward through nginx: the serials and the largest lot.
    const lotIds = (await erp.lots()).lots.map((l) => l.id);
    const serials = new Set<string>();
    let largest = { lot: '', units: -1 };
    for (const id of lotIds) {
      const response = await fetch(`${web}/api/v1/trace/lots/${encodeURIComponent(id)}`, {
        headers: { cookie },
      });
      if (response.status === 404) continue;
      const lot = lotTraceSchema.parse(await response.json());
      for (const unit of lot.units) if (unit.serial !== null) serials.add(unit.serial);
      if (lot.units.length > largest.units) largest = { lot: id, units: lot.units.length };
    }
    const pool = [...serials].sort();
    const draw = random(seed);
    const drawn = Array.from(
      { length: REQUESTS },
      () => pool[Math.floor(draw() * pool.length)] ?? '',
    );
    report.data = {
      lots: lotIds.length,
      serials: pool.length,
      largestLot: largest,
    };
    log(
      `${String(pool.length)} serials; largest lot ${largest.lot} (${String(largest.units)} units)`,
    );
    if (pool.length === 0 || largest.units <= 0) throw new Error('nothing loaded to trace');

    const backward = await measure(
      web,
      cookie,
      drawn.map((s) => `/api/v1/trace/serials/${encodeURIComponent(s)}`),
      (text) => {
        if (serialTraceSchema.parse(JSON.parse(text)).units.length === 0) {
          throw new Error('a backward trace without a unit');
        }
      },
    );
    const forward = await measure(
      web,
      cookie,
      Array.from(
        { length: REQUESTS },
        () => `/api/v1/trace/lots/${encodeURIComponent(largest.lot)}`,
      ),
      (text) => {
        if (lotTraceSchema.parse(JSON.parse(text)).units.length !== largest.units) {
          throw new Error(`the forward trace of ${largest.lot} changed its units`);
        }
      },
    );
    report.backward = backward;
    report.forward = forward;
    report.database = await stack.sqlJson(
      `SELECT json_build_object(
         'bytes', pg_database_size(current_database()),
         'pretty', pg_size_pretty(pg_database_size(current_database())),
         'genealogy', (SELECT json_object_agg(relname, pg_total_relation_size(c.oid))
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'genealogy' AND c.relkind = 'r'),
         'units', (SELECT count(*) FROM genealogy.serial_unit),
         'links', (SELECT count(*) FROM genealogy.genealogy_link))`,
    );
    for (const [name, series] of [
      ['backward', backward],
      ['forward', forward],
    ] as const) {
      if (!(series.ms.p95 < TARGET_P95_MS)) {
        failures.push(
          `${name} p95 ${String(series.ms.p95)} ms, not under ${String(TARGET_P95_MS)}`,
        );
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  } finally {
    report.totalMs = Date.now() - started;
    await writeFile(join(RESULTS, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await stack.destroy().catch((error: unknown) => {
      console.error('could not remove the stack', error);
    });
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  log(`report: ${JSON.stringify(report)}`);
  console.log(
    failures.length === 0 ? 'TRACE-PERF-OK' : `TRACE-PERF-FAILED: ${failures.join('; ')}`,
  );
  return failures.length === 0;
}

process.exit((await main()) ? 0 : 1);
