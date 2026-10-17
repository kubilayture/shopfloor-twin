/**
 * `LoadOrder` refusals for the run's state over OPC UA (#172, ADR-0030): a call before the run is
 * attached, or after it has finished, is transient for the caller (`BadWaitingForInitialData`, no
 * argument flagged), while production mode `schedule` is permanent (`BadInvalidState`, no
 * argument flagged), so the gateway (#173) can tell a retry from a definitive refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveRun, type LiveRun } from '../live/run.ts';
import { ManualClock } from '../live/testing.ts';
import type { ProductionMode } from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { PlantServers } from './plant-servers.ts';
import { onFreeOpcuaPorts, temporaryPki } from '../testing.ts';
import { callLoadOrder, connect } from './testing.ts';

const T0 = Date.UTC(2026, 9, 12, 3);
let offset: number;
const EPOCH = 1_791_000_000;
const WALL = Date.UTC(2026, 9, 16, 12);
const CALL = {
  commandId: 'PO-1~OP10~1',
  orderId: 'PO-1',
  product: 'VB-100',
  quantity: 4,
  notBefore: T0,
  deviceEpoch: EPOCH,
  expiresAt: WALL + 60_000,
};
let servers: PlantServers;
let removePki: (() => Promise<void>) | undefined;
const runs: LiveRun[] = [];

async function liveRun(production: ProductionMode): Promise<LiveRun> {
  const run = createLiveRun({
    config: await loadDefaultConfig(),
    seed: 20261012,
    start: T0,
    speed: 60,
    clock: new ManualClock(),
    production,
    onEvent: (event) => {
      servers.record(event);
    },
  });
  runs.push(run);
  return run;
}

beforeAll(async () => {
  const config = await loadDefaultConfig();
  const pki = await temporaryPki('load-order-state');
  removePki = pki.remove;
  ({ portOffset: offset } = await onFreeOpcuaPorts(async (portOffset) => {
    servers = new PlantServers({
      config,
      start: T0,
      portOffset,
      epoch: EPOCH,
      production: 'orders',
      wallClock: () => WALL,
      pkiFolder: pki.folder,
    });
    await servers.start();
  }));
}, 60_000);

afterAll(async () => {
  for (const run of runs) run.pacer.stop();
  await servers.stop();
  await removePki?.();
});

describe('LoadOrder refusals for the run state over OPC UA (#172)', () => {
  it('answers BadWaitingForInitialData with no argument flagged while the run is not attached', async () => {
    const { session, close } = await connect(4841 + offset);
    try {
      expect(await callLoadOrder(session, 'cnc-01', CALL)).toEqual({
        status: 'BadWaitingForInitialData',
        flagged: [],
        outputs: [],
      });
      expect(servers.servers[0]?.acceptance(CALL.commandId)).toBeUndefined();
    } finally {
      await close();
    }
  }, 60_000);

  it('answers BadWaitingForInitialData with no argument flagged once the run has finished', async () => {
    const run = await liveRun('orders');
    servers.attach(run);
    run.pacer.stop();
    expect(run.pacer.state).toBe('finished');
    const { session, close } = await connect(4841 + offset);
    try {
      expect(await callLoadOrder(session, 'cnc-01', CALL)).toEqual({
        status: 'BadWaitingForInitialData',
        flagged: [],
        outputs: [],
      });
      expect(run.line.queue('cnc-01')).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it('answers BadInvalidState with no argument flagged in production mode schedule', async () => {
    const run = await liveRun('schedule');
    servers.attach(run);
    expect(run.pacer.state).toBe('idle');
    const { session, close } = await connect(4842 + offset);
    try {
      expect(await callLoadOrder(session, 'cnc-02', CALL)).toEqual({
        status: 'BadInvalidState',
        flagged: [],
        outputs: [],
      });
    } finally {
      await close();
    }
  }, 60_000);
});
