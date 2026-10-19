import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createKeyAndCertificate,
  extendedKeyUsageOf,
  inspectCertificate,
  keyMatchesCertificate,
  type CertificateInfo,
} from './certificate.ts';
import {
  PKI_SUBFOLDERS,
  opcuaIdentities,
  pkiFiles,
  type OpcuaIdentity,
  type PkiRoots,
} from './layout.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A certificate is kept while it is valid for more than this (plan, "Keys and expiry"). */
export const RENEW_WITHIN_DAYS = 30;
/** The fixed validity of every certificate the step makes. */
export const DEFAULT_VALIDITY_DAYS = 365;

export interface EnsurePkiOptions extends PkiRoots {
  readonly now?: Date;
  readonly validityDays?: number;
  /** Identities to renew whatever their state (a key thought compromised; tests). */
  readonly renew?: readonly string[];
}

export type IdentityAction = 'kept' | 'created' | 'renewed';

export interface IdentityResult {
  readonly name: string;
  readonly applicationUri: string;
  readonly folder: string;
  readonly action: IdentityAction;
  /** Why existing material was replaced, for `renewed`. */
  readonly reason?: string;
  readonly notAfter: Date;
  readonly thumbprint: string;
}

export interface EnsurePkiResult {
  readonly identities: readonly IdentityResult[];
  /** Pinned certificates written, one per (identity, peer). */
  readonly pinned: number;
  /** Superseded or foreign pins removed from a `trusted/certs` folder, as `<identity>: <file>`. */
  readonly removed: readonly string[];
  readonly elapsedMs: number;
}

/**
 * The `pki` step (ADR-0038), the same code in Compose's one-shot `pki` service and in the test
 * helpers' exchange step: makes or keeps a key and a self-signed certificate per OPC UA identity,
 * then pins each identity's peers in its `trusted/certs`. Existing material is kept while it is
 * valid for more than 30 days and still says what the step would write (SAN, extended key usage,
 * matching key); anything else is replaced. A pin of one of these identities that isn't the peer's
 * current certificate (a superseded one after a renewal) is removed before the current one is
 * written, so a renewed certificate's predecessor is trusted nowhere. Files of other origin in
 * `trusted/certs` are left alone.
 */
export async function ensureOpcuaPki(options: EnsurePkiOptions): Promise<EnsurePkiResult> {
  const started = performance.now();
  const now = options.now ?? new Date();
  const validityDays = options.validityDays ?? DEFAULT_VALIDITY_DAYS;
  if (!(validityDays > RENEW_WITHIN_DAYS)) {
    throw new Error(`validity must exceed ${String(RENEW_WITHIN_DAYS)} days`);
  }
  const identities = opcuaIdentities(options);
  const results: IdentityResult[] = [];
  const current = new Map<string, CertificateInfo & { readonly pem: string }>();
  for (const identity of identities) {
    const { result, pem } = await ensureIdentity(
      identity,
      now,
      validityDays,
      options.renew?.includes(identity.name) ?? false,
    );
    results.push(result);
    current.set(identity.name, { ...inspectCertificate(pem), pem });
  }
  const managedUris = new Set(identities.map((identity) => identity.applicationUri));
  const removed: string[] = [];
  let pinned = 0;
  for (const identity of identities) {
    const trusted = pkiFiles(identity.folder).trustedCerts;
    const wanted = new Set(identity.pins.map((peer) => current.get(peer)?.thumbprint));
    for (const file of await readdir(trusted)) {
      const path = join(trusted, file);
      let info: CertificateInfo;
      try {
        info = inspectCertificate(await readFile(path));
      } catch {
        continue; // not a certificate this step can read: not one of its pins
      }
      const managed = info.uris.some((uri) => managedUris.has(uri));
      if (managed && !wanted.has(info.thumbprint)) {
        await rm(path);
        removed.push(`${identity.name}: ${file}`);
      }
    }
    for (const peer of identity.pins) {
      const certificate = current.get(peer);
      if (!certificate) throw new Error(`${identity.name} pins unknown identity ${peer}`);
      await writeAtomically(join(trusted, `${peer}.pem`), certificate.pem, 0o644);
      pinned++;
    }
  }
  return { identities: results, pinned, removed, elapsedMs: performance.now() - started };
}

async function ensureIdentity(
  identity: OpcuaIdentity,
  now: Date,
  validityDays: number,
  forceRenewal: boolean,
): Promise<{ result: IdentityResult; pem: string }> {
  for (const folder of PKI_SUBFOLDERS) {
    await mkdir(join(identity.folder, folder), { recursive: true });
  }
  const files = pkiFiles(identity.folder);
  await chmod(join(identity.folder, 'own', 'private'), 0o700);
  const reason = forceRenewal
    ? 'renewal requested'
    : await whyReplace(identity, files.certificateFile, files.privateKeyFile, now);
  if (reason === undefined) {
    const pem = await readFile(files.certificateFile, 'utf8');
    const info = inspectCertificate(pem);
    return {
      result: {
        name: identity.name,
        applicationUri: identity.applicationUri,
        folder: identity.folder,
        action: 'kept',
        notAfter: info.notAfter,
        thumbprint: info.thumbprint,
      },
      pem,
    };
  }
  const material = await createKeyAndCertificate({
    commonName: `shopfloor-twin ${identity.name}`,
    role: identity.role,
    applicationUri: identity.applicationUri,
    dnsNames: identity.dnsNames,
    validityDays,
    now,
  });
  // Key first: a certificate on disk always has its key beside it.
  await writeAtomically(files.privateKeyFile, material.privateKeyPem, 0o600);
  await writeAtomically(files.certificateFile, material.certificatePem, 0o644);
  const info = inspectCertificate(material.certificatePem);
  const existed = reason !== 'none yet';
  return {
    result: {
      name: identity.name,
      applicationUri: identity.applicationUri,
      folder: identity.folder,
      action: existed ? 'renewed' : 'created',
      ...(existed ? { reason } : {}),
      notAfter: info.notAfter,
      thumbprint: info.thumbprint,
    },
    pem: material.certificatePem,
  };
}

/** Why the existing material must be replaced, or undefined to keep it. */
async function whyReplace(
  identity: OpcuaIdentity,
  certificateFile: string,
  privateKeyFile: string,
  now: Date,
): Promise<string | undefined> {
  if (!existsSync(certificateFile) && !existsSync(privateKeyFile)) return 'none yet';
  if (!existsSync(certificateFile) || !existsSync(privateKeyFile)) {
    return 'certificate or key missing';
  }
  try {
    const pem = await readFile(certificateFile, 'utf8');
    const info = inspectCertificate(pem);
    if (info.notAfter.getTime() - now.getTime() <= RENEW_WITHIN_DAYS * DAY_MS) {
      return `expires ${info.notAfter.toISOString()}, within ${String(RENEW_WITHIN_DAYS)} days`;
    }
    if (info.uris[0] !== identity.applicationUri) return `SAN URI ${String(info.uris[0])}`;
    const missingDns = identity.dnsNames.filter((name) => !info.dnsNames.includes(name));
    if (missingDns.length > 0) return `SAN without DNS ${missingDns.join(', ')}`;
    const usages = info.extendedKeyUsages;
    if (usages.length !== 1 || usages[0] !== extendedKeyUsageOf(identity.role)) {
      return `extended key usage ${usages.join(', ') || 'missing'}`;
    }
    if (!keyMatchesCertificate(await readFile(privateKeyFile, 'utf8'), pem)) {
      return 'key does not match the certificate';
    }
  } catch (error) {
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
}

async function writeAtomically(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, content, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}
