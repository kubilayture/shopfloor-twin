import { X509Certificate, createHash, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEV_CA_IDENTITY,
  NAME_CONSTRAINTS_OID,
  WEB_IDENTITY,
  certificateAuthorityFrom,
  createCertificateAuthority,
  devCaFiles,
  ensureWebTls,
  inspectCertificate,
  issueTlsServerCertificate,
  sha256Fingerprint,
  spkiSha256,
  webTlsFiles,
} from './index.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

let root: string;
let options: { ca: string; web: string };
const servers: Server[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'shopfloor-twin-tls-test-'));
  options = { ca: join(root, 'ca'), web: join(root, 'web') };
});

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await rm(root, { recursive: true, force: true });
});

const read = (path: string) => readFile(path, 'utf8');
const actions = (result: Awaited<ReturnType<typeof ensureWebTls>>) =>
  result.identities.map((identity) => `${identity.name}:${identity.action}`);

/** An HTTPS server on 127.0.0.1 with this key and certificate; resolves with its port. */
async function serve(key: string, cert: string): Promise<number> {
  const server = createServer({ key, cert, minVersion: 'TLSv1.3' }, (_request, response) => {
    response.end('ok');
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}

/** A TLS handshake to 127.0.0.1:port as `servername`: the peer certificate, or the error code. */
function handshake(
  port: number,
  ca: string | undefined,
  servername: string,
): Promise<{ readonly certificate?: X509Certificate; readonly error?: string }> {
  return new Promise((done) => {
    const socket = connect({
      host: '127.0.0.1',
      port,
      // An address is checked against the SAN's IP addresses (no SNI for an address).
      ...(servername === '127.0.0.1' ? {} : { servername }),
      ...(ca === undefined ? {} : { ca }),
    });
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerX509Certificate();
      socket.destroy();
      done(certificate ? { certificate } : { error: 'no certificate' });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      done({ error: `${error.code ?? ''}: ${error.message}` });
    });
  });
}

describe('ensureWebTls, the dev CA and the web certificate (ADR-0039)', () => {
  it('makes a name-constrained CA, keeps its key in private/, and issues the web certificate', async () => {
    const result = await ensureWebTls(options);
    expect(actions(result)).toEqual([`${DEV_CA_IDENTITY}:created`, `${WEB_IDENTITY}:created`]);

    const ca = devCaFiles(options.ca);
    const caPem = await read(ca.certificateFile);
    const caCertificate = new X509Certificate(caPem);
    expect(caCertificate.ca).toBe(true);
    // A year (#241 review), TLS servers only.
    const caDays = (new Date(caCertificate.validTo).getTime() - Date.now()) / DAY_MS;
    expect(caDays).toBeGreaterThan(364);
    expect(caDays).toBeLessThan(366);
    expect(inspectCertificate(caPem).extendedKeyUsages).toEqual([SERVER_AUTH]);
    expect((await stat(ca.privateKeyFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(options.ca, 'private'))).mode & 0o777).toBe(0o700);
    const authority = await certificateAuthorityFrom(caPem, await read(ca.privateKeyFile));
    const constraints = authority.certificate.getExtension(NAME_CONSTRAINTS_OID);
    expect(constraints?.critical).toBe(true);

    const web = webTlsFiles(options.web);
    const webPem = await read(web.certificateFile);
    const info = inspectCertificate(webPem);
    expect(info.dnsNames).toEqual(['localhost']);
    expect(info.ipAddresses).toEqual(['127.0.0.1']);
    expect(info.uris).toEqual([]);
    expect(info.extendedKeyUsages).toEqual([SERVER_AUTH]);
    expect(info.keyCertSign).toBe(false);
    const leaf = new X509Certificate(webPem);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(caCertificate) && leaf.verify(caCertificate.publicKey)).toBe(true);
    // Only the public CA certificate is exported beside nginx's material, never the CA key.
    expect(await read(web.caFile)).toBe(caPem);
    expect((await stat(web.privateKeyFile)).mode & 0o777).toBe(0o600);
    expect(result.caFingerprint).toBe(caCertificate.fingerprint256);
  });

  it('pins the SPKI of the web key: the hash of the key, not of the certificate', async () => {
    const result = await ensureWebTls(options);
    const web = webTlsFiles(options.web);
    const fromKey = createHash('sha256')
      .update(
        createPublicKey(await read(web.privateKeyFile)).export({ type: 'spki', format: 'der' }),
      )
      .digest('base64');
    expect(result.webSpki).toBe(fromKey);
    expect(spkiSha256(await read(web.certificateFile))).toBe(fromKey);
    expect(sha256Fingerprint(await read(web.caFile))).toBe(result.caFingerprint);
  });

  it('keeps valid material, renews the web certificate near expiry and everything with a new CA', async () => {
    const first = await ensureWebTls(options);
    const again = await ensureWebTls(options);
    expect(actions(again)).toEqual([`${DEV_CA_IDENTITY}:kept`, `${WEB_IDENTITY}:kept`]);
    expect(again.webSpki).toBe(first.webSpki);

    // 340 days on, both (a year each) are within 30 days of their end: a new CA and a new web.
    const later = await ensureWebTls({ ...options, now: new Date(Date.now() + 340 * DAY_MS) });
    expect(actions(later)).toEqual([`${DEV_CA_IDENTITY}:renewed`, `${WEB_IDENTITY}:renewed`]);
    expect(later.identities[0]?.reason).toMatch(/within 30 days/);
    expect(later.webSpki).not.toBe(first.webSpki);

    // A web certificate renewed alone never outlives its CA: both end together.
    const sixMonths = new Date(Date.now() + 180 * DAY_MS);
    const renewedWeb = await ensureWebTls({ ...options, renew: ['web'], now: sixMonths });
    expect(actions(renewedWeb)).toEqual([`${DEV_CA_IDENTITY}:kept`, `${WEB_IDENTITY}:renewed`]);
    const caEnd = new X509Certificate(await read(devCaFiles(options.ca).certificateFile)).validTo;
    const webEnd = new X509Certificate(await read(webTlsFiles(options.web).certificateFile))
      .validTo;
    expect(Date.parse(webEnd)).toBeLessThanOrEqual(Date.parse(caEnd));

    const renewedCa = await ensureWebTls({ ...options, renew: ['dev-ca'] });
    expect(actions(renewedCa)).toEqual([`${DEV_CA_IDENTITY}:renewed`, `${WEB_IDENTITY}:renewed`]);
    expect(renewedCa.identities[1]?.reason).toBe('the dev CA is new');
    expect(renewedCa.caFingerprint).not.toBe(first.caFingerprint);
    expect(sha256Fingerprint(await read(webTlsFiles(options.web).caFile))).toBe(
      renewedCa.caFingerprint,
    );
  });

  it('replaces a web certificate another CA issued, and a CA without the name constraints', async () => {
    await ensureWebTls(options);
    const foreignCa = await createCertificateAuthority({
      commonName: 'foreign',
      validityDays: 400,
      now: new Date(),
    });
    const foreign = await issueTlsServerCertificate(foreignCa, {
      commonName: 'foreign web',
      dnsNames: ['localhost'],
      ipAddresses: ['127.0.0.1'],
      validityDays: 365,
      now: new Date(),
    });
    const web = webTlsFiles(options.web);
    await writeFile(web.certificateFile, foreign.certificatePem);
    await writeFile(web.privateKeyFile, foreign.privateKeyPem);
    const replaced = await ensureWebTls(options);
    expect(replaced.identities[1]).toMatchObject({
      action: 'renewed',
      reason: 'not issued by the current dev CA',
    });

    // A CA the owner might have made by hand, without the EKU or without the constraints:
    // replaced (and so the web too).
    const ca = devCaFiles(options.ca);
    await writeFile(ca.certificateFile, foreignCa.certificatePem);
    await writeFile(ca.privateKeyFile, foreignCa.privateKeyPem);
    const again = await ensureWebTls(options);
    expect(again.identities[0]).toMatchObject({
      action: 'renewed',
      reason: 'extended key usage missing',
    });
    expect(again.identities[1]?.action).toBe('renewed');
    const unconstrained = await createCertificateAuthority({
      commonName: 'unconstrained',
      validityDays: 400,
      now: new Date(),
      extendedKeyUsages: [SERVER_AUTH],
    });
    await writeFile(ca.certificateFile, unconstrained.certificatePem);
    await writeFile(ca.privateKeyFile, unconstrained.privateKeyPem);
    expect((await ensureWebTls(options)).identities[0]).toMatchObject({
      action: 'renewed',
      reason: 'name constraints differ',
    });
  });

  it("gives the web key nginx's group, readable by the group only (0640)", async () => {
    const group = process.getgid?.() ?? 0;
    await ensureWebTls({ ...options, keyGroup: group });
    const key = await stat(webTlsFiles(options.web).privateKeyFile);
    expect(key.mode & 0o777).toBe(0o640);
    expect(key.gid).toBe(group);
    // A kept key gets the same access again.
    await ensureWebTls(options);
    expect((await stat(webTlsFiles(options.web).privateKeyFile)).mode & 0o777).toBe(0o600);
  });

  it('refuses an unknown identity to renew and a validity renewal would undo at once', async () => {
    await expect(ensureWebTls({ ...options, renew: ['cnc-01'] })).rejects.toThrow(
      /not a TLS identity: cnc-01/,
    );
    await expect(ensureWebTls({ ...options, validityDays: 30 })).rejects.toThrow(/exceed 30/);
  });
});

describe('TLS with the dev CA (what nginx and the harnesses do)', () => {
  it('serves the web certificate to a client trusting the CA, by name and by address', async () => {
    await ensureWebTls(options);
    const web = webTlsFiles(options.web);
    const port = await serve(await read(web.privateKeyFile), await read(web.certificateFile));
    const ca = await read(web.caFile);
    const served = new X509Certificate(await read(web.certificateFile));
    for (const name of ['localhost', '127.0.0.1']) {
      const answer = await handshake(port, ca, name);
      expect(answer.error).toBeUndefined();
      expect(answer.certificate?.fingerprint256).toBe(served.fingerprint256);
    }
    // Without the dev CA the certificate is not trusted; with it, another name is refused.
    expect((await handshake(port, undefined, 'localhost')).error).toMatch(
      /^UNABLE_TO_VERIFY_LEAF_SIGNATURE:/,
    );
    expect((await handshake(port, ca, 'example.com')).error).toMatch(
      /^ERR_TLS_CERT_ALTNAME_INVALID:/,
    );
  });

  it('refuses a certificate the dev CA signed for a name outside its constraints', async () => {
    await ensureWebTls(options);
    const files = devCaFiles(options.ca);
    const ca = await certificateAuthorityFrom(
      await read(files.certificateFile),
      await read(files.privateKeyFile),
    );
    // What someone holding the CA key could sign: rejected by the client's own verification.
    const outside = await issueTlsServerCertificate(ca, {
      commonName: 'example.com',
      dnsNames: ['example.com'],
      ipAddresses: [],
      validityDays: 365,
      now: new Date(),
    });
    const port = await serve(outside.privateKeyPem, outside.certificatePem);
    expect((await handshake(port, ca.certificatePem, 'example.com')).error).toMatch(
      /permitted subtree violation/,
    );
  });
});
