/**
 * The executor's decisions against a scripted machine (#173, review of PR #184): stored answers
 * are reused only within their device epoch; a settle call waits for the device's own clock; an
 * `unknown` carries the `seqAfterExpiry` it read; a settle acceptance is kept and flagged.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOAD_ORDER_INPUTS,
  OPCUA_VARIABLES,
  type CommandResultValue,
  type LoadOrderCommand,
} from '@shopfloor/contracts';
import {
  DataType,
  DataValue,
  StatusCodes,
  type CallMethodResult,
  type StatusCode,
} from 'node-opcua';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { TopicSequences } from '../identity.ts';
import { CommandExecutor, type CommandMachine } from './executor.ts';
import { CommandStore } from './store.ts';

const dir = mkdtempSync(join(tmpdir(), 'gateway-settle-'));
const PATH = { area: 'machining', workCenter: 'cell-m1', equipment: 'cnc-01' } as const;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !condition();) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await wait(10);
  }
}

function answer(status: StatusCode, flagged?: string, outputs: unknown[] = []): CallMethodResult {
  return {
    statusCode: status,
    inputArgumentResults: LOAD_ORDER_INPUTS.map((n) => (n === flagged ? status : StatusCodes.Good)),
    outputArguments: outputs.map((value) => ({ value })),
  } as unknown as CallMethodResult;
}

const ACCEPTED = (duplicate: boolean) =>
  answer(StatusCodes.Good, undefined, [1, duplicate, 7, new Date('2026-10-12T03:00:00.000Z')]);

class ScriptedMachine implements CommandMachine {
  readonly machineId = 'cnc-01';
  deviceEpoch: number | undefined = 100;
  sequence = 42;
  /** The device's own clock offset against the test's, ms. */
  clockOffsetMs = 0;
  calls = 0;
  answer: () => Promise<CallMethodResult> = () => Promise.resolve(ACCEPTED(false));

  readVariable(path: string): Promise<DataValue> {
    const value = path === OPCUA_VARIABLES.epoch ? this.deviceEpoch : this.sequence;
    return Promise.resolve(
      new DataValue({ value: { dataType: DataType.UInt32, value }, statusCode: StatusCodes.Good }),
    );
  }

  readServerTime(): Promise<DataValue> {
    return Promise.resolve(
      new DataValue({
        value: { dataType: DataType.DateTime, value: new Date(Date.now() + this.clockOffsetMs) },
        statusCode: StatusCodes.Good,
      }),
    );
  }

  callMethod(): Promise<CallMethodResult> {
    this.calls++;
    return this.answer();
  }
}

let n = 0;
function command(options: { deviceEpoch?: number; expiresInMs?: number; id?: string } = {}) {
  n++;
  const orderId = options.id ?? `PO-S${String(n)}`;
  const message: LoadOrderCommand = {
    schema: 'uns.cmd.load-order/1',
    scope: 'topic',
    epoch: 1,
    seq: n,
    source: { id: 'mes-server', protocol: 'internal' },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (options.expiresInMs ?? 5_000)).toISOString(),
    value: {
      commandId: `${orderId}~OP10~1`,
      orderId,
      operation: 'OP10',
      product: 'VB-100',
      quantity: 2,
      notBefore: '2026-10-12T03:00:00.000Z',
      deviceEpoch: options.deviceEpoch ?? 100,
    },
  };
  return message;
}

const running: { executor: CommandExecutor; store: CommandStore }[] = [];

function setup(machine: ScriptedMachine) {
  const store = new CommandStore(join(dir, `${String(running.length)}.db`));
  const results: CommandResultValue[] = [];
  const skew: CommandResultValue[] = [];
  const executor = new CommandExecutor({
    store,
    publisher: {
      publish: (p) => {
        results.push(p.message.value);
        return Promise.resolve();
      },
    },
    sequences: new TopicSequences(1),
    paths: new Map([['cnc-01', PATH]]),
    machines: new Map([['cnc-01', machine]]),
    callDeadlineMs: 200,
    retryMs: 20,
    settleRetryMs: 50,
    clockAllowanceMs: 100,
    settleReadyWaitMs: 100,
    onSettleAcceptance: (value) => skew.push(value),
  });
  executor.start();
  running.push({ executor, store });
  const deliver = (message: LoadOrderCommand) => {
    executor.submit(
      store.record(
        'cnc-01',
        'orbis/gebze/machining/cell-m1/cnc-01/cmd/load-order',
        JSON.stringify(message),
      ),
    );
  };
  return { executor, results, skew, deliver };
}

afterEach(async () => {
  for (const { executor, store } of running.splice(0)) {
    await executor.stop();
    store.close();
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('command executor decisions (#173, review of PR #184)', () => {
  it('never answers a command of another device epoch from the result table', async () => {
    const machine = new ScriptedMachine();
    const { results, deliver } = setup(machine);
    const first = command({ id: 'PO-GOLDEN' });
    deliver(first);
    await until('accepted in epoch 100', () => results.length === 1);
    expect(results[0]).toMatchObject({ result: 'accepted', deviceEpoch: 100 });
    deliver(first); // same epoch: from the table
    await until('answered from the table', () => results.length === 2);
    expect(machine.calls).toBe(1);
    // A new run (epoch 101) gets the same deterministic command id and job: it must be called.
    machine.deviceEpoch = 101;
    deliver(command({ id: 'PO-GOLDEN', deviceEpoch: 101 }));
    await until('called again in epoch 101', () => results.length === 3);
    expect(machine.calls).toBe(2);
    expect(results[2]).toMatchObject({ result: 'accepted', deviceEpoch: 101 });
  });

  it('reports unknown with the seqAfterExpiry it read when the settle call fails, then settles', async () => {
    const machine = new ScriptedMachine();
    machine.answer = () => Promise.reject(new Error('BadConnectionClosed'));
    const { results, deliver } = setup(machine);
    deliver(command({ expiresInMs: -1_000 }));
    await until('unknown', () => results.length === 1);
    expect(results[0]).toMatchObject({
      result: 'unknown',
      seqAfterExpiry: 42,
      reason: 'BadConnectionClosed',
    });
    machine.answer = () => Promise.resolve(answer(StatusCodes.BadInvalidState, 'ExpiresAt'));
    await until('settled', () => results.length === 2);
    expect(results[1]).toMatchObject({ result: 'expired', seqAfterExpiry: 42 });
  });

  it('waits for the device clock to pass expiresAt + the allowance before reading Sequence', async () => {
    const machine = new ScriptedMachine();
    machine.clockOffsetMs = -60_000; // the device's clock is a minute behind
    machine.answer = () => Promise.resolve(answer(StatusCodes.BadInvalidState, 'ExpiresAt'));
    const { results, deliver } = setup(machine);
    deliver(command({ expiresInMs: -1_000 }));
    await until('unknown', () => results.length === 1);
    expect(results[0]).toMatchObject({
      result: 'unknown',
      seqAfterExpiry: null,
      reason: 'the device clock is not past expiresAt + the allowance yet',
    });
    await wait(200);
    expect(machine.calls).toBe(0);
    machine.clockOffsetMs = 0;
    await until('settled', () => results.length === 2);
    expect(results[1]).toMatchObject({ result: 'expired', seqAfterExpiry: 42 });
    expect(machine.calls).toBe(1);
  });

  it('keeps a settle acceptance as accepted and flags it as clock skew', async () => {
    const machine = new ScriptedMachine();
    const { executor, results, skew, deliver } = setup(machine);
    deliver(command({ expiresInMs: -1_000 }));
    await until('answered', () => results.length === 1);
    expect(results[0]).toMatchObject({ result: 'accepted', acceptedSeq: 7 });
    expect(skew).toHaveLength(1);
    expect(executor.settleAcceptances).toBe(1);
  });

  it('stops only after the running delivery has ended', async () => {
    const machine = new ScriptedMachine();
    let release: () => void = () => undefined;
    machine.answer = () =>
      new Promise((resolve) => {
        release = () => {
          resolve(ACCEPTED(false));
        };
      });
    const { executor, deliver } = setup(machine);
    deliver(command());
    await until('called', () => machine.calls === 1);
    let stopped = false;
    const stopping = executor.stop().then(() => {
      stopped = true;
    });
    await wait(50);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});
