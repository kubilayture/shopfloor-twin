import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
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
  /**
   * Tests only (#265): called after a file is staged in `.staging` and before it is renamed into
   * place, e.g. to hold the rename back while a node-opcua certificate manager watches.
   */
  readonly onStaged?: (staged: string, target: string) => Promise<void> | void;
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
  /** Pins in place after the run, one per (identity, peer). */
  readonly pinned: number;
  /**
   * Pins this run wrote: new or changed ones only. An unchanged pin is left alone, so a rerun
   * against running components doesn't touch the folders their certificate managers watch (#265).
   */
  readonly written: number;
  /**
   * What was removed from an identity's trust, as `<identity>: <folder>/<file>`: superseded or
   * foreign files in `trusted/certs`, anything in `trusted/crl`, `issuers/certs` or `issuers/crl`.
   */
  readonly removed: readonly string[];
  readonly elapsedMs: number;
}

/** Thrown for a `renew` name that is none of the identities (the CLI exits 2). */
export class UnknownIdentityError extends Error {}

/** The trust folders the step owns besides `trusted/certs`: kept empty (no CRL, no issuer). */
export const EMPTIED_FOLDERS = ['trusted/crl', 'issuers/certs', 'issuers/crl'] as const;

/**
 * Where the step stages a file before renaming it into place (#265): `<identity folder>/.staging`,
 * on the same volume as the folder it is renamed into (so the rename is atomic) but outside every
 * folder node-opcua's certificate manager watches (`trusted/*`, `issuers/*`, `rejected`). A temp
 * file in `trusted/certs` could be indexed by the running manager's watcher, whose late `unlink`
 * of it then dropped the real pin's fingerprint from the trust index (node-opcua-pki 7.1.0).
 * Removed at the end of every run.
 */
export const STAGING_FOLDER = '.staging';

/**
 * The `pki` step (ADR-0038), the same code in Compose's one-shot `pki` service and in the test
 * helpers' exchange step: makes or keeps a key and a self-signed certificate per OPC UA identity,
 * then makes each identity's trust exactly its pins. Existing material is kept while it is valid
 * for more than 30 days and still says what the step would write (SAN, extended key usage, no
 * `keyCertSign`, matching key); anything else is replaced. `trusted/certs` ends holding exactly the
 * current certificates of the identity's peers (`<peer>.pem`): a superseded certificate, one pinned
 * before #239 (when node-opcua accepted every certificate and kept it there) and any file put there
 * by hand are removed; `trusted/crl`, `issuers/certs` and `issuers/crl` are emptied, so no CA and no
 * revocation list can widen what a pinned leaf trusts (#239 review). A pin that is already the
 * peer's current certificate is not rewritten, and every file the step writes is staged outside the
 * watched folders (`STAGING_FOLDER`), so a rerun against running components leaves their trust index
 * alone (#265).
 */
export async function ensureOpcuaPki(options: EnsurePkiOptions): Promise<EnsurePkiResult> {
  const started = performance.now();
  const now = options.now ?? new Date();
  const validityDays = options.validityDays ?? DEFAULT_VALIDITY_DAYS;
  if (!(validityDays > RENEW_WITHIN_DAYS)) {
    throw new Error(`validity must exceed ${String(RENEW_WITHIN_DAYS)} days`);
  }
  const identities = opcuaIdentities(options);
  const unknown = (options.renew ?? []).filter(
    (name) => !identities.some((identity) => identity.name === name),
  );
  if (unknown.length > 0) {
    throw new UnknownIdentityError(
      `unknown identity to renew: ${unknown.join(', ')} (known: ${identities.map((i) => i.name).join(', ')})`,
    );
  }
  const stage = stager(options.onStaged);
  for (const identity of identities) {
    // What a run that died between staging and renaming left behind.
    await rm(join(identity.folder, STAGING_FOLDER), { recursive: true, force: true });
  }
  const results: IdentityResult[] = [];
  const current = new Map<string, CertificateInfo & { readonly pem: string }>();
  for (const identity of identities) {
    const { result, pem } = await ensureIdentity(
      identity,
      now,
      validityDays,
      options.renew?.includes(identity.name) ?? false,
      stage,
    );
    results.push(result);
    current.set(identity.name, { ...inspectCertificate(pem), pem });
  }
  const removed: string[] = [];
  let pinned = 0;
  let written = 0;
  for (const identity of identities) {
    const trusted = pkiFiles(identity.folder).trustedCerts;
    const wanted = new Set(identity.pins.map((peer) => `${peer}.pem`));
    const stale = new Map<string, string>();
    const unchanged = new Set<string>();
    for (const peer of identity.pins) {
      const file = join(trusted, `${peer}.pem`);
      const pem = existsSync(file) ? await readFile(file, 'utf8') : undefined;
      if (pem === undefined) continue;
      if (pem === current.get(peer)?.pem) unchanged.add(peer);
      else stale.set(`${peer}.pem`, file);
    }
    for (const file of await readdir(trusted)) {
      if (!wanted.has(file)) stale.set(file, join(trusted, file));
    }
    for (const folder of EMPTIED_FOLDERS) {
      const path = join(identity.folder, folder);
      for (const file of await readdir(path)) stale.set(`${folder}/${file}`, join(path, file));
    }
    for (const [name, path] of stale) {
      await rm(path, { recursive: true, force: true });
      removed.push(`${identity.name}: ${name.includes('/') ? name : `trusted/certs/${name}`}`);
    }
    for (const peer of identity.pins) {
      const certificate = current.get(peer);
      if (!certificate) throw new Error(`${identity.name} pins unknown identity ${peer}`);
      const file = join(trusted, `${peer}.pem`);
      if (unchanged.has(peer)) {
        // Left alone (#265): rewriting it would make the running manager's watcher re-read it.
        if (((await stat(file)).mode & 0o777) !== 0o644) await chmod(file, 0o644);
      } else {
        await stage(identity.folder, file, certificate.pem, 0o644);
        written++;
      }
      pinned++;
    }
  }
  for (const identity of identities) {
    await rm(join(identity.folder, STAGING_FOLDER), { recursive: true, force: true });
  }
  return { identities: results, pinned, written, removed, elapsedMs: performance.now() - started };
}

async function ensureIdentity(
  identity: OpcuaIdentity,
  now: Date,
  validityDays: number,
  forceRenewal: boolean,
  stage: Stage,
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
  await stage(identity.folder, files.privateKeyFile, material.privateKeyPem, 0o600);
  await stage(identity.folder, files.certificateFile, material.certificatePem, 0o644);
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
    if (info.keyCertSign) return 'key usage keyCertSign (a leaf must not sign certificates)';
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

type Stage = (folder: string, path: string, content: string, mode: number) => Promise<void>;

/**
 * Writes a file atomically without a temp file beside it (#265): the content goes to
 * `<identity folder>/.staging` (same volume, watched by no certificate manager), gets its mode,
 * and is renamed over `path`, so a watcher of `path`'s folder only ever sees the final file.
 */
function stager(onStaged: EnsurePkiOptions['onStaged']): Stage {
  return async (folder, path, content, mode) => {
    const staging = join(folder, STAGING_FOLDER);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const temporary = join(staging, `${basename(path)}.${String(process.pid)}.tmp`);
    await writeFile(temporary, content, { mode: 0o600 });
    await chmod(temporary, mode);
    await onStaged?.(temporary, path);
    await rename(temporary, path);
  };
}
