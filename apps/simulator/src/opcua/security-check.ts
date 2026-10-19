import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPCUA_MACHINES,
  OPCUA_METHODS,
  OPCUA_VARIABLES,
  opcuaEndpoint,
  opcuaNodeId,
  toIndexedNodeId,
} from '@shopfloor/contracts';
import {
  OPCUA_USERS,
  TOOLS_APPLICATION_URI,
  createKeyAndCertificate,
  pkiFiles,
} from '@shopfloor/pki';
import {
  AttributeIds,
  DataType,
  MessageSecurityMode,
  OPCUACertificateManager,
  OPCUAClient,
  SecurityPolicy,
  UserTokenPolicy,
  UserTokenType,
  resolveNodeId,
  type ClientSession,
  type EndpointDescription,
  type UserIdentityInfo,
} from 'node-opcua';

/**
 * Checklist S1 against running machine servers (#239, ADR-0038), as the tools client: the stack
 * smoke runs it in the `opcua-tools` container (`docker compose run --rm opcua-tools`), with the
 * tools certificate the `pki` step pinned on every server.
 *
 * - every server offers SignAndEncrypt only, with user-name tokens and no anonymous one;
 * - `opcua-reader` on the pinned tools certificate opens a session on every server and reads;
 * - the same session is refused `LoadOrder` and `LoadProgram` with `BadUserAccessDenied`: a
 *   permission refusal, on a certificate the server trusts;
 * - a client certificate the server doesn't pin is refused (`BadSecurityChecksFailed`);
 * - an anonymous session is refused, by the server too (the token sent anyway);
 * - a wrong password is refused.
 */
export interface SecurityCheckOptions {
  readonly host: string;
  readonly portOffset: number;
  /** The tools client's PKI folder (the `opcua-tools-pki` volume). */
  readonly toolsFolder: string;
  readonly readerPassword: string;
  readonly log?: (line: string) => void;
}

export class SecurityCheckError extends Error {}

const managers = new Map<string, Promise<OPCUACertificateManager>>();
/** One manager per folder, initialised once before its first use (see `testing.ts`). */
function manager(folder: string): Promise<OPCUACertificateManager> {
  let found = managers.get(folder);
  if (!found) {
    const created = new OPCUACertificateManager({
      rootFolder: folder,
      automaticallyAcceptUnknownCertificate: false,
    });
    found = created.initialize().then(() => created);
    managers.set(folder, found);
  }
  return found;
}

async function secureClient(folder: string): Promise<OPCUAClient> {
  return OPCUAClient.create({
    applicationName: 'shopfloor-twin tools',
    applicationUri: TOOLS_APPLICATION_URI,
    endpointMustExist: false,
    connectionStrategy: { maxRetry: 1, initialDelay: 250, maxDelay: 1_000 },
    securityMode: MessageSecurityMode.SignAndEncrypt,
    securityPolicy: SecurityPolicy.Basic256Sha256,
    certificateFile: pkiFiles(folder).certificateFile,
    privateKeyFile: pkiFiles(folder).privateKeyFile,
    clientCertificateManager: await manager(folder),
  });
}

const firstLine = (error: unknown): string =>
  error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);

/** Opens a session (or fails), runs `use`, and closes everything. */
async function withSession<T>(
  endpoint: string,
  folder: string,
  identity: UserIdentityInfo | undefined,
  use: (session: ClientSession) => Promise<T>,
  forceAnonymous = false,
): Promise<T> {
  const client = await secureClient(folder);
  try {
    await client.connect(endpoint);
    if (forceAnonymous) {
      // The endpoints offer no anonymous token, so node-opcua's client would refuse by itself:
      // add one to its copy of them, so that the server has to refuse the token.
      const known = (client as unknown as { _serverEndpoints: EndpointDescription[] })
        ._serverEndpoints;
      for (const description of known) {
        description.userIdentityTokens = [
          ...(description.userIdentityTokens ?? []),
          new UserTokenPolicy({ policyId: 'anonymous', tokenType: UserTokenType.Anonymous }),
        ];
      }
    }
    const session = await client.createSession(identity);
    try {
      return await use(session);
    } finally {
      await session.close().catch(() => undefined);
    }
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

/** Runs every check; throws `SecurityCheckError` naming the first that fails. */
export async function checkOpcuaSecurity(options: SecurityCheckOptions): Promise<void> {
  const log =
    options.log ??
    ((line: string) => {
      console.log(line);
    });
  const endpoint = (machine: string): string =>
    opcuaEndpoint(
      options.host,
      (OPCUA_MACHINES.find((m) => m.id === machine)?.port ?? 0) + options.portOffset,
    );
  const reader: UserIdentityInfo = {
    type: UserTokenType.UserName,
    userName: OPCUA_USERS.reader,
    password: options.readerPassword,
  };
  const fail = (message: string): never => {
    throw new SecurityCheckError(message);
  };

  for (const machine of OPCUA_MACHINES) {
    // Discovery runs over a None channel; the tools certificate keeps node-opcua from making a
    // default one in the home folder.
    const discovery = OPCUAClient.create({
      endpointMustExist: false,
      connectionStrategy: { maxRetry: 1 },
      certificateFile: pkiFiles(options.toolsFolder).certificateFile,
      privateKeyFile: pkiFiles(options.toolsFolder).privateKeyFile,
      clientCertificateManager: await manager(options.toolsFolder),
    });
    let endpoints: EndpointDescription[];
    try {
      await discovery.connect(endpoint(machine.id));
      endpoints = await discovery.getEndpoints();
    } finally {
      await discovery.disconnect().catch(() => undefined);
    }
    const insecure = endpoints.filter(
      (e) =>
        e.securityMode !== MessageSecurityMode.SignAndEncrypt ||
        (e.userIdentityTokens ?? []).some((t) => t.tokenType !== UserTokenType.UserName),
    );
    if (endpoints.length === 0 || insecure.length > 0) {
      fail(`${machine.id} offers an endpoint other than SignAndEncrypt with user names`);
    }
    const state = await withSession(
      endpoint(machine.id),
      options.toolsFolder,
      reader,
      async (s) => {
        const namespaces = await s.readNamespaceArray();
        return s.read({
          nodeId: resolveNodeId(
            toIndexedNodeId(opcuaNodeId(machine.id, OPCUA_VARIABLES.state), namespaces),
          ),
          attributeId: AttributeIds.Value,
        });
      },
    ).catch((error: unknown) => fail(`opcua-reader refused on ${machine.id}: ${firstLine(error)}`));
    if (!state.statusCode.isGood()) fail(`${machine.id}: State reads ${state.statusCode.name}`);
  }
  log(
    'ok: OPC UA servers offer SignAndEncrypt only (user names, no anonymous token); opcua-reader reads on all five',
  );

  const refusals = await withSession(endpoint('cnc-01'), options.toolsFolder, reader, async (s) => {
    const namespaces = await s.readNamespaceArray();
    const node = (path: string) =>
      resolveNodeId(toIndexedNodeId(opcuaNodeId('cnc-01', path), namespaces));
    const loadOrder = await s.call({
      objectId: node('ShopFloor'),
      methodId: node(OPCUA_METHODS.loadOrder),
      inputArguments: [
        { dataType: DataType.String, value: 'SMOKE~OP10~1' },
        { dataType: DataType.String, value: 'SMOKE' },
        { dataType: DataType.String, value: 'VB-100' },
        { dataType: DataType.UInt32, value: 1 },
        { dataType: DataType.DateTime, value: new Date() },
        { dataType: DataType.UInt32, value: 0 },
        { dataType: DataType.DateTime, value: new Date(Date.now() + 60_000) },
      ],
    });
    const loadProgram = await s.call({
      objectId: node('ShopFloor'),
      methodId: node(OPCUA_METHODS.loadProgram),
      inputArguments: [
        { dataType: DataType.String, value: 'VB-100' },
        { dataType: DataType.UInt32, value: 1 },
      ],
    });
    return [loadOrder.statusCode.name, loadProgram.statusCode.name];
  }).catch((error: unknown) => fail(`opcua-reader session on cnc-01: ${firstLine(error)}`));
  if (refusals.some((status) => status !== 'BadUserAccessDenied')) {
    fail(
      `opcua-reader's LoadOrder and LoadProgram answered ${refusals.join(', ')}, not BadUserAccessDenied`,
    );
  }
  log(
    'ok: opcua-reader (pinned tools certificate) refused LoadOrder and LoadProgram with BadUserAccessDenied',
  );

  const scratch = await mkdtemp(join(tmpdir(), 'opcua-unpinned-'));
  try {
    // A valid certificate for the tools URI that no server pins; it trusts the servers itself.
    for (const sub of ['own/certs', 'own/private']) {
      await mkdir(join(scratch, sub), { recursive: true });
    }
    await cp(pkiFiles(options.toolsFolder).trustedCerts, pkiFiles(scratch).trustedCerts, {
      recursive: true,
    });
    const unpinned = await createKeyAndCertificate({
      commonName: 'unpinned smoke client',
      role: 'client',
      applicationUri: TOOLS_APPLICATION_URI,
      dnsNames: ['localhost'],
      validityDays: 31,
      now: new Date(),
    });
    await writeFile(pkiFiles(scratch).privateKeyFile, unpinned.privateKeyPem, { mode: 0o600 });
    await writeFile(pkiFiles(scratch).certificateFile, unpinned.certificatePem);
    const outcome = await withSession(endpoint('cnc-01'), scratch, reader, () =>
      Promise.resolve('opened'),
    ).catch(firstLine);
    if (!outcome.includes('BadSecurityChecksFailed')) {
      fail(`an unpinned client certificate was not refused by the server: ${outcome}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  log('ok: a client certificate the server does not pin is refused (BadSecurityChecksFailed)');

  const anonymous = await withSession(
    endpoint('cnc-01'),
    options.toolsFolder,
    undefined,
    () => Promise.resolve('opened'),
    true,
  ).catch(firstLine);
  if (!anonymous.includes('BadIdentityToken'))
    fail(`an anonymous session was not refused: ${anonymous}`);
  const wrong = await withSession(
    endpoint('cnc-01'),
    options.toolsFolder,
    { ...reader, password: `${options.readerPassword}-wrong` },
    () => Promise.resolve('opened'),
  ).catch(firstLine);
  if (!/BadUserAccessDenied|BadIdentityTokenRejected/.test(wrong)) {
    fail(`a wrong password was not refused: ${wrong}`);
  }
  log('ok: anonymous sessions and a wrong password are refused by the server');
}
