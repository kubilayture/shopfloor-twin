/**
 * The pure parts of the fresh-clone test (#277, P10-02; `e2e/src/fresh-clone.ts`, Phase 10 plan
 * "The fresh-clone test"): the README's quick-start block, the isolation environment, the
 * placeholder env file, the checks of Compose's resolved configuration and of the containers, the
 * Node-free PATH's tool list and the cleanup commands with their refusals. Tested in
 * `fresh-clone-checks.test.ts`; none of them runs anything.
 */
import { GENERATED_KEY, REQUIRED_SECRETS } from '../../scripts/required-secrets.ts';

/** The marker around the README's quick-start block (one fenced block between two of them). */
export const QUICK_START_MARKER = '<!-- quick-start -->';

/** The Compose project and image tag of the developer's own stack: never touched by the test. */
export const OWNER_PROJECT = 'shopfloor-twin';
export const OWNER_TAG = 'dev';

/** The images `docker-compose.yml` builds (the pki, migrate and opcua-tools services reuse them). */
export const BUILT_IMAGES = ['simulator', 'edge-gateway', 'mes-server', 'erp-mock', 'web'] as const;

/** Services that run, healthy, after `up --wait`; the one-shot steps; the profile-only service. */
export const LONG_RUNNING = ['db', 'broker', 'simulator', 'gateway', 'mes', 'erp', 'web'] as const;
export const ONE_SHOT = ['pki', 'migrate'] as const;
export const PROFILE_ONLY = ['opcua-tools'] as const;

/**
 * The lines the test runs from the README: the fenced block between the two quick-start markers,
 * without blank lines, comments, and the `git clone` and `cd` lines (the test makes the clone
 * itself). Throws unless there is exactly one marked block with a fenced code block in it.
 */
export function quickStartLines(readme: string): string[] {
  const parts = readme.split(QUICK_START_MARKER);
  if (parts.length !== 3) {
    throw new Error(
      `the README must have exactly two ${QUICK_START_MARKER} markers, found ${String(parts.length - 1)}`,
    );
  }
  const fence = /```[a-z]*\n([\s\S]*?)\n```/.exec(parts[1] ?? '');
  if (fence?.[1] === undefined) throw new Error('no fenced code block between the markers');
  const lines = fence[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .filter((line) => !/^git\s+clone\b/.test(line) && !/^cd(\s|$)/.test(line));
  if (lines.length === 0) throw new Error('the quick-start block has no command to run');
  return lines;
}

/** The host ports the test chooses: one per port variable, five contiguous for OPC UA. */
export interface HostPorts {
  readonly mqtt: number;
  readonly simControl: number;
  readonly opcuaBase: number;
  readonly modbus: number;
  readonly erp: number;
  readonly web: number;
}

/** A disposable project's name and tag (`fresh-<hex>`), refusing the developer's. */
export function disposableName(hex: string): string {
  if (!/^[0-9a-f]{6,}$/.test(hex)) throw new Error(`not a hex suffix: ${hex}`);
  return `fresh-${hex}`;
}

/**
 * Throws unless `project` and `tag` name a disposable stack of the test's own: never the
 * developer's project (`shopfloor-twin`) or tag (`dev`), never an empty or malformed name.
 */
export function assertDisposable(project: string, tag: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project) || project === OWNER_PROJECT) {
    throw new Error(`refusing Compose project "${project}": not a disposable project`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(tag) || tag === OWNER_TAG) {
    throw new Error(`refusing image tag "${tag}": not a disposable tag`);
  }
}

/**
 * The isolation environment (plan step 2) for every Compose call after the README line: the
 * project, the image tag and every host-port variable of `docker-compose.yml`. The process
 * environment wins over `.env` in Compose's interpolation, and `COMPOSE_PROJECT_NAME` over the
 * file's `name:`.
 */
export function isolationEnv(
  project: string,
  tag: string,
  ports: HostPorts,
): Record<string, string> {
  assertDisposable(project, tag);
  return {
    COMPOSE_PROJECT_NAME: project,
    IMAGE_TAG: tag,
    MQTT_PORT: String(ports.mqtt),
    SIM_CONTROL_PORT: String(ports.simControl),
    SIM_OPCUA_HOST_PORTS: `${String(ports.opcuaBase)}-${String(ports.opcuaBase + 4)}`,
    SIM_MODBUS_HOST_PORT: String(ports.modbus),
    ERP_HTTP_PORT: String(ports.erp),
    WEB_HTTPS_PORT: String(ports.web),
  };
}

/** The value every secret gets in the placeholder env file. */
export const PLACEHOLDER = 'placeholder';

/**
 * The placeholder env file (plan step 4): every key of `.env.example`, each `*_PASSWORD` and
 * `*_TOKEN` and every other required secret set to `placeholder`, the other keys as they are.
 */
export function placeholderEnv(example: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of example.split('\n')) {
    const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    if (key === undefined) continue;
    seen.add(key);
    const secret = GENERATED_KEY.test(key) || REQUIRED_SECRETS.includes(key);
    lines.push(secret ? `${key}=${PLACEHOLDER}` : line);
  }
  for (const key of REQUIRED_SECRETS) if (!seen.has(key)) lines.push(`${key}=${PLACEHOLDER}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Problems of Compose's resolved configuration (`config --format json`, parsed in memory, never
 * printed): its name must be the disposable project, and every image a service builds, or any
 * image of `shopfloor-twin/…`, must carry the disposable tag. Messages name services and images
 * only, never an environment value.
 */
export function configProblems(config: unknown, project: string, tag: string): string[] {
  const problems: string[] = [];
  if (typeof config !== 'object' || config === null) return ['the configuration is not an object'];
  const { name, services } = config as { name?: unknown; services?: unknown };
  if (name !== project) problems.push(`the project resolves to "${String(name)}", not ${project}`);
  if (typeof services !== 'object' || services === null) return [...problems, 'no services'];
  let built = 0;
  for (const [service, definition] of Object.entries(services as Record<string, unknown>)) {
    const { build, image } = (definition ?? {}) as { build?: unknown; image?: unknown };
    const ours = typeof image === 'string' && image.startsWith('shopfloor-twin/');
    if (build !== undefined) built += 1;
    if (build === undefined && !ours) continue;
    if (typeof image !== 'string' || !image.endsWith(`:${tag}`)) {
      problems.push(`service ${service} uses image ${String(image)}, not one tagged ${tag}`);
    }
  }
  if (built === 0) problems.push('no service builds an image');
  return problems;
}

/** One row of `docker compose ps --all --format json` (the fields the test reads). */
export interface PsRow {
  readonly Name?: string;
  readonly Service?: string;
  readonly Project?: string;
  readonly State?: string;
  readonly Health?: string;
  readonly ExitCode?: number;
  readonly Labels?: string;
  readonly Publishers?: readonly {
    readonly URL?: string;
    readonly TargetPort?: number;
    readonly PublishedPort?: number;
  }[];
}

/** `docker compose ps --format json` output: a JSON array, or one object per line. */
export function parsePs(text: string): PsRow[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as PsRow[];
  return trimmed.split('\n').map((line) => JSON.parse(line) as PsRow);
}

const projectLabel = (row: PsRow): string | undefined =>
  (row.Labels ?? '')
    .split(',')
    .find((label) => label.startsWith('com.docker.compose.project='))
    ?.slice('com.docker.compose.project='.length);

/** Rows whose `com.docker.compose.project` label (and project) is not `project`. */
export function foreignRows(rows: readonly PsRow[], project: string): string[] {
  return rows
    .filter((row) => projectLabel(row) !== project || row.Project !== project)
    .map((row) => `${row.Name ?? '?'} (label ${projectLabel(row) ?? 'none'})`);
}

/**
 * Problems of the services' states after `up --wait`: every long-running service running and
 * healthy, the one-shot steps exited 0, the profile-only service never created.
 */
export function serviceProblems(rows: readonly PsRow[]): string[] {
  const problems: string[] = [];
  const of = (service: string) => rows.filter((row) => row.Service === service);
  for (const service of LONG_RUNNING) {
    const found = of(service);
    if (found.length !== 1) {
      problems.push(`${service}: ${String(found.length)} containers, not 1`);
      continue;
    }
    const [row] = found;
    if (row?.State !== 'running' || row.Health !== 'healthy') {
      problems.push(`${service}: ${row?.State ?? '?'} ${row?.Health ?? ''}`.trim());
    }
  }
  for (const service of ONE_SHOT) {
    const found = of(service);
    if (found.length !== 1 || found[0]?.State !== 'exited' || found[0].ExitCode !== 0) {
      problems.push(
        `${service}: ${found.map((row) => `${row.State ?? '?'} (exit ${String(row.ExitCode)})`).join(', ') || 'not created'}, not exited 0`,
      );
    }
  }
  for (const service of PROFILE_ONLY) {
    if (of(service).length > 0) problems.push(`${service} was started (profile tools)`);
  }
  return problems;
}

/**
 * The published container ports checklist S8 allows (8443, 1883, 4800, 4841–4845, 5020, 4600),
 * each mapped to the host port the test chose: `service:containerPort` → host port.
 */
export function expectedPublished(ports: HostPorts): Map<string, number> {
  const expected = new Map<string, number>([
    ['web:8443', ports.web],
    ['broker:1883', ports.mqtt],
    ['simulator:4800', ports.simControl],
    ['simulator:5020', ports.modbus],
    ['erp:4600', ports.erp],
  ]);
  for (let i = 0; i < 5; i++) expected.set(`simulator:${String(4841 + i)}`, ports.opcuaBase + i);
  return expected;
}

/** Container ports that must stay unpublished: the MES, the gateway and the database. */
export const UNPUBLISHED = ['mes:4700', 'gateway:4900', 'db:5432'] as const;

/**
 * Problems of the published ports: exactly S8's container ports, each on `127.0.0.1` at the
 * chosen host port, and the MES, gateway and database ports on none.
 */
export function portProblems(rows: readonly PsRow[], ports: HostPorts): string[] {
  const expected = expectedPublished(ports);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const publisher of row.Publishers ?? []) {
      if ((publisher.PublishedPort ?? 0) <= 0) continue;
      const key = `${row.Service ?? '?'}:${String(publisher.TargetPort)}`;
      seen.add(key);
      const at = `${publisher.URL ?? '?'}:${String(publisher.PublishedPort)}`;
      if (!expected.has(key)) problems.push(`published outside the S8 set: ${key} at ${at}`);
      else if (publisher.URL !== '127.0.0.1' || publisher.PublishedPort !== expected.get(key)) {
        problems.push(`${key} at ${at}, not 127.0.0.1:${String(expected.get(key))}`);
      }
    }
  }
  for (const key of expected.keys()) if (!seen.has(key)) problems.push(`${key} is not published`);
  for (const key of UNPUBLISHED) if (seen.has(key)) problems.push(`${key} is published`);
  return problems;
}

/**
 * The tools the Node-free PATH links to (plan step 3): `sh`, `git`, `docker`, the utilities and
 * optional tools the init script's header lists (`# Utilities:`, `# Optional:`), and the
 * credential helpers the Docker configuration names (`credsStore`, `credHelpers`).
 */
export function nodeFreeTools(
  initScript: string,
  dockerConfig: unknown,
): {
  readonly required: string[];
  readonly optional: string[];
} {
  const listed = (label: string) =>
    (new RegExp(`^# ${label}:(.*)$`, 'm').exec(initScript)?.[1] ?? '')
      .trim()
      .split(/\s+/)
      .filter((tool) => tool !== '');
  const utilities = listed('Utilities');
  if (utilities.length === 0) throw new Error('the init script lists no utilities in its header');
  const helpers = new Set<string>();
  if (typeof dockerConfig === 'object' && dockerConfig !== null) {
    const { credsStore, credHelpers } = dockerConfig as {
      credsStore?: unknown;
      credHelpers?: unknown;
    };
    if (typeof credsStore === 'string' && credsStore !== '') helpers.add(credsStore);
    if (typeof credHelpers === 'object' && credHelpers !== null) {
      for (const helper of Object.values(credHelpers)) {
        if (typeof helper === 'string' && helper !== '') helpers.add(helper);
      }
    }
  }
  return {
    required: [
      'sh',
      'git',
      'docker',
      ...utilities,
      ...[...helpers].map((h) => `docker-credential-${h}`),
    ],
    optional: listed('Optional'),
  };
}

/** Tools that must never be reachable from the Node-free PATH. */
export const FORBIDDEN_TOOLS = ['node', 'pnpm'] as const;

/**
 * The values of an env file's passwords and tokens (checklist S7): each searched for in the run's
 * output. Quotes around a value are dropped; values shorter than 12 characters can't be told from
 * ordinary text and are not counted (the init's are 32).
 */
export function secretValues(envText: string): string[] {
  const values: string[] = [];
  for (const line of envText.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match?.[1] === undefined || !GENERATED_KEY.test(match[1])) continue;
    const value = (match[2] ?? '').replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
    if (value.length >= 12) values.push(value);
  }
  return values;
}

/** How many of `secrets` appear in `output` (never which). */
export const leakedCount = (output: string, secrets: readonly string[]): number =>
  secrets.filter((secret) => output.includes(secret)).length;

/**
 * The cleanup's commands (plan step 7), each `docker` argv: the project down with its volumes,
 * named with `-p`, and the tag's images removed. Refuses the developer's project and tag.
 */
export function cleanupCommands(project: string, tag: string, placeholderFile: string): string[][] {
  assertDisposable(project, tag);
  return [
    [
      'compose',
      '--env-file',
      placeholderFile,
      '-p',
      project,
      'down',
      '--volumes',
      '--remove-orphans',
      '--timeout',
      '15',
    ],
    ...BUILT_IMAGES.map((image) => ['image', 'rm', '--force', `shopfloor-twin/${image}:${tag}`]),
  ];
}

/**
 * The first of `roots` that `path` equals or lies inside (all absolute, links already resolved by
 * the caller), or undefined: the clone's base must be inside no checkout of the repository.
 */
export function baseInside(path: string, roots: readonly string[]): string | undefined {
  const clean = (p: string) => p.replace(/\/+$/, '');
  return roots.find((root) => {
    const r = clean(root);
    const p = clean(path);
    return p === r || p.startsWith(`${r}/`);
  });
}
