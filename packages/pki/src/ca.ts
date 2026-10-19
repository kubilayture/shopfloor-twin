import { randomBytes } from 'node:crypto';
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { extendedKeyUsageOf, type CertificateRequest, type KeyPair } from './certificate.ts';

// A certificate authority: probe Q1 (#239) issues an OPC UA client certificate from one to record
// node-opcua's CRL behaviour (the reason OPC UA trust pins leaf certificates instead, ADR-0038);
// the dev CA of the HTTPS front (P9-14, ADR-0039) is built on it, with name constraints, and issues
// the web front's TLS server certificate (`issueTlsServerCertificate`).

// The global Web Crypto (Node's webcrypto): its types are the global `Crypto` and `CryptoKey`
// whether a consumer compiles with Node's types alone or with the DOM library too (e2e, P9-14).
x509.cryptoProvider.set(crypto);

const DAY_MS = 24 * 60 * 60 * 1000;
const ALGORITHM = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
} as const;

export interface CertificateAuthority {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly keys: KeyPair;
  readonly certificate: x509.X509Certificate;
}

function serial(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return bytes.toString('hex');
}

async function pem(key: CryptoKey): Promise<string> {
  return x509.PemConverter.encode(await crypto.subtle.exportKey('pkcs8', key), 'PRIVATE KEY');
}

/** Names a CA may issue for (RFC 5280 4.2.1.10): DNS subtrees and single IPv4 addresses. */
export interface PermittedNames {
  readonly dnsNames: readonly string[];
  readonly ipv4Addresses: readonly string[];
}

/** The OID of the name constraints extension. */
export const NAME_CONSTRAINTS_OID = '2.5.29.30';

function der(tag: number, ...parts: readonly Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  // Short-form lengths only: the constraints here are a few names.
  if (body.length > 127) throw new Error('name constraints too long');
  return Buffer.concat([Buffer.from([tag, body.length]), body]);
}

function ipv4Bytes(address: string): Buffer {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    throw new Error(`not an IPv4 address: ${address}`);
  }
  return Buffer.from(octets);
}

/**
 * A critical name constraints extension permitting only `names` (DER by hand: @peculiar/x509 has
 * no class for it). Each DNS name permits itself and its subdomains, each address itself (/32).
 */
export function nameConstraintsExtension(names: PermittedNames): x509.Extension {
  const subtrees = [
    ...names.dnsNames.map((name) => der(0x30, der(0x82, Buffer.from(name, 'ascii')))),
    ...names.ipv4Addresses.map((address) =>
      der(0x30, der(0x87, ipv4Bytes(address), Buffer.from([255, 255, 255, 255]))),
    ),
  ];
  // NameConstraints ::= SEQUENCE { permittedSubtrees [0] IMPLICIT GeneralSubtrees }
  return new x509.Extension(
    NAME_CONSTRAINTS_OID,
    true,
    new Uint8Array(der(0x30, der(0xa0, ...subtrees))),
  );
}

/**
 * A self-signed CA certificate (`keyCertSign`, `cRLSign`, CA:true, path length 0) and its key;
 * with `permitted`, a critical name constraints extension limiting what it may sign for; with
 * `extendedKeyUsages`, an extended key usage extension limiting the purposes of its chain
 * (OpenSSL and Node honour it on a CA; macOS needs the trust setting `-p ssl` besides, ADR-0039).
 */
export async function createCertificateAuthority(options: {
  readonly commonName: string;
  readonly validityDays: number;
  readonly now: Date;
  readonly permitted?: PermittedNames;
  readonly extendedKeyUsages?: readonly string[];
}): Promise<CertificateAuthority> {
  const keys = (await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])) as KeyPair;
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: [{ CN: [options.commonName] }, { O: ['Orbis Components (simulated)'] }],
    notBefore: new Date(options.now.getTime() - 60 * 60 * 1000),
    notAfter: new Date(options.now.getTime() + options.validityDays * DAY_MS),
    signingAlgorithm: ALGORITHM,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ...(options.permitted === undefined ? [] : [nameConstraintsExtension(options.permitted)]),
      ...(options.extendedKeyUsages === undefined
        ? []
        : [new x509.ExtendedKeyUsageExtension([...options.extendedKeyUsages], false)]),
    ],
  });
  return {
    certificatePem: `${certificate.toString('pem')}\n`,
    privateKeyPem: await pem(keys.privateKey),
    keys,
    certificate,
  };
}

/**
 * A TLS server certificate signed by `ca` (ADR-0039): RSA 2048, key usage `digitalSignature` and
 * `keyEncipherment`, extended key usage `serverAuth` only, the SAN's DNS names and IP addresses.
 */
export async function issueTlsServerCertificate(
  ca: CertificateAuthority,
  request: {
    readonly commonName: string;
    readonly dnsNames: readonly string[];
    readonly ipAddresses: readonly string[];
    readonly validityDays: number;
    readonly now: Date;
  },
): Promise<{ readonly certificatePem: string; readonly privateKeyPem: string }> {
  const keys = (await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])) as KeyPair;
  const certificate = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: [{ CN: [request.commonName] }, { O: ['Orbis Components (simulated)'] }],
    issuer: ca.certificate.subject,
    notBefore: new Date(request.now.getTime() - 60 * 60 * 1000),
    notAfter: new Date(request.now.getTime() + request.validityDays * DAY_MS),
    signingAlgorithm: ALGORITHM,
    publicKey: keys.publicKey,
    signingKey: ca.keys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
        true,
      ),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(ca.certificate),
      new x509.SubjectAlternativeNameExtension(
        [
          ...request.dnsNames.map((value) => ({ type: 'dns' as const, value })),
          ...request.ipAddresses.map((value) => ({ type: 'ip' as const, value })),
        ],
        false,
      ),
    ],
  });
  return {
    certificatePem: `${certificate.toString('pem')}\n`,
    privateKeyPem: await pem(keys.privateKey),
  };
}

/** A key and a certificate for `request`, signed by `ca` (OPC UA key usage, one EKU, SAN). */
export async function issueCertificate(
  ca: CertificateAuthority,
  request: CertificateRequest,
): Promise<{ readonly certificatePem: string; readonly privateKeyPem: string }> {
  const keys = (await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])) as KeyPair;
  const certificate = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: [{ CN: [request.commonName] }, { O: ['Orbis Components (simulated)'] }],
    issuer: ca.certificate.subject,
    notBefore: new Date(request.now.getTime() - 60 * 60 * 1000),
    notAfter: new Date(request.now.getTime() + request.validityDays * DAY_MS),
    signingAlgorithm: ALGORITHM,
    publicKey: keys.publicKey,
    signingKey: ca.keys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature |
          x509.KeyUsageFlags.nonRepudiation |
          x509.KeyUsageFlags.keyEncipherment |
          x509.KeyUsageFlags.dataEncipherment,
        true,
      ),
      new x509.ExtendedKeyUsageExtension([extendedKeyUsageOf(request.role)], false),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(ca.certificate),
      new x509.SubjectAlternativeNameExtension([
        { type: 'url', value: request.applicationUri },
        ...request.dnsNames.map((value) => ({ type: 'dns' as const, value })),
      ]),
    ],
  });
  return {
    certificatePem: `${certificate.toString('pem')}\n`,
    privateKeyPem: await pem(keys.privateKey),
  };
}

/** An empty certificate revocation list of `ca` (nothing revoked), PEM. */
export async function createEmptyCrl(ca: CertificateAuthority, now: Date): Promise<string> {
  const crl = await x509.X509CrlGenerator.create({
    issuer: ca.certificate.subject,
    thisUpdate: new Date(now.getTime() - 60 * 60 * 1000),
    nextUpdate: new Date(now.getTime() + 30 * DAY_MS),
    entries: [],
    signingAlgorithm: ALGORITHM,
    signingKey: ca.keys.privateKey,
    extensions: [await x509.AuthorityKeyIdentifierExtension.create(ca.certificate)],
  });
  return `${x509.PemConverter.encode(crl.rawData, 'X509 CRL')}\n`;
}

/**
 * A certificate authority made of an existing certificate and its PEM key: what someone holding a
 * pinned leaf's key could sign with (the #239 review's test of a minted certificate).
 */
export async function certificateAuthorityFrom(
  certificatePem: string,
  privateKeyPem: string,
): Promise<CertificateAuthority> {
  const certificate = new x509.X509Certificate(certificatePem);
  const algorithm = { name: ALGORITHM.name, hash: ALGORITHM.hash };
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    x509.PemConverter.decodeFirst(privateKeyPem),
    algorithm,
    true,
    ['sign'],
  );
  const publicKey = await certificate.publicKey.export(algorithm, ['verify']);
  return { certificatePem, privateKeyPem, keys: { publicKey, privateKey }, certificate };
}
