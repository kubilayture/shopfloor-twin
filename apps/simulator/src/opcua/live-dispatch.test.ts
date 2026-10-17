/**
 * A live run dispatched through OPC UA `LoadOrder` equals headless `orders-01` (#172, ADR-0030,
 * B3): the run is attached and idle at its start time, every job of the scenario's `dispatches` is
 * called on its CNC's server (through the attach and replay gate and the device's epoch and expiry
 * guard) and accepted, then the injections are posted, then the run is stepped.
 */
import { OPCUA_MACHINES } from '@shopfloor/contracts';
import { HOUR } from '@shopfloor/sim-core';
import { afterAll, describe, expect, it } from 'vitest';
import { groundTruthSchema } from '../control/app.ts';
import { scenarioOptions } from '../headless/golden.ts';
import { runHeadless } from '../headless/run.ts';
import { EVENT_SCHEMA, isoTime, stableStringify } from '../headless/serialize.ts';
import { createLiveRun, type LiveRun } from '../live/run.ts';
import { ManualClock } from '../live/testing.ts';
import type { PlantEvent } from '../plant/line.ts';
import { onFreeOpcuaPorts, temporaryPki } from '../testing.ts';
import { PlantServers } from './plant-servers.ts';
import { callLoadOrder, connect } from './testing.ts';

const EPOCH = 1_791_000_000;
const WALL = Date.UTC(2026, 9, 16, 12);
let servers: PlantServers | undefined;
let run: LiveRun | undefined;
let removePki: (() => Promise<void>) | undefined;

afterAll(async () => {
  run?.pacer.stop();
  await servers?.stop();
  await removePki?.();
});

describe('live orders-01 dispatched over OPC UA (#172, B3)', () => {
  it('reproduces headless orders-01 when the jobs are dispatched through LoadOrder at the idle start, then injected', async () => {
    const options = await scenarioOptions('orders-01');
    const until = options.start + 8 * HOUR;
    const headless: string[] = [];
    runHeadless({ ...options, end: until }, (line) => headless.push(line));

    const pki = await temporaryPki('live-dispatch');
    removePki = pki.remove;
    const {
      portOffset,
      value: { plant, live, events },
    } = await onFreeOpcuaPorts(async (portOffset) => {
      const plant = new PlantServers({
        config: options.config,
        start: options.start,
        portOffset,
        epoch: EPOCH,
        production: 'orders',
        wallClock: () => WALL,
        pkiFolder: pki.folder,
      });
      servers = plant;
      const events: PlantEvent[] = [];
      const live = createLiveRun({
        config: options.config,
        seed: options.seed,
        start: options.start,
        speed: 60,
        clock: new ManualClock(),
        production: 'orders',
        onEvent: (event) => {
          events.push(event);
          plant.record(event);
        },
      });
      run = live;
      plant.attach(live);
      await plant.start();
      return { plant, live, events };
    });

    // The live order: attached and idle at the start time, every job dispatched and accepted
    // through LoadOrder, then the injections, then the run resumes.
    expect(live.pacer.state).toBe('idle');
    const dispatches = options.dispatches ?? [];
    expect(dispatches.length).toBeGreaterThan(0);
    for (const dispatch of dispatches) {
      const machine = plant.servers.find((s) => s.machineId === dispatch.machine);
      const port = OPCUA_MACHINES.find((m) => m.id === dispatch.machine)?.port ?? 0;
      const { session, close } = await connect(port + portOffset);
      try {
        const result = await callLoadOrder(session, dispatch.machine, {
          ...dispatch,
          deviceEpoch: EPOCH,
          expiresAt: WALL + 60_000,
        });
        expect(result, dispatch.commandId).toMatchObject({ status: 'Good', flagged: [] });
        expect(result.outputs[1], dispatch.commandId).toBe(false);
        expect(machine?.acceptance(dispatch.commandId)?.seq).toBe(result.outputs[2]);
      } finally {
        await close();
      }
    }
    for (const injection of options.injections ?? []) {
      expect(live.inject(injection).ok).toBe(true);
    }
    while (live.simulation.nextEventTime !== undefined && live.simulation.nextEventTime < until) {
      live.pacer.step();
    }

    const lines = events.map((event, i) =>
      stableStringify({ ...event, schema: EVENT_SCHEMA, seq: i + 1, at: isoTime(event.at) }),
    );
    expect(lines.length).toBeGreaterThan(1_000);
    expect(lines).toEqual(headless.slice(1));
    // The control API 1.4 serves this run's order ground truth whole.
    const truth = live.groundTruth();
    expect(truth.productionMode).toBe('orders');
    expect(groundTruthSchema.parse({ epoch: 1, ...truth }).orders).toEqual(
      JSON.parse(JSON.stringify(truth.orders)),
    );
    expect(truth.orders.jobs).toHaveLength(dispatches.length);
  }, 120_000);
});
