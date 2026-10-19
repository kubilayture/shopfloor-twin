import { X509Certificate, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, chown, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  NAME_CONSTRAINTS_OID,
  certificateAuthorityFrom,
  createCertificateAuthority,
  issueTlsServerCertificate,
  nameConstraintsExtension,
  type CertificateAuthority,
  type PermittedNames,
} from './ca.ts';
import { inspectCertificate, keyMatchesCertificate } from './certificate.ts';
import { RENEW_WITHIN_DAYS, type IdentityResult } from './exchange.ts';

/**
 * The HTTPS front's PKI (P9-14, ADR-0039), run by the same `pki` step as the OPC UA material: a dev
 * CA per stack, whose key lives only in the `pki-ca` volume, and nginx's server certificate issued
 * by it into the `web-tls` volume, with the CA certificate (public) beside it for the harnesses and
 * the owner to trust. Separate from OPC UA trust: no OPC UA folder ever holds the CA or this
 * certificate (OPC UA pins leaf certificates, ADR-0038).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

/** The identity names of `PKI_RENEW` this module answers. */
export const DEV_CA_IDENTITY = 'dev-ca';
export const WEB_IDENTITY = 'web';
export const TLS_IDENTITIES = [DEV_CA_IDENTITY, WEB_IDENTITY] as const;

/**
 * The names in the web certificate's SAN: the host names the browser and every harness use (the
 * published port is on 127.0.0.1 only, so `::1` can't reach it; a container on the Compose network
 * connects to `web` with `localhost` as the TLS server name). The dev CA may sign for these names
 * only (name constraints), so a leaked CA key can't impersonate another site to a browser that
 * trusts it.
 */
export const WEB_DNS_NAMES = ['localhost'] as const;
export const WEB_IP_ADDRESSES = ['127.0.0.1'] as const;
export const DEV_CA_PERMITTED: PermittedNames = {
  dnsNames: WEB_DNS_NAMES,
  ipv4Addresses: WEB_IP_ADDRESSES,
};

/**
 * The dev CA's validity (#241 review: a year, not five): renewed by the step like every other
 * certificate, the web certificate with it; the owner then trusts the new one.
 */
export const DEV_CA_VALIDITY_DAYS = 365;
/** The web certificate's validity (below Apple's 825-day limit for TLS server certificates). */
export const WEB_VALIDITY_DAYS = 365;

export interface DevCaFiles {
  readonly certificateFile: string;
  readonly privateKeyFile: string;
}

/** The `pki-ca` volume: the CA certificate and, in `private/` (0700), its key (0600). */
export function devCaFiles(root: string): DevCaFiles {
  return {
    certificateFile: join(root, 'ca.pem'),
    privateKeyFile: join(root, 'private', 'ca-key.pem'),
  };
}

export interface WebTlsFiles {
  readonly certificateFile: string;
  readonly privateKeyFile: string;
  /** The dev CA's certificate (public): what a client trusts. */
  readonly caFile: string;
}

/** The `web-tls` volume (mounted read-only by nginx at /etc/nginx/tls). */
export function webTlsFiles(root: string): WebTlsFiles {
  return {
    certificateFile: join(root, 'server.pem'),
    privateKeyFile: join(root, 'server-key.pem'),
    caFile: join(root, 'ca.pem'),
  };
}

/**
 * The SHA-256 of a certificate's SubjectPublicKeyInfo, base64: what Chromium's
 * `--ignore-certificate-errors-spki-list` takes (and HPKP's `pin-sha256` was).
 */
export function spkiSha256(certificatePem: string | Buffer): string {
  const der = new X509Certificate(certificatePem).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}

/** The SHA-256 fingerprint of a certificate, as browsers and `openssl x509 -fingerprint` show it. */
export function sha256Fingerprint(certificatePem: string | Buffer): string {
  return new X509Certificate(certificatePem).fingerprint256;
}

export interface EnsureWebTlsOptions {
  /** The `pki-ca` volume. */
  readonly ca: string;
  /** The `web-tls` volume. */
  readonly web: string;
  readonly now?: Date;
  readonly validityDays?: number;
  readonly caValidityDays?: number;
  /** `dev-ca` and/or `web` to renew whatever their state; renewing the CA renews `web` too. */
  readonly renew?: readonly string[];
  /**
   * The group nginx runs as in the web image (101): the key is then 0640 with this group, so nginx
   * (another user than the step's) can read it. Without it the key is 0600 (tests).
   */
  readonly keyGroup?: number;
}

export interface EnsureWebTlsResult {
  readonly identities: readonly IdentityResult[];
  /** `spkiSha256` of the web certificate: the pin a Chromium harness passes. */
  readonly webSpki: string;
  /** The dev CA certificate's SHA-256 fingerprint, for the owner to compare when trusting it. */
  readonly caFingerprint: string;
  readonly elapsedMs: number;
}

/**
 * Makes or keeps the dev CA and the web certificate (ADR-0039), with the same rule as the OPC UA
 * material: kept while valid for more than 30 days and still what the step would write, else
 * replaced. A new CA always brings a new web certificate; `ca.pem` in the web volume is always the
 * current CA's.
 */
export async function ensureWebTls(options: EnsureWebTlsOptions): Promise<EnsureWebTlsResult> {
  const started = performance.now();
  const now = options.now ?? new Date();
  const validityDays = options.validityDays ?? WEB_VALIDITY_DAYS;
  const caValidityDays = options.caValidityDays ?? DEV_CA_VALIDITY_DAYS;
  if (!(validityDays > RENEW_WITHIN_DAYS) || !(caValidityDays > RENEW_WITHIN_DAYS)) {
    throw new Error(`validity must exceed ${String(RENEW_WITHIN_DAYS)} days`);
  }
  const renew = options.renew ?? [];
  const unknown = renew.filter((name) => !(TLS_IDENTITIES as readonly string[]).includes(name));
  if (unknown.length > 0) throw new Error(`not a TLS identity: ${unknown.join(', ')}`);

  const caPaths = devCaFiles(options.ca);
  await mkdir(join(options.ca, 'private'), { recursive: true });
  await chmod(join(options.ca, 'private'), 0o700);
  const caReason = renew.includes(DEV_CA_IDENTITY)
    ? 'renewal requested'
    : await whyReplaceCa(caPaths, now);
  let ca: CertificateAuthority;
  if (caReason === undefined) {
    ca = await certificateAuthorityFrom(
      await readFile(caPaths.certificateFile, 'utf8'),
      await readFile(caPaths.privateKeyFile, 'utf8'),
    );
  } else {
    ca = await createCertificateAuthority({
      commonName: 'shopfloor-twin dev CA',
      validityDays: caValidityDays,
      now,
      permitted: DEV_CA_PERMITTED,
      // TLS servers only (#241 review): a chain through this CA serves no other purpose.
      extendedKeyUsages: [SERVER_AUTH],
    });
    await writeAtomically(caPaths.privateKeyFile, ca.privateKeyPem, 0o600);
    await writeAtomically(caPaths.certificateFile, ca.certificatePem, 0o644);
  }

  const webPaths = webTlsFiles(options.web);
  await mkdir(options.web, { recursive: true });
  const keyMode = options.keyGroup === undefined ? 0o600 : 0o640;
  const webReason = renew.includes(WEB_IDENTITY)
    ? 'renewal requested'
    : caReason !== undefined && existsSync(webPaths.certificateFile)
      ? 'the dev CA is new'
      : await whyReplaceWeb(webPaths, ca.certificatePem, now);
  let webPem: string;
  if (webReason === undefined) {
    webPem = await readFile(webPaths.certificateFile, 'utf8');
    // The group and mode follow the options also for a kept key.
    await setKeyAccess(webPaths.privateKeyFile, keyMode, options.keyGroup);
  } else {
    // Never past the CA's own end: both are then renewed together (a new CA brings a new leaf).
    const caDaysLeft = Math.floor((ca.certificate.notAfter.getTime() - now.getTime()) / DAY_MS);
    const material = await issueTlsServerCertificate(ca, {
      commonName: 'shopfloor-twin web',
      dnsNames: WEB_DNS_NAMES,
      ipAddresses: WEB_IP_ADDRESSES,
      validityDays: Math.min(validityDays, caDaysLeft),
      now,
    });
    await writeAtomically(
      webPaths.privateKeyFile,
      material.privateKeyPem,
      keyMode,
      options.keyGroup,
    );
    await writeAtomically(webPaths.certificateFile, material.certificatePem, 0o644);
    webPem = material.certificatePem;
  }
  const exported = existsSync(webPaths.caFile) ? await readFile(webPaths.caFile, 'utf8') : '';
  if (exported !== ca.certificatePem) {
    await writeAtomically(webPaths.caFile, ca.certificatePem, 0o644);
  }

  const result = (
    name: string,
    folder: string,
    pem: string,
    reason: string | undefined,
  ): IdentityResult => {
    const info = inspectCertificate(pem);
    const action = reason === undefined ? 'kept' : reason === 'none yet' ? 'created' : 'renewed';
    return {
      name,
      applicationUri: '',
      folder,
      action,
      ...(action === 'renewed' && reason !== undefined ? { reason } : {}),
      notAfter: info.notAfter,
      thumbprint: info.thumbprint,
    };
  };
  return {
    identities: [
      result(DEV_CA_IDENTITY, options.ca, ca.certificatePem, caReason),
      result(WEB_IDENTITY, options.web, webPem, webReason),
    ],
    webSpki: spkiSha256(webPem),
    caFingerprint: sha256Fingerprint(ca.certificatePem),
    elapsedMs: performance.now() - started,
  };
}

const expiresSoon = (notAfter: Date, now: Date) =>
  notAfter.getTime() - now.getTime() <= RENEW_WITHIN_DAYS * DAY_MS;

async function whyReplaceCa(files: DevCaFiles, now: Date): Promise<string | undefined> {
  const hasCertificate = existsSync(files.certificateFile);
  const hasKey = existsSync(files.privateKeyFile);
  if (!hasCertificate && !hasKey) return 'none yet';
  if (!hasCertificate || !hasKey) return 'certificate or key missing';
  try {
    const pem = await readFile(files.certificateFile, 'utf8');
    const certificate = new X509Certificate(pem);
    if (!certificate.ca) return 'not a CA certificate';
    const usages = inspectCertificate(pem).extendedKeyUsages;
    if (usages.length !== 1 || usages[0] !== SERVER_AUTH) {
      return `extended key usage ${usages.join(', ') || 'missing'}`;
    }
    if (expiresSoon(new Date(certificate.validTo), now)) {
      return `expires ${new Date(certificate.validTo).toISOString()}, within ${String(RENEW_WITHIN_DAYS)} days`;
    }
    const authority = await certificateAuthorityFrom(
      pem,
      await readFile(files.privateKeyFile, 'utf8'),
    );
    const constraints = authority.certificate.getExtension(NAME_CONSTRAINTS_OID);
    const wanted = nameConstraintsExtension(DEV_CA_PERMITTED);
    if (
      constraints === null ||
      !constraints.critical ||
      !Buffer.from(constraints.value).equals(Buffer.from(wanted.value))
    ) {
      return 'name constraints differ';
    }
    if (!keyMatchesCertificate(await readFile(files.privateKeyFile, 'utf8'), pem)) {
      return 'key does not match the certificate';
    }
  } catch (error) {
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
}

async function whyReplaceWeb(
  files: WebTlsFiles,
  caPem: string,
  now: Date,
): Promise<string | undefined> {
  const hasCertificate = existsSync(files.certificateFile);
  const hasKey = existsSync(files.privateKeyFile);
  if (!hasCertificate && !hasKey) return 'none yet';
  if (!hasCertificate || !hasKey) return 'certificate or key missing';
  try {
    const pem = await readFile(files.certificateFile, 'utf8');
    const certificate = new X509Certificate(pem);
    const ca = new X509Certificate(caPem);
    if (!certificate.checkIssued(ca) || !certificate.verify(ca.publicKey)) {
      return 'not issued by the current dev CA';
    }
    const info = inspectCertificate(pem);
    if (expiresSoon(info.notAfter, now)) {
      return `expires ${info.notAfter.toISOString()}, within ${String(RENEW_WITHIN_DAYS)} days`;
    }
    const same = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && a.every((value, n) => value === b[n]);
    if (!same(info.dnsNames, WEB_DNS_NAMES) || !same(info.ipAddresses, WEB_IP_ADDRESSES)) {
      return `SAN ${[...info.dnsNames, ...info.ipAddresses].join(', ')}`;
    }
    if (info.uris.length > 0) return 'SAN with a URI (an OPC UA certificate)';
    if (info.extendedKeyUsages.length !== 1 || info.extendedKeyUsages[0] !== SERVER_AUTH) {
      return `extended key usage ${info.extendedKeyUsages.join(', ') || 'missing'}`;
    }
    if (!keyMatchesCertificate(await readFile(files.privateKeyFile, 'utf8'), pem)) {
      return 'key does not match the certificate';
    }
  } catch (error) {
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
}

async function setKeyAccess(path: string, mode: number, group: number | undefined): Promise<void> {
  // Group before mode: the key is never group-readable by a group other than nginx's.
  if (group !== undefined) await chown(path, -1, group);
  await chmod(path, mode);
}

async function writeAtomically(
  path: string,
  content: string,
  mode: number,
  group?: number,
): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await setKeyAccess(temporary, mode, group);
  await rename(temporary, path);
}
