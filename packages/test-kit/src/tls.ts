/**
 * Harness trust of the HTTPS front (P9-14, ADR-0039): a harness trusts exactly the stack it
 * started, never "any certificate".
 *
 * - Node clients trust the stack's dev CA: a child process through `NODE_EXTRA_CA_CERTS` (read by
 *   Node only when a process starts), the harness's own process through
 *   `tls.setDefaultCACertificates` (the same default store, set after the stack is up).
 * - Playwright's Chromium reads neither, and `ignoreHTTPSErrors` would accept any certificate
 *   (weakening checklist S4), so it is launched with `--ignore-certificate-errors-spki-list` set to
 *   the SPKI hash of this stack's nginx certificate: it accepts that one key and no other.
 *
 * The CA and the server certificate are read from the stack's own volume (through the web
 * container), never taken from the handshake, and the handshake must then present that very
 * certificate.
 */
import { X509Certificate } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import tls from 'node:tls';
import { spkiSha256 } from '@shopfloor/pki';

/** The environment variable a Playwright run reads the stack's SPKI pin from. */
export const WEB_SPKI_ENV = 'RECONCILE_WEB_SPKI';

/** Chromium's argument accepting only the key whose SPKI hash this is. */
export const chromiumSpkiArgument = (spki: string): string =>
  `--ignore-certificate-errors-spki-list=${spki}`;

/** Trust `caPem` in this process besides the CAs it already trusts (fetch, WebSocket, https). */
export function trustInProcess(caPem: string): void {
  const current = tls.getCACertificates('default');
  if (current.includes(caPem)) return;
  tls.setDefaultCACertificates([...current, caPem]);
}

/**
 * The certificate the TLS server at `url` presents, the handshake verified against `ca` alone (and
 * the URL's host name). Rejects when the handshake fails.
 */
export function presentedCertificate(url: string, ca: string): Promise<X509Certificate> {
  const { hostname, port } = new URL(url);
  const isAddress = /^[\d.]+$/.test(hostname);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: hostname,
      port: Number(port),
      ca,
      ...(isAddress ? {} : { servername: hostname }),
    });
    socket.setTimeout(10_000, () => {
      socket.destroy(new Error(`TLS handshake with ${url} timed out`));
    });
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerX509Certificate();
      const protocol = socket.getProtocol();
      socket.end();
      if (certificate === undefined) reject(new Error(`${url} presented no certificate`));
      else if (protocol !== 'TLSv1.3') reject(new Error(`${url} negotiated ${String(protocol)}`));
      else resolve(certificate);
    });
    socket.once('error', reject);
  });
}

export interface WebTrust {
  readonly url: string;
  /** The dev CA's certificate, written to a file for NODE_EXTRA_CA_CERTS. */
  readonly caFile: string;
  readonly caPem: string;
  /** SHA-256 of the nginx certificate's SPKI, base64: Chromium's pin. */
  readonly spki: string;
  /** For child processes: NODE_EXTRA_CA_CERTS and the Playwright pin. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Checks and installs the trust of a stack's web front: the server certificate must be issued by
 * the CA, the handshake at `url` must present exactly it (TLS 1.3), then this process trusts the
 * CA and the returned environment makes children trust it (Node) or pin its key (Chromium).
 */
export async function establishWebTrust(options: {
  readonly url: string;
  readonly caPem: string;
  readonly serverPem: string;
  /** A directory of the run's own (mode 700) for the CA file. */
  readonly dir: string;
}): Promise<WebTrust> {
  const ca = new X509Certificate(options.caPem);
  const server = new X509Certificate(options.serverPem);
  if (!ca.ca || !server.checkIssued(ca) || !server.verify(ca.publicKey)) {
    throw new Error("the web certificate is not issued by the stack's dev CA");
  }
  const presented = await presentedCertificate(options.url, options.caPem);
  if (presented.fingerprint256 !== server.fingerprint256) {
    throw new Error(
      `${options.url} presented ${presented.fingerprint256}, not the pki step's ${server.fingerprint256}`,
    );
  }
  const caFile = join(options.dir, 'dev-ca.pem');
  await writeFile(caFile, options.caPem, { mode: 0o644 });
  trustInProcess(options.caPem);
  const spki = spkiSha256(options.serverPem);
  return {
    url: options.url,
    caFile,
    caPem: options.caPem,
    spki,
    env: { NODE_EXTRA_CA_CERTS: caFile, [WEB_SPKI_ENV]: spki },
  };
}
