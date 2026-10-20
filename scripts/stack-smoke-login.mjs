// Login attempts from a probe container on the Compose network (#242, P9-15, checklist S5): run by
// scripts/stack-smoke.sh as `docker exec -i <probe> node - <mode> <count> < this file`, so each probe
// is a client address of its own. Through the web front (`SMOKE_LOGIN_TARGET=web`, the default:
// https://web:8443 with the dev CA from `SMOKE_LOGIN_CA` and `localhost` as the TLS name), or
// straight to the MES on the default network (`mes`: http://mes:4700, with `SMOKE_LOGIN_SPOOF` as a
// forged `X-Real-IP`, which the MES must not believe from there). The user name and password come
// from the environment (`SMOKE_LOGIN_USERNAME`, `SMOKE_LOGIN_PASSWORD`), never from argv.
//
// Modes, one line per answer on stdout (`<status> <retry-after or ->`):
// - `address`: this probe's address on the network (no request);
// - `sequence <count> [pace ms]`: count attempts one after the other, `pace` apart (default 1100,
//   inside the MES's per-name login bucket of 1 per second);
// - `drive <count>`: attempts until `count` were judged (401 or 200), waiting out each 429's
//   Retry-After; prints the judged answers only;
// - `burst <count>`: count attempts at once; then a last line `elapsed <ms>`.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { networkInterfaces } from 'node:os';

const [mode = '', countText = '1', paceText = '1100'] = process.argv.slice(2);
const count = Number(countText);
const pace = Number(paceText);
const target = process.env.SMOKE_LOGIN_TARGET ?? 'web';
const username = process.env.SMOKE_LOGIN_USERNAME ?? '';
const password = process.env.SMOKE_LOGIN_PASSWORD ?? '';

const fail = (message) => {
  console.error(`probe: ${message}`);
  process.exit(1);
};

if (mode === 'address') {
  const own = Object.values(networkInterfaces())
    .flat()
    .find((info) => info !== undefined && !info.internal && info.family === 'IPv4');
  if (own === undefined) fail('no IPv4 address');
  console.log(own.address);
  process.exit(0);
}
if (username === '' || password === '')
  fail('SMOKE_LOGIN_USERNAME and SMOKE_LOGIN_PASSWORD needed');

/** One login; resolves with `<status> <retry-after or ->`. */
function attempt() {
  const body = JSON.stringify({ username, password });
  const web = target === 'web';
  const host = web ? 'localhost:8443' : 'localhost:4700';
  const options = {
    host: web ? 'web' : 'mes',
    port: web ? 8443 : 4700,
    method: 'POST',
    path: '/api/v1/session',
    agent: false,
    headers: {
      host,
      origin: `${web ? 'https' : 'http'}://${host}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...(web || process.env.SMOKE_LOGIN_SPOOF === undefined
        ? {}
        : { 'x-real-ip': process.env.SMOKE_LOGIN_SPOOF }),
    },
    ...(web
      ? { servername: 'localhost', ca: process.env.SMOKE_LOGIN_CA, minVersion: 'TLSv1.3' }
      : {}),
  };
  return new Promise((resolve, reject) => {
    const req = (web ? httpsRequest : httpRequest)(options, (res) => {
      res.resume();
      res.on('end', () => {
        const retry = res.headers['retry-after'];
        resolve(`${String(res.statusCode)} ${typeof retry === 'string' ? retry : '-'}`);
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  if (mode === 'sequence') {
    for (let i = 0; i < count; i++) {
      if (i > 0) await sleep(pace);
      console.log(await attempt());
    }
  } else if (mode === 'drive') {
    let judged = 0;
    while (judged < count) {
      const answer = await attempt();
      const [status, retry] = answer.split(' ');
      if (status === '429') {
        await sleep(Number(retry) * 1000 + 200);
        continue;
      }
      console.log(answer);
      judged++;
      await sleep(pace);
    }
  } else if (mode === 'burst') {
    const started = Date.now();
    const answers = await Promise.all(Array.from({ length: count }, () => attempt()));
    for (const answer of answers) console.log(answer);
    console.log(`elapsed ${String(Date.now() - started)}`);
  } else {
    fail(`unknown mode ${mode}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
