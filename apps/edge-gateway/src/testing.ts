import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export { TEST_PASSWORDS, freePort, startBroker } from '@shopfloor/test-kit/broker';

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

const GATEWAY_MAIN = resolve(import.meta.dirname, 'main.ts');

export interface RunningGateway {
  readonly http: string;
  /** SIGTERM and wait (graceful), or SIGKILL (a crash). */
  stop(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}

/** The gateway as its own process, as in production. */
export async function startGateway(env: Readonly<Record<string, string>>): Promise<RunningGateway> {
  const port = env.HTTP_PORT ?? '4900';
  const child = spawn(process.execPath, [GATEWAY_MAIN], {
    env: { ...process.env, LOG_LEVEL: 'warn', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => {
      resolveExit();
    });
  });
  const http = `http://127.0.0.1:${port}`;
  for (let deadline = Date.now() + 30_000; ;) {
    const live = await fetch(`${http}/health/live`).then(
      (r) => r.ok,
      () => false,
    );
    if (live) break;
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill('SIGKILL');
      throw new Error('gateway did not start');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    http,
    stop: async (signal = 'SIGTERM') => {
      if (child.exitCode === null) child.kill(signal);
      await exited;
    },
  };
}
