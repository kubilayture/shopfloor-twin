/**
 * The Compose stack of the reconciliation (#100): docker-compose.yml plus e2e/compose.reconcile.yml,
 * under its own project name and a generated env file with random passwords. Compose reads that
 * file instead of the repository's `.env`, so the run neither needs nor reads local secrets.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { establishWebTrust, type WebTrust } from '@shopfloor/test-kit/tls';

const run = promisify(execFile);

/** The images `docker-compose.yml` builds, one per application (the `migrate` step uses the MES's). */
export const STACK_IMAGES = ['simulator', 'edge-gateway', 'mes-server', 'erp-mock', 'web'] as const;

/**
 * Removes a run's images under its tag (#228: every run removes what it built, also on failure),
 * never the dev stack's tag `dev`. Images that don't exist are skipped.
 */
export async function removeImages(
  tag: string,
  images: readonly string[] = STACK_IMAGES,
): Promise<void> {
  if (tag === 'dev') {
    console.error("not removing the dev stack's images (tag dev)");
    return;
  }
  for (const image of images) {
    await run('docker', ['image', 'rm', '--force', `shopfloor-twin/${image}:${tag}`]).catch(
      (error: unknown) => {
        console.error(`could not remove shopfloor-twin/${image}:${tag}`, error);
      },
    );
  }
}

export const REPO = resolve(import.meta.dirname, '../..');

/**
 * Run inside the `pki` container (its image, its `pki-ca` volume): a one-day certificate of the
 * stack's dev CA for the web's names with a fresh key, printed as JSON (#241 review).
 */
const MINT_SIBLING = `
import { readFileSync } from 'node:fs';
import { certificateAuthorityFrom, issueTlsServerCertificate } from '/app/packages/pki/src/index.ts';
const ca = await certificateAuthorityFrom(
  readFileSync('/var/lib/pki/ca/ca.pem', 'utf8'),
  readFileSync('/var/lib/pki/ca/private/ca-key.pem', 'utf8'),
);
const minted = await issueTlsServerCertificate(ca, {
  commonName: 'shopfloor-twin web',
  dnsNames: ['localhost'],
  ipAddresses: ['127.0.0.1'],
  validityDays: 1,
  now: new Date(),
});
console.log(JSON.stringify(minted));
`;

export interface StackOptions {
  readonly project: string;
  /** Extra variables for the env file (seed, start, speed). */
  readonly env: Readonly<Record<string, string>>;
  /** More Compose files after e2e/compose.reconcile.yml, relative to the repository (#178). */
  readonly files?: readonly string[];
  /**
   * Compose profiles to enable on every command of the project (P9-18: `observability` for
   * Prometheus), so `down` also removes their containers and volumes.
   */
  readonly profiles?: readonly string[];
}

export class Stack {
  readonly project: string;
  readonly #env: Readonly<Record<string, string>>;
  readonly #files: readonly string[];
  readonly #profiles: readonly string[];
  #dir: string | undefined;
  #values: Readonly<Record<string, string>> | undefined;

  constructor({ project, env, files = [], profiles = [] }: StackOptions) {
    this.project = project;
    this.#env = env;
    this.#files = files;
    this.#profiles = profiles;
  }

  /** Writes the env file (mode 600, in a fresh temporary directory). */
  async prepare(): Promise<void> {
    this.#dir = await mkdtemp(join(tmpdir(), 'shopfloor-reconcile-'));
    const secret = () => randomBytes(16).toString('hex');
    const values: Record<string, string> = {
      DB_PASSWORD: secret(),
      DB_APP_PASSWORD: secret(),
      MQTT_HEALTHCHECK_PASSWORD: secret(),
      MQTT_DEV_PASSWORD: secret(),
      MQTT_GATEWAY_PASSWORD: secret(),
      MQTT_MES_PASSWORD: secret(),
      ERP_API_TOKEN: secret(),
      // The simulator's control token (#237): the run's clients send it; nginx injects it on /sim/.
      SIM_CONTROL_TOKEN: secret(),
      // The OPC UA users' passwords (#239): opcua-gateway (gateway and simulator) and opcua-reader.
      OPCUA_GATEWAY_PASSWORD: secret(),
      OPCUA_READER_PASSWORD: secret(),
      // The MES's first admin (#170): it must change this password at its first login.
      MES_BOOTSTRAP_ADMIN_PASSWORD: secret(),
      ...this.#env,
    };
    this.#values = values;
    const text = Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join('');
    await writeFile(join(this.#dir, 'reconcile.env'), text, { mode: 0o600 });
  }

  /** The generated bootstrap admin password of this run (after `prepare()`). */
  get bootstrapAdminPassword(): string {
    return this.value('MES_BOOTSTRAP_ADMIN_PASSWORD');
  }

  /** A value of this run's env file (after `prepare()`), e.g. the generated ERP_API_TOKEN. */
  value(key: string): string {
    const value = this.#values?.[key];
    if (value === undefined) throw new Error(`${key}: prepare() first, or no such variable`);
    return value;
  }

  /** Runs `docker compose …` for this project; resolves with stdout. */
  async compose(args: readonly string[], timeoutMs = 600_000): Promise<string> {
    if (this.#dir === undefined) throw new Error('prepare() first');
    const { stdout } = await run(
      'docker',
      [
        'compose',
        '--project-name',
        this.project,
        '--project-directory',
        REPO,
        '--env-file',
        join(this.#dir, 'reconcile.env'),
        '--file',
        join(REPO, 'docker-compose.yml'),
        '--file',
        join(REPO, 'e2e/compose.reconcile.yml'),
        ...this.#files.flatMap((file) => ['--file', join(REPO, file)]),
        ...this.#profiles.flatMap((profile) => ['--profile', profile]),
        ...args,
      ],
      { cwd: REPO, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs },
    );
    return stdout;
  }

  /** `http://127.0.0.1:<port>` of a service's published container port (ephemeral). */
  async url(service: string, port: number, scheme: 'http' | 'https' = 'http'): Promise<string> {
    const published = (await this.compose(['port', service, String(port)])).trim();
    const hostPort = /:(\d+)$/.exec(published)?.[1];
    if (hostPort === undefined) throw new Error(`${service}:${String(port)} is not published`);
    return `${scheme}://127.0.0.1:${hostPort}`;
  }

  /**
   * The web front (P9-14, ADR-0039): `https://127.0.0.1:<port>` of nginx's 8443, after checking
   * that it serves the certificate the pki step wrote and trusting the stack's dev CA in this
   * process. The result's `env` makes a child trust it too (NODE_EXTRA_CA_CERTS) and gives
   * Playwright's Chromium the SPKI pin of this certificate (never `ignoreHTTPSErrors`). With
   * `sibling`, also a certificate of the same dev CA for the same names but another key, minted
   * inside the one-shot `pki` container (the CA key never leaves its volume), in `sibling.pem` and
   * `sibling-key.pem` of the run's own directory named by RECONCILE_WEB_SIBLING: the browser must
   * refuse it too (#241 review; e2e/browser/tls).
   */
  async webTrust(options: { readonly sibling?: boolean } = {}): Promise<WebTrust> {
    const dir = this.#dir;
    if (dir === undefined) throw new Error('prepare() first');
    const read = (file: string) =>
      this.compose(['exec', '-T', 'web', 'cat', `/etc/nginx/tls/${file}`]);
    const trust = await establishWebTrust({
      url: await this.url('web', 8443, 'https'),
      caPem: await read('ca.pem'),
      serverPem: await read('server.pem'),
      dir,
    });
    if (options.sibling !== true) return trust;
    const out = await this.compose([
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'pki',
      'node',
      '--input-type=module',
      '-e',
      MINT_SIBLING,
    ]);
    const minted = JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as {
      certificatePem?: string;
      privateKeyPem?: string;
    };
    if (minted.certificatePem === undefined || minted.privateKeyPem === undefined) {
      throw new Error('could not mint a sibling web certificate in the pki container');
    }
    await writeFile(join(dir, 'sibling.pem'), minted.certificatePem, { mode: 0o600 });
    await writeFile(join(dir, 'sibling-key.pem'), minted.privateKeyPem, { mode: 0o600 });
    return { ...trust, env: { ...trust.env, RECONCILE_WEB_SIBLING: dir } };
  }

  /** Rows of a SQL query returning one JSON value, run in the `db` container. */
  async sqlJson<T>(query: string): Promise<T> {
    const out = await this.sql(query);
    return JSON.parse(out.trim() || 'null') as T;
  }

  /**
   * Runs SQL with psql in the `db` container (`ON_ERROR_STOP`): resolves with its output, or
   * rejects with an error whose message holds psql's (the server's `ERROR:` line).
   */
  async sql(query: string): Promise<string> {
    const user = this.#env.DB_USER ?? 'shopfloor';
    const db = this.#env.DB_NAME ?? 'shopfloor';
    return this.compose([
      'exec',
      '-T',
      'db',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      user,
      '-d',
      db,
      '-Atc',
      query,
    ]);
  }

  /** Stops the project, deletes its volumes and the env file. */
  async destroy(): Promise<void> {
    try {
      if (this.#dir !== undefined) {
        await this.compose(['down', '--volumes', '--remove-orphans', '--timeout', '15']);
      }
    } finally {
      if (this.#dir !== undefined) await rm(this.#dir, { recursive: true, force: true });
      this.#dir = undefined;
    }
  }
}
