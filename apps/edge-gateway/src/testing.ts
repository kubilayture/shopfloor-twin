import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
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
export async function startSimulator(
  ports: {
    readonly opcuaOffset: number;
    readonly modbusPort: number;
    readonly controlPort: number;
  },
  /** Extra environment, e.g. `{ SIM_PRODUCTION: 'orders' }` (#173). */
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<RunningSimulator> {
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
      ...extraEnv,
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

/**
 * A TCP proxy between a client and a server (#173), to cut a connection or hold a server's answers
 * mid-call. In `hold`, bytes from the server are kept (the client's requests still reach it), so a
 * call can execute on the device while its answer never reaches the client in time; `release`
 * delivers them late, in order. `cut` destroys every connection; `down` also refuses new ones.
 */
export class TcpProxy {
  readonly port: number;
  readonly #server: Server;
  readonly #pairs = new Set<{ client: Socket; upstream: Socket; held: Buffer[] }>();
  #holding = false;
  #down = false;

  private constructor(server: Server, port: number) {
    this.#server = server;
    this.port = port;
  }

  static async start(
    listenPort: number,
    target: { readonly host: string; readonly port: number },
  ): Promise<TcpProxy> {
    const server = createServer();
    const proxy = new TcpProxy(server, listenPort);
    server.on('connection', (client) => {
      proxy.#accept(client, target);
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(listenPort, () => {
        resolveListen();
      });
    });
    return proxy;
  }

  /** Keep the server's bytes from now on. */
  hold(): void {
    this.#holding = true;
  }

  /** Deliver what was held, in order, and pass everything again. */
  release(): void {
    this.#holding = false;
    for (const pair of this.#pairs) {
      for (const chunk of pair.held.splice(0)) pair.client.write(chunk);
    }
  }

  /** Destroys every open connection (held bytes are lost); new connections pass. */
  cut(): void {
    this.#holding = false;
    for (const pair of this.#pairs) {
      pair.held.length = 0;
      pair.client.destroy();
      pair.upstream.destroy();
    }
    this.#pairs.clear();
  }

  /** Down: cut and refuse new connections; up: accept them again. */
  setDown(down: boolean): void {
    this.#down = down;
    if (down) this.cut();
  }

  async close(): Promise<void> {
    this.cut();
    await new Promise<void>((resolveClose) => {
      this.#server.close(() => {
        resolveClose();
      });
    });
  }

  #accept(client: Socket, target: { readonly host: string; readonly port: number }): void {
    if (this.#down) {
      client.destroy();
      return;
    }
    const upstream = connect(target.port, target.host);
    const pair = { client, upstream, held: [] as Buffer[] };
    this.#pairs.add(pair);
    const end = (): void => {
      this.#pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on('data', (chunk: Buffer) => upstream.write(chunk));
    upstream.on('data', (chunk: Buffer) => {
      if (this.#holding) pair.held.push(chunk);
      else client.write(chunk);
    });
    for (const socket of [client, upstream]) {
      socket.on('error', end);
      socket.on('close', end);
    }
  }
}

/** Proxies for the five OPC UA machine ports: `from` offset (the client's) → `to` offset (the server's). */
export async function opcuaProxies(
  machines: readonly { readonly id: string; readonly port: number }[],
  from: number,
  to: number,
): Promise<Map<string, TcpProxy>> {
  const proxies = new Map<string, TcpProxy>();
  for (const machine of machines) {
    proxies.set(
      machine.id,
      await TcpProxy.start(machine.port + from, { host: 'localhost', port: machine.port + to }),
    );
  }
  return proxies;
}
