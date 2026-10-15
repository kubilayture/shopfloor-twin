import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { opcuaEndpoint } from '@shopfloor/contracts';
import { OPCUAClient, type ClientSession } from 'node-opcua';

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
