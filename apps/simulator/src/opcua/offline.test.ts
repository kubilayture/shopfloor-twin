import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opcuaEndpoint } from '@shopfloor/contracts';
import { OPCUAClient } from 'node-opcua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDefaultConfig } from '../plant/testing.ts';
import { PlantServers } from './plant-servers.ts';

const OFFSET = 900;
let servers: PlantServers;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  servers = new PlantServers({
    config: await loadDefaultConfig(),
    start: Date.UTC(2026, 9, 12, 3),
    portOffset: OFFSET,
    pkiFolder: join(tmpdir(), 'shopfloor-twin-offline-test-pki'),
  });
  await servers.start();
}, 60_000);

afterAll(async () => {
  await servers.stop();
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
    await client.connect(opcuaEndpoint('localhost', 4841 + OFFSET));
    await client.createSession();

    expect(await servers.setOffline('cnc-01', true)).toBe(true);
    for (let i = 0; i < 50 && !events.includes('lost'); i++) await wait(100);
    expect(events).toEqual(['lost']);
    const newcomer = OPCUAClient.create({
      endpointMustExist: false,
      connectionStrategy: { maxRetry: 0 },
    });
    await expect(newcomer.connect(opcuaEndpoint('localhost', 4841 + OFFSET))).rejects.toThrow();

    await servers.setOffline('cnc-01', false);
    for (let i = 0; i < 50 && !events.includes('reestablished'); i++) await wait(100);
    expect(events).toEqual(['lost', 'reestablished']);
    expect(servers.servers[0]?.offline).toBe(false);
    expect(await servers.setOffline('cnc-99', true)).toBe(false);
    await client.disconnect();
  }, 60_000);
});
