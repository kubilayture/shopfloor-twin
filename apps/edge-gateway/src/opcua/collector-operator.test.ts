import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OPCUACertificateManager } from 'node-opcua';
import { OPCUA_MACHINES, type CycleComplete } from '@shopfloor/contracts';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { equipmentPaths } from '../hierarchy.ts';
import { TopicSequences } from '../identity.ts';
import type { UnsPublication } from '../publisher.ts';
import { installGatewayPki, startSimulator, type RunningSimulator } from '../testing.ts';
import { OpcuaCollector } from './collector.ts';

/**
 * A scripted shift change (#197 review): the simulator starts at 13:40 on Monday, so ASM-01's
 * operator changes at 14:00 (shift A to B) while parts are in its station. A part whose components
 * were taken before 14:00 and whose cycle completes after it must reach the UNS with the operator
 * at the cycle's start (ADR-0033), not the one at its end.
 */

// The simulator's ports are chosen at runtime by `startSimulator` (#212).
const START = '2026-10-12T13:40:00+03:00';
const SHIFT_CHANGE = Date.parse('2026-10-12T14:00:00+03:00');
const UNTIL = Date.parse('2026-10-12T14:06:00+03:00');
const ASM = OPCUA_MACHINES.find((m) => m.id === 'asm-01');

let simulator: RunningSimulator | undefined;
// This run's own client certificate store: a fixed name would be wiped by a parallel run (#212).
const pki = mkdtempSync(join(tmpdir(), 'shopfloor-twin-gw-client-pki-operator-'));
let collector: OpcuaCollector;
const published: UnsPublication[] = [];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const loaded = await loadPlantConfig(resolve(import.meta.dirname, '../../../../config/plant'));
  if (!loaded.ok) throw new Error(formatIssues(loaded.issues));
  if (!ASM) throw new Error('no asm-01');
  const path = equipmentPaths(loaded.config).get(ASM.id);
  if (!path) throw new Error('no path for asm-01');
  simulator = await startSimulator(undefined, { SIM_START: START });
  // SignAndEncrypt as opcua-gateway with the test process's pinned certificates (#239).
  const security = await installGatewayPki(pki);
  const certificateManager = new OPCUACertificateManager({
    rootFolder: pki,
    automaticallyAcceptUnknownCertificate: false,
  });
  await certificateManager.initialize();
  collector = new OpcuaCollector({
    machine: ASM,
    path,
    host: 'localhost',
    portOffset: simulator.opcuaOffset,
    publisher: {
      publish: (publication) => {
        published.push(publication);
        return Promise.resolve();
      },
    },
    sequences: new TopicSequences(1_800_000_000),
    incidents: { report: () => undefined },
    certificateManager,
    security,
  });
  await collector.prepare();
  await collector.start();
}, 180_000);

// Also after a failed beforeAll: whatever was started is stopped (#212).
afterAll(async () => {
  await (collector as OpcuaCollector | undefined)?.stop();
  await simulator?.stop();
  rmSync(pki, { recursive: true, force: true });
});

/** ASM-01's device facts in the simulator's stream, and those the collector published. */
const asmFacts = (sim: RunningSimulator): number =>
  sim.events.filter(
    (e) =>
      e.machineId === 'asm-01' &&
      (e.type === 'state' || e.type === 'cycle-complete' || e.type === 'alarm'),
  ).length;
const asmPublished = (): number =>
  published.filter((p) => p.message.source.id === 'asm-01' && p.message.scope === 'device').length;

describe('OPC UA collector: operator at the cycle start across a shift change (#197)', () => {
  it('publishes the operator at the start of a cycle that completes after the operator changed', async () => {
    if (!simulator) throw new Error('no simulator');
    await simulator.post('/api/v1/resume');
    // 60×: 26 simulated minutes, to 14:06; a generous deadline for a loaded machine (#212).
    for (let deadline = Date.now() + 120_000; Date.now() < deadline;) {
      const last = simulator.events.at(-1);
      if (last && Date.parse(last.at) >= UNTIL) break;
      await wait(250);
    }
    await simulator.post('/api/v1/pause');
    expect(
      Date.parse(simulator.events.at(-1)?.at ?? ''),
      'the simulator reached 14:06 within the deadline',
    ).toBeGreaterThanOrEqual(UNTIL);
    // Paused: every ASM-01 fact published, seen twice a second apart (count-based, #212). Gives
    // up quietly after a minute, so the assertions below show what is missing.
    const sim = simulator;
    for (let check = 0, deadline = Date.now() + 60_000; check < 2 && Date.now() < deadline;) {
      if (asmPublished() === asmFacts(sim)) {
        check++;
        await wait(1_000);
      } else {
        check = 0;
        await wait(100);
      }
    }

    // From the simulator's own events: ASM-01's operator events, and each part's first
    // consumption there.
    const operators: { at: number; operator: string | null }[] = [];
    const firstTaken = new Map<number, number>();
    const spans: { partId: number; seq: number; start: number; end: number }[] = [];
    let seq = collector.baseline;
    for (const event of simulator.events) {
      if (event.machineId !== 'asm-01') continue;
      const at = Date.parse(event.at);
      const partId = Number(event.partId);
      if (event.type === 'operator') {
        operators.push({ at, operator: (event.operatorId as string | null) ?? null });
      } else if (event.type === 'material-consumed' && !firstTaken.has(partId)) {
        firstTaken.set(partId, at);
      }
      if (event.type === 'state' || event.type === 'cycle-complete' || event.type === 'alarm') {
        seq++;
        const start = firstTaken.get(partId);
        if (event.type === 'cycle-complete' && start !== undefined) {
          spans.push({ partId, seq, start, end: at });
          firstTaken.delete(partId);
        }
      }
    }
    const change = operators.find((o) => o.at === SHIFT_CHANGE);
    expect(change?.operator, 'shift B staffs ASM-01 at 14:00').toEqual(expect.any(String));
    const across = spans.filter((s) => s.start < SHIFT_CHANGE && s.end > SHIFT_CHANGE);
    expect(across.length, 'a part in ASM-01 across 14:00').toBeGreaterThan(0);

    const cycles = new Map(
      published
        .map((p) => p.message)
        .filter((m): m is CycleComplete => m.schema === 'uns.events.cycle-complete/1')
        .map((m) => [m.seq, m]),
    );
    const before = operators.filter((o) => o.at < SHIFT_CHANGE).at(-1);
    for (const span of across) {
      const message = cycles.get(span.seq);
      expect(message?.value.partId, `seq ${String(span.seq)}`).toBe(span.partId);
      expect(message?.value.lots?.length).toBeGreaterThan(0);
      // Not the operator at the cycle's end.
      expect(message?.value.operator).not.toBe(change?.operator);
      expect(message?.value.operator).toEqual(expect.any(String));
      // Shift A's operator, when its staffing event is in the stream (it may be history).
      if (before) expect(message?.value.operator).toBe(before.operator);
    }
  }, 300_000);
});
