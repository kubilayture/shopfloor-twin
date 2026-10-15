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

/**
 * The project's Mosquitto (same image, configuration, users and ACL as Compose) in a throw-away
 * container. Shared by the gateway's and the MES's tests.
 */
export async function startBroker(
  options: { readonly hostPort?: number } = {},
): Promise<{ url: string; container: StartedTestContainer }> {
  useDockerContext();
  const container = await new GenericContainer('eclipse-mosquitto:2.1.2-alpine')
    .withCopyDirectoriesToContainer([{ source: MOSQUITTO_CONFIG, target: '/mosquitto/config' }])
    .withEntrypoint(['/bin/sh', '/mosquitto/config/entrypoint.sh'])
    .withEnvironment({
      MQTT_USERS: Object.entries(TEST_PASSWORDS)
        .map(([user, password]) => `${user}:${password}`)
        .join(' '),
      MQTT_HEALTHCHECK_PASSWORD: TEST_PASSWORDS.healthcheck,
    })
    .withExposedPorts(options.hostPort ? { container: 1883, host: options.hostPort } : 1883)
    .withWaitStrategy(Wait.forLogMessage(/running/))
    .start();
  return {
    url: `mqtt://${container.getHost()}:${String(container.getMappedPort(1883))}`,
    container,
  };
}
