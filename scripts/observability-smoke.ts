/**
 * Starts the observability profile with the stack (P9-17, `compose.observability.yml`) and checks
 * it: the Phase 9 plan's "the profile started once", repeatable (the performance suite, P9-18,
 * reads the same Prometheus).
 *
 * 1. `docker compose … --profile observability --profile grafana up -d --wait` (the stack,
 *    Prometheus and Grafana, as `pnpm stack:up:observability`);
 * 2. Prometheus: every scrape target up, and the targets exactly the five jobs of
 *    `config/prometheus/prometheus.yml` (prometheus, mes, gateway, simulator, erp), within 90 s;
 *    one metric of each component's own present;
 * 3. Grafana: `/api/health` answers, an anonymous request is refused (401), the admin
 *    (GRAFANA_ADMIN_PASSWORD) sees the provisioned datasource and its health check passes, so
 *    Grafana reaches Prometheus;
 * 4. networks: Grafana on `observability` only, Prometheus on `default` and `observability`, neither
 *    on `edge` (the MES's proxy-header trust, #237);
 * 5. prints the targets and both containers' memory against their limits.
 *
 * Both UIs are read on the host addresses Docker published (`docker compose port`), never assumed.
 * The stack stays up: `pnpm stack:down:observability` (with the same env file and project) stops
 * it. Run it through `node scripts/heavy.ts` when it builds images.
 *
 * Usage: node scripts/observability-smoke.ts. Environment: SMOKE_ENV_FILE (default ./.env; it must
 * set GRAFANA_ADMIN_PASSWORD and names the project with COMPOSE_PROJECT_NAME, as the gate's does),
 * SMOKE_EPHEMERAL_PORTS=1 (adds e2e/compose.ephemeral-ports.yml, as the gate's smoke; set
 * PROMETHEUS_PORT=0 and GRAFANA_PORT=0 in the env file for ephemeral ports of the profile too).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const envFile = resolve(REPO, process.env.SMOKE_ENV_FILE ?? '.env');
const JOBS = ['erp', 'gateway', 'mes', 'prometheus', 'simulator'];
/** One metric each component registers itself (not a default process metric). */
const OWN_METRICS = {
  mes: 'mes_ingest_messages_total',
  gateway: 'gateway_buffer_messages',
  simulator: 'sim_time_seconds',
  erp: 'erp_feed_entries',
} as const;
const TARGETS_DEADLINE_MS = 90_000;

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const ok = (message: string): void => {
  console.log(`ok: ${message}`);
};

/** The env file's value of `key` (last assignment wins, as Compose reads it), unquoted. */
function envValue(key: string): string | undefined {
  let value: string | undefined;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = new RegExp(`^${key}=(.*)$`).exec(line);
    if (match) value = (match[1] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return value;
}

const files = [
  '--file',
  'docker-compose.yml',
  ...(process.env.SMOKE_EPHEMERAL_PORTS === '1'
    ? ['--file', 'e2e/compose.ephemeral-ports.yml']
    : []),
  '--file',
  'compose.observability.yml',
];

function compose(...args: string[]): string {
  return execFileSync(
    'docker',
    [
      'compose',
      '--env-file',
      envFile,
      ...files,
      '--profile',
      'observability',
      '--profile',
      'grafana',
      ...args,
    ],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ).trim();
}

/** `http://<host address>` of a published container port, read back from Docker. */
function published(service: string, port: number): string {
  const address = compose('port', service, String(port));
  if (address === '' || address.endsWith(':0')) fail(`${service}:${String(port)} is not published`);
  if (!address.startsWith('127.0.0.1:'))
    fail(`${service}:${String(port)} on ${address}, not 127.0.0.1`);
  return `http://${address}`;
}

interface Answer {
  readonly status: number;
  /** The parsed JSON body, or the text when it isn't JSON. */
  readonly body: unknown;
}

async function json(url: string, init?: RequestInit): Promise<Answer> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the text itself.
  }
  return { status: response.status, body };
}

const password = envValue('GRAFANA_ADMIN_PASSWORD');
if (password === undefined || password === '') {
  fail(`GRAFANA_ADMIN_PASSWORD is not set in ${envFile} (the profile requires it)`);
}

compose('up', '-d', '--wait');
ok('the stack and the observability profile are up (healthy)');

// Prometheus: every target up.
const prometheus = published('prometheus', 9090);
interface Target {
  readonly labels: { readonly job: string; readonly instance: string };
  readonly health: string;
  readonly lastError: string;
  readonly scrapeUrl: string;
}
let targets: readonly Target[];
const deadline = Date.now() + TARGETS_DEADLINE_MS;
for (;;) {
  const { body } = await json(`${prometheus}/api/v1/targets?state=active`);
  targets = (body as { data: { activeTargets: Target[] } }).data.activeTargets;
  if (targets.length > 0 && targets.every((target) => target.health === 'up')) break;
  if (Date.now() > deadline) {
    for (const target of targets) {
      console.error(
        `  ${target.labels.job} ${target.scrapeUrl}: ${target.health} ${target.lastError}`,
      );
    }
    fail(`not every Prometheus target is up within ${String(TARGETS_DEADLINE_MS / 1000)} s`);
  }
  await new Promise((done) => setTimeout(done, 2_000));
}
const jobs = targets.map((target) => target.labels.job).sort();
if (JSON.stringify(jobs) !== JSON.stringify(JOBS)) {
  fail(`Prometheus scrapes ${jobs.join(', ')}, expected ${JOBS.join(', ')}`);
}
for (const target of targets)
  console.log(`  ${target.labels.job.padEnd(10)} ${target.scrapeUrl} ${target.health}`);
ok(`Prometheus: all ${String(targets.length)} targets up, inside the Compose network`);

for (const [job, metric] of Object.entries(OWN_METRICS)) {
  const query = encodeURIComponent(`count(${metric}{job="${job}"})`);
  const { body } = await json(`${prometheus}/api/v1/query?query=${query}`);
  const result = (body as { data: { result: { value: [number, string] }[] } }).data.result;
  const count = Number(result[0]?.value[1] ?? 0);
  if (count < 1) fail(`${job}: no ${metric} in Prometheus`);
}
ok(`Prometheus holds each component's own metrics (${Object.values(OWN_METRICS).join(', ')})`);

// No CORS (#244 review): a page on another origin gets no Access-Control-Allow-Origin.
const cors = await fetch(`${prometheus}/api/v1/query?query=up`, {
  headers: { origin: 'https://attacker.example' },
  signal: AbortSignal.timeout(10_000),
});
await cors.text();
const allowed = cors.headers.get('access-control-allow-origin');
if (allowed !== null) fail(`Prometheus allows the origin ${allowed} (CORS)`);
ok('Prometheus sends no CORS header to another origin');

// Grafana: health, no anonymous access, the provisioned datasource reaching Prometheus.
const grafana = published('grafana', 3000);
const health = await json(`${grafana}/api/health`);
if (health.status !== 200 || (health.body as { database?: string }).database !== 'ok') {
  fail(`Grafana /api/health answered ${String(health.status)}`);
}
const anonymous = await json(`${grafana}/api/datasources`);
if (anonymous.status !== 401)
  fail(`Grafana answered an anonymous request ${String(anonymous.status)}`);
const admin = { authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` };
const wrong = await json(`${grafana}/api/datasources`, {
  headers: { authorization: `Basic ${Buffer.from('admin:admin').toString('base64')}` },
});
if (wrong.status !== 401) fail(`Grafana accepted admin:admin (${String(wrong.status)})`);
const sources = await json(`${grafana}/api/datasources`, { headers: admin });
if (sources.status !== 200) fail(`Grafana refused the admin (${String(sources.status)})`);
const uids = (sources.body as { uid: string; type: string; url: string }[]).map(
  (source) => `${source.uid}:${source.type}:${source.url}`,
);
if (JSON.stringify(uids) !== JSON.stringify(['prometheus:prometheus:http://prometheus:9090'])) {
  fail(`Grafana's datasources: ${uids.join(', ')}`);
}
const check = await json(`${grafana}/api/datasources/uid/prometheus/health`, { headers: admin });
if (check.status !== 200 || (check.body as { status?: string }).status !== 'OK') {
  fail(
    `Grafana's Prometheus datasource check: ${String(check.status)} ${JSON.stringify(check.body)}`,
  );
}
// Hardening (#244 review): no Grafana /metrics, no plugin admin, the database on a tmpfs.
const grafanaMetrics = await json(`${grafana}/metrics`);
if (grafanaMetrics.status === 200) fail('Grafana serves /metrics');
const settings = await json(`${grafana}/api/admin/settings`, { headers: admin });
const plugins = (settings.body as Record<string, Record<string, string>>).plugins ?? {};
if (plugins.plugin_admin_enabled !== 'false') {
  fail(`Grafana's plugin admin: ${String(plugins.plugin_admin_enabled)}`);
}
const tmpfs = execFileSync(
  'docker',
  ['inspect', '--format', '{{json .HostConfig.Tmpfs}}', compose('ps', '-q', 'grafana')],
  { encoding: 'utf8' },
);
if (!tmpfs.includes('/var/lib/grafana')) fail(`Grafana's /var/lib/grafana is no tmpfs: ${tmpfs}`);
ok(
  'Grafana: healthy, anonymous and admin:admin refused, the datasource reaches Prometheus; no /metrics, no plugin admin, state on a tmpfs',
);

// Networks: Grafana only on `observability`; Prometheus on `default` and `observability`.
// Docker names them `<project>_<network>`; none of this file's network names has an underscore.
const networksOf = (service: string): string[] => {
  const id = compose('ps', '-q', service);
  const raw = execFileSync(
    'docker',
    ['inspect', '--format', '{{json .NetworkSettings.Networks}}', id],
    { encoding: 'utf8' },
  );
  return Object.keys(JSON.parse(raw) as Record<string, unknown>)
    .map((name) => name.slice(name.lastIndexOf('_') + 1))
    .sort();
};
const grafanaNetworks = networksOf('grafana');
const prometheusNetworks = networksOf('prometheus');
if (JSON.stringify(grafanaNetworks) !== JSON.stringify(['observability'])) {
  fail(`Grafana is on ${grafanaNetworks.join(', ')}`);
}
if (JSON.stringify(prometheusNetworks) !== JSON.stringify(['default', 'observability'])) {
  fail(`Prometheus is on ${prometheusNetworks.join(', ')}`);
}
ok(
  'networks: Grafana on observability only, Prometheus on default and observability, neither on edge',
);

// Memory against the limits (one sample).
for (const service of ['prometheus', 'grafana']) {
  const id = compose('ps', '-q', service);
  const usage = execFileSync(
    'docker',
    ['stats', '--no-stream', '--format', '{{.MemUsage}} ({{.MemPerc}}), CPU {{.CPUPerc}}', id],
    { encoding: 'utf8' },
  ).trim();
  console.log(`  ${service.padEnd(10)} ${usage}`);
}
ok('observability profile checked');
