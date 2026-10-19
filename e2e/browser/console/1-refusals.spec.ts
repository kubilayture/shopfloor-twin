import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { account } from '../login.ts';

/**
 * Every refusal of the console path (#237, security checklist S3), on the live stack of
 * `pnpm test:console` with the simulator still idle, before 2-actions.spec.ts drives it:
 *
 * - `/sim/` answers 401 anonymous and 403 to the four roles without `sim:control`, on reads and
 *   writes alike, and lets admin through;
 * - 404 outside the allowlist, exact routes only: the ground truth, the recorded run (and its
 *   variants by encoding, a trailing slash or dot segments), health, metrics, unknown routes;
 * - 403 for a method a route doesn't allow, and for a write (or a WebSocket upgrade) whose Origin
 *   is another one, missing, or whose Sec-Fetch-Site says cross-site;
 * - the control API itself 401 without its token or with another, reads included; nginx's token
 *   never comes back to the browser.
 *
 * None of these requests moves the run: it is still idle at 06:00 with no action afterwards.
 */
const web = process.env.RECONCILE_WEB_URL ?? '';
const simUrl = process.env.CONSOLE_SIM_URL ?? '';
const simToken = process.env.CONSOLE_SIM_TOKEN ?? '';
const OTHER_ROLES = ['operator', 'maintenance', 'quality', 'supervisor'] as const;
const origin = () => new URL(web).origin;

/** An API context logged in as `name` (or anonymous), always sending this page's Origin on writes. */
async function contextOf(name?: string): Promise<APIRequestContext> {
  const context = await request.newContext({ baseURL: web });
  if (name !== undefined) {
    const user = account(name);
    const login = await context.post('/api/v1/session', {
      headers: { origin: origin() },
      data: { username: user.username, password: user.password },
    });
    expect(login.status(), `${name} login`).toBe(200);
  }
  return context;
}

/**
 * A raw WebSocket handshake (an API context may drop hop-by-hop headers): its HTTP status. Over
 * HTTPS since P9-14, trusting the stack's dev CA through NODE_EXTRA_CA_CERTS.
 */
function upgradeStatus(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, web);
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        ...headers,
      },
    });
    req.on('upgrade', (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

const write = (context: APIRequestContext, path: string, headers: Record<string, string> = {}) =>
  context.post(path, { headers: { origin: origin(), ...headers } });

test.beforeAll(() => {
  test.skip(web === '' || simUrl === '' || simToken === '', 'runs inside pnpm test:console');
});

test('/sim/ answers 401 anonymous and 403 to every role but admin (sim:control)', async () => {
  const anonymous = await contextOf();
  for (const path of ['/sim/api/v1/status', '/sim/api/v1/lots', '/sim/api/v1/scenarios']) {
    expect((await anonymous.get(path)).status(), path).toBe(401);
  }
  expect((await write(anonymous, '/sim/api/v1/resume')).status()).toBe(401);
  for (const role of OTHER_ROLES) {
    const context = await contextOf(role);
    expect((await context.get('/sim/api/v1/status')).status(), role).toBe(403);
    expect((await context.get('/sim/api/v1/operators')).status(), role).toBe(403);
    expect((await write(context, '/sim/api/v1/resume')).status(), role).toBe(403);
    expect((await write(context, '/sim/api/v1/lots/SK1-2610-01/block')).status(), role).toBe(403);
    // Their MES session is fine: the refusal is the permission's.
    expect((await context.get('/api/v1/session')).status(), role).toBe(200);
    await context.dispose();
  }
  const admin = await contextOf('admin');
  const status = await admin.get('/sim/api/v1/status');
  expect(status.status()).toBe(200);
  expect(await status.json()).toMatchObject({ state: 'idle', simTime: '2026-10-12T03:00:00.000Z' });
  await admin.dispose();
  await anonymous.dispose();
});

test('/sim/ answers 404 outside its allowlist, exact routes only', async () => {
  const admin = await contextOf('admin');
  for (const path of [
    '/sim/api/v1/ground-truth',
    '/sim/api/v1/ground-truth?asOf=2026-10-12T03:00:00Z',
    '/sim/api/v1/scenario/recorded',
    '/sim/api/v1/scenario/recorded/',
    '/sim/api/v1/scenario%2Frecorded',
    '/sim/api/v1/scenario/../ground-truth',
    '/sim/api/v1/status/',
    '/sim/api/v1/statusx',
    '/sim/api/v1/lots/SK1-2610-01',
    '/sim/api/v1/faults/opcua',
    '/sim/api/v1/no-such-route',
    '/sim/health/ready',
    '/sim/health/live',
    '/sim/metrics',
    '/sim/documentation/json',
    '/sim/',
  ]) {
    expect((await admin.get(path)).status(), path).toBe(404);
  }
  // A write to an unlisted path is 404 too (after the Origin check passed).
  expect((await write(admin, '/sim/api/v1/lots/a%2Fb/block')).status()).toBe(404);
  await admin.dispose();
});

test('/sim/ refuses a method a route does not allow (403)', async () => {
  const admin = await contextOf('admin');
  const cases: [string, string][] = [
    ['DELETE', '/sim/api/v1/status'],
    ['POST', '/sim/api/v1/status'],
    ['GET', '/sim/api/v1/pause'],
    ['PUT', '/sim/api/v1/resume'],
    ['POST', '/sim/api/v1/speed'],
    ['PATCH', '/sim/api/v1/scenario'],
    ['DELETE', '/sim/api/v1/scenario'],
    ['GET', '/sim/api/v1/operators/absent'],
  ];
  for (const [method, path] of cases) {
    const response = await admin.fetch(path, { method, headers: { origin: origin() } });
    expect(response.status(), `${method} ${path}`).toBe(403);
  }
  await admin.dispose();
});

test('/sim/ refuses a write from another origin, without one or cross-site (403)', async () => {
  const admin = await contextOf('admin');
  const refused: Record<string, string>[] = [
    { origin: 'http://evil.test' },
    { origin: `${origin()}.evil.test` },
    { origin: origin().replace('127.0.0.1', 'localhost') },
    { origin: 'null' },
    { origin: origin(), 'sec-fetch-site': 'cross-site' },
    { origin: origin(), 'sec-fetch-site': 'same-site' },
  ];
  for (const headers of refused) {
    for (const path of ['/sim/api/v1/resume', '/sim/api/v1/faults/modbus']) {
      const response = await admin.post(path, { headers });
      expect(response.status(), `${path} ${JSON.stringify(headers)}`).toBe(403);
    }
  }
  // Without any Origin (not a page of this app).
  const bare = await request.newContext({
    baseURL: web,
    storageState: await admin.storageState(),
  });
  expect((await bare.post('/sim/api/v1/resume')).status()).toBe(403);
  // A WebSocket upgrade of the event stream from another origin, with admin's cookie: 403; from
  // this origin: 101.
  const cookie = (await admin.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  expect(await upgradeStatus('/sim/api/v1/events', { origin: 'http://evil.test', cookie })).toBe(
    403,
  );
  expect(await upgradeStatus('/sim/api/v1/events', { origin: origin(), cookie })).toBe(101);
  expect(await upgradeStatus('/sim/api/v1/events', { origin: origin() })).toBe(401);
  await bare.dispose();
  await admin.dispose();
});

test('the control API answers 401 without its token; nginx never shows the token', async () => {
  const direct = await request.newContext({ baseURL: simUrl });
  for (const path of ['/api/v1/status', '/api/v1/ground-truth', '/api/v1/lots', '/api/v1/x']) {
    expect((await direct.get(path)).status(), path).toBe(401);
    const wrong = await direct.get(path, { headers: { authorization: 'Bearer wrong-token-0000' } });
    expect(wrong.status(), `${path} with another token`).toBe(401);
  }
  expect((await direct.post('/api/v1/resume')).status()).toBe(401);
  expect((await direct.get('/health/ready')).status()).toBe(200);
  const allowed = await direct.get('/api/v1/status', {
    headers: { authorization: `Bearer ${simToken}` },
  });
  expect(allowed.status()).toBe(200);

  const admin = await contextOf('admin');
  for (const path of ['/sim/api/v1/status', '/sim/api/v1/scenarios', '/sim/api/v1/x']) {
    const response = await admin.get(path);
    expect(JSON.stringify(response.headers())).not.toContain(simToken);
    expect(await response.text()).not.toContain(simToken);
  }
  // Nothing above moved the run.
  const status = (await allowed.json()) as { state: string; events: number };
  expect(status.state).toBe('idle');
  const actions = await direct.get('/api/v1/actions', {
    headers: { authorization: `Bearer ${simToken}` },
  });
  expect(await actions.json()).toEqual({ actions: [] });
  await admin.dispose();
  await direct.dispose();
});
