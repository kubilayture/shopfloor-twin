import { connect } from 'node:net';
import { resolve } from 'node:path';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { useDockerContext } from './docker.ts';

export { freePort } from './ports.ts';

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
      const host = container.getHost();
      const port = container.getMappedPort(1883);
      // "running" in the log is not yet a broker on the host port: Docker's port forward can
      // accept a connection and never pass it on for a while, and a client then hangs (#212).
      try {
        await awaitMqtt(host, port, 60_000);
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
    text(`test-kit-probe-${String(process.pid)}-${String(Date.now())}`),
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

/** One CONNECT on `host:port`: true when the broker accepts it (CONNACK, return code 0) in 3 s. */
function mqttAnswers(host: string, port: number): Promise<boolean> {
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
    }, 3_000);
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
  for (const deadline = Date.now() + timeoutMs; !(await mqttAnswers(host, port));) {
    if (Date.now() > deadline) {
      throw new Error(`broker on ${host}:${String(port)} did not accept MQTT connections`);
    }
    await wait(250);
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
