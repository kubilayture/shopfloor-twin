// Stack smoke, part 2 (#99): the web container serves the app and proxies the MES API and its
// WebSocket within the MES's Host and Origin checks. Run by scripts/stack-smoke.sh on the host,
// with Node.js 26 (built-in fetch and WebSocket, no dependencies), so the requests carry the
// Host and Origin a browser on this machine would send.
// Usage: node scripts/stack-smoke-web.mjs [web base URL, default http://127.0.0.1:8080]
// Since #121 it checks the write refusals, and with SMOKE_WRITES=1 codes and clears one record.
// Since #143 it checks the alarm write refusals too, and with SMOKE_WRITES=1 acknowledges one
// alarm occurrence (skipped when the plant has raised none yet).
// Since #170 every API route and the WebSocket need a session: the checks log in as
// SMOKE_USERNAME / SMOKE_PASSWORD (an operator stack-smoke.sh creates per run) and check the
// refusals of anonymous requests (401, WebSocket 4401) and of a permission the role lacks (403).
// With SMOKE_WRITES=1 and MES_BOOTSTRAP_ADMIN_PASSWORD set, the bootstrap admin must change its
// password before anything else (403, WebSocket 4403); the smoke never changes it.

import { request as httpRequest } from 'node:http';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8080');
const MACHINES = ['asm-01', 'cnc-01', 'cnc-02', 'lkt-01', 'pck-01', 'wsh-01'];
const DEADLINE_MS = 60_000;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const username = process.env.SMOKE_USERNAME;
const password = process.env.SMOKE_PASSWORD;
if (!username || !password) fail('SMOKE_USERNAME and SMOKE_PASSWORD must be set (stack-smoke.sh)');

// The app shell, client-side routes and the headers nginx adds.
const shell = await fetch(new URL('/', base));
const html = await shell.text();
if (!shell.ok || !html.includes('<div id="root">')) fail(`GET / answered ${shell.status}`);
const csp = shell.headers.get('content-security-policy') ?? '';
if (!csp.includes("default-src 'self'")) fail(`no Content-Security-Policy on / (${csp})`);
if (shell.headers.get('x-content-type-options') !== 'nosniff') fail('no X-Content-Type-Options');
if (shell.headers.get('cache-control') !== 'no-cache') fail('index.html is cached');
const route = await fetch(new URL('/equipment/cnc-01?range=1h', base));
if (!route.ok || !(await route.text()).includes('<div id="root">')) {
  fail(`client-side route not answered with index.html (${route.status})`);
}
const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
if (asset === undefined) fail('no script asset in index.html');
const script = await fetch(new URL(asset, base), { headers: { 'accept-encoding': 'gzip' } });
await script.arrayBuffer();
if (!script.ok || !(script.headers.get('cache-control') ?? '').includes('immutable')) {
  fail(`hashed asset ${asset} not cacheable (${script.status})`);
}
if (script.headers.get('content-encoding') !== 'gzip') fail(`asset ${asset} not gzipped`);
console.log('ok: web serves the app (SPA fallback, CSP, caching, gzip)');

/**
 * One request with exactly these headers (fetch would add or drop some), plus the body's
 * Content-Length: Node frames no body of a DELETE by itself, so on a kept-alive connection nginx
 * would read it as the start of the next request and answer that one 400 (#178).
 */
function send(method, path, headers, body) {
  const length = body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL(path, base),
      { method, headers: { ...headers, ...length } },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, text, headers: response.headers }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
const json = { 'content-type': 'application/json' };

/** Logs in through the web (the page's own origin); resolves with the `Cookie` header value. */
async function login(name, secret) {
  const answer = await send(
    'POST',
    '/api/v1/session',
    { origin: base.origin, ...json },
    JSON.stringify({ username: name, password: secret }),
  );
  if (answer.status !== 200) return { status: answer.status, text: answer.text };
  const cookie = String(answer.headers['set-cookie'] ?? '').split(';')[0];
  const setCookie = String(answer.headers['set-cookie']);
  // A failure message never shows the token (#170 review L5).
  const redacted = setCookie.replace(/=[^;,]*/, '=(redacted)');
  if (!cookie.startsWith('sft_session=')) fail(`login set no session cookie: ${redacted}`);
  if (!/HttpOnly/i.test(setCookie) || !/SameSite=Strict/i.test(setCookie)) {
    fail(`session cookie not HttpOnly and SameSite=Strict: ${redacted}`);
  }
  return { status: 200, cookie, session: JSON.parse(answer.text) };
}

// Identity (#170): anonymous reads are refused, a login through the web sets the cookie.
const anonymous = await fetch(new URL('/api/v1/equipment', base));
const anonymousProblem = await anonymous.json().catch(() => ({}));
if (anonymous.status !== 401 || anonymousProblem.type !== 'urn:shopfloor:unauthenticated') {
  fail(`an anonymous read answered ${anonymous.status} ${JSON.stringify(anonymousProblem)}`);
}
console.log('ok: an anonymous read is refused (401 urn:shopfloor:unauthenticated)');
const wrong = await login(username, `${password}-wrong`);
if (wrong.status !== 401) fail(`a wrong password answered ${wrong.status}`);
const signedIn = await login(username, password);
if (signedIn.status !== 200)
  fail(`login as ${username} answered ${signedIn.status}: ${signedIn.text}`);
const cookie = signedIn.cookie;
if (signedIn.session.user.username !== username || signedIn.session.user.mustChangePassword) {
  fail(`unexpected session: ${JSON.stringify(signedIn.session.user)}`);
}
console.log(`ok: login through the web as ${username} (HttpOnly, SameSite=Strict cookie)`);
const authed = { cookie };
const getJson = async (path) => {
  const response = await fetch(new URL(path, base), { headers: authed });
  if (!response.ok) fail(`GET ${path} answered ${response.status}: ${await response.text()}`);
  return response.json();
};

// REST through the proxy: every machine with a current state, within the deadline.
const started = Date.now();
let missing = MACHINES;
while (missing.length > 0) {
  const response = await fetch(new URL('/api/v1/equipment', base), { headers: authed }).catch(
    () => undefined,
  );
  if (response?.ok) {
    const { equipment } = await response.json();
    const reported = new Set(equipment.filter((e) => e.current !== null).map((e) => e.id));
    missing = MACHINES.filter((id) => !reported.has(id));
  } else if (response !== undefined && response.status !== 503) {
    fail(`GET /api/v1/equipment answered ${response.status}: ${await response.text()}`);
  }
  if (missing.length === 0) break;
  if (Date.now() - started > DEADLINE_MS) fail(`no current state through the web for ${missing}`);
  await sleep(1000);
}
console.log(
  `ok: /api/v1/equipment through the web has all six machines' states (${Date.now() - started} ms)`,
);

/**
 * Opens the WebSocket through nginx with this Origin (and session cookie); resolves with the first
 * snapshot, rejects with `closed <code>` when the MES closes it first; `session` null: no cookie.
 */
function snapshot(origin, session = cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/v1/ws', base);
    url.protocol = 'ws:';
    const socket = new WebSocket(url, {
      headers: { origin, ...(session === null ? {} : { cookie: session }) },
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('no snapshot within 10 s'));
    }, 10_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', topic: 'states' }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type !== 'snapshot') return;
      clearTimeout(timer);
      socket.close();
      resolve(message);
    });
    socket.addEventListener('close', (event) => {
      clearTimeout(timer);
      reject(new Error(`closed ${event.code}`));
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('connection refused or failed'));
    });
  });
}

// The page's own origin passes the MES's Origin check because nginx forwards the Host.
const message = await snapshot(base.origin).catch((error) => fail(`WebSocket: ${error.message}`));
const states = message.states.map((s) => s.equipment).sort();
if (states.join() !== MACHINES.join()) fail(`WebSocket snapshot incomplete: ${states}`);
console.log('ok: WebSocket through the web (/api/v1/ws) sends a snapshot of all six machines');

// Another site's page must not open it.
// The upgrade itself must fail: a socket that opens but stays silent would not prove the check.
const foreign = await snapshot('http://evil.test').then(
  () => 'accepted',
  (error) => error.message,
);
if (foreign !== 'connection refused or failed') fail(`WebSocket from a foreign Origin: ${foreign}`);
console.log('ok: WebSocket from a foreign Origin refused');

// Without a session the MES accepts the upgrade and closes the socket at once with 4401.
const anonymousSocket = await snapshot(base.origin, null).then(
  () => 'snapshot',
  (error) => error.message,
);
if (anonymousSocket !== 'closed 4401') fail(`WebSocket without a session: ${anonymousSocket}`);
console.log('ok: WebSocket without a session closed with 4401');

// Writes through the web (#121, ADR-0023): a foreign Origin, a missing Origin and a form content
// type are refused, and nginx passes only GET, POST, PUT and DELETE under /api/. These refusals
// change nothing, so they always run. With SMOKE_WRITES=1 (CI, or a disposable Compose project:
// runbook "Full stack") the page's own origin also codes one downtime record and clears it again.
// That leaves two permanent rows in the append-only audit, so it is off by default: a local run
// must not write into a dev database.

const page = { origin: base.origin, ...json, cookie };

// The guards answer before any route is looked up, so a record that doesn't exist will do.
const refused = '/api/v1/downtime/cnc-01~0~0/coding';
const body = JSON.stringify({ segments: [], version: 0 });
for (const [name, headers, status] of [
  ['a foreign Origin', { origin: 'http://evil.test', ...json }, 403],
  ['no Origin', json, 403],
  [
    'a form content type',
    { origin: base.origin, 'content-type': 'application/x-www-form-urlencoded' },
    415,
  ],
]) {
  const answer = await send('PUT', refused, headers, body);
  if (answer.status !== status) fail(`write with ${name} answered ${answer.status}, not ${status}`);
  console.log(`ok: write with ${name} refused (${status})`);
}
// The alarm writes (#143) sit behind the same guards; the occurrence need not exist. The 405 of
// MES_WRITES=off is not checked here: MES_WRITES is the `mes` container's environment, fixed for
// the stack under test, and toggling it would mean recreating the MES in the middle of the smoke.
// The MES's own tests check the 405 for every alarm write (alarm-writes.test.ts).
const alarmWrites = [
  ['/api/v1/alarms/cnc-01~0~0/ack', {}],
  ['/api/v1/alarms/ack', { ids: ['cnc-01~0~0'] }],
  ['/api/v1/alarms/cnc-01~0~0/comments', { text: 'refused' }],
  [
    '/api/v1/alarm-points/cnc-01/SPINDLE-OVERLOAD/shelve',
    { reason: 'refused', durationMs: 60_000, version: 0 },
  ],
  ['/api/v1/alarm-points/cnc-01/SPINDLE-OVERLOAD/unshelve', { version: 0 }],
];
for (const [path, request] of alarmWrites) {
  for (const [name, headers, status] of [
    ['a foreign Origin', { origin: 'http://evil.test', ...json }, 403],
    ['no Origin', json, 403],
    [
      'a form content type',
      { origin: base.origin, 'content-type': 'application/x-www-form-urlencoded' },
      415,
    ],
  ]) {
    const answer = await send('POST', path, headers, JSON.stringify(request));
    if (answer.status !== status) {
      fail(`alarm write ${path} with ${name} answered ${answer.status}, not ${status}`);
    }
  }
}
console.log('ok: alarm writes with a foreign Origin, no Origin or a form content type refused');

// Identity (#170): the page's own origin without a session is 401; an operator may not shelve
// (403 urn:shopfloor:forbidden, checked before the route reads its body).
const noSession = await send('PUT', refused, { origin: base.origin, ...json }, body);
if (noSession.status !== 401) fail(`a write without a session answered ${noSession.status}`);
const shelve = await send(
  'POST',
  '/api/v1/alarm-points/cnc-01/SPINDLE-OVERLOAD/shelve',
  page,
  JSON.stringify({ reason: 'refused', durationMs: 60_000, version: 0 }),
);
if (shelve.status !== 403 || JSON.parse(shelve.text).type !== 'urn:shopfloor:forbidden') {
  fail(`an operator's shelve answered ${shelve.status}: ${shelve.text}`);
}
console.log('ok: a write without a session is 401, a permission the role lacks 403');

// Orders and the terminal (#178): an operator may not write orders (403, before the route reads
// anything), may not work on an order operation without a crew row at its work center (409
// not-signed-on) and may not sign on with a desk session (409 terminal-session-required). The
// orders come from the ERP mock's default dataset; the MES pulls it every ERP_POLL_MS.
const problemType = (answer) => {
  try {
    return JSON.parse(answer.text).type ?? null;
  } catch {
    return null;
  }
};
let imported;
for (const begun = Date.now(); imported === undefined;) {
  imported = (await getJson('/api/v1/orders')).orders.find((o) => o.status === 'imported');
  if (imported === undefined) {
    if (Date.now() - begun > DEADLINE_MS) fail('the MES imported no order from the ERP mock');
    await sleep(1000);
  }
}
const orderPath = (action) => `/api/v1/orders/${encodeURIComponent(imported.id)}/${action}`;
for (const action of ['release', 'dispatch', 'close']) {
  const answer = await send(
    'POST',
    orderPath(action),
    page,
    JSON.stringify({ version: imported.version }),
  );
  if (answer.status !== 403 || problemType(answer) !== 'urn:shopfloor:forbidden') {
    fail(`an operator's order ${action} answered ${answer.status}: ${answer.text}`);
  }
}
const terminalStart = await send(
  'POST',
  `/api/v1/terminal/line-a1/orders/${encodeURIComponent(imported.id)}/operations/OP30/start`,
  page,
  JSON.stringify({ activity: null }),
);
if (terminalStart.status !== 409 || problemType(terminalStart) !== 'urn:shopfloor:not-signed-on') {
  fail(
    `a terminal write without a crew row answered ${terminalStart.status}: ${terminalStart.text}`,
  );
}
const deskSignOn = await send('POST', '/api/v1/terminal/line-a1/sign-on', page, '{}');
if (
  deskSignOn.status !== 409 ||
  problemType(deskSignOn) !== 'urn:shopfloor:terminal-session-required'
) {
  fail(`a sign-on with a desk session answered ${deskSignOn.status}: ${deskSignOn.text}`);
}
const unchanged = (await getJson(`/api/v1/orders/${encodeURIComponent(imported.id)}`)).order;
if (unchanged.version !== imported.version || unchanged.status !== 'imported') {
  fail(`a refused write changed order ${imported.id}: ${JSON.stringify(unchanged)}`);
}
console.log(
  `ok: an operator's order writes are 403; a terminal write without a crew row and a desk sign-on are 409 (${imported.id})`,
);

const patch = await send('PATCH', refused, page, body);
if (patch.status !== 403) fail(`PATCH through the web answered ${patch.status}, not 403`);
console.log('ok: nginx passes only GET, POST, PUT and DELETE under /api/ (PATCH refused, 403)');

if (process.env.SMOKE_WRITES !== '1') {
  console.log('skipped: a write through the web (set SMOKE_WRITES=1, on a disposable database)');
  process.exit(0);
}

// The bootstrap admin (#168, #170): on a fresh database it exists with a temporary password, so
// every route but the session and password routes answers 403 until it is changed, and its socket
// is closed with 4403. Logging in rotates nothing; the smoke never changes the password.
const bootstrap = process.env.MES_BOOTSTRAP_ADMIN_PASSWORD;
if (bootstrap) {
  const admin = await login('admin', bootstrap);
  if (admin.status !== 200 || !admin.session.user.mustChangePassword) {
    fail(`bootstrap admin: ${admin.status} ${JSON.stringify(admin.session?.user ?? admin.text)}`);
  }
  const read = await fetch(new URL('/api/v1/equipment', base), {
    headers: { cookie: admin.cookie },
  });
  const problem = await read.json();
  if (read.status !== 403 || problem.type !== 'urn:shopfloor:password-change-required') {
    fail(`the bootstrap admin read answered ${read.status} ${JSON.stringify(problem)}`);
  }
  const adminSocket = await snapshot(base.origin, admin.cookie).then(
    () => 'snapshot',
    (error) => error.message,
  );
  if (adminSocket !== 'closed 4403') fail(`the bootstrap admin's WebSocket: ${adminSocket}`);
  await send(
    'DELETE',
    '/api/v1/session',
    { origin: base.origin, ...json, cookie: admin.cookie },
    '{}',
  );
  console.log('ok: the bootstrap admin must change its password first (403, WebSocket 4403)');
} else {
  console.log('skipped: the bootstrap admin check (MES_BOOTSTRAP_ADMIN_PASSWORD not set)');
}

// A supervisor (#178) releases and dispatches the imported order, then is refused an abandon of
// its command while the command's device run goes on (409 order-state). The stack runs in schedule
// mode, so the device refuses the job (wrong mode): no job is made; the order stays flagged.
const supervisorName = process.env.SMOKE_SUPERVISOR_USERNAME;
const supervisorSecret = process.env.SMOKE_SUPERVISOR_PASSWORD;
if (!supervisorName || !supervisorSecret) fail('SMOKE_SUPERVISOR_USERNAME/PASSWORD not set');
const supervisorLogin = await login(supervisorName, supervisorSecret);
if (supervisorLogin.status !== 200) {
  fail(`supervisor login answered ${supervisorLogin.status}: ${supervisorLogin.text}`);
}
const desk = { origin: base.origin, ...json, cookie: supervisorLogin.cookie };
const write = async (action, request) => {
  const answer = await send('POST', orderPath(action), desk, JSON.stringify(request));
  return { status: answer.status, type: problemType(answer), body: answer.text };
};
const released = await write('release', { version: imported.version });
if (released.status !== 200) fail(`release answered ${released.status}: ${released.body}`);
const dispatched = await write('dispatch', { version: JSON.parse(released.body).order.version });
if (dispatched.status !== 200) fail(`dispatch answered ${dispatched.status}: ${dispatched.body}`);
const { order: afterDispatch, command } = JSON.parse(dispatched.body);
const abandon = await write('abandon-command', {
  version: afterDispatch.version,
  commandId: command.commandId,
});
if (abandon.status !== 409 || abandon.type !== 'urn:shopfloor:order-state') {
  fail(`an abandon while the run goes on answered ${abandon.status}: ${abandon.body}`);
}
console.log(
  `ok: a supervisor released and dispatched ${imported.id}; abandoning ${command.commandId} while its run goes on is 409 order-state`,
);

const reasons = (await getJson('/api/v1/reason-codes')).reasons;
const reason = reasons.find((r) => r.id !== 'UNCODED' && r.parent !== null)?.id;
if (reason === undefined) fail('no reason code to code with');
/** A record nobody coded, closed and final, so the smoke never replaces an operator's codings. */
const untouched = (r) => r.end !== null && r.ms > 0 && !r.provisional && r.codings.length === 0;
// One of the last 30 days of plant time (a fresh plant makes one quickly).
let record;
for (const begun = Date.now(); record === undefined;) {
  const { clock } = await getJson('/api/v1/plant');
  if (clock !== null) {
    const to = new Date(Date.parse(clock.watermark) + 1);
    const from = new Date(to.getTime() - 30 * 86_400_000);
    const list = await getJson(
      `/api/v1/downtime?from=${from.toISOString()}&to=${to.toISOString()}`,
    );
    record = list.records?.find(untouched);
  }
  if (record === undefined) {
    if (Date.now() - begun > 3 * DEADLINE_MS) fail('no closed, final, uncoded downtime record');
    await sleep(2000);
  }
}
const coding = `/api/v1/downtime/${encodeURIComponent(record.id)}/coding`;
const segments = [{ from: record.start, to: record.end, reason, comment: 'stack smoke' }];

/** PUT with the record's current version, read again once on 409 (a clip may move it on). */
async function code(request, expectCodings) {
  for (let attempt = 0; ; attempt++) {
    const list = await getJson(
      `/api/v1/downtime?equipment=${record.equipment}&from=${record.start}&to=${record.end}`,
    );
    const now = list.records.find((r) => r.id === record.id);
    if (now === undefined) fail(`record ${record.id} disappeared`);
    // Never overwrite codings this smoke didn't write.
    if (now.codings.length !== expectCodings) fail(`record ${record.id} was coded meanwhile`);
    const answer = await send(
      'PUT',
      coding,
      page,
      JSON.stringify({ ...request, version: now.version }),
    );
    if (answer.status !== 409 || attempt > 0) return answer;
  }
}
const coded = await code({ segments }, 0);
if (coded.status !== 200) fail(`coding ${record.id} answered ${coded.status}: ${coded.text}`);
const codedRecord = JSON.parse(coded.text).record;
if (codedRecord.reason !== reason || codedRecord.codings.length !== 1) {
  fail(`coding not applied: ${coded.text}`);
}
const cleared = await code({ segments: [] }, 1);
if (cleared.status !== 200)
  fail(`clearing ${record.id} answered ${cleared.status}: ${cleared.text}`);
if (JSON.parse(cleared.text).record.codings.length !== 0) fail('codings not cleared');
const audit = await getJson(`/api/v1/downtime/${encodeURIComponent(record.id)}/audit`);
const actions = audit.entries
  .slice(0, 2)
  .map((e) => `${e.action}:${e.actor}`)
  .join(',');
if (actions !== `cleared:${username},coded:${username}`) fail(`audit: ${actions}`);
console.log(
  `ok: write through the web with the page's origin (${record.id} coded, cleared, audited)`,
);

// An alarm acknowledgement (#143): the newest unacknowledged occurrence of the last 7 days of plant
// time, if the plant has raised one (the alarms-01 injections raise some early; week-01's first
// alarm comes on Tuesday). Acknowledging is monotonic: a second write is `changed: false` and adds
// no audit entry.
const { clock } = await getJson('/api/v1/plant');
const alarmTo = new Date(Date.parse(clock?.watermark ?? new Date().toISOString()) + 1);
const alarmFrom = new Date(alarmTo.getTime() - 7 * 86_400_000);
const alarmList = await getJson(
  `/api/v1/alarms?view=active&from=${alarmFrom.toISOString()}&to=${alarmTo.toISOString()}`,
);
const occurrence = alarmList.alarms?.find((a) => a.acknowledged === null);
if (occurrence === undefined) {
  console.log('skipped: an alarm acknowledgement through the web (no unacknowledged occurrence)');
  process.exit(0);
}
const ackPath = `/api/v1/alarms/${encodeURIComponent(occurrence.id)}/ack`;
const acked = await send('POST', ackPath, page, '{}');
if (acked.status !== 200)
  fail(`acknowledging ${occurrence.id} answered ${acked.status}: ${acked.text}`);
const ackResult = JSON.parse(acked.text);
if (!ackResult.changed || ackResult.occurrence.acknowledged?.by !== username) {
  fail(`acknowledgement not applied: ${acked.text}`);
}
const again = await send('POST', ackPath, page, '{}');
if (again.status !== 200 || JSON.parse(again.text).changed !== false) {
  fail(`a second acknowledgement of ${occurrence.id} changed it: ${again.text}`);
}
const alarmHistory = await getJson(`/api/v1/alarms/${encodeURIComponent(occurrence.id)}/history`);
const acks = alarmHistory.entries.filter((e) => e.source === 'audit' && e.transition === 'ack');
if (acks.length !== 1 || acks[0].actor !== username || acks[0].authenticated !== true) {
  fail(`alarm audit: ${JSON.stringify(acks)}`);
}
console.log(
  `ok: alarm acknowledged through the web with the page's origin (${occurrence.id}, audited once)`,
);
