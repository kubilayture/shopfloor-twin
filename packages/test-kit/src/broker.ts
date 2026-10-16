import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { useDockerContext } from './docker.ts';

/** Passwords of the broker users in test brokers (never the ones in `.env`). */
export const TEST_PASSWORDS = {
  healthcheck: 'test-healthcheck',
  dev: 'test-dev',
  'gw-01': 'test-gateway',
  mes: 'test-mes',
} as const;

const MOSQUITTO_CONFIG = resolve(import.meta.dirname, '../../../config/mosquitto');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A host port that is free right now: the OS picks one (bind to port 0), we read it back and
 * close. Chosen at runtime, so parallel runs (two worktrees, say) do not clash on a fixed port.
 */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        if (port > 0) resolvePort(port);
        else reject(new Error('the OS did not report a free port'));
      });
    });
  });
}

/**
 * The project's Mosquitto (same image, configuration, users and ACL as Compose) in a throw-away
 * container. Shared by the gateway's and the MES's tests.
 *
 * With a fixed `hostPort` (a broker restarted where its clients left it), a failed start is
 * retried (`attempts`, default 5, a second apart): the port of a just-stopped container can take
 * a moment to be released.
 */
export async function startBroker(
  options: { readonly hostPort?: number; readonly attempts?: number } = {},
): Promise<{ url: string; container: StartedTestContainer }> {
  useDockerContext();
  const attempts = options.hostPort ? (options.attempts ?? 5) : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      const container = await brokerContainer(options.hostPort).start();
      return {
        url: `mqtt://${container.getHost()}:${String(container.getMappedPort(1883))}`,
        container,
      };
    } catch (error) {
      if (attempt >= attempts) {
        const where = options.hostPort ? ` on host port ${String(options.hostPort)}` : '';
        throw new Error(`broker did not start${where} after ${String(attempt)} attempt(s)`, {
          cause: error,
        });
      }
      await wait(1_000);
    }
  }
}

function brokerContainer(hostPort: number | undefined): GenericContainer {
  return new GenericContainer('eclipse-mosquitto:2.1.2-alpine')
    .withCopyDirectoriesToContainer([{ source: MOSQUITTO_CONFIG, target: '/mosquitto/config' }])
    .withEntrypoint(['/bin/sh', '/mosquitto/config/entrypoint.sh'])
    .withEnvironment({
      MQTT_USERS: Object.entries(TEST_PASSWORDS)
        .map(([user, password]) => `${user}:${password}`)
        .join(' '),
      MQTT_HEALTHCHECK_PASSWORD: TEST_PASSWORDS.healthcheck,
    })
    .withExposedPorts(hostPort ? { container: 1883, host: hostPort } : 1883)
    .withWaitStrategy(Wait.forLogMessage(/running/));
}
