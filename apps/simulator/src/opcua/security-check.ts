import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPCUA_MACHINES,
  OPCUA_METHODS,
  OPCUA_VARIABLES,
  SHOPFLOOR_NAMESPACE_URI,
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
  BrowseDirection,
  DataType,
  NodeClass,
  MessageSecurityMode,
  OPCUACertificateManager,
  OPCUAClient,
  SecurityPolicy,
  UserTokenPolicy,
  UserTokenType,
  resolveNodeId,
  type ClientSession,
  type EndpointDescription,
  type NodeId,
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
 * - a wrong password is refused;
 * - no variable of any machine is writable: none has the CurrentWrite bit, for `opcua-reader`, and
 *   a Write of every variable is refused (`BadNotWritable` or `BadUserAccessDenied`).
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

  let variables = 0;
  for (const machine of OPCUA_MACHINES) {
    const probe = await withSession(endpoint(machine.id), options.toolsFolder, reader, (s) =>
      probeWrites(s, machine.id),
    ).catch((error: unknown) => fail(`write probe on ${machine.id}: ${firstLine(error)}`));
    if (probe.writableByAccessLevel.length > 0 || probe.writesNotRefused.length > 0) {
      fail(
        `${machine.id}: writable for opcua-reader: ${[...probe.writableByAccessLevel, ...probe.writesNotRefused].join(', ')}`,
      );
    }
    variables += probe.variables;
  }
  log(
    `ok: no variable is writable (${String(variables)} variables on five machines, every Write refused)`,
  );
}

/** What a client may write under one machine (#239 review). */
export interface WriteProbe {
  /** Variables found by browsing the machine's object downwards. */
  readonly variables: number;
  /** Browse names whose AccessLevel or UserAccessLevel has the CurrentWrite bit. */
  readonly writableByAccessLevel: string[];
  /** `<browse name> <status>` of each Write not refused with BadNotWritable or BadUserAccessDenied. */
  readonly writesNotRefused: string[];
}

const CURRENT_WRITE = 0x02;
const VARIABLE: number = NodeClass.Variable;
const OBJECT: number = NodeClass.Object;
const REFUSED_WRITES = new Set(['BadNotWritable', 'BadUserAccessDenied']);

/**
 * Browses every variable under a machine's object (hierarchical references, depth first) and
 * writes each one its own current value, in one Write request: a refusal by access level answers
 * before any type check, so a Good or another code means the value could be changed.
 */
export async function probeWrites(session: ClientSession, machineId: string): Promise<WriteProbe> {
  const namespaces = await session.readNamespaceArray();
  const start = resolveNodeId(
    toIndexedNodeId(`nsu=${SHOPFLOOR_NAMESPACE_URI};s=${machineId}`, namespaces),
  );
  const seen = new Set<string>([start.toString()]);
  const queue: NodeId[] = [start];
  const found: { nodeId: NodeId; name: string }[] = [];
  while (queue.length > 0) {
    const batch = queue.splice(0, 50);
    const results = await session.browse(
      batch.map((nodeId) => ({
        nodeId,
        referenceTypeId: 'HierarchicalReferences',
        includeSubtypes: true,
        browseDirection: BrowseDirection.Forward,
        resultMask: 63,
      })),
    );
    for (const result of results) {
      for (const reference of result.references ?? []) {
        const id = reference.nodeId.toString();
        if (seen.has(id)) continue;
        seen.add(id);
        const nodeId = resolveNodeId(reference.nodeId);
        const nodeClass: number = reference.nodeClass;
        if (nodeClass === VARIABLE) {
          found.push({ nodeId, name: reference.browseName.toString() });
        }
        if (nodeClass === VARIABLE || nodeClass === OBJECT) {
          queue.push(nodeId);
        }
      }
    }
  }
  const attributes = await session.read(
    found.flatMap(({ nodeId }) => [
      { nodeId, attributeId: AttributeIds.AccessLevel },
      { nodeId, attributeId: AttributeIds.UserAccessLevel },
      { nodeId, attributeId: AttributeIds.Value },
    ]),
  );
  const writableByAccessLevel = found
    .filter((_, i) =>
      [attributes[3 * i], attributes[3 * i + 1]].some(
        (value) => (Number(value?.value.value) & CURRENT_WRITE) !== 0,
      ),
    )
    .map((variable) => variable.name);
  const writes = await session.write(
    found.map(({ nodeId }, i) => ({
      nodeId,
      attributeId: AttributeIds.Value,
      value: { value: attributes[3 * i + 2]?.value ?? { dataType: DataType.Null } },
    })),
  );
  const writesNotRefused = found
    .map((variable, i) => `${variable.name} ${writes[i]?.name ?? 'missing'}`)
    .filter((line) => !REFUSED_WRITES.has(line.slice(line.lastIndexOf(' ') + 1)));
  return { variables: found.length, writableByAccessLevel, writesNotRefused };
}
