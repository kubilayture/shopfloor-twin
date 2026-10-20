import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { useDockerContext } from './docker.ts';

export { freePort } from './ports.ts';

/**
 * Passwords of the broker users in test brokers (never the ones in `.env`). As in Compose, the
 * gateway's two users share the gateway's password, the MES's two users the MES's, and
 * `smoke-reader` dev's.
 */
export const TEST_PASSWORDS = {
  healthcheck: 'test-healthcheck',
  dev: 'test-dev',
  'smoke-reader': 'test-dev',
  'gw-01': 'test-gateway',
  'gw-01-cmd': 'test-gateway',
  mes: 'test-mes',
  'mes-cmd': 'test-mes',
} as const;

export type BrokerUser = keyof typeof TEST_PASSWORDS;

/** The broker's configuration directory, mounted read-only in Compose. */
export const MOSQUITTO_CONFIG = resolve(import.meta.dirname, '../../../config/mosquitto');

interface TemplateClient {
  readonly username: string;
  readonly clientid?: string;
}

/**
 * The client id the broker binds to each user (ADR-0039), read from the dynamic-security
 * template so tests and broker can't drift apart: `gw-01` → `gw-01`, `gw-01-cmd` → `gw-01-cmd`,
 * `mes` → `mes-server`, `mes-cmd` → `mes-server-cmd`, and every other user to its own name.
 */
export const BOUND_CLIENT_IDS: ReadonlyMap<string, string> = new Map(
  (
    JSON.parse(readFileSync(resolve(MOSQUITTO_CONFIG, 'dynamic-security.json'), 'utf8')) as {
      clients: TemplateClient[];
    }
  ).clients.flatMap((c) => (c.clientid === undefined ? [] : [[c.username, c.clientid] as const])),
);

/**
 * MQTT.js login options of a broker user in a test broker: its username, password and the one
 * client id the broker accepts for it (every user is bound, ADR-0039). So a test holds at most one
 * connection per user at a time.
 */
export function brokerLogin(user: BrokerUser): {
  username: string;
  password: string;
  clientId: string;
} {
  const clientId = BOUND_CLIENT_IDS.get(user);
  if (clientId === undefined) throw new Error(`the broker template binds no client id to ${user}`);
  return { username: user, password: TEST_PASSWORDS[user], clientId };
}

/** `MQTT_USERS` of the broker's entrypoint for the test passwords: "user:password …". */
export function mqttUsers(
  users: readonly BrokerUser[] = Object.keys(TEST_PASSWORDS) as BrokerUser[],
): string {
  return users.map((user) => `${user}:${TEST_PASSWORDS[user]}`).join(' ');
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The project's Mosquitto (same image, configuration and `entrypoint.sh` as Compose, so the same
 * dynamic-security generation, users, client-id bindings and ACLs) in a throw-away container.
 * Shared by the gateway's and the MES's tests.
 *
 * `configDir` and `mqttUsers` are for the broker's own security tests only: another
 * configuration directory (the Phase 8 ACL file for the parity test) and another `MQTT_USERS`.
 *
 * With a fixed `hostPort` (a broker restarted where its clients left it), a failed start is
 * retried (`attempts`, default 5, a second apart): the port of a just-stopped container can take
 * a moment to be released.
 *
 * One attempt takes at most about 80 s (#212): 60 s for the container to log "running", then
 * `readyTimeoutMs` (20 s) for it to accept an MQTT connection on the host port.
 */
export async function startBroker(
  options: {
    readonly hostPort?: number;
    readonly attempts?: number;
    readonly readyTimeoutMs?: number;
    readonly configDir?: string;
    readonly mqttUsers?: string;
  } = {},
): Promise<{ url: string; container: StartedTestContainer }> {
  useDockerContext();
  const attempts = options.hostPort ? (options.attempts ?? 5) : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      const container = await brokerContainer(options).start();
      const host = container.getHost();
      const port = container.getMappedPort(1883);
      // "running" in the log is not yet a broker on the host port: Docker's port forward can
      // accept a connection and never pass it on for a while, and a client then hangs (#212).
      try {
        await awaitMqtt(host, port, options.readyTimeoutMs ?? 20_000);
      } catch (error) {
        await container.stop().catch(() => undefined);
        throw error;
      }
      return { url: `mqtt://${host}:${String(port)}`, container };
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

/** An MQTT 3.1.1 CONNECT of the healthcheck user (clean session, no will), encoded by hand. */
function connectPacket(): Buffer {
  const text = (value: string) => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const body = Buffer.concat([
    text('MQTT'),
    Buffer.from([4, 0b1100_0010, 0, 30]), // level 4; username, password, clean; keep-alive 30 s
    text('healthcheck'), // the client id the broker binds to the user healthcheck
    text('healthcheck'),
    text(TEST_PASSWORDS.healthcheck),
  ]);
  const length: number[] = [];
  for (let rest = body.length; ;) {
    const byte = rest % 128;
    rest = Math.floor(rest / 128);
    length.push(rest > 0 ? byte | 0x80 : byte);
    if (rest === 0) break;
  }
  return Buffer.concat([Buffer.from([0x10, ...length]), body]);
}

/** One CONNECT on `host:port`: true when the broker accepts it (CONNACK, return code 0) in time. */
function mqttAnswers(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveAnswer) => {
    const socket = connect(port, host);
    let received = Buffer.alloc(0);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      if (ok) socket.end(Buffer.from([0xe0, 0])); // DISCONNECT
      socket.destroy();
      resolveAnswer(ok);
    };
    const timer = setTimeout(() => {
      done(false);
    }, timeoutMs);
    socket.on('connect', () => socket.write(connectPacket()));
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 4) done(received[0] === 0x20 && received[3] === 0);
    });
    socket.on('error', () => {
      done(false);
    });
    socket.on('close', () => {
      done(false);
    });
  });
}

/** Polls until the broker accepts an MQTT connection on the host port, within `timeoutMs`. */
async function awaitMqtt(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(`broker on ${host}:${String(port)} did not accept MQTT connections`);
    }
    // No probe outlasts the deadline: the whole wait stays within `timeoutMs`.
    if (await mqttAnswers(host, port, Math.min(3_000, left))) return;
    await wait(Math.min(250, Math.max(0, deadline - Date.now())));
  }
}

function brokerContainer(options: {
  readonly hostPort?: number;
  readonly configDir?: string;
  readonly mqttUsers?: string;
}): GenericContainer {
  const hostPort = options.hostPort;
  return new GenericContainer('eclipse-mosquitto:2.1.2-alpine')
    .withCopyDirectoriesToContainer([
      { source: options.configDir ?? MOSQUITTO_CONFIG, target: '/mosquitto/config' },
    ])
    .withEntrypoint(['/bin/sh', '/mosquitto/config/entrypoint.sh'])
    .withEnvironment({
      MQTT_USERS: options.mqttUsers ?? mqttUsers(),
      MQTT_HEALTHCHECK_PASSWORD: TEST_PASSWORDS.healthcheck,
    })
    .withExposedPorts(hostPort ? { container: 1883, host: hostPort } : 1883)
    .withWaitStrategy(Wait.forLogMessage(/running/))
    .withStartupTimeout(60_000);
}
