import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OPCUACertificateManager } from 'node-opcua';
import {
  OPCUA_MACHINES,
  parseUnsMessage,
  type StateCurrent,
  type Telemetry,
  type UnsMessage,
} from '@shopfloor/contracts';
import { formatIssues, loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { equipmentPaths } from '../hierarchy.ts';
import { TopicSequences } from '../identity.ts';
import type { IncidentInput } from '../incidents.ts';
import type { Publisher, UnsPublication } from '../publisher.ts';
import { startSimulator, type RunningSimulator, type SimEvent } from '../testing.ts';
import { OpcuaCollector } from './collector.ts';

// Clear of the Compose stack (TimescaleDB on 5442, broker on 1883, simulator on 4800–5020).
const PORTS = { opcuaOffset: 3100, modbusPort: 8120, controlPort: 7900 };
let simulator: RunningSimulator;
let config: PlantConfig;
const published: UnsPublication[] = [];
const incidents: IncidentInput[] = [];
const collectors: OpcuaCollector[] = [];
const baselines = new Map<string, number>();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !condition();) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await wait(100);
  }
}

const snapshotsOf = (machineId: string): number =>
  published.filter(
    (p) =>
      p.message.source.id === machineId &&
      p.message.schema === 'uns.state.current/1' &&
      p.message.kind === 'snapshot',
  ).length;

const publisher: Publisher = {
  publish: (publication) => {
    published.push(publication);
    return Promise.resolve();
  },
};

/** The device facts of one machine in the simulator's own order: fact k has device sequence k. */
function deviceFacts(machineId: string): SimEvent[] {
  return simulator.events.filter(
    (e) =>
      e.machineId === machineId &&
      (e.type === 'state' || e.type === 'cycle-complete' || e.type === 'alarm'),
  );
}

const deviceMessages = (machineId: string): UnsMessage[] =>
  published.map((p) => p.message).filter((m) => m.source.id === machineId && m.scope === 'device');

beforeAll(async () => {
  const loaded = await loadPlantConfig(resolve(import.meta.dirname, '../../../../config/plant'));
  if (!loaded.ok) throw new Error(formatIssues(loaded.issues));
  config = loaded.config;
  simulator = await startSimulator(PORTS);
  const paths = equipmentPaths(config);
  const sequences = new TopicSequences(1_800_000_000);
  const pki = join(tmpdir(), 'shopfloor-twin-gw-client-pki');
  rmSync(pki, { recursive: true, force: true });
  const certificateManager = new OPCUACertificateManager({
    rootFolder: pki,
    automaticallyAcceptUnknownCertificate: true,
  });
  await certificateManager.initialize();
  for (const machine of OPCUA_MACHINES) {
    const path = paths.get(machine.id);
    if (!path) throw new Error(`no path for ${machine.id}`);
    collectors.push(
      new OpcuaCollector({
        machine,
        path,
        host: 'localhost',
        portOffset: PORTS.opcuaOffset,
        publisher,
        sequences,
        incidents: { report: (incident) => incidents.push(incident) },
        telemetrySamplingMs: 500,
        resyncGraceMs: 1_500,
        sessionTimeoutMs: 5_000,
        certificateManager,
      }),
    );
  }
  // The clients share a certificate: create it one at a time, then connect them all at once.
  for (const collector of collectors) await collector.prepare();
  await Promise.all(collectors.map((collector) => collector.start()));
  // The simulator is idle until resumed. Its start-up facts were emitted before the event stream
  // connected and are history to the collectors; device sequence k + baseline is stream fact k.
  for (const collector of collectors) baselines.set(collector.machineId, collector.baseline);
  expect(simulator.events).toEqual([]);
}, 120_000);

afterAll(async () => {
  await Promise.all(collectors.map((c) => c.stop()));
  await simulator.stop();
});

describe('OPC UA collector (#76)', () => {
  it('publishes every state change, cycle and alarm of all five machines as valid UNS messages, at 60×', async () => {
    await simulator.post('/api/v1/resume');
    await wait(20_000); // 20 simulated minutes
    await simulator.post('/api/v1/pause');
    await wait(1_500);

    for (const publication of published) {
      const parsed = parseUnsMessage(JSON.parse(JSON.stringify(publication.message)));
      expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
    }
    let total = 0;
    for (const machine of OPCUA_MACHINES) {
      const baseline = baselines.get(machine.id) ?? 0;
      const expected = deviceFacts(machine.id).map((event, i) => ({
        seq: baseline + i + 1,
        event,
      }));
      const messages = deviceMessages(machine.id);
      expect(
        messages.map((m) => m.seq),
        machine.id,
      ).toEqual(expected.map((e) => e.seq));
      for (const [i, { event }] of expected.entries()) {
        const message = messages[i];
        expect(message?.sourceTime, `${machine.id} #${String(i)}`).toBe(event.at);
        if (event.type === 'state' && message?.schema === 'uns.state.current/1') {
          expect(message.value).toEqual({ state: event.to, cause: event.cause ?? null });
        } else if (
          event.type === 'cycle-complete' &&
          message?.schema === 'uns.events.cycle-complete/1'
        ) {
          expect(message.value).toMatchObject({
            product: event.product,
            partId: event.partId,
            serial: event.serial,
            result: event.result,
            reason: event.reason ?? null,
          });
          const measurement = event.measurement as
            { value: number; upperLimit: number } | undefined;
          expect(message.value.measurement?.value).toBe(measurement?.value);
          expect(message.value.measurement?.upperLimit).toBe(measurement?.upperLimit);
        } else if (event.type === 'alarm' && message?.schema === 'uns.alarms/1') {
          expect(message.value).toEqual({
            code: event.code,
            transition: event.transition,
            severity: event.severity,
          });
        } else {
          throw new Error(
            `${machine.id} #${String(i)}: ${event.type} published as ${String(message?.schema)}`,
          );
        }
      }
      total += expected.length;
    }
    expect(total).toBeGreaterThan(30);
    expect(incidents.filter((i) => i.type === 'sequence-gap')).toEqual([]);
  }, 120_000);

  it('samples telemetry and publishes a snapshot of every machine on connect', () => {
    const topics = new Set(published.map((p) => p.topic));
    for (const id of ['cnc-01', 'cnc-02']) {
      const path = `orbis/gebze/machining/cell-m1/${id}`;
      expect(topics.has(`${path}/telemetry/spindle-load`), id).toBe(true);
      expect(topics.has(`${path}/telemetry/coolant-temperature`), id).toBe(true);
    }
    const snapshots = published.filter(
      (p) => p.message.schema === 'uns.state.current/1' && p.message.kind === 'snapshot',
    );
    expect(new Set(snapshots.map((s) => s.message.source.id))).toEqual(
      new Set(OPCUA_MACHINES.map((m) => m.id)),
    );
    // Every snapshot names the simulator run (device epoch) it was read in (contract 1.1).
    for (const s of snapshots) {
      const message = s.message as Extract<StateCurrent, { kind: 'snapshot' }>;
      expect(message.deviceEpoch).toBeGreaterThan(1_700_000_000);
    }
    // Telemetry read once the run is known carries its device epoch (contract 1.1); a sample
    // delivered before the resync read the epoch carries none, never a guessed one.
    const epochs = new Set(
      snapshots.map((s) => (s.message as Extract<StateCurrent, { kind: 'snapshot' }>).deviceEpoch),
    );
    const telemetry = published
      .filter((p) => p.message.schema === 'uns.telemetry/1')
      .map((p) => (p.message as Telemetry).deviceEpoch);
    expect(telemetry.some((e) => e !== undefined)).toBe(true);
    expect(telemetry.every((e) => e === undefined || epochs.has(e))).toBe(true);
    expect(
      published.every((p) => p.retain === (p.message.schema !== 'uns.events.cycle-complete/1')),
    ).toBe(true);
  });

  it('accounts for every fact exactly once across a long and a short outage', async () => {
    const collector = collectors.find((c) => c.machineId === 'cnc-01');
    if (!collector) throw new Error('no cnc-01 collector');
    const snapshotsBefore = snapshotsOf('cnc-01');
    await simulator.post('/api/v1/resume');
    // Longer than the 5 s session timeout: the session is gone, a new one must be created.
    await simulator.post('/api/v1/faults/opcua/cnc-01', { offline: true });
    await wait(9_000);
    await simulator.post('/api/v1/faults/opcua/cnc-01', { offline: false });
    await until(() => collector.connected, 20_000);
    await wait(3_000);
    // A short one: the session survives and the server republishes what it kept.
    await simulator.post('/api/v1/faults/opcua/cnc-01', { offline: true });
    await wait(1_500);
    await simulator.post('/api/v1/faults/opcua/cnc-01', { offline: false });
    await until(() => collector.connected, 20_000);
    await wait(3_000);
    await simulator.post('/api/v1/pause');
    await wait(3_000);

    const kinds = incidents.filter((i) => i.equipment === 'cnc-01').map((i) => i.type);
    expect(kinds.filter((k) => k === 'disconnected')).toHaveLength(2);
    expect(snapshotsOf('cnc-01')).toBeGreaterThanOrEqual(snapshotsBefore + 2);
    const baseline = baselines.get('cnc-01') ?? 0;
    const emitted = deviceFacts('cnc-01').map((_, i) => baseline + i + 1);
    const published = deviceMessages('cnc-01').map((m) => m.seq);
    const lost = collector.lost.flatMap((r) =>
      Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from + i),
    );
    expect(new Set(published).size).toBe(published.length); // nothing published twice
    expect(lost.filter((seq) => published.includes(seq))).toEqual([]); // nothing both
    expect([...published, ...lost].sort((a, b) => a - b)).toEqual(emitted); // and nothing missing
    const reportedLost = incidents
      .filter((i) => i.equipment === 'cnc-01' && i.type === 'sequence-gap')
      .reduce((sum, i) => sum + (i.lost ?? 0), 0);
    expect(reportedLost).toBe(lost.length);
  }, 180_000);
});
