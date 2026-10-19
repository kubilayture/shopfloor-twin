import { randomBytes, webcrypto } from 'node:crypto';
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { extendedKeyUsageOf, type CertificateRequest, type KeyPair } from './certificate.ts';

// A certificate authority: probe Q1 (#239) issues an OPC UA client certificate from one to record
// node-opcua's CRL behaviour (the reason OPC UA trust pins leaf certificates instead, ADR-0038);
// the dev CA of the HTTPS front (P9-14, ADR-0039) is built on it.

x509.cryptoProvider.set(webcrypto);

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
  return x509.PemConverter.encode(await webcrypto.subtle.exportKey('pkcs8', key), 'PRIVATE KEY');
}

/** A self-signed CA certificate (`keyCertSign`, `cRLSign`, CA:true) and its key. */
export async function createCertificateAuthority(options: {
  readonly commonName: string;
  readonly validityDays: number;
  readonly now: Date;
}): Promise<CertificateAuthority> {
  const keys = (await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])) as KeyPair;
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
    ],
  });
  return {
    certificatePem: `${certificate.toString('pem')}\n`,
    privateKeyPem: await pem(keys.privateKey),
    keys,
    certificate,
  };
}

/** A key and a certificate for `request`, signed by `ca` (OPC UA key usage, one EKU, SAN). */
export async function issueCertificate(
  ca: CertificateAuthority,
  request: CertificateRequest,
): Promise<{ readonly certificatePem: string; readonly privateKeyPem: string }> {
  const keys = (await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])) as KeyPair;
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
