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

const run = promisify(execFile);

export const REPO = resolve(import.meta.dirname, '../..');

export interface StackOptions {
  readonly project: string;
  /** Extra variables for the env file (seed, start, speed). */
  readonly env: Readonly<Record<string, string>>;
}

export class Stack {
  readonly project: string;
  readonly #env: Readonly<Record<string, string>>;
  #dir: string | undefined;

  constructor({ project, env }: StackOptions) {
    this.project = project;
    this.#env = env;
  }

  /** Writes the env file (mode 600, in a fresh temporary directory). */
  async prepare(): Promise<void> {
    this.#dir = await mkdtemp(join(tmpdir(), 'shopfloor-reconcile-'));
    const secret = () => randomBytes(16).toString('hex');
    const values: Record<string, string> = {
      DB_PASSWORD: secret(),
      MQTT_HEALTHCHECK_PASSWORD: secret(),
      MQTT_DEV_PASSWORD: secret(),
      MQTT_GATEWAY_PASSWORD: secret(),
      MQTT_MES_PASSWORD: secret(),
      ...this.#env,
    };
    const text = Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join('');
    await writeFile(join(this.#dir, 'reconcile.env'), text, { mode: 0o600 });
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
        ...args,
      ],
      { cwd: REPO, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs },
    );
    return stdout;
  }

  /** `http://127.0.0.1:<port>` of a service's published container port (ephemeral). */
  async url(service: string, port: number): Promise<string> {
    const published = (await this.compose(['port', service, String(port)])).trim();
    const hostPort = /:(\d+)$/.exec(published)?.[1];
    if (hostPort === undefined) throw new Error(`${service}:${String(port)} is not published`);
    return `http://127.0.0.1:${hostPort}`;
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
