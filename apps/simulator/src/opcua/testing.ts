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
import { DataType, OPCUAClient, resolveNodeId, type ClientSession } from 'node-opcua';

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function connect(
  port: number,
): Promise<{ session: ClientSession; close: () => Promise<void> }> {
  const client = OPCUAClient.create({
    endpointMustExist: false,
    connectionStrategy: { maxRetry: 2 },
  });
  await client.connect(opcuaEndpoint('localhost', port));
  const session = await client.createSession();
  return {
    session,
    close: async () => {
      await session.close();
      await client.disconnect();
    },
  };
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
