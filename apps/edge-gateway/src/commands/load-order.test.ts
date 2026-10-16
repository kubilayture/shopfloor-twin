import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOAD_ORDER_INPUTS, type LoadOrderCommand } from '@shopfloor/contracts';
import { StatusCodes, type CallMethodResult, type StatusCode } from 'node-opcua';
import { afterAll, describe, expect, it } from 'vitest';
import {
  interpretLoadOrder,
  interpretSettleCall,
  jobKey,
  loadOrderArguments,
} from './load-order.ts';
import { CommandStore } from './store.ts';

const COMMAND: LoadOrderCommand = {
  schema: 'uns.cmd.load-order/1',
  scope: 'topic',
  epoch: 1_800_000_000,
  seq: 1,
  source: { id: 'mes-server', protocol: 'internal' },
  issuedAt: '2026-10-16T12:00:00.000Z',
  expiresAt: '2026-10-16T12:01:00.000Z',
  value: {
    commandId: 'PO-1~OP10~1',
    orderId: 'PO-1',
    operation: 'OP10',
    product: 'VB-100',
    quantity: 4,
    notBefore: '2026-10-12T03:00:00.000Z',
    deviceEpoch: 1_792_000_000,
  },
};

function answer(
  statusCode: StatusCode,
  flagged?: (typeof LOAD_ORDER_INPUTS)[number],
  outputs: unknown[] = [],
): CallMethodResult {
  return {
    statusCode,
    inputArgumentResults: LOAD_ORDER_INPUTS.map((name) =>
      name === flagged ? statusCode : StatusCodes.Good,
    ),
    outputArguments: outputs.map((value) => ({ value })),
  } as unknown as CallMethodResult;
}

const ACCEPTED_AT = new Date('2026-10-12T03:00:00.000Z');

describe('LoadOrder answers (#173)', () => {
  it('passes the command as LoadOrder arguments, ExpiresAt from the envelope', () => {
    const args = loadOrderArguments(COMMAND);
    expect(args.map((a) => a.value as unknown)).toEqual([
      'PO-1~OP10~1',
      'PO-1',
      'VB-100',
      4,
      new Date('2026-10-12T03:00:00.000Z'),
      1_792_000_000,
      new Date('2026-10-16T12:01:00.000Z'),
    ]);
    expect(jobKey('cnc-01', COMMAND)).not.toBe(jobKey('cnc-02', COMMAND));
  });

  it.each([
    [
      'accepted',
      answer(StatusCodes.Good, undefined, [1, false, 7, ACCEPTED_AT]),
      { result: 'accepted', position: 1, acceptedSeq: 7 },
    ],
    [
      'duplicate',
      answer(StatusCodes.Good, undefined, [2, true, 5, ACCEPTED_AT]),
      { result: 'duplicate', acceptedSeq: 5 },
    ],
    [
      'expired',
      answer(StatusCodes.BadInvalidState, 'ExpiresAt'),
      { result: 'expired', seqAfterExpiry: null },
    ],
    [
      'epoch-mismatch',
      answer(StatusCodes.BadInvalidState, 'DeviceEpoch'),
      { result: 'rejected', code: 'epoch-mismatch' },
    ],
    ['wrong-mode', answer(StatusCodes.BadInvalidState), { result: 'rejected', code: 'wrong-mode' }],
    [
      'command-conflict',
      answer(StatusCodes.BadInvalidArgument, 'CommandId'),
      { result: 'rejected', code: 'command-conflict' },
    ],
    [
      'invalid-product',
      answer(StatusCodes.BadInvalidArgument, 'Product'),
      { result: 'rejected', code: 'invalid-product' },
    ],
    [
      'invalid-quantity',
      answer(StatusCodes.BadInvalidArgument, 'Quantity'),
      { result: 'rejected', code: 'invalid-quantity' },
    ],
    [
      'invalid-argument',
      answer(StatusCodes.BadInvalidArgument, 'NotBefore'),
      { result: 'rejected', code: 'invalid-argument' },
    ],
    [
      'queue-full',
      answer(StatusCodes.BadResourceUnavailable),
      { result: 'rejected', code: 'queue-full' },
    ],
  ])('reads %s as a definitive answer', (_label, result, value) => {
    expect(interpretLoadOrder(COMMAND, result)).toEqual({
      kind: 'final',
      value: expect.objectContaining({
        ...value,
        commandId: 'PO-1~OP10~1',
        expiresAt: COMMAND.expiresAt,
      }) as unknown,
    });
  });

  it('reads a run not attached or finished as transient, and anything else as unknown', () => {
    expect(interpretLoadOrder(COMMAND, answer(StatusCodes.BadWaitingForInitialData))).toEqual({
      kind: 'transient',
      statusCode: 'BadWaitingForInitialData',
    });
    expect(interpretLoadOrder(COMMAND, answer(StatusCodes.BadInternalError))).toMatchObject({
      kind: 'unknown',
      statusCode: 'BadInternalError',
    });
    expect(interpretLoadOrder(COMMAND, answer(StatusCodes.Good, undefined, [1]))).toMatchObject({
      kind: 'unknown',
      reason: 'Good without valid outputs',
    });
  });

  it('maps a settle call: Duplicate, expired (with seqAfterExpiry) and epoch-mismatch are final, the rest unknown', () => {
    const settle = (result: CallMethodResult) => interpretSettleCall(COMMAND, result, 41);
    expect(settle(answer(StatusCodes.Good, undefined, [2, true, 5, ACCEPTED_AT]))).toMatchObject({
      kind: 'final',
      value: { result: 'duplicate' },
    });
    expect(settle(answer(StatusCodes.BadInvalidState, 'ExpiresAt'))).toMatchObject({
      kind: 'final',
      value: { result: 'expired', seqAfterExpiry: 41 },
    });
    expect(settle(answer(StatusCodes.BadInvalidState, 'DeviceEpoch'))).toMatchObject({
      kind: 'final',
      value: { result: 'rejected', code: 'epoch-mismatch' },
    });
    expect(settle(answer(StatusCodes.BadInvalidArgument, 'Product'))).toMatchObject({
      kind: 'unknown',
      reason: 'the settle call was refused (invalid-product)',
    });
    expect(settle(answer(StatusCodes.BadWaitingForInitialData))).toMatchObject({
      kind: 'unknown',
      statusCode: 'BadWaitingForInitialData',
    });
    expect(settle(answer(StatusCodes.BadTimeout))).toMatchObject({ kind: 'unknown' });
  });
});

describe('command store (#173)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-command-store-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps definitive answers by command id, expired by command id and expiresAt, never unknown', () => {
    const file = join(dir, 'store.db');
    const store = new CommandStore(file);
    const base = {
      commandId: 'PO-1~OP10~1',
      orderId: 'PO-1',
      deviceEpoch: 1,
      statusCode: 'BadInvalidState',
    };
    store.saveResult('job', {
      ...base,
      result: 'expired',
      expiresAt: '2026-10-16T12:01:00.000Z',
      seqAfterExpiry: 3,
    });
    expect(store.result('PO-1~OP10~1')).toBeUndefined();
    expect(store.expired('PO-1~OP10~1', '2026-10-16T12:01:00.000Z')?.value.result).toBe('expired');
    expect(store.expired('PO-1~OP10~1', '2026-10-16T12:02:00.000Z')).toBeUndefined();
    expect(() => {
      store.saveResult('job', {
        ...base,
        result: 'unknown',
        expiresAt: 'x',
        seqAfterExpiry: null,
        reason: 'r',
      });
    }).toThrow(/never stored/);
    store.saveResult('job', { ...base, result: 'rejected', expiresAt: 'x', code: 'queue-full' });
    store.saveResult('job', { ...base, result: 'rejected', expiresAt: 'y', code: 'wrong-mode' });
    expect(store.result('PO-1~OP10~1')?.value).toMatchObject({ code: 'queue-full' }); // first wins
    const entry = store.record('cnc-01', 't', '{}', 5);
    store.close();
    store.close();
    const reopened = new CommandStore(file);
    expect(reopened.pending()).toEqual([{ ...entry, receivedAt: 5 }]);
    reopened.done(entry.id);
    expect(reopened.pending()).toEqual([]);
    reopened.close();
  });
});
