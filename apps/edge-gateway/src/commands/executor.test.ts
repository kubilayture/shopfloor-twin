/**
 * The command executor against the real simulator in production mode `orders` (#173, plan B2):
 * real OPC UA sessions through a TCP proxy that can hold the device's answers or cut the
 * connection mid-call. Every case ends with exactly one `accepted` job fact per command id.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  OPCUA_MACHINES,
  loadOrderCommandId,
  type CommandResultValue,
  type JobEvent,
  type LoadOrderCommand,
} from '@shopfloor/contracts';
import { OPCUACertificateManager } from 'node-opcua';
import { formatIssues, loadPlantConfig, plantAlarms } from '@shopfloor/plant-config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { equipmentPaths } from '../hierarchy.ts';
import { TopicSequences } from '../identity.ts';
import { OpcuaCollector } from '../opcua/collector.ts';
import type { CommandResultPublication, UnsPublication } from '../publisher.ts';
import { opcuaProxies, startSimulator, type RunningSimulator, type TcpProxy } from '../testing.ts';
import { CommandExecutor, type CommandExecutorOptions } from './executor.ts';
import { CommandStore } from './store.ts';

const SIM = { opcuaOffset: 3400, modbusPort: 8420, controlPort: 8210 };
const PROXY_OFFSET = 3450;
const DEADLINE_MS = 1_500;
const NOT_BEFORE = '2026-10-12T03:00:00.000Z';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !condition();) {
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms: ${what}`);
    await wait(50);
  }
}

let simulator: RunningSimulator;
let proxies: Map<string, TcpProxy>;
const dir = mkdtempSync(join(tmpdir(), 'gateway-commands-'));
const facts: UnsPublication[] = [];
const results: CommandResultPublication[] = [];
const collectors: OpcuaCollector[] = [];
let paths: Map<string, { area: string; workCenter: string; equipment: string }>;
let store: CommandStore;
let executor: CommandExecutor;
const invalid: string[] = [];
/** Sim events of every run, also of runs that were restarted. */
const pastEvents: RunningSimulator['events'][] = [];

const cnc = (id: string): OpcuaCollector => {
  const collector = collectors.find((c) => c.machineId === id);
  if (!collector) throw new Error(id);
  return collector;
};

function newExecutor(overrides: Partial<CommandExecutorOptions> = {}): CommandExecutor {
  return new CommandExecutor({
    store,
    publisher: {
      publish: (publication) => {
        results.push(publication);
        return Promise.resolve();
      },
    },
    sequences: new TopicSequences(1_800_000_100),
    paths,
    machines: new Map(
      collectors.filter((c) => c.kind === 'machine-tool').map((c) => [c.machineId, c]),
    ),
    callDeadlineMs: DEADLINE_MS,
    retryMs: 300,
    settleRetryMs: 700,
    clockAllowanceMs: 1_000,
    onInvalid: (_entry, error) => invalid.push(error),
    ...overrides,
  });
}

let orders = 0;
function command(
  options: {
    readonly product?: string;
    readonly quantity?: number;
    readonly deviceEpoch?: number;
    readonly expiresInMs?: number;
    readonly machine?: string;
  } = {},
): LoadOrderCommand {
  orders++;
  const orderId = `PO-T${String(orders)}`;
  const now = Date.now();
  return {
    schema: 'uns.cmd.load-order/1',
    scope: 'topic',
    epoch: 1_800_000_000,
    seq: orders,
    source: { id: 'mes-server', protocol: 'internal' },
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (options.expiresInMs ?? 20_000)).toISOString(),
    value: {
      commandId: loadOrderCommandId(orderId, 1),
      orderId,
      operation: 'OP10',
      product: options.product ?? 'VB-100',
      quantity: options.quantity ?? 2,
      notBefore: NOT_BEFORE,
      deviceEpoch: options.deviceEpoch ?? epochOf(options.machine ?? 'cnc-01'),
    },
  };
}

function epochOf(machine: string): number {
  const epoch = cnc(machine).deviceEpoch;
  if (epoch === undefined) throw new Error(`${machine} not ready`);
  return epoch;
}

/** A delivery as the command session records it, handed to the executor. */
function deliver(message: unknown, equipment = 'cnc-01', target = executor): void {
  const path = paths.get(equipment);
  if (!path) throw new Error(equipment);
  const topic = `orbis/gebze/${path.area}/${path.workCenter}/${equipment}/cmd/load-order`;
  target.submit(store.record(equipment, topic, JSON.stringify(message)));
}

const answers = (commandId: string): CommandResultValue[] =>
  results.map((r) => r.message.value).filter((v) => v.commandId === commandId);

/** The `accepted` job facts of a command id in every simulator run so far (the ground truth). */
const acceptedFacts = (commandId: string): number =>
  [...pastEvents, simulator.events]
    .flat()
    .filter((e) => e.type === 'job' && e.transition === 'accepted' && e.commandId === commandId)
    .length;

/** The device sequence number of the job's accepted fact, as the collector published it. */
const acceptedSeq = (commandId: string): number | undefined =>
  facts
    .map((f) => f.message)
    .find(
      (m): m is JobEvent =>
        m.schema === 'uns.events.job/1' &&
        m.value.commandId === commandId &&
        m.value.transition === 'accepted',
    )?.seq;

beforeAll(async () => {
  const loaded = await loadPlantConfig(resolve(import.meta.dirname, '../../../../config/plant'));
  if (!loaded.ok) throw new Error(formatIssues(loaded.issues));
  const config = loaded.config;
  paths = new Map(equipmentPaths(config));
  simulator = await startSimulator(SIM, { SIM_PRODUCTION: 'orders' });
  proxies = await opcuaProxies(OPCUA_MACHINES, PROXY_OFFSET, SIM.opcuaOffset);
  const certificateManager = new OPCUACertificateManager({
    rootFolder: join(dir, 'pki'),
    automaticallyAcceptUnknownCertificate: true,
  });
  await certificateManager.initialize();
  const sequences = new TopicSequences(1_800_000_000);
  for (const machine of OPCUA_MACHINES.filter((m) => m.kind === 'machine-tool')) {
    const path = paths.get(machine.id);
    if (!path) throw new Error(machine.id);
    collectors.push(
      new OpcuaCollector({
        machine,
        path,
        host: 'localhost',
        portOffset: PROXY_OFFSET,
        publisher: {
          publish: (publication) => {
            facts.push(publication);
            return Promise.resolve();
          },
        },
        sequences,
        incidents: { report: () => undefined },
        alarmCodes: plantAlarms(config)
          .filter((p) => p.equipment === machine.id)
          .map((p) => p.code),
        resyncGraceMs: 500,
        sessionTimeoutMs: 10_000,
        certificateManager,
      }),
    );
  }
  for (const collector of collectors) await collector.prepare();
  await Promise.all(collectors.map((c) => c.start()));
  store = new CommandStore(join(dir, 'gateway.db'));
  executor = newExecutor();
  executor.start();
}, 120_000);

afterAll(async () => {
  await executor.stop();
  store.close();
  await Promise.all(collectors.map((c) => c.stop()));
  for (const proxy of proxies.values()) await proxy.close();
  await simulator.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('LoadOrder through the command executor (#173, ADR-0029)', () => {
  it('accepts a job with the device acceptance, and answers a duplicate delivery and a resend from the result table', async () => {
    const first = command();
    const id = first.value.commandId;
    deliver(first);
    deliver(first); // the broker delivered it twice
    await until('both deliveries answered', () => answers(id).length === 2);
    const calls = executor.calls;
    expect(answers(id)).toEqual([
      expect.objectContaining({ result: 'accepted', position: 1, statusCode: 'Good' }),
      expect.objectContaining({ result: 'accepted', position: 1, statusCode: 'Good' }),
    ]);
    await until('the accepted fact', () => acceptedSeq(id) !== undefined);
    expect(answers(id)[0]).toMatchObject({ acceptedSeq: acceptedSeq(id) });
    // The cmd-res was lost: the MES resends with a new expiresAt, answered without a call.
    const resend = { ...first, expiresAt: new Date(Date.now() + 30_000).toISOString() };
    deliver(resend);
    await until('the resend answered', () => answers(id).length === 3);
    expect(answers(id)[2]).toMatchObject({ result: 'accepted', expiresAt: resend.expiresAt });
    expect(executor.calls).toBe(calls);
    expect(acceptedFacts(id)).toBe(1);
    expect(results.every((r) => r.topic.endsWith('/cnc-01/cmd-res/load-order'))).toBe(true);
    await until('the inbox empty', () => store.pending().length === 0);
  });

  it('runs one command at a time per CNC, in arrival order', async () => {
    const commands = [command(), command(), command({ machine: 'cnc-02' })];
    deliver(commands[0]);
    deliver(commands[1]);
    deliver(commands[2], 'cnc-02');
    for (const c of commands) {
      await until('answered', () => answers(c.value.commandId).length === 1);
    }
    const [a, b, c] = commands.map((x) => answers(x.value.commandId)[0]);
    expect(a?.result).toBe('accepted');
    expect(b?.result).toBe('accepted');
    if (a?.result !== 'accepted' || b?.result !== 'accepted') throw new Error('not accepted');
    expect(b.position).toBe(a.position + 1);
    expect(b.acceptedSeq).toBeGreaterThan(a.acceptedSeq);
    expect(c).toMatchObject({ result: 'accepted', position: 1 });
  });

  it('answers the device refusals: wrong epoch, invalid product and quantity, a conflicting job; and refuses non-CNCs', async () => {
    const wrongEpoch = command({ deviceEpoch: epochOf('cnc-01') - 1 });
    const badProduct = command({ product: 'VB-999' });
    const badQuantity = command({ quantity: 100_000 });
    const conflict = { ...badQuantity, value: { ...badQuantity.value, quantity: 3 } };
    const notCnc = command();
    deliver(wrongEpoch);
    deliver(badProduct);
    deliver(conflict); // accepted
    deliver(badQuantity); // same id as the accepted job, another quantity
    deliver(notCnc, 'asm-01');
    deliver('not json at all');
    deliver({ ...wrongEpoch, schema: 'uns.cmd-res/1' });
    await until(
      'every refusal answered',
      () =>
        [wrongEpoch, badProduct, badQuantity, notCnc].every(
          (c) => answers(c.value.commandId).length >= 1,
        ) && answers(badQuantity.value.commandId).length === 2,
    );
    expect(answers(wrongEpoch.value.commandId)).toEqual([
      expect.objectContaining({
        result: 'rejected',
        code: 'epoch-mismatch',
        statusCode: 'BadInvalidState',
      }),
    ]);
    expect(answers(badProduct.value.commandId)).toEqual([
      expect.objectContaining({
        result: 'rejected',
        code: 'invalid-product',
        statusCode: 'BadInvalidArgument',
      }),
    ]);
    expect(answers(badQuantity.value.commandId)).toEqual([
      expect.objectContaining({ result: 'accepted' }),
      expect.objectContaining({ result: 'rejected', code: 'command-conflict' }),
    ]);
    expect(answers(notCnc.value.commandId)).toEqual([
      expect.objectContaining({
        result: 'rejected',
        code: 'unsupported-equipment',
        statusCode: null,
      }),
    ]);
    expect(
      results.find((r) => r.message.value.commandId === notCnc.value.commandId)?.topic,
    ).toMatch(/\/asm-01\/cmd-res\/load-order$/);
    await until('invalid deliveries dropped', () => invalid.length === 2);
    expect(acceptedFacts(wrongEpoch.value.commandId)).toBe(0);
    expect(acceptedFacts(badQuantity.value.commandId)).toBe(1);
    // A definitive refusal is kept: a resend is answered from the table.
    const calls = executor.calls;
    deliver({ ...badProduct, expiresAt: new Date(Date.now() + 30_000).toISOString() });
    await until('resend answered', () => answers(badProduct.value.commandId).length === 2);
    expect(executor.calls).toBe(calls);
    await until('the inbox empty', () => store.pending().length === 0);
  });

  it('calls an expired command once after expiresAt: the device answers expired, and a resend is called again', async () => {
    const expired = command({ expiresInMs: -5_000 });
    const id = expired.value.commandId;
    deliver(expired);
    await until('the settle answer', () => answers(id).length === 1);
    const answer = answers(id)[0];
    expect(answer).toMatchObject({ result: 'expired', statusCode: 'BadInvalidState' });
    expect(answer?.result === 'expired' && answer.seqAfterExpiry).toBeGreaterThan(0);
    expect(acceptedFacts(id)).toBe(0);
    // The same delivery again: from the table. A resend with a new expiresAt: called, accepted.
    deliver(expired);
    const resend = { ...expired, expiresAt: new Date(Date.now() + 20_000).toISOString() };
    deliver(resend);
    await until('both answered', () => answers(id).length === 3);
    expect(
      answers(id)
        .slice(1)
        .map((a) => a.result),
    ).toEqual(['expired', 'accepted']);
    expect(acceptedFacts(id)).toBe(1);
  });

  it('retries a call that timed out after the device acted, and learns Duplicate (one job)', async () => {
    const proxy = proxies.get('cnc-01');
    if (!proxy) throw new Error('no proxy');
    const timedOut = command();
    const id = timedOut.value.commandId;
    proxy.hold();
    deliver(timedOut);
    await until('the device accepted it', () => acceptedFacts(id) === 1);
    await wait(DEADLINE_MS + 500); // the gateway's deadline passed: outcome unknown
    expect(answers(id)).toEqual([]);
    proxy.release();
    await until('answered', () => answers(id).length === 1);
    expect(answers(id)[0]).toMatchObject({
      result: 'duplicate',
      position: expect.any(Number) as number,
    });
    expect(acceptedFacts(id)).toBe(1);
  });

  it('retries after a TCP cut mid-call, on the re-established session (one job)', async () => {
    const proxy = proxies.get('cnc-02');
    if (!proxy) throw new Error('no proxy');
    const cut = command({ machine: 'cnc-02' });
    const id = cut.value.commandId;
    proxy.hold();
    deliver(cut, 'cnc-02');
    await until('the device accepted it', () => acceptedFacts(id) === 1);
    proxy.cut();
    await until('answered', () => answers(id).length === 1, 40_000);
    expect(answers(id)[0]).toMatchObject({ result: 'duplicate' });
    expect(acceptedFacts(id)).toBe(1);
  }, 60_000);

  it('reports unknown while it cannot settle after expiresAt, never expired on its own, then settles with Duplicate', async () => {
    const proxy = proxies.get('cnc-01');
    if (!proxy) throw new Error('no proxy');
    const held = command({ expiresInMs: 2_500 });
    const id = held.value.commandId;
    proxy.hold();
    deliver(held);
    await until('the device accepted it', () => acceptedFacts(id) === 1);
    await until('unknown reported', () => answers(id).length === 1, 15_000);
    expect(answers(id)[0]).toMatchObject({ result: 'unknown', seqAfterExpiry: null });
    expect(executor.pending.settling).toBe(1);
    proxy.release();
    await until('settled', () => answers(id).length >= 2, 20_000);
    const settled = answers(id).at(-1);
    expect(settled).toMatchObject({ result: 'duplicate', acceptedSeq: acceptedSeq(id) });
    expect(answers(id).some((a) => a.result === 'expired')).toBe(false);
    await until('settling ends', () => executor.pending.settling === 0);
    expect(acceptedFacts(id)).toBe(1);
  }, 60_000);

  it('processes again what a crash left between the call and its result: Duplicate, one job', async () => {
    const proxy = proxies.get('cnc-01');
    if (!proxy) throw new Error('no proxy');
    const crashed = command();
    const id = crashed.value.commandId;
    proxy.hold();
    deliver(crashed);
    await until('the device accepted it', () => acceptedFacts(id) === 1);
    await executor.stop(); // the gateway is gone: nothing stored, the delivery still in the inbox
    expect(store.pending().map((e) => JSON.parse(e.payload) as unknown)).toEqual([crashed]);
    proxy.cut();
    executor = newExecutor();
    executor.start();
    await until('answered after the restart', () => answers(id).length === 1, 40_000);
    expect(answers(id)[0]).toMatchObject({ result: 'duplicate' });
    expect(acceptedFacts(id)).toBe(1);
    await until('the inbox empty', () => store.pending().length === 0);
  }, 60_000);

  it('answers rejected (epoch-mismatch) without calling when the simulator restarted mid-call', async () => {
    const proxy = proxies.get('cnc-01');
    if (!proxy) throw new Error('no proxy');
    const restarted = command();
    const id = restarted.value.commandId;
    const oldEpoch = epochOf('cnc-01');
    proxy.hold();
    deliver(restarted);
    await until('the device accepted it', () => acceptedFacts(id) === 1);
    pastEvents.push(simulator.events);
    await simulator.stop();
    await wait(1_100); // a new run gets a new epoch (Unix seconds)
    simulator = await startSimulator(SIM, { SIM_PRODUCTION: 'orders' });
    proxy.cut();
    for (const other of proxies.values()) other.cut();
    await until('answered', () => answers(id).length === 1, 60_000);
    expect(answers(id)[0]).toMatchObject({
      result: 'rejected',
      code: 'epoch-mismatch',
      statusCode: null,
    });
    expect(epochOf('cnc-01')).not.toBe(oldEpoch);
    expect(acceptedFacts(id)).toBe(1); // in the old run only
    expect(simulator.events.filter((e) => e.type === 'job')).toEqual([]);
  }, 120_000);
});
