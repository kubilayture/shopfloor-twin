import { execFileSync, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
    if (host.startsWith('unix://') && host !== 'unix:///var/run/docker.sock') {
      process.env.DOCKER_HOST = host;
      // A VM-based runtime (Colima, Docker Desktop) has the usual socket inside the VM, which the
      // Ryuk reaper mounts. Rootless Docker (/run/user/…) is left to Testcontainers' own detection.
      if (!host.startsWith('unix:///run/user/')) {
        process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= '/var/run/docker.sock';
      }
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

export interface RunningSimulator {
  readonly control: string;
  readonly opcuaOffset: number;
  readonly modbusPort: number;
  /** Plant events from the control WebSocket (`sim-event/1`), the ground truth. */
  readonly events: SimEvent[];
  post(path: string, body?: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

export interface SimEvent {
  readonly type: string;
  readonly seq: number;
  readonly at: string;
  readonly machineId?: string;
  readonly [key: string]: unknown;
}

const SIMULATOR_MAIN = resolve(import.meta.dirname, '../../simulator/src/main.ts');

/**
 * The real simulator as a child process (apps may not import each other, plan section 8), started
 * idle, with its event stream already subscribed.
 */
export async function startSimulator(ports: {
  readonly opcuaOffset: number;
  readonly modbusPort: number;
  readonly controlPort: number;
}): Promise<RunningSimulator> {
  const control = `http://127.0.0.1:${String(ports.controlPort)}`;
  // A fresh certificate store each run: a store left locked by a killed run would hang the start.
  const pki = join(tmpdir(), `shopfloor-twin-gw-test-pki-${String(ports.opcuaOffset)}`);
  rmSync(pki, { recursive: true, force: true });
  const child = spawn(process.execPath, [SIMULATOR_MAIN], {
    env: {
      ...process.env,
      SIM_AUTOSTART: 'false',
      SIM_SPEED: '60',
      OPCUA_PORT_OFFSET: String(ports.opcuaOffset),
      OPCUA_PKI_DIR: pki,
      MODBUS_PORT: String(ports.modbusPort),
      CONTROL_PORT: String(ports.controlPort),
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => {
      resolveExit();
    });
  });
  for (let deadline = Date.now() + 60_000; ;) {
    const ready = await fetch(`${control}/health/ready`).then(
      (r) => r.ok,
      () => false,
    );
    if (ready) break;
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill('SIGKILL');
      throw new Error('simulator did not become ready');
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const events: SimEvent[] = [];
  const socket = new WebSocket(`${control.replace('http', 'ws')}/api/v1/events`);
  socket.addEventListener('message', (message: MessageEvent) => {
    events.push(JSON.parse(String(message.data)) as SimEvent);
  });
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen);
    socket.addEventListener('error', reject);
  });
  return {
    control,
    opcuaOffset: ports.opcuaOffset,
    modbusPort: ports.modbusPort,
    events,
    post: async (path, body) => {
      const response = await fetch(`${control}${path}`, {
        method: path.endsWith('/speed') ? 'PUT' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return response.json();
    },
    stop: async () => {
      socket.close();
      child.kill('SIGTERM');
      await exited;
    },
  };
}
