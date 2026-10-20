import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REPO } from './stack.ts';

/**
 * The hardened Compose and the HTTPS front, read from the files (P9-14, ADR-0039, security checklist
 * S4 and S8): what `docker compose up` publishes, what the dev override adds, and the nginx and
 * Playwright settings the harnesses' trust depends on. The stack smoke checks the same on a
 * running stack.
 */

interface Service {
  readonly image?: string;
  readonly profiles?: readonly string[];
  readonly command?: readonly string[];
  readonly tmpfs?: readonly string[];
  readonly networks?: Readonly<Record<string, unknown>>;
  readonly deploy?: { readonly resources?: { readonly limits?: Record<string, string> } };
  readonly ports?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly volumes?: readonly string[];
  readonly depends_on?: Readonly<Record<string, { condition: string }>>;
  readonly group_add?: readonly string[];
}

/** A Compose file's services; Compose's merge tags (`!reset`, `!override`) read as plain values. */
async function services(file: string): Promise<Record<string, Service>> {
  const text = await readFile(join(REPO, file), 'utf8');
  const document = parse(text.replaceAll(/!(reset|override)\b/g, '')) as {
    services: Record<string, Service>;
  };
  return document.services;
}

/** `host ip:host port:container port` (a range on both sides allowed) → the container ports. */
function published(
  ports: readonly string[] | undefined,
): { ip: string; host: string; port: number }[] {
  return (ports ?? []).flatMap((entry) => {
    const match = /^(?<ip>[\d.]+):(?<host>.*):(?<from>\d+)(?:-(?<to>\d+))?$/.exec(entry);
    if (!match?.groups) throw new Error(`unexpected port syntax: ${entry}`);
    const { ip = '', host = '', from = '0', to } = match.groups;
    const first = Number(from);
    const last = to === undefined ? first : Number(to);
    return Array.from({ length: last - first + 1 }, (_, n) => ({ ip, host, port: first + n }));
  });
}

const portsOf = (all: Record<string, Service>) =>
  Object.fromEntries(
    Object.entries(all)
      .map(([name, service]) => [name, published(service.ports).map((p) => p.port)] as const)
      .filter(([, ports]) => ports.length > 0),
  );

describe('the hardened Compose (P9-14, checklist S8)', () => {
  it('publishes exactly the S8 list on 127.0.0.1: web 8443, broker 1883, control API, OPC UA, Modbus, ERP', async () => {
    const all = await services('docker-compose.yml');
    expect(portsOf(all)).toEqual({
      broker: [1883],
      simulator: [4800, 4841, 4842, 4843, 4844, 4845, 5020],
      erp: [4600],
      web: [8443],
    });
    for (const service of Object.values(all)) {
      for (const port of published(service.ports)) expect(port.ip).toBe('127.0.0.1');
    }
    // No 4700, 4900 or 5442 (nor the web's old 8080) on the host.
    for (const name of ['mes', 'gateway', 'db']) expect(all[name]?.ports).toBeUndefined();
    expect(published(all.web?.ports)).toEqual([
      { ip: '127.0.0.1', host: '${WEB_HTTPS_PORT:-8443}', port: 8443 },
    ]);
  });

  it('republishes the MES, the gateway and the database for development only (compose.dev-ports.yml)', async () => {
    const dev = await services('compose.dev-ports.yml');
    expect(Object.keys(dev).sort()).toEqual(['db', 'gateway', 'mes']);
    expect(
      Object.fromEntries(Object.entries(dev).map(([n, s]) => [n, published(s.ports)])),
    ).toEqual({
      db: [{ ip: '127.0.0.1', host: '${DB_PORT:-5442}', port: 5432 }],
      gateway: [{ ip: '127.0.0.1', host: '${GATEWAY_HTTP_PORT:-4900}', port: 4900 }],
      mes: [{ ip: '127.0.0.1', host: '${MES_HTTP_PORT:-4700}', port: 4700 }],
    });
    const scripts = (
      JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['stack:up']).toBe('docker compose up -d --wait');
    expect(scripts['stack:up:dev']).toBe(
      'docker compose --file docker-compose.yml --file compose.dev-ports.yml up -d --wait',
    );
  });

  it("keeps the gate smoke's override hardened: nothing of the MES, gateway or database published", async () => {
    const smoke = await services('e2e/compose.ephemeral-ports.yml');
    expect(portsOf(smoke)).toEqual({ simulator: [4800], erp: [4600], web: [8443] });
    for (const port of published(smoke.web?.ports)) expect(port).toMatchObject({ host: '' });
  });

  it("makes the cookie Secure by default and gives the web the pki step's certificate, read-only", async () => {
    const all = await services('docker-compose.yml');
    expect(all.mes?.environment?.MES_COOKIE_SECURE).toBe('${MES_COOKIE_SECURE:-on}');
    expect(all.web?.volumes).toEqual(['web-tls:/etc/nginx/tls:ro']);
    expect(all.web?.depends_on?.pki).toEqual({ condition: 'service_completed_successfully' });
    expect(all.pki?.volumes).toEqual(
      expect.arrayContaining(['pki-ca:/var/lib/pki/ca', 'web-tls:/var/lib/pki/web']),
    );
    expect(all.pki?.group_add).toEqual(['101']);
    // The dev CA's key: in pki-ca, which only the one-shot pki step mounts.
    const mounting = Object.entries(all)
      .filter(([, s]) => (s.volumes ?? []).some((v) => v.startsWith('pki-ca:')))
      .map(([name]) => name);
    expect(mounting).toEqual(['pki']);
  });

  it('limits every service, mounts no Docker socket and runs the images of the repository as node (#242)', async () => {
    const all = await services('docker-compose.yml');
    for (const [name, service] of Object.entries(all)) {
      // Resource limits on every service, the database and the broker included (P9-01).
      const limits = (
        service as { deploy?: { resources?: { limits?: { cpus?: string; memory?: string } } } }
      ).deploy?.resources?.limits;
      expect(limits?.cpus, name).toMatch(/^\d+(\.\d+)?$/);
      expect(limits?.memory, name).toMatch(/^\d+[MG]$/);
      // No Docker socket, no privileged mode, no host network or PID namespace.
      expect(JSON.stringify(service.volumes ?? []), name).not.toMatch(/docker\.sock/);
      const raw = service as { privileged?: boolean; network_mode?: string; pid?: string };
      expect(raw.privileged, name).toBeUndefined();
      expect(raw.network_mode, name).toBeUndefined();
      expect(raw.pid, name).toBeUndefined();
    }
    // The four Node images switch to `node` before their command; the web is nginx-unprivileged.
    for (const app of ['simulator', 'edge-gateway', 'mes-server', 'erp-mock']) {
      const dockerfile = await readFile(join(REPO, `apps/${app}/Dockerfile`), 'utf8');
      const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
      expect(users.at(-1), app).toBe('node');
    }
    const web = await readFile(join(REPO, 'apps/web/Dockerfile'), 'utf8');
    expect(web).toMatch(/^FROM\s+\S*nginx-unprivileged\S*/m);
  });
});

describe('the observability profile (P9-17, compose.observability.yml)', () => {
  it('is opt-in: the default stack has neither service nor a variable of it; Grafana has a profile of its own', async () => {
    const all = await services('docker-compose.yml');
    expect(Object.keys(all)).not.toContain('prometheus');
    expect(Object.keys(all)).not.toContain('grafana');
    const text = await readFile(join(REPO, 'docker-compose.yml'), 'utf8');
    expect(text).not.toMatch(/GRAFANA|PROMETHEUS/);
    const observability = await services('compose.observability.yml');
    expect(Object.keys(observability).sort()).toEqual(['grafana', 'prometheus']);
    // Prometheus alone for the performance suite (P9-18): Grafana's memory stays out of T5.
    expect(observability.prometheus?.profiles).toEqual(['observability']);
    expect(observability.grafana?.profiles).toEqual(['grafana']);
    const scripts = (
      JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    const files =
      'docker compose --file docker-compose.yml --file compose.observability.yml --profile observability --profile grafana';
    expect(scripts['stack:up:observability']).toBe(`${files} up -d --wait`);
    expect(scripts['stack:down:observability']).toBe(`${files} down`);
    expect(scripts['stack:reset:observability']).toBe(`${files} down --volumes`);
  });

  it('pins both images, limits both and publishes them on 127.0.0.1 only', async () => {
    const observability = await services('compose.observability.yml');
    for (const [name, service] of Object.entries(observability)) {
      expect(service.image, name).toMatch(/:v?\d+\.\d+\.\d+(-[a-z]+)?$/);
      expect(service.deploy?.resources?.limits, name).toEqual({
        cpus: expect.any(String) as string,
        memory: expect.any(String) as string,
      });
    }
    expect(
      Object.fromEntries(
        Object.entries(observability).map(([name, s]) => [name, published(s.ports)]),
      ),
    ).toEqual({
      prometheus: [{ ip: '127.0.0.1', host: '${PROMETHEUS_PORT:-9090}', port: 9090 }],
      grafana: [{ ip: '127.0.0.1', host: '${GRAFANA_PORT:-3000}', port: 3000 }],
    });
  });

  it('has no default credentials: the Grafana admin password is required, no anonymous access', async () => {
    const grafana = (await services('compose.observability.yml')).grafana;
    expect(grafana?.environment?.GF_SECURITY_ADMIN_PASSWORD).toMatch(
      /^\$\{GRAFANA_ADMIN_PASSWORD:\?[^}]+\}$/,
    );
    expect(grafana?.environment).toMatchObject({
      GF_AUTH_ANONYMOUS_ENABLED: 'false',
      GF_USERS_ALLOW_SIGN_UP: 'false',
    });
    const example = await readFile(join(REPO, '.env.example'), 'utf8');
    expect(example).toMatch(/^GRAFANA_ADMIN_PASSWORD=$/m);
  });

  it('hardens Grafana (#244 review): no plugin installs, nothing published or sent out, its proxy to Prometheus only, state on a tmpfs', async () => {
    const grafana = (await services('compose.observability.yml')).grafana;
    expect(grafana?.environment).toMatchObject({
      GF_PLUGINS_PREINSTALL_DISABLED: 'true',
      GF_PLUGINS_PLUGIN_ADMIN_ENABLED: 'false',
      GF_PLUGINS_PUBLIC_KEY_RETRIEVAL_DISABLED: 'true',
      GF_SNAPSHOTS_EXTERNAL_ENABLED: 'false',
      GF_PUBLIC_DASHBOARDS_ENABLED: 'false',
      GF_SECURITY_DATA_SOURCE_PROXY_WHITELIST: 'prometheus:9090',
      GF_UNIFIED_ALERTING_ENABLED: 'false',
      GF_METRICS_ENABLED: 'false',
      GF_ANALYTICS_REPORTING_ENABLED: 'false',
      GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
      GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: 'false',
    });
    expect(grafana?.tmpfs).toEqual([expect.stringMatching(/^\/var\/lib\/grafana:uid=472,/)]);
    expect(grafana?.volumes).toEqual([
      './config/grafana/provisioning:/etc/grafana/provisioning:ro',
    ]);
  });

  it('gives Prometheus no CORS origin: its regex matches no character', async () => {
    const command = (await services('compose.observability.yml')).prometheus?.command ?? [];
    const cors = command.filter((flag) => flag.startsWith('--web.cors.origin='));
    expect(cors).toHaveLength(1);
    const pattern = new RegExp(`^(?:${cors[0]?.slice('--web.cors.origin='.length) ?? '.*'})$`);
    for (const origin of ['', 'null', 'http://localhost:9090', 'https://attacker.example']) {
      expect(pattern.test(origin), origin).toBe(false);
    }
    expect(command.some((flag) => /enable-(admin-api|lifecycle)/.test(flag))).toBe(false);
  });

  it('keeps Grafana off the plant networks and Prometheus off edge (the MES trusts edge only)', async () => {
    const observability = await services('compose.observability.yml');
    expect(Object.keys(observability.grafana?.networks ?? {})).toEqual(['observability']);
    expect(Object.keys(observability.prometheus?.networks ?? {}).sort()).toEqual([
      'default',
      'observability',
    ]);
  });

  it('scrapes every component by service name inside the network, never a host port', async () => {
    const config = parse(
      await readFile(join(REPO, 'config/prometheus/prometheus.yml'), 'utf8'),
    ) as {
      scrape_configs: { job_name: string; static_configs: { targets: string[] }[] }[];
    };
    const targets = Object.fromEntries(
      config.scrape_configs.map((job) => [
        job.job_name,
        job.static_configs.flatMap((c) => c.targets),
      ]),
    );
    expect(targets).toEqual({
      prometheus: ['localhost:9090'],
      mes: ['mes:4700'],
      gateway: ['gateway:4900'],
      simulator: ['simulator:4800'],
      erp: ['erp:4600'],
    });
    // Each a service of the default network in docker-compose.yml.
    const all = await services('docker-compose.yml');
    for (const name of ['mes', 'gateway', 'simulator', 'erp']) {
      expect(all[name], name).toBeDefined();
      const networks = Object.keys(all[name]?.networks ?? { default: {} });
      expect(networks, name).toContain('default');
    }
  });
});

describe('the HTTPS front (P9-14, checklist S4)', () => {
  it('listens on 8443 with TLS only, TLS 1.3, no redirect and no HSTS', async () => {
    const dir = join(REPO, 'apps/web/nginx');
    const template = await readFile(join(dir, 'default.conf.template'), 'utf8');
    const directives = template
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter((line) => line !== '');
    expect(directives.filter((line) => line.startsWith('listen '))).toEqual(['listen 8443 ssl;']);
    expect(directives).toContain('ssl_protocols TLSv1.3;');
    expect(directives).toContain('ssl_session_tickets off;');
    expect(directives.filter((line) => /^return\s+30\d|^error_page\s+497/.test(line))).toEqual([]);
    for (const file of await readdir(dir)) {
      const text = (await readFile(join(dir, file), 'utf8'))
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      expect(text, file).not.toMatch(/strict-transport-security/i);
    }
  });

  it('never lets Playwright accept any certificate: the Chromium SPKI pin, not ignoreHTTPSErrors', async () => {
    const config = await readFile(join(REPO, 'e2e/playwright.config.ts'), 'utf8');
    expect(config).toContain('chromiumSpkiArgument(spki)');
    const files = [
      'e2e/playwright.config.ts',
      ...(await readdir(join(REPO, 'e2e/browser'), { recursive: true }))
        .filter((file) => file.endsWith('.ts'))
        .map((file) => join('e2e/browser', file)),
    ];
    for (const file of files) {
      const code = (await readFile(join(REPO, file), 'utf8'))
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/)/.test(line))
        .join('\n');
      expect(code, file).not.toMatch(/ignoreHTTPSErrors|ignore-certificate-errors(?!-spki-list)/);
    }
  });
});
