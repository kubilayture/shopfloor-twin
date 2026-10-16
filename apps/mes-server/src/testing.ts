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
