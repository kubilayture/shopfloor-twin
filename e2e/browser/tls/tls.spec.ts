import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { SECURE_SESSION_COOKIE } from '@shopfloor/contracts/identity';
import { createCertificateAuthority, issueTlsServerCertificate, spkiSha256 } from '@shopfloor/pki';
import { WEB_SPKI_ENV } from '@shopfloor/test-kit/tls';
import { account, logIn } from '../login.ts';

/**
 * The HTTPS front (P9-14, ADR-0039, security checklist S4), in the browser the harness launched
 * with `--ignore-certificate-errors-spki-list` for this stack's nginx key alone (never
 * `ignoreHTTPSErrors`). Runs in the reconciliation's `orders-dispatch` project (the gate) and in
 * `pnpm test:console`:
 *
 * - the page comes over TLS 1.3 with the certificate the pki step issued from the stack's dev CA;
 *   no Strict-Transport-Security header;
 * - a certificate other than the stack's, valid for the same names but of another key and CA, is
 *   refused by the same browser: the pin accepts one key, not "any certificate";
 * - so is one of the stack's own dev CA for the same names with another key (#241 review), minted
 *   by the harness inside the `pki` container (RECONCILE_WEB_SIBLING): the pin is the leaf's key,
 *   not the CA;
 * - plain HTTP to the web's port is answered 400 by nginx, with no redirect;
 * - a login sets `__Host-sft_session` with `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/` and no
 *   `Domain`.
 */
const web = process.env.RECONCILE_WEB_URL ?? '';
const pin = process.env[WEB_SPKI_ENV] ?? '';
let foreign: Server | undefined;
let foreignUrl = '';
let foreignSpki = '';
const siblingDir = process.env.RECONCILE_WEB_SIBLING ?? '';
let sibling: Server | undefined;
let siblingUrl = '';
let siblingSpki = '';

/** An HTTPS server on 127.0.0.1 presenting this certificate; resolves with its URL. */
async function serve(key: string, cert: string): Promise<{ server: Server; url: string }> {
  const server = createServer({ key, cert }, (_request, response) => {
    response.end('<p>not the stack</p>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, url: `https://127.0.0.1:${String((server.address() as AddressInfo).port)}/` };
}

test.beforeAll(async () => {
  test.skip(web === '' || pin === '', 'runs inside pnpm test:reconcile or pnpm test:console');
  // Another CA and another key, for the very names of the web certificate (localhost, 127.0.0.1).
  const now = new Date();
  const ca = await createCertificateAuthority({
    commonName: 'not the stack',
    validityDays: 2,
    now,
  });
  const material = await issueTlsServerCertificate(ca, {
    commonName: 'shopfloor-twin web',
    dnsNames: ['localhost'],
    ipAddresses: ['127.0.0.1'],
    validityDays: 1,
    now,
  });
  foreignSpki = spkiSha256(material.certificatePem);
  ({ server: foreign, url: foreignUrl } = await serve(
    material.privateKeyPem,
    material.certificatePem,
  ));
  if (siblingDir !== '') {
    const cert = readFileSync(join(siblingDir, 'sibling.pem'), 'utf8');
    siblingSpki = spkiSha256(cert);
    ({ server: sibling, url: siblingUrl } = await serve(
      readFileSync(join(siblingDir, 'sibling-key.pem'), 'utf8'),
      cert,
    ));
  }
});

test.afterAll(() => {
  foreign?.close();
  sibling?.close();
});

test("the page comes over TLS 1.3 with the pki step's certificate, without HSTS", async ({
  page,
}) => {
  expect(web).toMatch(/^https:\/\//);
  const response = await page.goto('/');
  expect(response?.ok()).toBe(true);
  expect(new URL(page.url()).protocol).toBe('https:');
  const details = await response?.securityDetails();
  expect(details?.protocol).toBe('TLS 1.3');
  expect(details?.issuer).toBe('shopfloor-twin dev CA');
  expect(details?.subjectName).toBe('shopfloor-twin web');
  expect(await response?.headerValue('strict-transport-security')).toBeNull();
});

test('the same browser refuses a certificate other than the stack’s', async ({ page }) => {
  expect(foreignSpki).not.toBe(pin);
  await expect(page.goto(foreignUrl)).rejects.toThrow(/net::ERR_CERT_AUTHORITY_INVALID/);
});

test("the same browser refuses a certificate of the stack's own dev CA with another key", async ({
  page,
}) => {
  expect(siblingDir, 'RECONCILE_WEB_SIBLING (the harness mints it)').not.toBe('');
  expect(siblingSpki).not.toBe(pin);
  await expect(page.goto(siblingUrl)).rejects.toThrow(/net::ERR_CERT_AUTHORITY_INVALID/);
});

test('plain HTTP to the web port is answered 400, without a redirect', async () => {
  const plain = new URL(web);
  plain.protocol = 'http:';
  const response = await fetch(plain, { redirect: 'manual' });
  expect(response.status).toBe(400);
  expect(response.headers.get('location')).toBeNull();
  expect(await response.text()).toContain('The plain HTTP request was sent to HTTPS port');
});

test('a login sets the __Host- session cookie, Secure, HttpOnly and SameSite=Strict', async ({
  page,
}) => {
  await logIn(page, account('admin'));
  const cookies = (await page.context().cookies()).filter((c) => c.name.includes('sft_session'));
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toMatchObject({
    name: SECURE_SESSION_COOKIE,
    domain: new URL(web).hostname,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
  });
});
