import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
// @peculiar/x509 2 resolves its services through tsyringe, which needs this polyfill loaded first.
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import type { IdentityRole } from './layout.ts';

// The global Web Crypto (Node's webcrypto): its types are the global `Crypto` and `CryptoKey`
// whether a consumer compiles with Node's types alone or with the DOM library too (e2e, P9-14).
x509.cryptoProvider.set(crypto);

const DAY_MS = 24 * 60 * 60 * 1000;

/** A WebCrypto key pair, as @peculiar/x509 takes it. */
export interface KeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
}

/** RSA 2048 with SHA-256: what `Basic256Sha256` and `Aes128_Sha256_RsaOaep` take. */
const ALGORITHM = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
} as const;

/**
 * OPC UA Part 6 6.2.2 for an application instance certificate: `digitalSignature`,
 * `nonRepudiation`, `keyEncipherment` and `dataEncipherment`. No `keyCertSign` (#239 review):
 * node-opcua ignores `cA=false`, so a pinned leaf that may sign certificates would be a CA for
 * whoever holds its key; node-opcua verifies a self-signed leaf without it (tested).
 */
const KEY_USAGE: x509.KeyUsageFlags =
  x509.KeyUsageFlags.digitalSignature |
  x509.KeyUsageFlags.nonRepudiation |
  x509.KeyUsageFlags.keyEncipherment |
  x509.KeyUsageFlags.dataEncipherment;

const EXTENDED_KEY_USAGE: Record<IdentityRole, string> = {
  server: x509.ExtendedKeyUsage.serverAuth,
  client: x509.ExtendedKeyUsage.clientAuth,
};

export interface CertificateRequest {
  readonly commonName: string;
  readonly role: IdentityRole;
  readonly applicationUri: string;
  readonly dnsNames: readonly string[];
  /** Validity from `now`, days. */
  readonly validityDays: number;
  readonly now: Date;
}

export interface KeyAndCertificate {
  /** PKCS #8, PEM. */
  readonly privateKeyPem: string;
  readonly certificatePem: string;
}

/** A fresh RSA 2048 key and a self-signed OPC UA application certificate for it. */
export async function createKeyAndCertificate(
  request: CertificateRequest,
): Promise<KeyAndCertificate> {
  const keys = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  // A positive 128-bit serial (the high bit clear, RFC 5280 4.1.2.2).
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial.toString('hex'),
    name: [{ CN: [request.commonName] }, { O: ['Orbis Components (simulated)'] }],
    // An hour back, so that a clock a little behind still sees the certificate as valid.
    notBefore: new Date(request.now.getTime() - 60 * 60 * 1000),
    notAfter: new Date(request.now.getTime() + request.validityDays * DAY_MS),
    signingAlgorithm: ALGORITHM,
    keys: keys as KeyPair,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(KEY_USAGE, true),
      new x509.ExtendedKeyUsageExtension([EXTENDED_KEY_USAGE[request.role]], false),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(keys.publicKey),
      new x509.SubjectAlternativeNameExtension([
        { type: 'url', value: request.applicationUri },
        ...request.dnsNames.map((value) => ({ type: 'dns' as const, value })),
      ]),
    ],
  });
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
  return {
    privateKeyPem: x509.PemConverter.encode(pkcs8, 'PRIVATE KEY'),
    certificatePem: `${certificate.toString('pem')}\n`,
  };
}

/** What a certificate says, as far as the PKI step checks it. */
export interface CertificateInfo {
  readonly subject: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** The SAN's URIs, in order: node-opcua takes the first as the `applicationUri`. */
  readonly uris: readonly string[];
  readonly dnsNames: readonly string[];
  /** The SAN's IP addresses (the web front's certificate, ADR-0039). */
  readonly ipAddresses: readonly string[];
  readonly extendedKeyUsages: readonly string[];
  /** SHA-1 of the DER, hex: OPC UA's certificate thumbprint. */
  readonly thumbprint: string;
  readonly der: Buffer;
  /** Whether its key usage lets it sign certificates (`keyCertSign`). */
  readonly keyCertSign: boolean;
}

export function inspectCertificate(pem: string | Buffer): CertificateInfo {
  const certificate = new x509.X509Certificate(typeof pem === 'string' ? pem : new Uint8Array(pem));
  const names = certificate.getExtension(x509.SubjectAlternativeNameExtension)?.names.items ?? [];
  const der = Buffer.from(certificate.rawData);
  return {
    subject: certificate.subject,
    notBefore: certificate.notBefore,
    notAfter: certificate.notAfter,
    uris: names.filter((name) => name.type === 'url').map((name) => name.value),
    dnsNames: names.filter((name) => name.type === 'dns').map((name) => name.value),
    ipAddresses: names.filter((name) => name.type === 'ip').map((name) => name.value),
    extendedKeyUsages: (certificate.getExtension(x509.ExtendedKeyUsageExtension)?.usages ?? []).map(
      String,
    ),
    thumbprint: createHash('sha1').update(der).digest('hex'),
    keyCertSign:
      ((certificate.getExtension(x509.KeyUsagesExtension)?.usages ?? 0) &
        x509.KeyUsageFlags.keyCertSign) !==
      0,
    der,
  };
}

/** Whether a PEM private key is the key of this certificate. */
export function keyMatchesCertificate(privateKeyPem: string, certificatePem: string): boolean {
  const publicKey = createPublicKey(createPrivateKey(privateKeyPem)).export({
    type: 'spki',
    format: 'der',
  });
  const certificate = new x509.X509Certificate(certificatePem);
  return Buffer.from(certificate.publicKey.rawData).equals(publicKey);
}

export const extendedKeyUsageOf = (role: IdentityRole): string => EXTENDED_KEY_USAGE[role];
