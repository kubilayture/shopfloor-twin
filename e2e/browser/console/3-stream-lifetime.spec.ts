import { expect, request, test } from '@playwright/test';
import { account } from '../login.ts';

/**
 * The event stream ends within its lifetime after a logout (#237 review). nginx's permission check
 * runs at the upgrade only, so the simulator closes every event-stream connection after
 * `SIM_EVENTS_LIFETIME_MS` (`pnpm test:console` sets 4 s) with 4100; the next upgrade passes the
 * check again. Here: admin opens the stream through `/sim/`, logs out, the stream closes with 4100
 * within the lifetime, and the reconnect is refused (401).
 */
const web = process.env.RECONCILE_WEB_URL ?? '';
const lifetimeMs = Number(process.env.CONSOLE_EVENTS_LIFETIME_MS ?? '0');

interface Opened {
  readonly result: 'open' | 'refused';
  readonly closed: Promise<{ code: number; reason: string; at: number }>;
}

/** A WebSocket to the event stream with this cookie and the page's Origin (Node's, with headers). */
function openStream(cookie: string): Promise<Opened> {
  const url = `${web.replace('http', 'ws')}/sim/api/v1/events`;
  const socket = new WebSocket(url, {
    headers: { cookie, origin: new URL(web).origin },
  } as unknown as string[]);
  const closed = new Promise<{ code: number; reason: string; at: number }>((resolve) => {
    socket.addEventListener('close', (event) => {
      resolve({ code: event.code, reason: event.reason, at: Date.now() });
    });
  });
  return new Promise((resolve) => {
    socket.addEventListener('open', () => {
      resolve({ result: 'open', closed });
    });
    socket.addEventListener('error', () => {
      resolve({ result: 'refused', closed });
    });
  });
}

test.beforeAll(() => {
  test.skip(web === '' || lifetimeMs === 0, 'runs inside pnpm test:console');
});

test('a logout ends the event stream within its lifetime; the reconnect is refused', async () => {
  test.setTimeout(lifetimeMs + 60_000);
  const context = await request.newContext({ baseURL: web });
  const admin = account('admin');
  const login = await context.post('/api/v1/session', {
    headers: { origin: new URL(web).origin },
    data: { username: admin.username, password: admin.password },
  });
  expect(login.status()).toBe(200);
  const cookie = (await context.storageState()).cookies
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const stream = await openStream(cookie);
  expect(stream.result).toBe('open');
  const loggedOut = Date.now();
  const logout = await context.delete('/api/v1/session', {
    headers: { origin: new URL(web).origin },
    data: {},
  });
  expect(logout.status()).toBe(200);

  const closed = await stream.closed;
  expect(closed.code).toBe(4100);
  expect(closed.reason).toBe('stream lifetime reached; reconnect');
  expect(closed.at - loggedOut).toBeLessThanOrEqual(lifetimeMs + 2_000);

  // The reconnect is a new upgrade: nginx asks the MES again, and the session is gone.
  const again = await openStream(cookie);
  expect(again.result).toBe('refused');
  await context.dispose();
});
