import { resolve } from 'node:path';
import {
  ENTRY_SIZE,
  MODBUS_MAX_READ,
  REGISTERS,
  RING_END,
  SNAPSHOT_LENGTH,
  encodeActiveAlarms,
  encodeEntry,
  modbusTables,
  parseUnsMessage,
  ringSlot,
  writeU32,
  writeU64,
  type AlarmSnapshot,
  type RingEntry,
  type StateCurrent,
  type Telemetry,
} from '@shopfloor/contracts';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TopicSequences } from '../identity.ts';
import type { IncidentInput } from '../incidents.ts';
import type { UnsPublication } from '../publisher.ts';
import { startSimulator, type RunningSimulator } from '../testing.ts';
import { MemoryCursorStore, ModbusPoller, connectModbus, type RegisterReader } from './poller.ts';

const PATH = { area: 'machining', workCenter: 'cell-m1', equipment: 'wsh-01' } as const;
const tables = modbusTables({
  products: ['VB-100', 'VB-200'],
  failureCodes: ['HEATER-FAULT'],
  minorStopCauses: ['CONVEYOR-JAM'],
});

/** A ring entry without its sequence number, distributed over the union. */
type Fact = RingEntry extends infer E ? (E extends RingEntry ? Omit<E, 'seq'> : never) : never;

/** A WSH-01 register map in memory, written with the contract's own encoders. */
class FakeWasher implements RegisterReader {
  readonly registers = new Array<number>(RING_END).fill(0);
  silent = false;
  reads: [number, number][] = [];
  #seq = 0;
  readonly #active = new Set<string>();

  constructor(epoch: number) {
    writeU32(this.registers, REGISTERS.epoch, epoch);
  }

  restart(epoch: number): void {
    this.registers.fill(0);
    writeU32(this.registers, REGISTERS.epoch, epoch);
    this.#seq = 0;
    this.#active.clear();
  }

  fact(entry: Fact): void {
    this.#seq++;
    const words = encodeEntry({ ...entry, seq: this.#seq }, tables);
    this.registers.splice(ringSlot(this.#seq), ENTRY_SIZE, ...words);
    if (entry.type === 'alarm') {
      if (entry.transition === 'active') this.#active.add(entry.code);
      else this.#active.delete(entry.code);
      this.registers[REGISTERS.activeAlarms] = encodeActiveAlarms(this.#active, tables);
    }
    writeU32(this.registers, REGISTERS.eventCounter, this.#seq);
    writeU64(this.registers, REGISTERS.simTime, entry.at);
  }

  /** Called after each read: lets a test change the device between two requests. */
  afterRead: (address: number) => void = () => undefined;
  closed = 0;

  read(address: number, length: number): Promise<number[]> {
    this.reads.push([address, length]);
    queueMicrotask(() => {
      this.afterRead(address);
    });
    if (this.silent) return Promise.reject(new Error('Timed out after 500 ms'));
    if (length > MODBUS_MAX_READ || address + length > RING_END) {
      return Promise.reject(Object.assign(new Error('Illegal data address'), { modbusCode: 2 }));
    }
    return Promise.resolve(this.registers.slice(address, address + length));
  }

  close(): Promise<void> {
    this.closed++;
    return Promise.resolve();
  }
}

function setup(
  washer: FakeWasher,
  cursors = new MemoryCursorStore(),
  publish: (p: UnsPublication) => Promise<void> = () => Promise.resolve(),
  connect: () => Promise<RegisterReader> = () => Promise.resolve(washer),
) {
  const published: UnsPublication[] = [];
  const incidents: IncidentInput[] = [];
  const poller = new ModbusPoller({
    machineId: 'wsh-01',
    path: PATH,
    tables,
    scaling: { bath: 0.1, conveyor: 0.01 },
    alarmSeverity: 700,
    connect,
    publisher: {
      publish: (p) => {
        published.push(p);
        return publish(p);
      },
    },
    sequences: new TopicSequences(1_800_000_000),
    incidents: { report: (i) => incidents.push(i) },
    cursors,
    silentAfter: 2,
  });
  const facts = () =>
    published.filter((p) => p.message.scope === 'device').map((p) => p.message.seq);
  return { poller, published, incidents, facts, cursors };
}

const state = (at: number): Fact => ({
  type: 'state',
  at,
  state: 'Running',
  cause: null,
});

describe('Modbus poller against a register map in memory (#77)', () => {
  it('treats facts before the first poll as history, then publishes every new one exactly once, reading across the ring end in two requests', async () => {
    const washer = new FakeWasher(100);
    for (let i = 0; i < 60; i++) washer.fact(state(i));
    const { poller, facts, published } = setup(washer);
    await poller.poll();
    expect(facts()).toEqual([]);
    expect(published.map((p) => p.topic)).toEqual([
      'orbis/gebze/machining/cell-m1/wsh-01/state/current',
      'orbis/gebze/machining/cell-m1/wsh-01/alarms/_snapshot',
      'orbis/gebze/machining/cell-m1/wsh-01/telemetry/bath-temperature',
      'orbis/gebze/machining/cell-m1/wsh-01/telemetry/conveyor-speed',
    ]);
    washer.fact({ type: 'cycle', at: 61, product: 'VB-200', result: 'good', partId: 4711 });
    washer.fact({ type: 'alarm', at: 62, code: 'HEATER-FAULT', transition: 'active' });
    for (let i = 0; i < 10; i++) washer.fact(state(70 + i)); // facts 61..72: the ring wraps after 64
    washer.reads = [];
    await poller.poll();
    expect(facts()).toEqual(Array.from({ length: 12 }, (_, i) => 61 + i));
    expect(washer.reads.slice(1)).toEqual([
      [ringSlot(61), 4 * ENTRY_SIZE],
      [ringSlot(65), 8 * ENTRY_SIZE],
    ]);
    const cycle = published.find((p) => p.message.schema === 'uns.events.cycle-complete/1');
    expect(cycle?.message.value).toEqual({
      product: 'VB-200',
      partId: 4711,
      serial: '',
      result: 'good',
      reason: null,
      measurement: null,
    });
    const alarm = published.find((p) => p.message.schema === 'uns.alarms/1');
    expect(alarm?.topic).toBe('orbis/gebze/machining/cell-m1/wsh-01/alarms/heater-fault');
    expect(alarm?.message.value).toEqual({
      code: 'HEATER-FAULT',
      transition: 'active',
      severity: 700,
    });
    expect(published.every((p) => parseUnsMessage(p.message).ok)).toBe(true);
    await poller.poll();
    expect(facts()).toHaveLength(12);
  });

  it('publishes an alarm snapshot from the ring head and the alarm bits of one read, on every resync (#141)', async () => {
    const washer = new FakeWasher(100);
    washer.fact(state(1));
    washer.fact({ type: 'alarm', at: 2, code: 'HEATER-FAULT', transition: 'active' });
    const { poller, published } = setup(washer);
    const alarmSnapshots = () =>
      published
        .filter((p) => p.message.schema === 'uns.alarm-snapshot/1')
        .map((p) => {
          expect(p.retain).toBe(true);
          const message = p.message as AlarmSnapshot;
          return [message.seq, message.deviceEpoch, message.asOfSeq, message.value.active];
        });
    await poller.poll();
    // One read of the snapshot block (0-17) gives the counter and the bits together.
    expect(washer.reads[0]).toEqual([0, SNAPSHOT_LENGTH]);
    expect(SNAPSHOT_LENGTH).toBe(REGISTERS.activeAlarms + 1);
    expect(alarmSnapshots()).toEqual([[1, 100, 2, ['HEATER-FAULT']]]);
    // No resync, no snapshot: the facts carry the changes.
    washer.fact({ type: 'alarm', at: 3, code: 'HEATER-FAULT', transition: 'cleared' });
    await poller.poll();
    expect(alarmSnapshots()).toHaveLength(1);
    // After a silence.
    washer.silent = true;
    await poller.poll();
    await poller.poll();
    washer.silent = false;
    await poller.poll();
    expect(alarmSnapshots().at(-1)).toEqual([2, 100, 3, []]);
    // After a device restart (new epoch), numbered by the gateway's topic counter.
    washer.restart(200);
    washer.fact({ type: 'alarm', at: 4, code: 'HEATER-FAULT', transition: 'active' });
    await poller.poll();
    expect(alarmSnapshots().at(-1)).toEqual([3, 200, 1, ['HEATER-FAULT']]);
    expect(published.every((p) => parseUnsMessage(p.message).ok)).toBe(true);
  });

  it('reports an overrun when more than 64 facts happened between two polls, and continues', async () => {
    const washer = new FakeWasher(100);
    const { poller, facts, incidents } = setup(washer);
    await poller.poll();
    for (let i = 0; i < 70; i++) washer.fact(state(i));
    await poller.poll();
    expect(incidents).toEqual([
      expect.objectContaining({ type: 'ring-overrun', equipment: 'wsh-01', lost: 6 }),
    ]);
    expect(facts()).toEqual(Array.from({ length: 64 }, (_, i) => 7 + i));
  });

  it('reports a silent device after consecutive failures, recovers, and loses nothing the ring kept', async () => {
    const washer = new FakeWasher(100);
    const { poller, facts, incidents, published } = setup(washer);
    await poller.poll();
    washer.silent = true;
    washer.fact(state(1));
    await poller.poll();
    expect(incidents).toEqual([]);
    await poller.poll();
    expect(incidents.map((i) => i.type)).toEqual(['device-silent']);
    expect(poller.connected).toBe(false);
    washer.fact(state(2));
    washer.silent = false;
    await poller.poll();
    expect(incidents.map((i) => i.type)).toEqual(['device-silent', 'device-recovered']);
    expect(facts()).toEqual([1, 2]);
    const snapshots = published.filter(
      (p) => p.message.schema === 'uns.state.current/1' && p.message.kind === 'snapshot',
    );
    expect(snapshots).toHaveLength(2); // on first contact and after the silence
    // Snapshots name the device epoch they were read in (contract 1.1), for the MES's anchors.
    expect(
      snapshots.map((p) => (p.message as Extract<StateCurrent, { kind: 'snapshot' }>).deviceEpoch),
    ).toEqual([100, 100]);
  });

  it('resumes from the stored cursor after a gateway restart, and starts over when the device restarted', async () => {
    const washer = new FakeWasher(100);
    for (let i = 0; i < 5; i++) washer.fact(state(i));
    const cursors = new MemoryCursorStore();
    const first = setup(washer, cursors);
    await first.poller.poll();
    washer.fact(state(10));
    await first.poller.poll();
    expect(cursors.get('wsh-01')).toEqual({ epoch: 100, seq: 6 });
    washer.fact(state(11)); // happens while the gateway is down
    const second = setup(washer, cursors);
    await second.poller.poll();
    expect(second.facts()).toEqual([7]);

    washer.restart(200);
    washer.fact(state(20));
    await second.poller.poll();
    expect(second.incidents.map((i) => i.type)).toEqual(['epoch-change']);
    expect(second.facts()).toEqual([7, 1]);
    expect(second.published.filter((p) => p.message.scope === 'device').at(-1)?.message.epoch).toBe(
      200,
    );
  });

  it('counts facts overwritten during one walk in a single incident', async () => {
    const washer = new FakeWasher(100);
    const { poller, facts, incidents } = setup(washer);
    await poller.poll();
    for (let i = 0; i < 10; i++) washer.fact(state(i));
    // Right after the snapshot read, 64 more facts overwrite the whole ring.
    washer.afterRead = (address) => {
      if (address === 0) {
        washer.afterRead = () => undefined;
        for (let i = 0; i < 64; i++) washer.fact(state(100 + i));
      }
    };
    await poller.poll();
    expect(incidents).toEqual([expect.objectContaining({ type: 'ring-overrun', lost: 10 })]);
    expect(facts()).toEqual([]);
    await poller.poll();
    expect(facts()).toEqual(Array.from({ length: 64 }, (_, i) => 11 + i));
    expect(incidents).toHaveLength(1);
  });

  it('retries the snapshot until the broker accepts it', async () => {
    const washer = new FakeWasher(100);
    let accept = false;
    const { poller, published } = setup(washer, new MemoryCursorStore(), (p) =>
      accept || p.message.schema !== 'uns.state.current/1'
        ? Promise.resolve()
        : Promise.reject(new Error('not connected to the broker')),
    );
    await poller.poll();
    await new Promise((r) => setTimeout(r, 0));
    accept = true;
    await poller.poll();
    await poller.poll();
    const snapshots = published.filter(
      (p) => p.message.schema === 'uns.state.current/1' && p.message.kind === 'snapshot',
    );
    expect(snapshots).toHaveLength(2); // the refused one and the accepted retry; then no more
  });

  it('stops cleanly while a connection attempt is still pending', async () => {
    const washer = new FakeWasher(100);
    let release: (reader: RegisterReader) => void = () => undefined;
    const { poller } = setup(
      washer,
      new MemoryCursorStore(),
      undefined,
      () =>
        new Promise<RegisterReader>((resolve) => {
          release = resolve;
        }),
    );
    poller.start();
    await new Promise((r) => setTimeout(r, 10));
    const stopping = poller.stop();
    release(washer);
    await stopping;
    await new Promise((r) => setTimeout(r, 10));
    expect(washer.reads).toEqual([]);
    expect(washer.closed).toBe(1);
    expect(poller.connected).toBe(false);
  });

  it('scales telemetry with the register resolutions and stamps it with the device time', async () => {
    const washer = new FakeWasher(100);
    washer.registers[REGISTERS.bathTemperature] = 0x10000 - 15; // -1.5 °C as i16
    washer.registers[REGISTERS.conveyorSpeed] = 201;
    writeU64(washer.registers, REGISTERS.simTime, Date.UTC(2026, 9, 12, 4));
    const { poller, published } = setup(washer);
    await poller.poll();
    const telemetry = published.filter((p) => p.message.schema === 'uns.telemetry/1');
    expect(
      telemetry.map((p) => [p.topic.split('/').at(-1), p.message.value, p.message.sourceTime]),
    ).toEqual([
      ['bath-temperature', -1.5, '2026-10-12T04:00:00.000Z'],
      ['conveyor-speed', 2.01, '2026-10-12T04:00:00.000Z'],
    ]);
    // The device epoch from the same read (contract 1.1), so the MES credits the right run.
    expect(telemetry.map((p) => (p.message as Telemetry).deviceEpoch)).toEqual([100, 100]);
    washer.restart(200);
    writeU64(washer.registers, REGISTERS.simTime, Date.UTC(2026, 9, 12, 3));
    published.length = 0;
    await poller.poll();
    expect(
      published
        .filter((p) => p.message.schema === 'uns.telemetry/1')
        .map((p) => (p.message as Telemetry).deviceEpoch),
    ).toEqual([200, 200]);
  });
});

describe('Modbus poller against the real simulator (#77)', () => {
  const PORTS = { opcuaOffset: 3200, modbusPort: 8220, controlPort: 8000 };
  let simulator: RunningSimulator;
  let washerTables: ReturnType<typeof modbusTables>;

  beforeAll(async () => {
    const loaded = await loadPlantConfig(resolve(import.meta.dirname, '../../../../config/plant'));
    if (!loaded.ok) throw new Error(formatIssues(loaded.issues));
    const failures = loaded.config.failures.equipment['wsh-01'];
    washerTables = modbusTables({
      products: loaded.config.products.products.map((p) => p.id),
      failureCodes: failures?.failureModes.map((m) => m.code) ?? [],
      minorStopCauses: failures?.minorStops.causes ?? [],
    });
    simulator = await startSimulator(PORTS);
  }, 120_000);

  afterAll(async () => {
    await simulator.stop();
  });

  it('publishes every washer fact of the run, including those during a silence, in order', async () => {
    const published: UnsPublication[] = [];
    const incidents: IncidentInput[] = [];
    const poller = new ModbusPoller({
      machineId: 'wsh-01',
      path: PATH,
      tables: washerTables,
      scaling: { bath: 0.1, conveyor: 0.01 },
      alarmSeverity: 700,
      connect: () => connectModbus('127.0.0.1', PORTS.modbusPort, 300),
      publisher: {
        publish: (p) => {
          published.push(p);
          return Promise.resolve();
        },
      },
      sequences: new TopicSequences(1_800_000_000),
      incidents: { report: (i) => incidents.push(i) },
      pollMs: 200,
      silentAfter: 2,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 1_000));
    await simulator.post('/api/v1/resume');
    await new Promise((r) => setTimeout(r, 8_000));
    await simulator.post('/api/v1/faults/modbus', { silent: true });
    await new Promise((r) => setTimeout(r, 3_000));
    await simulator.post('/api/v1/faults/modbus', { silent: false });
    await new Promise((r) => setTimeout(r, 8_000));
    await simulator.post('/api/v1/pause');
    await new Promise((r) => setTimeout(r, 1_500));
    await poller.stop();

    const washerFacts = simulator.events.filter(
      (e) =>
        e.machineId === 'wsh-01' &&
        (e.type === 'state' || e.type === 'cycle-complete' || e.type === 'alarm'),
    );
    const device = published.filter((p) => p.message.scope === 'device').map((p) => p.message);
    expect(washerFacts.length).toBeGreaterThan(10);
    expect(device.map((m) => m.sourceTime)).toEqual(washerFacts.map((e) => e.at));
    expect(device.map((m) => m.seq)).toEqual(device.map((_, i) => (device[0]?.seq ?? 0) + i));
    for (const [i, event] of washerFacts.entries()) {
      const message = device[i];
      if (event.type === 'state' && message?.schema === 'uns.state.current/1') {
        expect(message.value).toEqual({ state: event.to, cause: event.cause ?? null });
      } else if (
        event.type === 'cycle-complete' &&
        message?.schema === 'uns.events.cycle-complete/1'
      ) {
        expect([message.value.product, message.value.partId, message.value.result]).toEqual([
          event.product,
          event.partId,
          event.result,
        ]);
      } else if (event.type === 'alarm' && message?.schema === 'uns.alarms/1') {
        expect([message.value.code, message.value.transition]).toEqual([
          event.code,
          event.transition,
        ]);
      } else {
        throw new Error(`fact ${String(i)}: ${event.type} published as ${String(message?.schema)}`);
      }
    }
    expect(incidents.map((i) => i.type)).toEqual(['device-silent', 'device-recovered']);
    expect(published.every((p) => parseUnsMessage(p.message).ok)).toBe(true);
    const topics = new Set(published.map((p) => p.topic.split('/').slice(-2).join('/')));
    expect(topics).toEqual(
      new Set([
        'state/current',
        'alarms/_snapshot',
        'events/cycle-complete',
        'telemetry/bath-temperature',
        'telemetry/conveyor-speed',
      ]),
    );
    // Alarm snapshots (#141) on first contact and after the silence; each consistent with the
    // facts up to its asOfSeq (no alarm was active at either).
    const alarmSnapshots = published
      .map((p) => p.message)
      .filter((m): m is AlarmSnapshot => m.schema === 'uns.alarm-snapshot/1');
    const firstSeq = device[0]?.seq ?? 0;
    expect(alarmSnapshots.map((m) => [m.seq, m.value.active])).toEqual([
      [1, []],
      [2, []],
    ]);
    expect(alarmSnapshots[0]?.asOfSeq).toBe(firstSeq - 1);
    expect(alarmSnapshots[1]?.asOfSeq).toBeGreaterThanOrEqual(firstSeq);
    expect(alarmSnapshots[1]?.asOfSeq).toBeLessThanOrEqual(device.at(-1)?.seq ?? 0);
  }, 120_000);
});
