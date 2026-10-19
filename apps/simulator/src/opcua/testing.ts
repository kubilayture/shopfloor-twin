import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  LOAD_ORDER_INPUTS,
  OPCUA_METHODS,
  SHOPFLOOR_NAMESPACE_URI,
  opcuaEndpoint,
  opcuaNodeId,
  toIndexedNodeId,
} from '@shopfloor/contracts';
import { pkiFiles } from '@shopfloor/pki';
import {
  DataType,
  MessageSecurityMode,
  OPCUACertificateManager,
  OPCUAClient,
  SecurityPolicy,
  UserTokenType,
  resolveNodeId,
  type ClientSession,
} from 'node-opcua';

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How a test client connects (#239): over None, or SignAndEncrypt with a pinned certificate. */
export type TestClient =
  | { readonly mode: 'none' }
  | {
      readonly mode: 'sign-and-encrypt';
      /** The client's own PKI folder (the pki step's `tools` or `gateway`, or an unpinned one). */
      readonly pkiFolder: string;
      readonly applicationUri: string;
      /** User name and password; left out, the session is anonymous. */
      readonly user?: { readonly userName: string; readonly password: string };
    };

const certificateManagers = new Map<string, Promise<OPCUACertificateManager>>();

/**
 * One certificate manager per folder and process (node-opcua locks the folder it manages),
 * initialised once before its first use: clients that start at the same moment and initialise it
 * each on their own can read its trust list before it is loaded and refuse a pinned server
 * (`BadCertificateUntrusted`).
 */
function certificateManager(folder: string): Promise<OPCUACertificateManager> {
  let manager = certificateManagers.get(folder);
  if (!manager) {
    const created = new OPCUACertificateManager({
      rootFolder: folder,
      automaticallyAcceptUnknownCertificate: false,
    });
    manager = created.initialize().then(() => created);
    certificateManagers.set(folder, manager);
  }
  return manager;
}

export async function connect(
  port: number,
  as: TestClient = { mode: 'none' },
): Promise<{ session: ClientSession; close: () => Promise<void> }> {
  const client =
    as.mode === 'none'
      ? OPCUAClient.create({ endpointMustExist: false, connectionStrategy: { maxRetry: 2 } })
      : OPCUAClient.create({
          endpointMustExist: false,
          connectionStrategy: { maxRetry: 2 },
          applicationName: 'shopfloor-twin test client',
          applicationUri: as.applicationUri,
          securityMode: MessageSecurityMode.SignAndEncrypt,
          securityPolicy: SecurityPolicy.Basic256Sha256,
          certificateFile: pkiFiles(as.pkiFolder).certificateFile,
          privateKeyFile: pkiFiles(as.pkiFolder).privateKeyFile,
          clientCertificateManager: await certificateManager(as.pkiFolder),
        });
  await client.connect(opcuaEndpoint('localhost', port));
  try {
    const session = await client.createSession(
      as.mode === 'sign-and-encrypt' && as.user
        ? { type: UserTokenType.UserName, userName: as.user.userName, password: as.user.password }
        : undefined,
    );
    return {
      session,
      close: async () => {
        await session.close();
        await client.disconnect();
      },
    };
  } catch (error) {
    await client.disconnect();
    throw error;
  }
}

export interface LoadOrderCall {
  readonly commandId: string;
  readonly orderId: string;
  readonly product: string;
  readonly quantity: number;
  readonly notBefore: number;
  readonly deviceEpoch: number;
  readonly expiresAt: number;
}

/**
 * Calls a CNC's `ShopFloor.LoadOrder` (#172): the status name, the flagged arguments
 * (`<argument> <status>`) and the outputs (dates as epoch milliseconds).
 */
export async function callLoadOrder(session: ClientSession, machine: string, call: LoadOrderCall) {
  const namespaces = await session.readNamespaceArray();
  const result = await session.call({
    objectId: resolveNodeId(
      toIndexedNodeId(`nsu=${SHOPFLOOR_NAMESPACE_URI};s=${machine}.ShopFloor`, namespaces),
    ),
    methodId: resolveNodeId(
      toIndexedNodeId(opcuaNodeId(machine, OPCUA_METHODS.loadOrder), namespaces),
    ),
    inputArguments: [
      { dataType: DataType.String, value: call.commandId },
      { dataType: DataType.String, value: call.orderId },
      { dataType: DataType.String, value: call.product },
      { dataType: DataType.UInt32, value: call.quantity },
      { dataType: DataType.DateTime, value: new Date(call.notBefore) },
      { dataType: DataType.UInt32, value: call.deviceEpoch },
      { dataType: DataType.DateTime, value: new Date(call.expiresAt) },
    ],
  });
  return {
    status: result.statusCode.name,
    flagged: (result.inputArgumentResults ?? [])
      .map((r, i) => (r.name === 'Good' ? undefined : `${LOAD_ORDER_INPUTS[i] ?? '?'} ${r.name}`))
      .filter((x) => x !== undefined),
    outputs: (result.outputArguments ?? []).map((o) =>
      o.value instanceof Date ? o.value.getTime() : (o.value as unknown),
    ),
  };
}

export interface DocumentedVariable {
  readonly path: string;
  readonly type: 'String' | 'UInt32' | 'Double' | 'Boolean';
  readonly machines: string;
}

const CONTRACT = resolve(import.meta.dirname, '../../../../docs/contracts/opcua-address-space.md');

/** The "Project variables" table of the address-space contract, one row per path. */
export async function documentedVariables(): Promise<DocumentedVariable[]> {
  const text = await readFile(CONTRACT, 'utf8');
  const section = text.slice(text.indexOf('## Project variables'));
  const table = section.slice(0, section.indexOf('\n\n', section.indexOf('| ---')));
  return table
    .split('\n')
    .slice(2)
    .flatMap((row) => {
      const [paths = '', type = '', machines = ''] = row
        .split('|')
        .slice(1)
        .map((c) => c.trim());
      const names = [...paths.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
      const first = names[0] ?? '';
      const parent = first.slice(0, first.lastIndexOf('.'));
      return names.map((name) => ({
        path: name.startsWith('.') ? `${parent}${name}` : name,
        type: type.split(',')[0]?.trim() as DocumentedVariable['type'],
        machines,
      }));
    });
}

/** The Events table of the address-space contract: event type name → its project fields. */
export async function documentedEventFields(): Promise<Map<string, string[]>> {
  const text = await readFile(CONTRACT, 'utf8');
  const section = text.slice(text.indexOf('## Events'));
  const table = section.slice(0, section.indexOf('\n\n', section.indexOf('| ---')));
  return new Map(
    table
      .split('\n')
      .slice(2)
      .flatMap((row) => {
        const [type = '', fields = ''] = row
          .split('|')
          .slice(1)
          .map((c) => c.trim());
        const name = /^`([^`]+)`$/.exec(type)?.[1];
        if (!name) return [];
        const list = (fields.split(';')[0] ?? '')
          .replace(/\([^)]*\)/g, '')
          .split(',')
          .map((f) => f.trim())
          .filter((f) => f !== '');
        return [[name, list]];
      }),
  );
}
