import { opcuaEndpoint } from '@shopfloor/contracts';
import { OPCUAClient } from 'node-opcua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDefaultConfig } from '../plant/testing.ts';
import { onFreeOpcuaPorts, temporaryPki } from '../testing.ts';
import { PlantServers } from './plant-servers.ts';

let offset: number;
let servers: PlantServers;
/** Set once the servers have started, so that `afterAll` stops only what `beforeAll` started. */
let started: PlantServers | undefined;
let removePki: (() => Promise<void>) | undefined;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const config = await loadDefaultConfig();
  const pki = await temporaryPki('offline');
  removePki = pki.remove;
  ({ portOffset: offset, value: servers } = await onFreeOpcuaPorts(
    (portOffset) =>
      new PlantServers({
        config,
        start: Date.UTC(2026, 9, 12, 3),
        portOffset,
        pkiFolder: pki.folder,
      }),
  ));
  started = servers;
}, 60_000);

afterAll(async () => {
  try {
    await started?.stop();
  } finally {
    await removePki?.();
  }
});

describe('OPC UA offline fault (#76, plan section 4)', () => {
  it('drops connected clients and refuses new ones while offline; clients reconnect once it is back', async () => {
    const client = OPCUAClient.create({
      endpointMustExist: false,
      connectionStrategy: { maxRetry: 100, initialDelay: 200, maxDelay: 500 },
    });
    const events: string[] = [];
    client.on('connection_lost', () => events.push('lost'));
    client.on('connection_reestablished', () => events.push('reestablished'));
    await client.connect(opcuaEndpoint('localhost', 4841 + offset));
    await client.createSession();

    expect(await servers.setOffline('cnc-01', true)).toBe(true);
    for (let i = 0; i < 50 && !events.includes('lost'); i++) await wait(100);
    expect(events).toEqual(['lost']);
    const newcomer = OPCUAClient.create({
      endpointMustExist: false,
      connectionStrategy: { maxRetry: 0 },
    });
    await expect(newcomer.connect(opcuaEndpoint('localhost', 4841 + offset))).rejects.toThrow();

    await servers.setOffline('cnc-01', false);
    for (let i = 0; i < 50 && !events.includes('reestablished'); i++) await wait(100);
    expect(events).toEqual(['lost', 'reestablished']);
    expect(servers.servers[0]?.offline).toBe(false);
    expect(await servers.setOffline('cnc-99', true)).toBe(false);
    await client.disconnect();
  }, 60_000);
});
