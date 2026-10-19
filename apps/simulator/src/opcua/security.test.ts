import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPCUA_MACHINES,
  OPCUA_METHODS,
  opcuaEndpoint,
  opcuaNodeId,
  toIndexedNodeId,
} from '@shopfloor/contracts';
import type { PlantConfig } from '@shopfloor/plant-config';
import {
  GATEWAY_APPLICATION_URI,
  OPCUA_USERS,
  TOOLS_APPLICATION_URI,
  certificateAuthorityFrom,
  createEmptyCrl,
  createKeyAndCertificate,
  ensureOpcuaPki,
  inspectCertificate,
  issueCertificate,
  pkiFiles,
} from '@shopfloor/pki';
import {
  AttributeIds,
  DataType,
  MessageSecurityMode,
  OPCUAClient,
  SecurityPolicy,
  UserTokenPolicy,
  UserTokenType,
  resolveNodeId,
  type EndpointDescription,
} from 'node-opcua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDefaultConfig } from '../plant/testing.ts';
import { onFreeOpcuaPorts, securePki, type SecurePki } from '../testing.ts';
import { PlantServers } from './plant-servers.ts';
import { checkOpcuaSecurity, probeWrites } from './security-check.ts';
import { FAILED_LOGIN_DELAY_MS, hasClientAuth, userManager } from './security.ts';
import { callLoadOrder, connect, type TestClient } from './testing.ts';

// OPC UA security (#239, ADR-0038, checklist S1), against the five servers under SignAndEncrypt
// with the pki step's certificates, made by the same code as Compose's `pki` service.

const T0 = Date.UTC(2026, 9, 12, 3);
let config: PlantConfig;
let pki: SecurePki;
let servers: PlantServers | undefined;
let offset = 0;

const port = (machineId: string): number =>
  (OPCUA_MACHINES.find((m) => m.id === machineId)?.port ?? 0) + offset;

const client = (
  folder: string,
  applicationUri: string,
  user?: { userName: string; password: string },
): TestClient => ({
  mode: 'sign-and-encrypt',
  pkiFolder: folder,
  applicationUri,
  ...(user ? { user } : {}),
});

let reader: TestClient;
let gateway: TestClient;
/** Client folders made by the tests. */
let scratch: string;

async function startServers(): Promise<void> {
  ({ portOffset: offset, value: servers } = await onFreeOpcuaPorts(
    (portOffset) =>
      new PlantServers({
        config,
        start: T0,
        portOffset,
        pkiFolder: pki.folder,
        security: pki.security,
        production: 'orders',
      }),
  ));
}

/** The outcome of opening a session: 'opened', or the first line of the error. */
async function attempt(as: TestClient, machine = 'cnc-01'): Promise<string> {
  try {
    const { close } = await connect(port(machine), as);
    await close();
    return 'opened';
  } catch (error) {
    return error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
  }
}

beforeAll(async () => {
  config = await loadDefaultConfig();
  pki = await securePki('security');
  reader = client(pki.tools, TOOLS_APPLICATION_URI, {
    userName: OPCUA_USERS.reader,
    password: pki.passwords.reader,
  });
  gateway = client(pki.gateway, GATEWAY_APPLICATION_URI, {
    userName: OPCUA_USERS.gateway,
    password: pki.passwords.gateway,
  });
  scratch = await mkdtemp(join(tmpdir(), 'shopfloor-twin-security-clients-'));
  await startServers();
}, 60_000);

afterAll(async () => {
  await servers?.stop();
  await pki.remove();
  await rm(scratch, { recursive: true, force: true });
});

describe('OPC UA security (#239, ADR-0038)', () => {
  it('offers SignAndEncrypt only, with user names and no anonymous token', async () => {
    const discovery = OPCUAClient.create({ endpointMustExist: false });
    await discovery.connect(opcuaEndpoint('localhost', port('cnc-01')));
    let endpoints: EndpointDescription[];
    try {
      endpoints = await discovery.getEndpoints();
    } finally {
      await discovery.disconnect();
    }
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      expect(endpoint.securityMode).toBe(MessageSecurityMode.SignAndEncrypt);
      expect(endpoint.userIdentityTokens?.map((t) => t.tokenType)).toEqual([
        UserTokenType.UserName,
      ]);
    }
    expect(new Set(endpoints.map((e) => e.securityPolicyUri))).toEqual(
      new Set([SecurityPolicy.Basic256Sha256, SecurityPolicy.Aes128_Sha256_RsaOaep]),
    );
  });

  it('opens sessions for the pinned gateway and tools certificates with their users', async () => {
    for (const machine of OPCUA_MACHINES) {
      expect(await attempt(gateway, machine.id), machine.id).toBe('opened');
      expect(await attempt(reader, machine.id), machine.id).toBe('opened');
    }
  });

  it('refuses a client certificate it does not pin', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'shopfloor-twin-unpinned-'));
    try {
      // A complete PKI of its own: valid certificates for the same URIs, pinned nowhere here. The
      // client trusts this run's servers, so only the servers' check can refuse it.
      const other = {
        simulator: join(folder, 's'),
        gateway: join(folder, 'g'),
        tools: join(folder, 't'),
      };
      await ensureOpcuaPki(other);
      await cp(pkiFiles(pki.tools).trustedCerts, pkiFiles(other.tools).trustedCerts, {
        recursive: true,
      });
      const outcome = await attempt(
        client(other.tools, TOOLS_APPLICATION_URI, {
          userName: OPCUA_USERS.reader,
          password: pki.passwords.reader,
        }),
      );
      expect(outcome).toContain('BadSecurityChecksFailed');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("refuses a pinned certificate presented under another application's URI", async () => {
    // node-opcua's client always names the URI in its certificate; this one claims the gateway's
    // while presenting the (pinned) tools certificate, as a spoofing client would.
    const spoof = OPCUAClient.create({
      endpointMustExist: false,
      connectionStrategy: { maxRetry: 1 },
      applicationUri: GATEWAY_APPLICATION_URI,
      securityMode: MessageSecurityMode.SignAndEncrypt,
      securityPolicy: SecurityPolicy.Basic256Sha256,
      certificateFile: pkiFiles(pki.tools).certificateFile,
      privateKeyFile: pkiFiles(pki.tools).privateKeyFile,
    });
    (spoof as unknown as { _getApplicationUri: () => string })._getApplicationUri = () =>
      GATEWAY_APPLICATION_URI;
    try {
      await spoof.connect(opcuaEndpoint('localhost', port('cnc-01')));
      await expect(
        spoof.createSession({
          type: UserTokenType.UserName,
          userName: OPCUA_USERS.gateway,
          password: pki.passwords.gateway,
        }),
      ).rejects.toThrow(/BadCertificateUriInvalid/);
    } finally {
      await spoof.disconnect();
    }
  });

  it('refuses an anonymous session, also when the client sends the token anyway', async () => {
    // node-opcua's client refuses by itself: the endpoints offer no anonymous token.
    expect(await attempt(client(pki.tools, TOOLS_APPLICATION_URI))).toContain(
      'Cannot find ANONYMOUS user token policy',
    );
    // The server's own refusal: an anonymous token sent all the same.
    const forced = OPCUAClient.create({
      endpointMustExist: false,
      connectionStrategy: { maxRetry: 1 },
      applicationUri: TOOLS_APPLICATION_URI,
      securityMode: MessageSecurityMode.SignAndEncrypt,
      securityPolicy: SecurityPolicy.Basic256Sha256,
      certificateFile: pkiFiles(pki.tools).certificateFile,
      privateKeyFile: pkiFiles(pki.tools).privateKeyFile,
    });
    try {
      await forced.connect(opcuaEndpoint('localhost', port('cnc-01')));
      const known = (forced as unknown as { _serverEndpoints: EndpointDescription[] })
        ._serverEndpoints;
      for (const endpoint of known) {
        endpoint.userIdentityTokens = [
          ...(endpoint.userIdentityTokens ?? []),
          new UserTokenPolicy({ policyId: 'anonymous', tokenType: UserTokenType.Anonymous }),
        ];
      }
      await expect(forced.createSession()).rejects.toThrow(/BadIdentityToken/);
    } finally {
      await forced.disconnect();
    }
  });

  it('refuses a wrong password and an unknown user', async () => {
    const wrong = await attempt(
      client(pki.gateway, GATEWAY_APPLICATION_URI, {
        userName: OPCUA_USERS.gateway,
        password: pki.passwords.reader,
      }),
    );
    expect(wrong).toMatch(/BadUserAccessDenied|BadIdentityTokenRejected/);
    const unknown = await attempt(
      client(pki.tools, TOOLS_APPLICATION_URI, {
        userName: 'admin',
        password: pki.passwords.reader,
      }),
    );
    expect(unknown).toMatch(/BadUserAccessDenied|BadIdentityTokenRejected/);
  });

  it('lets opcua-reader read but not call LoadOrder or LoadProgram (address space 1.3)', async () => {
    const { session, close } = await connect(port('cnc-01'), reader);
    try {
      const namespaces = await session.readNamespaceArray();
      const node = (path: string) =>
        resolveNodeId(toIndexedNodeId(opcuaNodeId('cnc-01', path), namespaces));
      const state = await session.read({
        nodeId: node('ShopFloor.State'),
        attributeId: AttributeIds.Value,
      });
      expect(state.statusCode.name).toBe('Good');
      for (const method of [OPCUA_METHODS.loadOrder, OPCUA_METHODS.loadProgram]) {
        const executable = await session.read({
          nodeId: node(method),
          attributeId: AttributeIds.UserExecutable,
        });
        expect(executable.value.value, method).toBe(false);
      }
      const order = await callLoadOrder(session, 'cnc-01', {
        commandId: 'PO-S1~OP10~1',
        orderId: 'PO-S1',
        product: 'VB-100',
        quantity: 1,
        notBefore: T0,
        deviceEpoch: servers?.epoch ?? 0,
        expiresAt: Date.now() + 60_000,
      });
      expect(order.status).toBe('BadUserAccessDenied');
      const program = await session.call({
        objectId: node('ShopFloor'),
        methodId: node(OPCUA_METHODS.loadProgram),
        inputArguments: [
          { dataType: DataType.String, value: 'VB-100' },
          { dataType: DataType.UInt32, value: 1 },
        ],
      });
      expect(program.statusCode.name).toBe('BadUserAccessDenied');
    } finally {
      await close();
    }
  });

  it('lets opcua-gateway call LoadOrder (the run is not attached: a transient refusal, not a permission one)', async () => {
    const { session, close } = await connect(port('cnc-02'), gateway);
    try {
      const namespaces = await session.readNamespaceArray();
      const executable = await session.read({
        nodeId: resolveNodeId(
          toIndexedNodeId(opcuaNodeId('cnc-02', OPCUA_METHODS.loadOrder), namespaces),
        ),
        attributeId: AttributeIds.UserExecutable,
      });
      expect(executable.value.value).toBe(true);
      const order = await callLoadOrder(session, 'cnc-02', {
        commandId: 'PO-S2~OP10~1',
        orderId: 'PO-S2',
        product: 'VB-100',
        quantity: 1,
        notBefore: T0,
        deviceEpoch: servers?.epoch ?? 0,
        expiresAt: Date.now() + 60_000,
      });
      expect(order.status).toBe('BadWaitingForInitialData');
    } finally {
      await close();
    }
  });

  it('lets neither opcua-reader nor opcua-gateway write any variable (address space 1.3, #239 review)', async () => {
    for (const as of [reader, gateway]) {
      for (const machine of OPCUA_MACHINES) {
        const { session, close } = await connect(port(machine.id), as);
        try {
          const probe = await probeWrites(session, machine.id);
          // The machine's own variables and the companion instances under it.
          expect(probe.variables, machine.id).toBeGreaterThan(15);
          expect(probe.writableByAccessLevel, machine.id).toEqual([]);
          expect(probe.writesNotRefused, machine.id).toEqual([]);
        } finally {
          await close();
        }
      }
    }
    // The plant's own updates still land (setValueFromSource is not a client write).
    const { session, close } = await connect(port('cnc-01'), reader);
    try {
      const namespaces = await session.readNamespaceArray();
      const epoch = await session.read({
        nodeId: resolveNodeId(
          toIndexedNodeId(opcuaNodeId('cnc-01', 'ShopFloor.Epoch'), namespaces),
        ),
        attributeId: AttributeIds.Value,
      });
      expect(epoch.value.value).toBe(servers?.epoch);
    } finally {
      await close();
    }
  }, 60_000);

  it("passes the smoke's security check (the opcua-tools container's code)", async () => {
    const lines: string[] = [];
    await checkOpcuaSecurity({
      host: 'localhost',
      portOffset: offset,
      toolsFolder: pki.tools,
      readerPassword: pki.passwords.reader,
      log: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(5);
    await expect(
      checkOpcuaSecurity({
        host: 'localhost',
        portOffset: offset,
        toolsFolder: pki.tools,
        readerPassword: pki.passwords.gateway,
        log: () => undefined,
      }),
    ).rejects.toThrow(/opcua-reader refused on cnc-01/);
  }, 60_000);

  it('refuses to start a server without the pki step’s certificate', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'shopfloor-twin-no-pki-'));
    try {
      expect(
        () =>
          new PlantServers({
            config,
            start: T0,
            pkiFolder: empty,
            security: pki.security,
          }),
      ).toThrow(/certificate\.pem is missing: run the pki step first/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  /** A client folder of its own: `own` material as given, trusting this run's servers. */
  async function clientFolder(name: string, certificatePem: string, privateKeyPem: string) {
    const folder = join(scratch, name);
    for (const sub of ['own/certs', 'own/private']) {
      await mkdir(join(folder, sub), { recursive: true });
    }
    await cp(pkiFiles(pki.tools).trustedCerts, pkiFiles(folder).trustedCerts, { recursive: true });
    await writeFile(pkiFiles(folder).certificateFile, certificatePem);
    await writeFile(pkiFiles(folder).privateKeyFile, privateKeyPem, { mode: 0o600 });
    return folder;
  }

  async function restartServers(): Promise<void> {
    await servers?.stop();
    servers = undefined;
    await startServers();
  }

  it('refuses a pinned certificate without clientAuth (a server certificate as a client)', async () => {
    const serverRole = await createKeyAndCertificate({
      commonName: 'server-role client',
      role: 'server',
      applicationUri: 'urn:orbis-components:shopfloor-twin:server-role',
      dnsNames: ['localhost'],
      validityDays: 31,
      now: new Date(),
    });
    // Pinned on CNC-01 by hand, so only the extended key usage can refuse it.
    await writeFile(
      join(pkiFiles(join(pki.folder, 'cnc-01')).trustedCerts, 'server-role.pem'),
      serverRole.certificatePem,
    );
    await restartServers();
    const folder = await clientFolder(
      'server-role',
      serverRole.certificatePem,
      serverRole.privateKeyPem,
    );
    const outcome = await attempt(
      client(folder, 'urn:orbis-components:shopfloor-twin:server-role', {
        userName: OPCUA_USERS.reader,
        password: pki.passwords.reader,
      }),
    );
    expect(outcome).toContain('BadCertificateUseNotAllowed');
    expect(await attempt(reader)).toBe('opened');
  }, 60_000);

  it('refuses a legacy pin and a certificate minted with a pinned key once the pki step ran (#239 review)', async () => {
    // A certificate a server pinned before #239, when node-opcua accepted every client.
    const legacy = await createKeyAndCertificate({
      commonName: 'legacy client',
      role: 'client',
      applicationUri: 'urn:orbis-components:shopfloor-twin:legacy',
      dnsNames: ['localhost'],
      validityDays: 90,
      now: new Date(),
    });
    // A client certificate signed with the tools key (a pinned leaf) and that key's CRL in the
    // server's trusted/crl: the chain node-opcua would follow if the leaf could act as a CA.
    const toolsCa = await certificateAuthorityFrom(
      await readFile(pkiFiles(pki.tools).certificateFile, 'utf8'),
      await readFile(pkiFiles(pki.tools).privateKeyFile, 'utf8'),
    );
    const minted = await issueCertificate(toolsCa, {
      commonName: 'minted client',
      role: 'client',
      applicationUri: 'urn:orbis-components:shopfloor-twin:minted',
      dnsNames: ['localhost'],
      validityDays: 90,
      now: new Date(),
    });
    const cnc = join(pki.folder, 'cnc-01');
    await writeFile(join(pkiFiles(cnc).trustedCerts, 'legacy.pem'), legacy.certificatePem);
    await writeFile(
      join(cnc, 'trusted', 'crl', 'tools.crl.pem'),
      await createEmptyCrl(toolsCa, new Date()),
    );
    await restartServers();
    const legacyClient = client(
      await clientFolder('legacy', legacy.certificatePem, legacy.privateKeyPem),
      'urn:orbis-components:shopfloor-twin:legacy',
      { userName: OPCUA_USERS.reader, password: pki.passwords.reader },
    );
    const mintedClient = client(
      await clientFolder(
        'minted',
        minted.certificatePem + toolsCa.certificatePem,
        minted.privateKeyPem,
      ),
      'urn:orbis-components:shopfloor-twin:minted',
      { userName: OPCUA_USERS.reader, password: pki.passwords.reader },
    );
    // Before the step: the hand-made pin works, which is what an upgraded volume held.
    expect(await attempt(legacyClient)).toBe('opened');
    const mintedBefore = await attempt(mintedClient);
    const result = await ensureOpcuaPki({
      simulator: pki.folder,
      gateway: pki.gateway,
      tools: pki.tools,
    });
    expect(result.removed).toEqual(
      expect.arrayContaining([
        'cnc-01: trusted/certs/legacy.pem',
        'cnc-01: trusted/crl/tools.crl.pem',
        'cnc-01: trusted/certs/server-role.pem',
      ]),
    );
    await restartServers();
    const after = { legacy: await attempt(legacyClient), minted: await attempt(mintedClient) };
    expect(after.legacy).toContain('BadSecurityChecksFailed');
    // node-opcua follows a chain to a pinned leaf as to a CA, keyCertSign or not: with that key's CRL
    // in trusted/crl the minted certificate opened a session before the step (recorded in
    // ADR-0038); without any CRL it is refused.
    expect(mintedBefore).toBe('opened');
    expect(after.minted).toContain('BadCertificateRevocationUnknown');
    expect(await attempt(reader)).toBe('opened');
  }, 90_000);

  it('trusts a renewed certificate and no longer its predecessor', async () => {
    const previous = await mkdtemp(join(tmpdir(), 'shopfloor-twin-previous-tools-'));
    try {
      await cp(pki.tools, previous, { recursive: true });
      const result = await ensureOpcuaPki({
        simulator: pki.folder,
        gateway: pki.gateway,
        tools: pki.tools,
        renew: ['tools'],
      });
      expect(result.removed).toHaveLength(OPCUA_MACHINES.length);
      // The servers read their trust lists at start: restart them on the renewed pins.
      await servers?.stop();
      servers = undefined;
      await startServers();
      expect(await attempt(reader)).toBe('opened');
      const old = await attempt(
        client(previous, TOOLS_APPLICATION_URI, {
          userName: OPCUA_USERS.reader,
          password: pki.passwords.reader,
        }),
      );
      expect(old).toContain('BadSecurityChecksFailed');
    } finally {
      await rm(previous, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('userManager', () => {
  const manager = userManager({ gateway: 'g'.repeat(32), reader: 'r'.repeat(32) });
  const check = (user: string, password: string) =>
    new Promise<{ valid: boolean; ms: number }>((resolve, reject) => {
      const started = performance.now();
      manager.isValidUserAsync(user, password, (error, valid) => {
        if (error) reject(error);
        else resolve({ valid: valid === true, ms: performance.now() - started });
      });
    });

  it('accepts each user with its own password only, and answers a refusal after 250 ms', async () => {
    const gatewayOk = await check(OPCUA_USERS.gateway, 'g'.repeat(32));
    expect(gatewayOk.valid).toBe(true);
    expect(gatewayOk.ms).toBeLessThan(FAILED_LOGIN_DELAY_MS);
    expect((await check(OPCUA_USERS.reader, 'r'.repeat(32))).valid).toBe(true);
    for (const [user, password] of [
      [OPCUA_USERS.gateway, 'r'.repeat(32)],
      ['nobody', ''],
    ] as const) {
      const refused = await check(user, password);
      expect(refused.valid).toBe(false);
      expect(refused.ms).toBeGreaterThanOrEqual(FAILED_LOGIN_DELAY_MS - 5);
    }
    expect(manager.getUserRoles('nobody')).toEqual([]);
  });

  it('brakes a burst of guesses without blocking the event loop', async () => {
    const started = performance.now();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) => check(OPCUA_USERS.gateway, `guess-${String(i)}`)),
    );
    clearInterval(timer);
    expect(results.every((r) => !r.valid)).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(FAILED_LOGIN_DELAY_MS - 5);
    expect(ticks).toBeGreaterThan(5);
  });
});

describe('hasClientAuth', () => {
  it('reads the leaf of a DER chain', async () => {
    const make = (role: 'client' | 'server') =>
      createKeyAndCertificate({
        commonName: role,
        role,
        applicationUri: TOOLS_APPLICATION_URI,
        dnsNames: [],
        validityDays: 31,
        now: new Date(),
      });
    const client = inspectCertificate((await make('client')).certificatePem).der;
    const server = inspectCertificate((await make('server')).certificatePem).der;
    expect(hasClientAuth(client)).toBe(true);
    expect(hasClientAuth(Buffer.concat([client, server]))).toBe(true);
    expect(hasClientAuth(server)).toBe(false);
    expect(hasClientAuth(Buffer.concat([server, client]))).toBe(false);
    expect(hasClientAuth([server, client])).toBe(false);
    expect(hasClientAuth(Buffer.from([0x30, 0x03, 0, 0, 0]))).toBe(false);
  });
});
