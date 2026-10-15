import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

export const TEST_PASSWORDS = {
  healthcheck: 'test-healthcheck',
  dev: 'test-dev',
  'gw-01': 'test-gateway',
  mes: 'test-mes',
} as const;

const MOSQUITTO_CONFIG = resolve(import.meta.dirname, '../../../config/mosquitto');

/**
 * Testcontainers looks for Docker at the default socket. Docker Desktop alternatives such as Colima
 * use another one, so without DOCKER_HOST the active `docker context` decides, as for the CLI.
 */
function useDockerContext(): void {
  if (process.env.DOCKER_HOST) return;
  try {
    const host = execFileSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      {
        encoding: 'utf8',
      },
    ).trim();
    if (host.startsWith('unix://')) {
      process.env.DOCKER_HOST = host;
      // Inside the Docker VM the socket is at the usual place (needed by the Ryuk reaper).
      process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= '/var/run/docker.sock';
    }
  } catch {
    // No docker CLI: let Testcontainers try its defaults.
  }
}

/** The project's Mosquitto (same image, configuration, users and ACL as Compose) in a throw-away container. */
export async function startBroker(): Promise<{ url: string; container: StartedTestContainer }> {
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
    .withExposedPorts(1883)
    .withWaitStrategy(Wait.forLogMessage(/running/))
    .start();
  return {
    url: `mqtt://${container.getHost()}:${String(container.getMappedPort(1883))}`,
    container,
  };
}
