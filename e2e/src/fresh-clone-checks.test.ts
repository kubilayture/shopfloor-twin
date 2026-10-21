import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_SECRETS } from '../../scripts/required-secrets.ts';
import {
  PLACEHOLDER,
  assertDisposable,
  cleanupCommands,
  configProblems,
  disposableName,
  expectedPublished,
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
  type PsRow,
} from './fresh-clone-checks.ts';
import { REPO } from './stack.ts';

/** The fresh-clone test's checks (#277, P10-02; Phase 10 plan "The fresh-clone test"). */

const PORTS: HostPorts = {
  mqtt: 31001,
  simControl: 31002,
  opcuaBase: 21000,
  modbus: 31003,
  erp: 31004,
  web: 31005,
};
const PROJECT = 'fresh-0a1b2c3d';

describe('the README quick-start block', () => {
  it('is one line in the README: the init, then docker compose up -d --wait', () => {
    expect(quickStartLines(readFileSync(join(REPO, 'README.md'), 'utf8'))).toEqual([
      'sh scripts/stack-init.sh && docker compose up -d --wait',
    ]);
  });

  it('leaves out blank lines, comments, git clone and cd; refuses a missing or doubled block', () => {
    const block = (body: string) =>
      `x\n<!-- quick-start -->\n\n\`\`\`sh\n${body}\n\`\`\`\n\n<!-- quick-start -->\ny`;
    expect(
      quickStartLines(block('git clone https://example/x.git\ncd x\n\n# a comment\na && b\nc')),
    ).toEqual(['a && b', 'c']);
    expect(() => quickStartLines('no markers')).toThrow(/exactly two/);
    expect(() => quickStartLines(`${block('a')}\n<!-- quick-start -->`)).toThrow(/exactly two/);
    expect(() => quickStartLines('<!-- quick-start -->\ntext\n<!-- quick-start -->')).toThrow(
      /no fenced code block/,
    );
    expect(() => quickStartLines(block('cd x'))).toThrow(/no command/);
  });
});

describe('the isolation environment and the refusals', () => {
  it('names the project and tag fresh-<hex> and sets every host-port variable, five contiguous for OPC UA', () => {
    expect(disposableName('0a1b2c3d')).toBe(PROJECT);
    expect(() => disposableName('xyz')).toThrow();
    expect(isolationEnv(PROJECT, PROJECT, PORTS)).toEqual({
      COMPOSE_PROJECT_NAME: PROJECT,
      IMAGE_TAG: PROJECT,
      MQTT_PORT: '31001',
      SIM_CONTROL_PORT: '31002',
      SIM_OPCUA_HOST_PORTS: '21000-21004',
      SIM_MODBUS_HOST_PORT: '31003',
      ERP_HTTP_PORT: '31004',
      WEB_HTTPS_PORT: '31005',
    });
  });

  it('covers every host-port variable of docker-compose.yml', () => {
    const compose = readFileSync(join(REPO, 'docker-compose.yml'), 'utf8');
    const variables = [...compose.matchAll(/'127\.0\.0\.1:\$\{([A-Z_]+):-[^}]*\}:[\d-]+'/g)].map(
      (match) => match[1],
    );
    expect(variables.length).toBeGreaterThan(0);
    expect(compose.match(/'127\.0\.0\.1:/g)).toHaveLength(variables.length);
    const env = isolationEnv(PROJECT, PROJECT, PORTS);
    for (const variable of variables) expect(env, variable).toHaveProperty(String(variable));
  });

  it("refuses the developer's project shopfloor-twin and tag dev, and malformed names", () => {
    expect(() => {
      assertDisposable('shopfloor-twin', PROJECT);
    }).toThrow(/refusing Compose project/);
    expect(() => {
      assertDisposable(PROJECT, 'dev');
    }).toThrow(/refusing image tag/);
    expect(() => {
      assertDisposable('', PROJECT);
    }).toThrow();
    expect(() => {
      assertDisposable(PROJECT, '');
    }).toThrow();
    expect(() => isolationEnv('shopfloor-twin', PROJECT, PORTS)).toThrow();
    expect(() => {
      assertDisposable(PROJECT, PROJECT);
    }).not.toThrow();
  });

  it('cleans up with the project named by -p, its volumes, and only the tag’s images; refuses the developer’s', () => {
    const commands = cleanupCommands(PROJECT, PROJECT, '/tmp/x/placeholder.env');
    const [down, ...images] = commands;
    expect(down?.slice(0, 2)).toEqual(['compose', '--env-file']);
    expect(down?.[down.indexOf('-p') + 1]).toBe(PROJECT);
    expect(down?.indexOf('-p')).toBeLessThan(down?.indexOf('down') ?? -1);
    expect(down).toContain('--volumes');
    expect(images).toHaveLength(5);
    for (const image of images) {
      expect(image.slice(0, 3)).toEqual(['image', 'rm', '--force']);
      expect(image[3]).toMatch(new RegExp(`^shopfloor-twin/[a-z-]+:${PROJECT}$`));
    }
    expect(() => cleanupCommands('shopfloor-twin', PROJECT, '/x')).toThrow();
    expect(() => cleanupCommands(PROJECT, 'dev', '/x')).toThrow();
  });
});

describe('the placeholder env file and the resolution check', () => {
  const example = readFileSync(join(REPO, '.env.example'), 'utf8');

  it('has every key of .env.example, every password, token and required secret the placeholder', () => {
    const text = placeholderEnv(example);
    const keys = (source: string) =>
      [...source.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((match) => [match[1], match[2]] as const);
    const written = new Map(keys(text));
    for (const [key, value] of keys(example)) {
      expect(written.has(key), key).toBe(true);
      const secret = /_(PASSWORD|TOKEN)$/.test(String(key));
      expect(written.get(key), key).toBe(secret ? PLACEHOLDER : value);
    }
    for (const key of REQUIRED_SECRETS) expect(written.get(key), key).toBe(PLACEHOLDER);
    expect(text).not.toContain('change-me');
  });

  const config = (name: string, tag: string) => ({
    name,
    services: {
      db: { image: 'timescale/timescaledb:2.30.2-pg18' },
      simulator: { build: { context: '.' }, image: `shopfloor-twin/simulator:${tag}` },
      'opcua-tools': { image: `shopfloor-twin/simulator:${tag}` },
      web: { build: { context: '.' }, image: `shopfloor-twin/web:${tag}` },
    },
  });

  it('accepts the disposable project with every built image on its tag', () => {
    expect(configProblems(config(PROJECT, PROJECT), PROJECT, PROJECT)).toEqual([]);
  });

  it("refuses the file's own name, the dev tag, an untagged build and no services", () => {
    expect(configProblems(config('shopfloor-twin', PROJECT), PROJECT, PROJECT)).toEqual([
      `the project resolves to "shopfloor-twin", not ${PROJECT}`,
    ]);
    expect(configProblems(config(PROJECT, 'dev'), PROJECT, PROJECT)).toHaveLength(3);
    expect(
      configProblems(
        { name: PROJECT, services: { mes: { build: { context: '.' } } } },
        PROJECT,
        PROJECT,
      ),
    ).toEqual([`service mes uses image undefined, not one tagged ${PROJECT}`]);
    expect(configProblems({ name: PROJECT, services: {} }, PROJECT, PROJECT)).toEqual([
      'no service builds an image',
    ]);
    expect(configProblems(null, PROJECT, PROJECT)).toEqual(['the configuration is not an object']);
  });

  it('never runs interpolated config except with the placeholder env file (fresh-clone.ts)', () => {
    const source = readFileSync(join(REPO, 'e2e/src/fresh-clone.ts'), 'utf8');
    const configCalls = [...source.matchAll(/'config'/g)];
    expect(configCalls).toHaveLength(1);
    expect(source).toContain("['--env-file', placeholderFile, 'config', '--format', 'json']");
    // Every Compose call goes through compose() (the isolation environment) or the cleanup's
    // commands (which name the project with -p).
    // (`docker compose version` for the record touches no project.)
    expect([...source.matchAll(/\['compose', (?!'version')/g)]).toHaveLength(1);
    expect(source).toContain("return run('docker', ['compose', ...args], {");
    expect(source).toContain('env: { ...baseEnv(), ...isolation },');
  });
});

const row = (service: string, extra: Partial<PsRow> = {}): PsRow => ({
  Name: `${PROJECT}-${service}-1`,
  Service: service,
  Project: PROJECT,
  State: 'running',
  Health: 'healthy',
  ExitCode: 0,
  Labels: `com.docker.compose.service=${service},com.docker.compose.project=${PROJECT}`,
  ...extra,
});
const healthy = (): PsRow[] => [
  ...['db', 'broker', 'simulator', 'gateway', 'mes', 'erp', 'web'].map((s) => row(s)),
  row('pki', { State: 'exited', Health: '' }),
  row('migrate', { State: 'exited', Health: '' }),
];

describe('the containers after up', () => {
  it('parses docker compose ps as an array or as one object per line', () => {
    const rows = healthy();
    expect(parsePs(JSON.stringify(rows))).toEqual(rows);
    expect(parsePs(rows.map((r) => JSON.stringify(r)).join('\n'))).toEqual(rows);
    expect(parsePs('\n')).toEqual([]);
  });

  it('finds containers of another project by their label', () => {
    expect(foreignRows(healthy(), PROJECT)).toEqual([]);
    const theirs = row('db', {
      Name: 'shopfloor-twin-db-1',
      Project: 'shopfloor-twin',
      Labels: 'com.docker.compose.project=shopfloor-twin',
    });
    expect(foreignRows([...healthy(), theirs], PROJECT)).toEqual([
      'shopfloor-twin-db-1 (label shopfloor-twin)',
    ]);
    expect(foreignRows([row('db', { Labels: '' })], PROJECT)).toHaveLength(1);
  });

  it('wants every long-running service healthy, pki and migrate exited 0, opcua-tools absent', () => {
    expect(serviceProblems(healthy())).toEqual([]);
    const rows = healthy().map((r) =>
      r.Service === 'mes'
        ? { ...r, Health: 'starting' }
        : r.Service === 'migrate'
          ? { ...r, ExitCode: 1 }
          : r,
    );
    expect(serviceProblems(rows)).toEqual([
      'mes: running starting',
      'migrate: exited (exit 1), not exited 0',
    ]);
    expect(serviceProblems([...healthy(), row('opcua-tools')])).toEqual([
      'opcua-tools was started (profile tools)',
    ]);
    expect(serviceProblems(healthy().filter((r) => r.Service !== 'erp'))).toEqual([
      'erp: 0 containers, not 1',
    ]);
  });

  const published = (ports: HostPorts): PsRow[] => {
    const rows = healthy();
    const byService = new Map<
      string,
      { URL: string; TargetPort: number; PublishedPort: number }[]
    >();
    for (const [key, host] of expectedPublished(ports)) {
      const [service, target] = key.split(':');
      const list = byService.get(String(service)) ?? [];
      list.push({ URL: '127.0.0.1', TargetPort: Number(target), PublishedPort: host });
      byService.set(String(service), list);
    }
    return rows.map((r) => ({
      ...r,
      Publishers: [
        ...(byService.get(r.Service ?? '') ?? []),
        // Exposed, not published: ignored.
        { URL: '', TargetPort: 9999, PublishedPort: 0 },
      ],
    }));
  };

  it('wants exactly the S8 ports, each on 127.0.0.1 at the chosen host port', () => {
    expect(expectedPublished(PORTS).size).toBe(10);
    expect(portProblems(published(PORTS), PORTS)).toEqual([]);
  });

  it('refuses a missing, extra, moved or wildcard-bound port, and a published MES, gateway or database', () => {
    const rows = published(PORTS);
    const without = rows.map((r) => (r.Service === 'erp' ? { ...r, Publishers: [] } : r));
    expect(portProblems(without, PORTS)).toEqual(['erp:4600 is not published']);
    const extra = rows.map((r) =>
      r.Service === 'mes'
        ? { ...r, Publishers: [{ URL: '127.0.0.1', TargetPort: 4700, PublishedPort: 4700 }] }
        : r,
    );
    expect(portProblems(extra, PORTS)).toEqual([
      'published outside the S8 set: mes:4700 at 127.0.0.1:4700',
      'mes:4700 is published',
    ]);
    const defaults = rows.map((r) =>
      r.Service === 'web'
        ? { ...r, Publishers: [{ URL: '127.0.0.1', TargetPort: 8443, PublishedPort: 8443 }] }
        : r,
    );
    expect(portProblems(defaults, PORTS)).toEqual([
      'web:8443 at 127.0.0.1:8443, not 127.0.0.1:31005',
    ]);
    const wildcard = rows.map((r) =>
      r.Service === 'broker'
        ? { ...r, Publishers: [{ URL: '0.0.0.0', TargetPort: 1883, PublishedPort: 31001 }] }
        : r,
    );
    expect(portProblems(wildcard, PORTS)).toEqual([
      'broker:1883 at 0.0.0.0:31001, not 127.0.0.1:31001',
    ]);
  });
});

describe('the Node-free PATH', () => {
  const script = readFileSync(join(REPO, 'scripts/stack-init.sh'), 'utf8');

  it("links sh, git, docker, the init's utilities and optional tools, and the configured credential helpers", () => {
    expect(nodeFreeTools(script, {})).toEqual({
      required: ['sh', 'git', 'docker', 'od', 'tr'],
      optional: ['openssl'],
    });
    expect(
      nodeFreeTools(script, {
        credsStore: 'osxkeychain',
        credHelpers: { 'ghcr.io': 'gh', x: 'osxkeychain' },
      }).required,
    ).toEqual([
      'sh',
      'git',
      'docker',
      'od',
      'tr',
      'docker-credential-osxkeychain',
      'docker-credential-gh',
    ]);
    expect(() => nodeFreeTools('#!/bin/sh\n', {})).toThrow(/no utilities/);
  });

  it('lists every external command the init calls in its header', () => {
    const body = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    const { required, optional } = nodeFreeTools(script, {});
    for (const tool of ['od', 'tr', 'openssl']) expect(body).toContain(`${tool} `);
    // No other common external utility is used (each would be missing on the Node-free PATH).
    for (const tool of [
      'sed',
      'awk',
      'grep',
      'cut',
      'head',
      'tail',
      'cat',
      'mktemp',
      'mv',
      'cp',
      'chmod',
      'date',
    ]) {
      expect(body, tool).not.toMatch(new RegExp(`(^|[\\s|;&(\`$])${tool}\\s`, 'm'));
    }
    expect([...required, ...optional]).toContain('od');
  });
});

describe('checklist S7 in the output', () => {
  it("takes every password's and token's value of 12 characters or more, without quotes", () => {
    const text = [
      'DB_PASSWORD=0123456789abcdef',
      'ERP_API_TOKEN="quoted-value-123"',
      "MQTT_DEV_PASSWORD='single-quoted-1'",
      'SHORT_TOKEN=short',
      'DB_NAME=shopfloor',
      '# OTHER_PASSWORD=commented-out-value',
    ].join('\n');
    expect(secretValues(text)).toEqual(['0123456789abcdef', 'quoted-value-123', 'single-quoted-1']);
  });

  it('counts the secrets that appear, never naming them', () => {
    expect(
      leakedCount('a log with 0123456789abcdef in it', ['0123456789abcdef', 'zzzzzzzzzzzzzz']),
    ).toBe(1);
    expect(leakedCount('clean', ['0123456789abcdef'])).toBe(0);
  });
});

describe("the clone's smoke under the isolation environment", () => {
  it("keeps the project, tag and host ports given in the environment over its env file's", () => {
    const smoke = readFileSync(join(REPO, 'scripts/stack-smoke.sh'), 'utf8');
    const start = smoke.indexOf('env_file=${SMOKE_ENV_FILE');
    const end = smoke.indexOf('\ndone\n', smoke.indexOf('set +a', start)) + '\ndone\n'.length;
    expect(start).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), 'smoke-env-'));
    try {
      const envFile = join(dir, 'smoke.env');
      writeFileSync(
        envFile,
        'MQTT_PORT=1883\nWEB_HTTPS_PORT=8443\nSIM_OPCUA_HOST_PORTS=4841-4845\nDB_NAME=shopfloor\n',
      );
      const print =
        'printf \'%s|%s|%s|%s|%s|%s\\n\' "$MQTT_PORT" "$WEB_HTTPS_PORT" "$SIM_OPCUA_HOST_PORTS" "$DB_NAME" "$COMPOSE_PROJECT_NAME" "${IMAGE_TAG-unset}"';
      const result = spawnSync(
        '/bin/sh',
        ['-c', `set -eu\n${smoke.slice(start, end)}\n${print}\n`],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '',
            SMOKE_ENV_FILE: envFile,
            MQTT_PORT: '31001',
            SIM_OPCUA_HOST_PORTS: '21000-21004',
            COMPOSE_PROJECT_NAME: PROJECT,
          },
        },
      );
      expect(result.stderr).toBe('');
      // Given: kept; not given: the file's; IMAGE_TAG neither given nor in the file: unset.
      expect(result.stdout.trim()).toBe(`31001|8443|21000-21004|shopfloor|${PROJECT}|unset`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
