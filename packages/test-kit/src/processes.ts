import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { OPCUA_MACHINES } from '@shopfloor/contracts';
import { freeOffset, freePort, freePorts } from './ports.ts';

// The real simulator and edge gateway as child processes (apps may not import each other, plan
// section 8), and TCP proxies to cut or hold their connections: shared by the gateway's command
// tests (#173) and the MES's orders end to end (#174). Ports are chosen at runtime and readiness
// waits are generous (#212): other suites and agents run on the same machine at the same time.

const REPO = resolve(import.meta.dirname, '../../..');
const SIMULATOR_MAIN = resolve(REPO, 'apps/simulator/src/main.ts');
const GATEWAY_MAIN = resolve(REPO, 'apps/edge-gateway/src/main.ts');

/** How long a spawned process may take to become ready: generous, for a loaded machine. */
const SIMULATOR_READY_MS = 120_000;
const GATEWAY_READY_MS = 90_000;
/** How long a SIGTERM may take before the process is killed. */
const STOP_GRACE_MS = 15_000;
/** Start attempts when a process exits before it is ready (a port taken in the meantime). */
const START_ATTEMPTS = 5;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every child still running when the test process exits is killed, also after a failed
// `beforeAll` or a crashed test, so no simulator or gateway outlives its suite.
const children = new Set<ChildProcess>();
const killChildren = (): void => {
  for (const child of children) child.kill('SIGKILL');
};
process.once('exit', killChildren);
// Also on a signal; when nobody else handles it, it is raised again for its default (the exit).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    killChildren();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  });
}

/** Thrown when a child exited before it was ready: worth a retry, on other ports if it can. */
class ExitedEarly extends Error {}

interface Child {
  readonly process: ChildProcess;
  /** Resolves once a pino log line of the child has this `msg`. */
  logged(msg: string): Promise<void>;
  /** Signals the child (SIGKILL after a grace period) and waits for its exit. */
  stop(signal?: NodeJS.Signals): Promise<void>;
}

const running = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

/**
 * Spawns `main` with its pino log on a pipe: the child's own "listening" line is what tells it
 * apart from another process answering on the same port. Lines at warn and above (and anything
 * that is not a log line) go on to stderr, as with the inherited stdio before.
 */
function spawnChild(main: string, env: NodeJS.ProcessEnv): Child {
  const child = spawn(process.execPath, [main], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  children.add(child);
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => {
      children.delete(child);
      resolveExit();
    });
  });
  const seen = new Set<string>();
  const waiting = new Map<string, (() => void)[]>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    let entry: { level?: unknown; msg?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      process.stderr.write(`${line}\n`);
      return;
    }
    if (typeof entry.level === 'number' && entry.level >= 40) process.stderr.write(`${line}\n`);
    if (typeof entry.msg === 'string') {
      seen.add(entry.msg);
      for (const resolveSeen of waiting.get(entry.msg)?.splice(0) ?? []) resolveSeen();
    }
  });
  return {
    process: child,
    logged: (msg) =>
      seen.has(msg)
        ? Promise.resolve()
        : new Promise<void>((resolveSeen) => {
            waiting.set(msg, [...(waiting.get(msg) ?? []), resolveSeen]);
          }),
    stop: async (signal = 'SIGTERM') => {
      if (running(child)) child.kill(signal);
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, STOP_GRACE_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}

/**
 * Polls `probe` until it holds and the child has logged `msg`, within `timeoutMs`. Throws
 * `ExitedEarly` when the child exits first, an Error on timeout; the caller stops the child.
 */
async function awaitReady(
  child: Child,
  what: string,
  msg: string | undefined,
  probe: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  let logged = msg === undefined;
  if (msg !== undefined) {
    void child.logged(msg).then(() => {
      logged = true;
    });
  }
  for (const deadline = Date.now() + timeoutMs; ;) {
    if (!running(child.process)) throw new ExitedEarly(`${what} exited before it was ready`);
    if (logged && (await probe()) && running(child.process)) return;
    if (Date.now() > deadline) {
      throw new Error(`${what} did not become ready within ${String(timeoutMs)} ms`);
    }
    await wait(200);
  }
}

/** `GET url` is 2xx; false on any error and after 5 s, so one stuck request can't hang a wait. */
const answersOk = (url: string): Promise<boolean> =>
  fetch(url, { signal: AbortSignal.timeout(5_000) }).then(
    (r) => r.ok,
    () => false,
  );

/** Whether the caller asked for a log level that hides the child's `info` lines. */
const quietLevel = (level: string | undefined): boolean =>
  level !== undefined && !['info', 'debug', 'trace'].includes(level);

export interface SimulatorPorts {
  /** Added to every OPC UA machine's base port (`OPCUA_MACHINES`, 4841–4845). */
  readonly opcuaOffset: number;
  readonly modbusPort: number;
  readonly controlPort: number;
}

/** Ports for one simulator, free right now: a checked OPC UA block, ephemeral Modbus and control. */
export async function freeSimulatorPorts(): Promise<SimulatorPorts> {
  const opcuaOffset = await freeOffset(OPCUA_MACHINES.map((machine) => machine.port));
  const [modbusPort = 0, controlPort = 0] = await freePorts(2);
  return { opcuaOffset, modbusPort, controlPort };
}

export interface RunningSimulator {
  readonly control: string;
  /** The ports it runs on, to restart it where its clients left it. */
  readonly ports: SimulatorPorts;
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

/**
 * The real simulator as a child process, started idle, with its event stream already subscribed.
 *
 * Without `ports` (the usual case) it gets free ones (`freeSimulatorPorts`), and a start that
 * exits early because a port was taken in the meantime is retried on new ones. With `ports` (a
 * restart where its clients left it) the same ports are retried. Ready means: the child logged
 * that its last server listens, and its control API says ready.
 */
export async function startSimulator(
  ports?: SimulatorPorts,
  /** Extra environment, e.g. `{ SIM_PRODUCTION: 'orders' }` (#173). */
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<RunningSimulator> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await launchSimulator(ports ?? (await freeSimulatorPorts()), extraEnv);
    } catch (error) {
      if (!(error instanceof ExitedEarly) || attempt >= START_ATTEMPTS) throw error;
      await wait(ports ? 1_000 : 100);
    }
  }
}

async function launchSimulator(
  ports: SimulatorPorts,
  extraEnv: Readonly<Record<string, string>>,
): Promise<RunningSimulator> {
  const control = `http://127.0.0.1:${String(ports.controlPort)}`;
  // A certificate store of its own: a store left locked by a killed run would hang the start,
  // and one shared by name would be wiped by a parallel run.
  const pki = mkdtempSync(join(tmpdir(), 'shopfloor-twin-sim-pki-'));
  const child = spawnChild(SIMULATOR_MAIN, {
    ...process.env,
    SIM_AUTOSTART: 'false',
    SIM_SPEED: '60',
    OPCUA_PORT_OFFSET: String(ports.opcuaOffset),
    OPCUA_PKI_DIR: pki,
    MODBUS_PORT: String(ports.modbusPort),
    CONTROL_PORT: String(ports.controlPort),
    LOG_LEVEL: 'info',
    ...extraEnv,
  });
  const removePki = () => {
    rmSync(pki, { recursive: true, force: true });
  };
  let socket: WebSocket | undefined;
  try {
    await awaitReady(
      child,
      'simulator',
      quietLevel(extraEnv.LOG_LEVEL) ? undefined : 'Modbus TCP server listening',
      () => answersOk(`${control}/health/ready`),
      SIMULATOR_READY_MS,
    );
    const events: SimEvent[] = [];
    const ws = new WebSocket(`${control.replace('http', 'ws')}/api/v1/events`);
    socket = ws;
    ws.addEventListener('message', (message: MessageEvent) => {
      events.push(JSON.parse(String(message.data)) as SimEvent);
    });
    await new Promise((resolveOpen, reject) => {
      ws.addEventListener('open', resolveOpen);
      ws.addEventListener('error', reject);
    });
    return {
      control,
      ports,
      opcuaOffset: ports.opcuaOffset,
      modbusPort: ports.modbusPort,
      events,
      post: async (path, body) => {
        const response = await fetch(`${control}${path}`, {
          method: path.endsWith('/speed') ? 'PUT' : 'POST',
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        });
        return response.json();
      },
      stop: async () => {
        ws.close();
        await child.stop();
        removePki();
      },
    };
  } catch (error) {
    socket?.close();
    await child.stop('SIGKILL');
    removePki();
    throw error;
  }
}

export interface RunningGateway {
  readonly http: string;
  /** SIGTERM and wait (graceful), or SIGKILL (a crash). */
  stop(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}

/**
 * The gateway as its own process, as in production. Ready means: the child logged "gateway
 * started" (after its HTTP server listens) and answers `/health/live`. A start that exits early
 * (its HTTP port taken in the meantime) is retried: on a new free port unless `HTTP_PORT` pins one.
 */
export async function startGateway(env: Readonly<Record<string, string>>): Promise<RunningGateway> {
  for (let attempt = 1; ; attempt++) {
    try {
      // An HTTP port the caller didn't pin is chosen per attempt (read it from `http`).
      const port = env.HTTP_PORT ?? String(await freePort());
      return await launchGateway({ ...env, HTTP_PORT: port });
    } catch (error) {
      if (!(error instanceof ExitedEarly) || attempt >= START_ATTEMPTS) throw error;
      await wait(env.HTTP_PORT === undefined ? 100 : 1_000);
    }
  }
}

async function launchGateway(env: Readonly<Record<string, string>>): Promise<RunningGateway> {
  const port = env.HTTP_PORT ?? '4900';
  const child = spawnChild(GATEWAY_MAIN, { ...process.env, LOG_LEVEL: 'info', ...env });
  const http = `http://127.0.0.1:${port}`;
  try {
    await awaitReady(
      child,
      'gateway',
      quietLevel(env.LOG_LEVEL) ? undefined : 'gateway started',
      () => answersOk(`${http}/health/live`),
      GATEWAY_READY_MS,
    );
  } catch (error) {
    await child.stop('SIGKILL');
    throw error;
  }
  return {
    http,
    stop: (signal = 'SIGTERM') => child.stop(signal),
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
  #target: { readonly host: string; readonly port: number };
  #holding = false;
  #down = false;

  private constructor(
    server: Server,
    port: number,
    target: { readonly host: string; readonly port: number },
  ) {
    this.#server = server;
    this.port = port;
    this.#target = target;
  }

  /** Listens on `listenPort`; 0 lets the OS pick a free one (read it from `port`). */
  static async start(
    listenPort: number,
    target: { readonly host: string; readonly port: number },
  ): Promise<TcpProxy> {
    const server = createServer();
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(listenPort, () => {
        server.off('error', reject);
        resolveListen();
      });
    });
    const proxy = new TcpProxy(server, (server.address() as AddressInfo).port, target);
    server.on('connection', (client) => {
      proxy.#accept(client);
    });
    return proxy;
  }

  /** New connections go to `target` from now on (a server restarted on another port). */
  retarget(target: { readonly host: string; readonly port: number }): void {
    this.#target = target;
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

  #accept(client: Socket): void {
    if (this.#down) {
      client.destroy();
      return;
    }
    const upstream = connect(this.#target.port, this.#target.host);
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

/**
 * Proxies for the OPC UA machine ports, from a block the clients use (`offset`) to the server's
 * (`to`). The client block is a free one chosen here (a block found taken while binding is given
 * up for another), or `from` when given.
 */
export async function opcuaProxies(
  machines: readonly { readonly id: string; readonly port: number }[],
  to: number,
  from?: number,
): Promise<{ readonly offset: number; readonly proxies: Map<string, TcpProxy> }> {
  for (let attempt = 1; ; attempt++) {
    const offset = from ?? (await freeOffset(machines.map((machine) => machine.port)));
    const proxies = new Map<string, TcpProxy>();
    try {
      for (const machine of machines) {
        proxies.set(
          machine.id,
          await TcpProxy.start(machine.port + offset, {
            host: 'localhost',
            port: machine.port + to,
          }),
        );
      }
      return { offset, proxies };
    } catch (error) {
      for (const proxy of proxies.values()) await proxy.close();
      const taken = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (from !== undefined || !taken || attempt >= START_ATTEMPTS) throw error;
    }
  }
}
