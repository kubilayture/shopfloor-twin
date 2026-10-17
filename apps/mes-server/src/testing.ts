import { sql, type QueryExecutorProvider } from 'kysely';
import { useDockerContext } from '@shopfloor/test-kit/docker';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/**
 * The test server's users: `user` is the image's bootstrap superuser (it creates databases and
 * runs the migrations, as the `migrate` step does), `appPassword` is what the migrations give
 * `mes_app`, the role the module code is handed (#169), so a missing grant fails a test.
 */
export const TEST_DB = {
  user: 'mes',
  password: 'mes-test',
  database: 'shopfloor',
  appUser: 'mes_app',
  appPassword: 'mes-app-test',
} as const;

/** The stack's TimescaleDB image in a throw-away container; `url` is the superuser's. */
export async function startDatabase(): Promise<{ url: string; container: StartedTestContainer }> {
  useDockerContext();
  const container = await new GenericContainer('timescale/timescaledb:2.30.2-pg18')
    .withEnvironment({
      POSTGRES_USER: TEST_DB.user,
      POSTGRES_PASSWORD: TEST_DB.password,
      POSTGRES_DB: TEST_DB.database,
      TS_TUNE_MEMORY: '256MB',
      TS_TUNE_NUM_CPUS: '2',
    })
    .withCommand(['postgres', '-c', 'timescaledb.telemetry_level=off'])
    .withExposedPorts(5432)
    // The image restarts PostgreSQL once after its init scripts.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  return {
    url: `postgres://${TEST_DB.user}:${TEST_DB.password}@${container.getHost()}:${String(container.getMappedPort(5432))}/${TEST_DB.database}`,
    container,
  };
}

/** The URL of `database` on the server of `serverUrl` (the superuser's), as the superuser. */
export function databaseUrl(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** The URL of `database` on the server of `serverUrl`, as `mes_app` (what the MES connects as). */
export function appUrl(serverUrl: string, database: string): string {
  const url = new URL(databaseUrl(serverUrl, database));
  url.username = TEST_DB.appUser;
  url.password = TEST_DB.appPassword;
  return url.toString();
}

/**
 * Waits until some other session is blocked by the backend `holder` (`pg_blocking_pids`), so a
 * test of a lock race knows the waiting write got that far, however long a loaded machine took
 * (#212), instead of sleeping a fixed time.
 */
export async function blockedBy(
  db: QueryExecutorProvider,
  holder: number,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; ;) {
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND pg_blocking_pids(pid) @> ARRAY[${holder}::int]`.execute(db);
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The backend pid of a connection or transaction (the `holder` of `blockedBy`). */
export async function backendPid(db: QueryExecutorProvider): Promise<number> {
  const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db);
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('no backend pid');
  return pid;
}
