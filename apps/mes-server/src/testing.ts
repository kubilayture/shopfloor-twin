import { useDockerContext } from '@shopfloor/test-kit/docker';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

export const TEST_DB = { user: 'mes', password: 'mes-test', database: 'shopfloor' } as const;

/** The stack's TimescaleDB image in a throw-away container. */
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
