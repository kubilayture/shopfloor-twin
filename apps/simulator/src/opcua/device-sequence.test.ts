import { createHash } from 'node:crypto';
import { HOUR } from '@shopfloor/sim-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scenarioOptions } from '../headless/golden.ts';
import { createLiveRun } from '../live/run.ts';
import { temporaryPki } from '../testing.ts';
import { PlantServers } from './plant-servers.ts';

/**
 * Phase 8 plan, "Device facts for traceability" (ADR-0033): lots and the operator are fields on
 * the existing cycle event, so no OPC UA event enters or leaves a device sequence. A scripted
 * shift (orders-01's Monday shift A, with its dispatches and injections) is routed through the
 * machine servers, unstarted, so their sequence counters move exactly as they do live; every
 * (machine, seq, plant event type) that took a sequence number is hashed and compared with the
 * digest recorded from `main` before #196.
 */
const RECORDED = {
  events: 1279,
  sha256: 'af5f4164e261eafec27b63a0590783ad46629359ce469ebef64a08965be083fe',
};

// The servers here are never started (no port is bound); they still get a folder of their own.
let pki: Awaited<ReturnType<typeof temporaryPki>>;

beforeAll(async () => {
  pki = await temporaryPki('sequence');
});

afterAll(async () => {
  await pki.remove();
});

describe('device sequence (ADR-0009, ADR-0033)', () => {
  it("keeps every OPC UA event's (machine, seq, type) of a scripted shift", async () => {
    const options = await scenarioOptions('orders-01');
    const servers = new PlantServers({
      config: options.config,
      start: options.start,
      pkiFolder: pki.folder,
      production: 'orders',
    });
    const lines: string[] = [];
    const run = createLiveRun({
      config: options.config,
      seed: options.seed,
      start: options.start,
      production: 'orders',
      dispatches: options.dispatches ?? [],
      onEvent: (event) => {
        if (!('machineId' in event)) return;
        const server = servers.servers.find((s) => s.machineId === event.machineId);
        if (!server) return;
        const before = server.sequence;
        server.record(event);
        if (server.sequence !== before) {
          expect(server.sequence).toBe(before + 1);
          lines.push(`${event.machineId} ${String(server.sequence)} ${event.type}`);
        }
      },
    });
    for (const injection of options.injections ?? []) {
      const accepted = run.inject(injection);
      expect(accepted.ok).toBe(true);
    }
    const end = options.start + 8 * HOUR;
    run.simulation.runUntil(end - 1, (event, simulation) => {
      run.line.handle(event, simulation);
    });
    const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
    expect({ events: lines.length, sha256: digest }).toEqual(RECORDED);
  });

  it('gives a leak-drift event no sequence number', async () => {
    const options = await scenarioOptions('week-01');
    const servers = new PlantServers({
      config: options.config,
      start: options.start,
      pkiFolder: pki.folder,
    });
    const drifts: number[] = [];
    const run = createLiveRun({
      config: options.config,
      seed: options.seed,
      start: options.start,
      onEvent: (event) => {
        if (!('machineId' in event)) return;
        const server = servers.servers.find((s) => s.machineId === event.machineId);
        const before = server?.sequence;
        server?.record(event);
        if (event.type === 'leak-drift') drifts.push((server?.sequence ?? 0) - (before ?? 0));
      },
    });
    const accepted = run.injectLeakDrift({
      machine: 'lkt-01',
      shift: 0.6,
      at: options.start + HOUR + 1,
      until: options.start + 2 * HOUR + 1,
    });
    expect(accepted.ok).toBe(true);
    run.simulation.runUntil(options.start + 3 * HOUR, (event, simulation) => {
      run.line.handle(event, simulation);
    });
    expect(drifts).toEqual([0, 0]);
  });
});
