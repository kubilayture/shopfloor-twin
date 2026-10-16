// Stack smoke, part 2 (#99): the web container serves the app and proxies the MES API and its
// WebSocket within the MES's Host and Origin checks. Run by scripts/stack-smoke.sh on the host,
// with Node.js 26 (built-in fetch and WebSocket, no dependencies), so the requests carry the
// Host and Origin a browser on this machine would send.
// Usage: node scripts/stack-smoke-web.mjs [web base URL, default http://127.0.0.1:8080]
// Since #121 it checks the write refusals, and with SMOKE_WRITES=1 codes and clears one record.
// Since #143 it checks the alarm write refusals too, and with SMOKE_WRITES=1 acknowledges one
// alarm occurrence (skipped when the plant has raised none yet).

import { request as httpRequest } from 'node:http';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8080');
const MACHINES = ['asm-01', 'cnc-01', 'cnc-02', 'lkt-01', 'pck-01', 'wsh-01'];
const DEADLINE_MS = 60_000;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// REST through the proxy: every machine with a current state, within the deadline.
const started = Date.now();
let missing = MACHINES;
while (missing.length > 0) {
  const response = await fetch(new URL('/api/v1/equipment', base)).catch(() => undefined);
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

/** Opens the WebSocket through nginx with this Origin; resolves with the first snapshot. */
function snapshot(origin) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/v1/ws', base);
    url.protocol = 'ws:';
    const socket = new WebSocket(url, { headers: { origin } });
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

// Writes through the web (#121, ADR-0023): a foreign Origin, a missing Origin and a form content
// type are refused, and nginx passes only GET, POST, PUT and DELETE under /api/. These refusals
// change nothing, so they always run. With SMOKE_WRITES=1 (CI, or a disposable Compose project:
// runbook "Full stack") the page's own origin also codes one downtime record and clears it again.
// That leaves two permanent rows in the append-only audit, so it is off by default: a local run
// must not write into a dev database.

/** One request with exactly these headers (fetch would add or drop some). */
function send(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, base), { method, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (text += chunk));
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const getJson = async (path) => (await fetch(new URL(path, base))).json();
const json = { 'content-type': 'application/json' };
const page = { origin: base.origin, ...json };

// The guards answer before any route is looked up, so a record that doesn't exist will do.
const refused = '/api/v1/downtime/cnc-01~0~0/coding';
const body = JSON.stringify({ segments: [], codedBy: 'stack smoke', version: 0 });
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
// The alarm writes (#143) sit behind the same guards; the occurrence need not exist.
const alarmWrites = [
  ['/api/v1/alarms/cnc-01~0~0/ack', { actor: 'stack smoke' }],
  ['/api/v1/alarms/ack', { ids: ['cnc-01~0~0'], actor: 'stack smoke' }],
  ['/api/v1/alarms/cnc-01~0~0/comments', { actor: 'stack smoke', text: 'refused' }],
  [
    '/api/v1/alarm-points/cnc-01/SPINDLE-OVERLOAD/shelve',
    { actor: 'stack smoke', reason: 'refused', durationMs: 60_000, version: 0 },
  ],
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

const patch = await send('PATCH', refused, page, body);
if (patch.status !== 403) fail(`PATCH through the web answered ${patch.status}, not 403`);
console.log('ok: nginx passes only GET, POST, PUT and DELETE under /api/ (PATCH refused, 403)');

if (process.env.SMOKE_WRITES !== '1') {
  console.log('skipped: a write through the web (set SMOKE_WRITES=1, on a disposable database)');
  process.exit(0);
}

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
const coded = await code({ segments, codedBy: 'stack smoke' }, 0);
if (coded.status !== 200) fail(`coding ${record.id} answered ${coded.status}: ${coded.text}`);
const codedRecord = JSON.parse(coded.text).record;
if (codedRecord.reason !== reason || codedRecord.codings.length !== 1) {
  fail(`coding not applied: ${coded.text}`);
}
const cleared = await code({ segments: [], codedBy: 'stack smoke' }, 1);
if (cleared.status !== 200)
  fail(`clearing ${record.id} answered ${cleared.status}: ${cleared.text}`);
if (JSON.parse(cleared.text).record.codings.length !== 0) fail('codings not cleared');
const audit = await getJson(`/api/v1/downtime/${encodeURIComponent(record.id)}/audit`);
const actions = audit.entries
  .slice(0, 2)
  .map((e) => `${e.action}:${e.actor}`)
  .join(',');
if (actions !== 'cleared:stack smoke,coded:stack smoke') fail(`audit: ${actions}`);
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
const acked = await send('POST', ackPath, page, JSON.stringify({ actor: 'stack smoke' }));
if (acked.status !== 200)
  fail(`acknowledging ${occurrence.id} answered ${acked.status}: ${acked.text}`);
const ackResult = JSON.parse(acked.text);
if (!ackResult.changed || ackResult.occurrence.acknowledged?.by !== 'stack smoke') {
  fail(`acknowledgement not applied: ${acked.text}`);
}
const again = await send('POST', ackPath, page, JSON.stringify({ actor: 'stack smoke' }));
if (again.status !== 200 || JSON.parse(again.text).changed !== false) {
  fail(`a second acknowledgement of ${occurrence.id} changed it: ${again.text}`);
}
const alarmHistory = await getJson(`/api/v1/alarms/${encodeURIComponent(occurrence.id)}/history`);
const acks = alarmHistory.entries.filter((e) => e.source === 'audit' && e.transition === 'ack');
if (acks.length !== 1 || acks[0].actor !== 'stack smoke' || acks[0].authenticated !== false) {
  fail(`alarm audit: ${JSON.stringify(acks)}`);
}
console.log(
  `ok: alarm acknowledged through the web with the page's origin (${occurrence.id}, audited once)`,
);
