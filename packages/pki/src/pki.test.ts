import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPCUA_MACHINES } from '@shopfloor/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GATEWAY_APPLICATION_URI,
  TOOLS_APPLICATION_URI,
  createCertificateAuthority,
  createEmptyCrl,
  createKeyAndCertificate,
  EMPTIED_FOLDERS,
  STAGING_FOLDER,
  UnknownIdentityError,
  ensureOpcuaPki,
  inspectCertificate,
  issueCertificate,
  keyMatchesCertificate,
  machineApplicationUri,
  opcuaIdentities,
  pkiFiles,
  requireOwnMaterial,
  type PkiRoots,
} from './index.ts';

const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';
const DAY_MS = 24 * 60 * 60 * 1000;

let root: string;
let roots: PkiRoots;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'shopfloor-twin-pki-test-'));
  roots = { simulator: join(root, 'sim'), gateway: join(root, 'gw'), tools: join(root, 'tools') };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const certificate = async (folder: string) =>
  inspectCertificate(await readFile(pkiFiles(folder).certificateFile, 'utf8'));

describe('the OPC UA identities (ADR-0038)', () => {
  it('has the five servers, the gateway and the tools client, servers pinning the clients and back', () => {
    const identities = opcuaIdentities(roots);
    expect(identities.map((i) => i.name)).toEqual([
      ...OPCUA_MACHINES.map((m) => m.id),
      'edge-gateway',
      'tools',
    ]);
    const cnc = identities.find((i) => i.name === 'cnc-01');
    expect(cnc).toMatchObject({
      role: 'server',
      applicationUri: 'urn:orbis-components:shopfloor-twin:cnc-01',
      dnsNames: ['simulator', 'localhost'],
      folder: join(roots.simulator, 'cnc-01'),
      pins: ['edge-gateway', 'tools'],
    });
    expect(identities.find((i) => i.name === 'edge-gateway')?.pins).toEqual(
      OPCUA_MACHINES.map((m) => m.id),
    );
  });
});

// 15 s per test, not Vitest's default 5 s (#288): each run of the step makes several RSA-2048
// keys, whose time varies; a test takes up to 1.1 s alone and took up to 2.2 s in `pnpm verify`
// at turbo's default concurrency. 15 s is about seven times that worst. The describe's few
// validation-only tests (no keys made) share it; `tls.test.ts` stays on the default (its
// longest test: 0.6 s alone, 1.17 s under load, under a quarter of the default).
describe('ensureOpcuaPki, the pki step', { timeout: 15_000 }, () => {
  it('makes a key and a certificate per identity with the URI, DNS names, key usage and EKU', async () => {
    const result = await ensureOpcuaPki(roots);
    expect(result.identities.map((i) => i.action)).toEqual(Array(7).fill('created'));
    expect(result.pinned).toBe(5 * 2 + 5 + 5);
    expect(result.written).toBe(5 * 2 + 5 + 5);
    for (const identity of opcuaIdentities(roots)) {
      const info = await certificate(identity.folder);
      expect(info.uris).toEqual([identity.applicationUri]);
      expect(info.dnsNames).toEqual([...identity.dnsNames]);
      expect(info.extendedKeyUsages).toEqual([
        identity.role === 'server' ? SERVER_AUTH : CLIENT_AUTH,
      ]);
      expect(info.notAfter.getTime() - Date.now()).toBeGreaterThan(364 * DAY_MS);
      // A leaf may not sign certificates (#239 review).
      expect(info.keyCertSign).toBe(false);
      const files = pkiFiles(identity.folder);
      expect(
        keyMatchesCertificate(
          await readFile(files.privateKeyFile, 'utf8'),
          await readFile(files.certificateFile, 'utf8'),
        ),
      ).toBe(true);
      expect((await stat(files.privateKeyFile)).mode & 0o777).toBe(0o600);
      expect((await readdir(files.trustedCerts)).sort()).toEqual(
        [...identity.pins].sort().map((peer) => `${peer}.pem`),
      );
    }
    // A pin is the peer's own certificate.
    const pinned = await readFile(
      join(pkiFiles(join(roots.simulator, 'cnc-01')).trustedCerts, 'edge-gateway.pem'),
      'utf8',
    );
    expect(inspectCertificate(pinned).thumbprint).toBe(
      (await certificate(roots.gateway)).thumbprint,
    );
  });

  it('keeps valid material and renews it within 30 days of expiry, removing the superseded pins', async () => {
    const first = await ensureOpcuaPki(roots);
    const again = await ensureOpcuaPki(roots);
    expect(again.identities.map((i) => i.action)).toEqual(Array(7).fill('kept'));
    expect(again.removed).toEqual([]);
    expect(again.identities.map((i) => i.thumbprint)).toEqual(
      first.identities.map((i) => i.thumbprint),
    );
    // 340 days on, every certificate is within 30 days of its end.
    const later = await ensureOpcuaPki({ ...roots, now: new Date(Date.now() + 340 * DAY_MS) });
    expect(later.identities.every((i) => i.action === 'renewed')).toBe(true);
    expect(later.identities[0]?.reason).toMatch(/within 30 days/);
    expect(later.removed).toHaveLength(20);
    for (const identity of opcuaIdentities(roots)) {
      expect((await readdir(pkiFiles(identity.folder).trustedCerts)).sort()).toEqual(
        [...identity.pins].sort().map((peer) => `${peer}.pem`),
      );
    }
  });

  it('makes trusted/certs exactly the pins and empties the CRL and issuer folders (#239 review)', async () => {
    await ensureOpcuaPki(roots);
    const folder = join(roots.simulator, 'cnc-01');
    const cnc = pkiFiles(folder).trustedCerts;
    const oldGateway = await readFile(pkiFiles(roots.gateway).certificateFile, 'utf8');
    await writeFile(join(cnc, 'copied-by-hand.pem'), oldGateway);
    // What a server kept before #239: node-opcua accepted every client and pinned it.
    const legacy = await createKeyAndCertificate({
      commonName: 'legacy client',
      role: 'client',
      applicationUri: 'urn:example:legacy',
      dnsNames: [],
      validityDays: 90,
      now: new Date(),
    });
    await writeFile(join(cnc, 'legacy-0123abcd.pem'), legacy.certificatePem);
    await writeFile(join(cnc, 'notes.txt'), 'not a certificate');
    const ca = await createCertificateAuthority({
      commonName: 'x',
      validityDays: 60,
      now: new Date(),
    });
    const crl = await createEmptyCrl(ca, new Date());
    await writeFile(join(folder, 'trusted', 'crl', 'x.crl.pem'), crl);
    await writeFile(join(folder, 'issuers', 'certs', 'x.pem'), ca.certificatePem);
    await writeFile(join(folder, 'issuers', 'crl', 'x.crl.pem'), crl);
    const result = await ensureOpcuaPki({ ...roots, renew: ['edge-gateway'] });
    expect(result.identities.find((i) => i.name === 'edge-gateway')).toMatchObject({
      action: 'renewed',
      reason: 'renewal requested',
    });
    expect(result.removed).toEqual(
      expect.arrayContaining([
        'cnc-01: trusted/certs/edge-gateway.pem',
        'cnc-01: trusted/certs/copied-by-hand.pem',
        'cnc-01: trusted/certs/legacy-0123abcd.pem',
        'cnc-01: trusted/certs/notes.txt',
        'cnc-01: trusted/crl/x.crl.pem',
        'cnc-01: issuers/certs/x.pem',
        'cnc-01: issuers/crl/x.crl.pem',
      ]),
    );
    expect((await readdir(cnc)).sort()).toEqual(['edge-gateway.pem', 'tools.pem']);
    for (const empty of EMPTIED_FOLDERS) expect(await readdir(join(folder, empty))).toEqual([]);
    const pinned = await readFile(join(cnc, 'edge-gateway.pem'), 'utf8');
    expect(inspectCertificate(pinned).thumbprint).toBe(
      (await certificate(roots.gateway)).thumbprint,
    );
  });

  it('leaves unchanged pins alone on a rerun (#265)', async () => {
    await ensureOpcuaPki(roots);
    const pins = opcuaIdentities(roots).flatMap((identity) =>
      identity.pins.map((peer) => join(pkiFiles(identity.folder).trustedCerts, `${peer}.pem`)),
    );
    const before = await Promise.all(pins.map((pin) => stat(pin)));
    // A pin whose mode drifted is fixed in place, not rewritten.
    await chmod(pins[0] ?? '', 0o600);
    const staged: string[] = [];
    const again = await ensureOpcuaPki({ ...roots, onStaged: (file) => void staged.push(file) });
    expect(again).toMatchObject({ pinned: 20, written: 0, removed: [] });
    expect(staged).toEqual([]);
    const after = await Promise.all(pins.map((pin) => stat(pin)));
    expect(after.map((s) => [s.ino, s.mtimeMs])).toEqual(before.map((s) => [s.ino, s.mtimeMs]));
    expect(after.every((s) => (s.mode & 0o777) === 0o644)).toBe(true);
  });

  it('stages every file outside the watched folders, then renames it into place (#265)', async () => {
    const watched = ['trusted/certs', 'trusted/crl', 'issuers/certs', 'issuers/crl', 'rejected'];
    const listWatched = async () => {
      const files: string[] = [];
      for (const identity of opcuaIdentities(roots)) {
        for (const folder of watched) {
          const path = join(identity.folder, folder);
          for (const file of await readdir(path).catch(() => [])) files.push(join(path, file));
        }
      }
      return files;
    };
    const seen: { staged: string; target: string; watched: string[] }[] = [];
    const onStaged = async (staged: string, target: string) => {
      seen.push({ staged, target, watched: await listWatched() });
    };
    await ensureOpcuaPki({ ...roots, onStaged });
    const renewed = await ensureOpcuaPki({ ...roots, renew: ['tools'], onStaged });
    expect(renewed.written).toBe(5);
    // 7 keys and certificates and 20 pins, then the tools key, certificate and its 5 pins.
    expect(seen).toHaveLength(7 * 2 + 20 + 2 + 5);
    for (const { staged, target, watched: files } of seen) {
      const identity = opcuaIdentities(roots).find((i) => target.startsWith(`${i.folder}/`));
      expect(staged.startsWith(join(identity?.folder ?? '?', STAGING_FOLDER, ''))).toBe(true);
      // Nothing but final files ever lies in a folder a certificate manager watches.
      expect(files.filter((file) => !file.endsWith('.pem'))).toEqual([]);
      expect(files).not.toContain(staged);
    }
    for (const identity of opcuaIdentities(roots)) {
      expect(await readdir(identity.folder)).not.toContain(STAGING_FOLDER);
    }
  });

  it('removes what a run that died while staging left behind', async () => {
    await ensureOpcuaPki(roots);
    const leftover = join(roots.tools, STAGING_FOLDER);
    await mkdir(leftover);
    await writeFile(join(leftover, 'cnc-01.pem.123.tmp'), 'half');
    await ensureOpcuaPki(roots);
    expect(await readdir(roots.tools)).not.toContain(STAGING_FOLDER);
  });

  it('refuses to renew an identity it does not know', async () => {
    await expect(ensureOpcuaPki({ ...roots, renew: ['tools', 'cnc-9'] })).rejects.toThrow(
      UnknownIdentityError,
    );
  });

  it.each([
    [
      'a missing key',
      async () => rm(pkiFiles(roots.tools).privateKeyFile),
      'certificate or key missing',
    ],
    [
      "another identity's certificate",
      async () =>
        writeFile(
          pkiFiles(roots.tools).certificateFile,
          await readFile(pkiFiles(roots.gateway).certificateFile, 'utf8'),
        ),
      `SAN URI ${GATEWAY_APPLICATION_URI}`,
    ],
    [
      'a key that is not the certificate’s',
      async () =>
        writeFile(
          pkiFiles(roots.tools).privateKeyFile,
          await readFile(pkiFiles(roots.gateway).privateKeyFile, 'utf8'),
        ),
      'key does not match the certificate',
    ],
    [
      'a certificate node-opcua made (both EKUs)',
      async () => {
        const both = await createKeyAndCertificate({
          commonName: 'x',
          role: 'server',
          applicationUri: TOOLS_APPLICATION_URI,
          dnsNames: ['localhost'],
          validityDays: 365,
          now: new Date(),
        });
        await writeFile(pkiFiles(roots.tools).certificateFile, both.certificatePem);
      },
      `extended key usage ${SERVER_AUTH}`,
    ],
    [
      'an unreadable certificate',
      async () => writeFile(pkiFiles(roots.tools).certificateFile, 'garbage'),
      'unreadable',
    ],
  ])('replaces %s', async (_what, damage, reason) => {
    await ensureOpcuaPki(roots);
    await damage();
    const result = await ensureOpcuaPki(roots);
    const tools = result.identities.find((i) => i.name === 'tools');
    expect(tools?.action).toBe('renewed');
    expect(tools?.reason).toContain(reason);
    expect(() => requireOwnMaterial(roots.tools, TOOLS_APPLICATION_URI)).not.toThrow();
  });

  it('refuses a validity that renewal would undo at once', async () => {
    await expect(ensureOpcuaPki({ ...roots, validityDays: 30 })).rejects.toThrow(/exceed 30 days/);
  });
});

describe('requireOwnMaterial', () => {
  // 10 s, not Vitest's default 5 s (#288): it makes the step's keys first; 0.37 to 0.49 s alone,
  // 1.04 to 1.61 s in `pnpm verify` at the default concurrency, over a quarter of the default.
  it(
    'names what is missing, another URI, a foreign key and an expired certificate',
    {
      timeout: 10_000,
    },
    async () => {
      const folder = join(roots.simulator, 'cnc-01');
      expect(() => requireOwnMaterial(folder, machineApplicationUri('cnc-01'))).toThrow(
        /certificate\.pem is missing: run the pki step first/,
      );
      await ensureOpcuaPki(roots);
      expect(requireOwnMaterial(folder, machineApplicationUri('cnc-01'))).toEqual(pkiFiles(folder));
      expect(() => requireOwnMaterial(folder, machineApplicationUri('cnc-02'))).toThrow(
        /is for urn:orbis-components:shopfloor-twin:cnc-01, not .*cnc-02/,
      );
      await writeFile(
        pkiFiles(folder).privateKeyFile,
        await readFile(pkiFiles(roots.tools).privateKeyFile, 'utf8'),
      );
      expect(() => requireOwnMaterial(folder, machineApplicationUri('cnc-01'))).toThrow(
        /is not the key of/,
      );
      const expired = await createKeyAndCertificate({
        commonName: 'old',
        role: 'server',
        applicationUri: machineApplicationUri('cnc-01'),
        dnsNames: [],
        validityDays: 31,
        now: new Date(Date.now() - 40 * DAY_MS),
      });
      await writeFile(pkiFiles(folder).privateKeyFile, expired.privateKeyPem);
      await writeFile(pkiFiles(folder).certificateFile, expired.certificatePem);
      expect(() => requireOwnMaterial(folder, machineApplicationUri('cnc-01'))).toThrow(/expired/);
    },
  );
});

describe('a certificate authority (probe Q1)', () => {
  it('issues a certificate with the requested URI and EKU, and an empty CRL', async () => {
    const now = new Date();
    const ca = await createCertificateAuthority({ commonName: 'test CA', validityDays: 60, now });
    const issued = await issueCertificate(ca, {
      commonName: 'client',
      role: 'client',
      applicationUri: TOOLS_APPLICATION_URI,
      dnsNames: ['localhost'],
      validityDays: 60,
      now,
    });
    const info = inspectCertificate(issued.certificatePem);
    expect(info.uris).toEqual([TOOLS_APPLICATION_URI]);
    expect(info.extendedKeyUsages).toEqual([CLIENT_AUTH]);
    expect(keyMatchesCertificate(issued.privateKeyPem, issued.certificatePem)).toBe(true);
    expect(inspectCertificate(ca.certificatePem).subject).toContain('CN=test CA');
    expect(inspectCertificate(ca.certificatePem).keyCertSign).toBe(true);
    expect(await createEmptyCrl(ca, now)).toMatch(/^-----BEGIN X509 CRL-----/);
  });
});
