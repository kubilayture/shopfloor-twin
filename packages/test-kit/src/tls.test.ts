import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  certificateAuthorityFrom,
  createCertificateAuthority,
  devCaFiles,
  ensureWebTls,
  issueTlsServerCertificate,
  spkiSha256,
  webTlsFiles,
} from '@shopfloor/pki';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WEB_SPKI_ENV, chromiumSpkiArgument, establishWebTrust } from './tls.ts';

let root: string;
const servers: Server[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'shopfloor-twin-trust-test-'));
});

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await rm(root, { recursive: true, force: true });
});

async function serve(key: string, cert: string, maxVersion?: 'TLSv1.2'): Promise<string> {
  const server = createServer({ key, cert, ...(maxVersion ? { maxVersion } : {}) }, (_q, r) => {
    r.end('ok');
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

const read = (path: string) => readFile(path, 'utf8');

describe('establishWebTrust (ADR-0039)', () => {
  it("trusts the stack's CA in this process and pins the served key for Chromium", async () => {
    const result = await ensureWebTls({ ca: join(root, 'ca'), web: join(root, 'web') });
    const web = webTlsFiles(join(root, 'web'));
    const serverPem = await read(web.certificateFile);
    const url = await serve(await read(web.privateKeyFile), serverPem);
    const trust = await establishWebTrust({
      url,
      caPem: await read(web.caFile),
      serverPem,
      dir: root,
    });
    expect(trust.spki).toBe(result.webSpki);
    expect(trust.env).toEqual({ NODE_EXTRA_CA_CERTS: trust.caFile, [WEB_SPKI_ENV]: trust.spki });
    expect(await read(trust.caFile)).toBe(trust.caPem);
    // fetch now verifies the stack's certificate against the dev CA.
    expect(await (await fetch(url)).text()).toBe('ok');
    expect(chromiumSpkiArgument(trust.spki)).toBe(
      `--ignore-certificate-errors-spki-list=${result.webSpki}`,
    );
  });

  it('refuses a server presenting another certificate, one of another CA, or TLS 1.2', async () => {
    await ensureWebTls({ ca: join(root, 'ca'), web: join(root, 'web') });
    const web = webTlsFiles(join(root, 'web'));
    const caPem = await read(web.caFile);
    const serverPem = await read(web.certificateFile);
    const ca = devCaFiles(join(root, 'ca'));
    const authority = await certificateAuthorityFrom(
      await read(ca.certificateFile),
      await read(ca.privateKeyFile),
    );
    const request = {
      commonName: 'other',
      dnsNames: ['localhost'],
      ipAddresses: ['127.0.0.1'],
      validityDays: 365,
      now: new Date(),
    };
    // Same CA, another key: valid for the CA, but not the certificate the pki step wrote.
    const sibling = await issueTlsServerCertificate(authority, request);
    expect(spkiSha256(sibling.certificatePem)).not.toBe(spkiSha256(serverPem));
    const siblingUrl = await serve(sibling.privateKeyPem, sibling.certificatePem);
    await expect(
      establishWebTrust({ url: siblingUrl, caPem, serverPem, dir: root }),
    ).rejects.toThrow(/presented .*, not the pki step's/);
    const foreignCa = await createCertificateAuthority({
      commonName: 'foreign',
      validityDays: 400,
      now: new Date(),
    });
    const foreign = await issueTlsServerCertificate(foreignCa, request);
    const foreignUrl = await serve(foreign.privateKeyPem, foreign.certificatePem);
    await expect(
      establishWebTrust({ url: foreignUrl, caPem, serverPem, dir: root }),
    ).rejects.toThrow(/certificate/);
    await expect(
      establishWebTrust({
        url: foreignUrl,
        caPem,
        serverPem: foreign.certificatePem,
        dir: root,
      }),
    ).rejects.toThrow(/not issued by the stack's dev CA/);
    const oldUrl = await serve(await read(web.privateKeyFile), serverPem, 'TLSv1.2');
    await expect(establishWebTrust({ url: oldUrl, caPem, serverPem, dir: root })).rejects.toThrow(
      /negotiated TLSv1\.2/,
    );
  });
});
