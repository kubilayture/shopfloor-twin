// Stack smoke, part 2 (#99): the web container serves the app and proxies the MES API and its
// WebSocket within the MES's Host and Origin checks. Run by scripts/stack-smoke.sh on the host,
// with Node.js 26 (built-in fetch and WebSocket, no dependencies), so the requests carry the
// Host and Origin a browser on this machine would send.
// Usage: node scripts/stack-smoke-web.mjs [web base URL, default http://127.0.0.1:8080]

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
const foreign = await snapshot('http://evil.test').then(
  () => true,
  () => false,
);
if (foreign) fail('WebSocket accepted from a foreign Origin');
console.log('ok: WebSocket from a foreign Origin refused');
