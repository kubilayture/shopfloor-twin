import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ENTRY_SIZE,
  MACHINE_STATES,
  MODBUS_MAP_VERSION,
  REGISTERS,
  RING_CAPACITY,
  SNAPSHOT_LENGTH,
  STATUS_BITS,
  decodeActiveAlarms,
  decodeEntry,
  i16,
  ringSlot,
  u32,
  u64,
  type RingEntry,
} from '@shopfloor/contracts';
import type { PlantConfig } from '@shopfloor/plant-config';
import { HOUR } from '@shopfloor/sim-core';
import Modbus from 'modbus-serial';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveRun, type LiveRun } from '../live/run.ts';
import { ManualClock } from '../live/testing.ts';
import type { PlantEvent } from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { onFreePort } from '../testing.ts';
import { WasherModbusServer } from './washer-server.ts';

const ModbusRTU = Modbus.default;
const T0 = Date.UTC(2026, 9, 12, 3);
const EPOCH = 1_791_774_000;
let config: PlantConfig;
let washer: WasherModbusServer;
let run: LiveRun;
let clock: ManualClock;
let client: InstanceType<typeof ModbusRTU>;
const events: PlantEvent[] = [];

const read = async (address: number, length: number): Promise<number[]> =>
  (await client.readHoldingRegisters(address, length)).data;

/** Reads entries first..last in requests of at most 12 entries, split where the ring ends. */
async function readEntries(first: number, last: number): Promise<(RingEntry | undefined)[]> {
  const entries: (RingEntry | undefined)[] = [];
  let requests = 0;
  for (let seq = first; seq <= last;) {
    const untilRingEnd = RING_CAPACITY - ((seq - 1) % RING_CAPACITY);
    const count = Math.min(12, last - seq + 1, untilRingEnd);
    const words = await read(ringSlot(seq), count * ENTRY_SIZE);
    requests++;
    for (let i = 0; i < count; i++) {
      entries.push(decodeEntry(words.slice(i * ENTRY_SIZE, (i + 1) * ENTRY_SIZE), washer.tables));
    }
    seq += count;
  }
  readRequests += requests;
  return entries;
}

let readRequests = 0;

const washerFacts = (): PlantEvent[] =>
  events.filter(
    (e) =>
      'machineId' in e &&
      e.machineId === 'wsh-01' &&
      (e.type === 'state' || e.type === 'cycle-complete' || e.type === 'alarm'),
  );

function asEntry(event: PlantEvent, seq: number): RingEntry {
  if (event.type === 'state') {
    return { type: 'state', seq, at: event.at, state: event.to, cause: event.cause ?? null };
  }
  if (event.type === 'cycle-complete') {
    return {
      type: 'cycle',
      seq,
      at: event.at,
      product: event.product,
      result: event.result,
      partId: event.partId,
    };
  }
  if (event.type === 'alarm') {
    return { type: 'alarm', seq, at: event.at, code: event.code, transition: event.transition };
  }
  throw new Error(`not a washer fact: ${event.type}`);
}

beforeAll(async () => {
  config = await loadDefaultConfig();
  const { port } = await onFreePort((port) => {
    clock = new ManualClock();
    events.length = 0;
    washer = new WasherModbusServer({ config, epoch: EPOCH, port });
    run = createLiveRun({
      config,
      seed: 20261012,
      start: T0,
      speed: 60,
      clock,
      onEvent: (event) => {
        events.push(event);
        washer.record(event);
      },
    });
    washer.attach(run);
    return washer;
  });
  client = new ModbusRTU();
  await client.connectTCP('127.0.0.1', { port });
  client.setID(1);
  client.setTimeout(500);
});

afterAll(async () => {
  run.pacer.stop();
  client.close(() => undefined);
  await washer.stop();
});

describe('WSH-01 Modbus server (#74)', () => {
  it('matches the register table of docs/contracts/modbus-register-map.md', async () => {
    const doc = await readFile(
      resolve(import.meta.dirname, '../../../../docs/contracts/modbus-register-map.md'),
      'utf8',
    );
    const section = doc.slice(doc.indexOf('## Registers'), doc.indexOf('## Ring entries'));
    const rows = [...section.matchAll(/^\| (\d+) +\| `(\w+)` +\| (\w+) +\|/gm)].map((m) => [
      m[2],
      Number(m[1]),
    ]);
    expect(Object.fromEntries(rows)).toEqual(REGISTERS);
    const snapshot = await read(0, SNAPSHOT_LENGTH);
    expect(snapshot[REGISTERS.mapVersion]).toBe(MODBUS_MAP_VERSION);
    expect(MODBUS_MAP_VERSION).toBe(2);
    expect(u32(snapshot, REGISTERS.epoch)).toBe(EPOCH);
    expect(snapshot[REGISTERS.ringCapacity]).toBe(RING_CAPACITY);
    expect(snapshot[REGISTERS.entrySize]).toBe(ENTRY_SIZE);
  });

  it('serves a snapshot that agrees with the model at the last processed step', async () => {
    run.pacer.start();
    for (let i = 0; i < 180; i++) clock.advance(1_000); // 3 simulated hours
    run.pacer.pause();
    const snapshot = await read(0, SNAPSHOT_LENGTH);
    const now = run.simulation.now;
    expect(u64(snapshot, REGISTERS.simTime)).toBe(now);
    const lastState = events.filter((e) => e.type === 'state' && e.machineId === 'wsh-01').at(-1);
    expect(MACHINE_STATES[snapshot[REGISTERS.state] ?? -1]).toBe(
      lastState?.type === 'state' ? lastState.to : undefined,
    );
    const reading = run.processValues.readWasher(now);
    expect(i16(snapshot[REGISTERS.bathTemperature] ?? 0) / 10).toBeCloseTo(
      reading?.bathCelsius ?? NaN,
      6,
    );
    expect((snapshot[REGISTERS.conveyorSpeed] ?? 0) / 100).toBeCloseTo(
      reading?.conveyorMetresPerMinute ?? NaN,
      6,
    );
    expect(Boolean((snapshot[REGISTERS.status] ?? 0) & STATUS_BITS.heaterOn)).toBe(
      reading?.heaterOn,
    );
    const cycles = events.filter(
      (e) => e.type === 'cycle-complete' && e.machineId === 'wsh-01',
    ).length;
    expect(u32(snapshot, REGISTERS.cycles)).toBe(cycles);
    expect(cycles).toBeGreaterThan(20);
  });

  it('keeps every fact in the ring: polling once per simulated minute loses nothing over a shift', async () => {
    const collected: RingEntry[] = [];
    let handled = u32(await read(0, SNAPSHOT_LENGTH), REGISTERS.eventCounter);
    const before = washerFacts().length;
    expect(handled).toBe(before);
    run.pacer.resume();
    for (let i = 0; i < 300; i++) {
      clock.advance(1_000); // one simulated minute at 60×
      const counter = u32(await read(0, SNAPSHOT_LENGTH), REGISTERS.eventCounter);
      expect(counter - handled).toBeLessThanOrEqual(RING_CAPACITY);
      for (const entry of await readEntries(handled + 1, counter)) {
        if (entry) collected.push(entry);
      }
      handled = counter;
    }
    run.pacer.pause();
    const expected = washerFacts()
      .slice(before)
      .map((event, i) => asEntry(event, before + i + 1));
    expect(expected.length).toBeGreaterThan(100);
    expect(collected).toEqual(expected);
    expect(collected.some((e) => e.type === 'state' && e.cause === 'BREAK')).toBe(true);
    expect(collected.some((e) => e.type === 'cycle')).toBe(true);
  });

  it('overwrites the oldest entries after 64 facts, which a poller detects by the entry sequence', async () => {
    const counter = u32(await read(0, SNAPSHOT_LENGTH), REGISTERS.eventCounter);
    expect(counter).toBeGreaterThan(RING_CAPACITY);
    const [entry] = await readEntries(counter - RING_CAPACITY, counter - RING_CAPACITY);
    expect(entry?.seq).toBe(counter);
  });

  it('answers out-of-map reads with exception 2, and other unit ids or a silent device not at all', async () => {
    for (const [address, length] of [
      [730, 20],
      [0, 126],
    ] as const) {
      await expect(read(address, length)).rejects.toMatchObject({ modbusCode: 2 });
    }
    client.setID(7);
    await expect(read(0, 1)).rejects.toThrow(/Timed out/);
    client.setID(1);
    washer.silent = true;
    await expect(read(0, 1)).rejects.toThrow(/Timed out/);
    washer.silent = false;
    expect(await read(0, 1)).toEqual([MODBUS_MAP_VERSION]);
    await expect(client.readInputRegisters(0, 1)).rejects.toMatchObject({ modbusCode: 1 });
    await expect(client.readCoils(0, 1)).rejects.toMatchObject({ modbusCode: 1 });
    await expect(client.writeRegister(0, 5)).rejects.toMatchObject({ modbusCode: 1 });
    expect(await read(0, 1)).toEqual([MODBUS_MAP_VERSION]);
  });

  it('reads across the ring end in two requests: one read across it would be refused', async () => {
    const counter = u32(await read(0, SNAPSHOT_LENGTH), REGISTERS.eventCounter);
    const lastSlotSeq = counter - ((counter - 1) % RING_CAPACITY) - 1; // ends at slot 63
    const before = readRequests;
    const entries = await readEntries(lastSlotSeq - 5, lastSlotSeq + 5);
    expect(entries.map((e) => e?.seq)).toEqual(
      Array.from({ length: 11 }, (_, i) => lastSlotSeq - 5 + i),
    );
    expect(readRequests - before).toBe(2);
    await expect(read(ringSlot(lastSlotSeq - 1), 3 * ENTRY_SIZE)).rejects.toMatchObject({
      modbusCode: 2,
    });
  });

  it('carries alarm transitions through the ring, and the active alarms with the counter (#141)', async () => {
    const at = run.simulation.now;
    const snapshots: number[][] = [];
    for (const transition of ['active', 'cleared'] as const) {
      washer.record({
        type: 'alarm',
        at,
        machineId: 'wsh-01',
        code: 'HEATER-FAULT',
        transition,
        severity: 700,
      });
      snapshots.push(await read(0, SNAPSHOT_LENGTH));
    }
    // One read of the snapshot block: the bits belong to its eventCounter.
    expect(
      snapshots.map((words) => [
        u32(words, REGISTERS.eventCounter),
        decodeActiveAlarms(words[REGISTERS.activeAlarms] ?? 0, washer.tables),
      ]),
    ).toEqual([
      [washer.sequence - 1, ['HEATER-FAULT']],
      [washer.sequence, []],
    ]);
    const counter = u32(await read(0, SNAPSHOT_LENGTH), REGISTERS.eventCounter);
    expect(await readEntries(counter - 1, counter)).toEqual([
      { type: 'alarm', seq: counter - 1, at, code: 'HEATER-FAULT', transition: 'active' },
      { type: 'alarm', seq: counter, at, code: 'HEATER-FAULT', transition: 'cleared' },
    ]);
  });

  it('documents the default lookup tables', async () => {
    const doc = await readFile(
      resolve(import.meta.dirname, '../../../../docs/contracts/modbus-register-map.md'),
      'utf8',
    );
    const row = (name: string) =>
      [
        ...(new RegExp(`\\| ${name} +\\|([^\\n]*)\\|`).exec(doc)?.[1] ?? '').matchAll(
          /`([A-Z0-9-]+)`/g,
        ),
      ].map((m) => m[1]);
    expect(row('Causes')).toEqual(washer.tables.causes.slice(1));
    expect(row('Products')).toEqual(washer.tables.products);
    expect(row('Alarms')).toEqual(washer.tables.alarms);
  });

  it('starts the epoch and counter fresh with each run', () => {
    // The model's facts, plus the two alarm entries recorded directly above.
    expect(washer.sequence).toBe(washerFacts().length + 2);
    expect(run.simulation.now - T0).toBeGreaterThan(7 * HOUR);
  });
});
