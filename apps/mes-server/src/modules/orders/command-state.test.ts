/**
 * How a dispatch command is read from its deliveries, results and job facts (#174, ADR-0029):
 * the precedence of several `cmd-res` per command id, `failed`, settling by `seqAfterExpiry`, the
 * epoch's end, `command-unconfirmed`, and the outbox's resend decisions. Order of arrival never
 * matters (a property test shuffles the results).
 */
import type { CommandResultValue } from '@shopfloor/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readCommand, type CommandInputs, type CommandPolicy } from './command-state.ts';

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const EPOCH = 1_760_000_000;
const ID = 'PO-1~OP10~1';
const policy: CommandPolicy = { maxAttempts: 3, resendMs: 15_000, failMarginMs: 30_000 };
const iso = (ms: number): string => new Date(ms).toISOString();

const attempt = (k: number) => ({ issuedAt: T0 + k * 15_000, expiresAt: T0 + k * 15_000 + 60_000 });

const base: CommandInputs = {
  commandId: ID,
  equipment: 'cnc-01',
  deviceEpoch: EPOCH,
  attempts: [],
  results: [],
  facts: [],
  device: {
    epoch: EPOCH,
    newestEpoch: EPOCH,
    receivedThrough: 10,
    settledSeq: 10,
    settledTime: T0,
  },
};

const answered = (expiresAt: number) => ({
  commandId: ID,
  orderId: 'PO-1',
  deviceEpoch: EPOCH,
  expiresAt: iso(expiresAt),
  statusCode: 'Good',
});
const accepted = (expiresAt: number, kind: 'accepted' | 'duplicate' = 'accepted') => ({
  equipment: 'cnc-01',
  value: {
    ...answered(expiresAt),
    result: kind,
    position: 1,
    acceptedSeq: 12,
    acceptedAt: '2026-10-12T03:00:00.000Z',
  } as CommandResultValue,
});
const expired = (expiresAt: number, seqAfterExpiry: number | null = 20) => ({
  equipment: 'cnc-01',
  value: {
    ...answered(expiresAt),
    result: 'expired',
    statusCode: 'BadInvalidState',
    seqAfterExpiry,
  } as CommandResultValue,
});
const unknown = (expiresAt: number, seqAfterExpiry: number | null = 20) => ({
  equipment: 'cnc-01',
  value: {
    ...answered(expiresAt),
    result: 'unknown',
    statusCode: null,
    seqAfterExpiry,
    reason: 'deadline',
  } as CommandResultValue,
});
const rejected = (code: 'invalid-product' | 'command-conflict' | 'epoch-mismatch') => ({
  equipment: 'cnc-01',
  value: {
    ...answered(attempt(0).expiresAt),
    result: 'rejected',
    statusCode: 'BadInvalidArgument',
    code,
  } as CommandResultValue,
});
const fact = (transition: 'accepted' | 'started' | 'completed', seq: number) => ({
  equipment: 'cnc-01',
  epoch: EPOCH,
  seq,
  sourceTime: Date.parse('2026-10-12T03:00:00.000Z') + seq * 1_000,
  transition,
});

const read = (input: Partial<CommandInputs>, now = T0) =>
  readCommand({ ...base, ...input }, now, policy);

describe('reading a command (ADR-0029)', () => {
  it('is queued until its first delivery, then sent; a delivery without an answer is resent', () => {
    expect(read({})).toMatchObject({ state: 'queued', settled: false, send: true });
    const one = { attempts: [attempt(0)] };
    expect(read(one, T0 + 14_999)).toMatchObject({ state: 'sent', send: false });
    expect(read(one, T0 + 15_000)).toMatchObject({ state: 'sent', send: true });
    // An unknown answer for the latest delivery: the gateway is settling it, no resend.
    expect(read({ ...one, results: [unknown(attempt(0).expiresAt)] }, T0 + 20_000)).toMatchObject({
      state: 'unknown',
      send: false,
    });
    // At most maxAttempts deliveries.
    const all = { attempts: [attempt(0), attempt(1), attempt(2)] };
    expect(read(all, T0 + 50_000)).toMatchObject({ state: 'sent', send: false });
  });

  it('takes accepted and duplicate as sticky; the fact confirms and gives the acceptance', () => {
    const results = [expired(attempt(0).expiresAt), accepted(attempt(1).expiresAt, 'duplicate')];
    const byResult = read({ attempts: [attempt(0), attempt(1)], results });
    expect(byResult).toMatchObject({
      state: 'accepted',
      settled: true,
      confirmed: false,
      job: 'accepted',
      accepted: { by: 'result', seq: 12 },
      send: false,
    });
    // A later expired, unknown or command-conflict never revokes an acceptance.
    const later = read({
      attempts: [attempt(0), attempt(1)],
      results: [...results, unknown(attempt(1).expiresAt), rejected('command-conflict')],
    });
    expect(later).toMatchObject({ state: 'accepted', rejection: null });
    const confirmed = read({
      attempts: [attempt(0)],
      results,
      facts: [fact('accepted', 11), fact('started', 13)],
    });
    expect(confirmed).toMatchObject({
      state: 'accepted',
      confirmed: true,
      accepted: { by: 'fact', seq: 11 },
      job: 'started',
      started: { seq: 13 },
    });
    expect(read({ facts: [fact('accepted', 11), fact('completed', 30)] })).toMatchObject({
      job: 'completed',
      completedAt: fact('completed', 30).sourceTime,
    });
  });

  it('holds expired only for the delivery it answers: a resend follows, the last one settles', () => {
    const first = read({ attempts: [attempt(0)], results: [expired(attempt(0).expiresAt)] }, T0);
    expect(first).toMatchObject({ state: 'sent', settled: false, send: true, failed: false });
    // An expired answer of an older delivery says nothing about the newer one.
    const newer = read({
      attempts: [attempt(0), attempt(1)],
      results: [expired(attempt(0).expiresAt)],
    });
    expect(newer).toMatchObject({ state: 'sent', settled: false, send: false });
    const last = read({
      attempts: [attempt(0), attempt(1), attempt(2)],
      results: [expired(attempt(2).expiresAt)],
    });
    expect(last).toMatchObject({ state: 'expired', settled: true, job: null, send: false });
    // An unknown never overrides a definitive answer for the same expiresAt, in either order.
    for (const results of [
      [unknown(attempt(2).expiresAt), expired(attempt(2).expiresAt)],
      [expired(attempt(2).expiresAt), unknown(attempt(2).expiresAt)],
    ]) {
      expect(read({ attempts: [attempt(0), attempt(1), attempt(2)], results }).state).toBe(
        'expired',
      );
    }
  });

  it('is rejected for good (no job), but not by a command-conflict after an acceptance', () => {
    expect(read({ attempts: [attempt(0)], results: [rejected('invalid-product')] })).toMatchObject({
      state: 'rejected',
      settled: true,
      rejection: 'invalid-product',
      job: null,
    });
    expect(
      read({
        attempts: [attempt(0)],
        results: [rejected('command-conflict'), accepted(attempt(0).expiresAt)],
      }).state,
    ).toBe('accepted');
  });

  it('is failed after its last expiresAt plus the margin without a final answer, and not final', () => {
    const one = { attempts: [attempt(0), attempt(1), attempt(2)] };
    const lastExpiry = attempt(2).expiresAt;
    expect(read(one, lastExpiry + 29_999)).toMatchObject({ state: 'sent', failed: false });
    expect(read(one, lastExpiry + 30_000)).toMatchObject({
      state: 'failed',
      failed: true,
      settled: false,
    });
    // An unknown is not final either.
    expect(
      read({ ...one, results: [unknown(lastExpiry, null)] }, lastExpiry + 30_000),
    ).toMatchObject({ state: 'failed', settled: false });
    // A late duplicate settles it: the job exists.
    expect(
      read({ ...one, results: [accepted(lastExpiry, 'duplicate')] }, lastExpiry + 90_000),
    ).toMatchObject({ state: 'accepted', settled: true, failed: false });
  });

  it('settles an unknown or failed command once every fact through seqAfterExpiry arrived without its acceptance', () => {
    const one = { attempts: [attempt(0)] };
    const S = 20;
    const results = [unknown(attempt(0).expiresAt, S)];
    const late = attempt(0).expiresAt + 60_000;
    const at = (receivedThrough: number) =>
      read({ ...one, results, device: { ...base.device, receivedThrough } }, late);
    expect(at(S - 1)).toMatchObject({ state: 'failed', settled: false, seqAfterExpiry: S });
    expect(at(S)).toMatchObject({ state: 'not-accepted', settled: true, job: null });
    // Its accepted fact at or below seqAfterExpiry: the job exists after all.
    expect(
      read(
        {
          ...one,
          results,
          facts: [fact('accepted', S)],
          device: { ...base.device, receivedThrough: S },
        },
        late,
      ),
    ).toMatchObject({ state: 'accepted', job: 'accepted' });
    // A seqAfterExpiry of an older delivery says nothing about the latest one.
    expect(
      read(
        {
          attempts: [attempt(0), attempt(1)],
          results,
          device: { ...base.device, receivedThrough: 99 },
        },
        late,
      ).settled,
    ).toBe(false);
    // Received through: a gap written off as an incident is not received (settledSeq is).
    expect(
      read(
        { ...one, results, device: { ...base.device, receivedThrough: 5, settledSeq: 99 } },
        late,
      ).settled,
    ).toBe(false);
  });

  it('ends with its device run: no job, or a lost one', () => {
    const ended = { device: { ...base.device, newestEpoch: EPOCH + 1 } };
    expect(read({ ...ended, attempts: [attempt(0)] })).toMatchObject({
      state: 'epoch-ended',
      settled: true,
      job: null,
      epochEnded: true,
      send: false,
    });
    expect(read({ ...ended, facts: [fact('accepted', 11), fact('started', 12)] })).toMatchObject({
      state: 'accepted',
      job: 'lost',
    });
    expect(read({ ...ended, facts: [fact('accepted', 11), fact('completed', 40)] }).job).toBe(
      'completed',
    );
  });

  it('reads only its own equipment and device run', () => {
    const other = {
      results: [
        { ...accepted(attempt(0).expiresAt), equipment: 'cnc-02' },
        {
          equipment: 'cnc-01',
          value: { ...accepted(attempt(0).expiresAt).value, deviceEpoch: EPOCH - 1 },
        },
      ],
      facts: [
        { ...fact('accepted', 11), equipment: 'cnc-02' },
        { ...fact('accepted', 11), epoch: EPOCH - 1 },
      ],
      attempts: [attempt(0)],
    };
    expect(read(other)).toMatchObject({ state: 'sent', accepted: null, confirmed: false });
  });

  it('is unconfirmed when the CNC passed the acceptance of a cmd-res without its fact', () => {
    const results = [accepted(attempt(0).expiresAt)];
    const acceptedAt = Date.parse('2026-10-12T03:00:00.000Z');
    const at = (settledSeq: number, settledTime: number, epoch = EPOCH) =>
      read({
        attempts: [attempt(0)],
        results,
        device: { ...base.device, epoch, settledSeq, settledTime },
      }).unconfirmed;
    expect(at(11, acceptedAt)).toBe(false);
    expect(at(12, acceptedAt - 1)).toBe(false);
    expect(at(12, acceptedAt)).toBe(true);
    // A newer run's facts arrive: the old run's fact never will.
    expect(at(1, acceptedAt - 1, EPOCH + 1)).toBe(true);
    expect(
      read({ attempts: [attempt(0)], results, facts: [fact('accepted', 12)] }).unconfirmed,
    ).toBe(false);
    // Two accepted facts for one id: exactly-once broken on the device.
    expect(read({ facts: [fact('accepted', 11), fact('accepted', 14)] }).acceptedFacts).toBe(2);
  });

  it('reads the same whatever order the results arrived in (property)', () => {
    const attempts = [attempt(0), attempt(1), attempt(2)];
    const pool = [
      expired(attempt(0).expiresAt),
      unknown(attempt(1).expiresAt, 15),
      expired(attempt(1).expiresAt, 15),
      unknown(attempt(2).expiresAt, 25),
      accepted(attempt(2).expiresAt, 'duplicate'),
      rejected('command-conflict'),
      expired(attempt(2).expiresAt, 25),
    ];
    fc.assert(
      fc.property(
        fc.subarray(pool),
        fc.integer({ min: 0, max: 40 }),
        fc.nat(),
        (results, receivedThrough, seed) => {
          const shuffled = [...results].sort(
            (a, b) =>
              ((pool.indexOf(a) * 7919 + seed) % 13) - ((pool.indexOf(b) * 7919 + seed) % 13),
          );
          const device = { ...base.device, receivedThrough };
          const now = attempt(2).expiresAt + 60_000;
          const one = readCommand({ ...base, attempts, results, device }, now, policy);
          const two = readCommand({ ...base, attempts, results: shuffled, device }, now, policy);
          expect(two).toEqual(one);
          // An acceptance, once there, is never revoked by anything else in the pool.
          if (results.some((r) => r.value.result === 'duplicate')) {
            expect(one.state).toBe('accepted');
          }
        },
      ),
    );
  });
});
