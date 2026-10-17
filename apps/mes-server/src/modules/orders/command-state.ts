import type { CommandResultValue, JobTransition } from '@shopfloor/contracts';
import type { CommandState, JobState } from '@shopfloor/contracts/mes-api';

/**
 * How the orders module reads a dispatch command (#174, ADR-0029, plan "Command path"): a pure
 * function of what the MES published (the attempts with their `expiresAt`), every `cmd-res` the
 * gateway answered, the device's job facts and how far the CNC's device stream has arrived. It is
 * recomputed whenever any of them moves, so the order of arrival never matters.
 */

/** What a command's reading is made of. */
export interface CommandInputs {
  readonly commandId: string;
  readonly equipment: string;
  readonly deviceEpoch: number;
  /**
   * Every delivery written, in order (wall times in ms); `published` once the broker acknowledged
   * it. Only published ones count towards `maxAttempts`; an unpublished latest one is resent.
   */
  readonly attempts: readonly {
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly published: boolean;
  }[];
  /** Every `cmd-res` stored for the command id (any equipment and device epoch). */
  readonly results: readonly { readonly equipment: string; readonly value: CommandResultValue }[];
  /** Every job fact stored for the command id (any equipment and epoch). */
  readonly facts: readonly {
    readonly equipment: string;
    readonly epoch: number;
    readonly seq: number;
    readonly sourceTime: number;
    readonly transition: JobTransition;
  }[];
  /** The command's CNC: how far its device stream has arrived (`Ingest.deviceProgress`). */
  /**
   * What the command was read as before (its stored state). Settled without a job is final but
   * for its own `accepted` fact: a later reading (another policy after a restart, an answer of
   * another kind) never reopens it, never resends it.
   */
  readonly previous?: { readonly state: CommandState; readonly settled: boolean };
  readonly device: {
    /** The device stream's current epoch (its cursor), null before any fact. */
    readonly epoch: number | null;
    /** The newest device epoch known from facts, anchors or snapshots. */
    readonly newestEpoch: number | null;
    /** Every number from the stream's first one up to here has arrived. */
    readonly receivedThrough: number | null;
    /** The numbers seen in the stream's epoch, as sorted ranges (a reported gap is not seen). */
    readonly seen?: readonly (readonly [number, number])[];
    /**
     * The highest number of the command's run the MES had stored before its first delivery was
     * written: the device emitted it before the command existed, so the command's acceptance has
     * a higher number. Null when none.
     */
    readonly before?: number | null;
    /** ADR-0018's final-through (a gap written off as an incident counts as closed). */
    readonly settledSeq: number | null;
    /** Plant time of the fact at `settledSeq` (ms). */
    readonly settledTime: number | null;
  };
}

export interface CommandPolicy {
  /** Published deliveries at most: the first and the resends (5). */
  readonly maxAttempts: number;
  /** A delivery with no answer this long is resent with a new `expiresAt` (15 s). */
  readonly resendMs: number;
  /** `failed` after the last `expiresAt` plus this, with no final answer (30 s). */
  readonly failMarginMs: number;
}

export const DEFAULT_POLICY: CommandPolicy = {
  maxAttempts: 5,
  resendMs: 15_000,
  failMarginMs: 30_000,
};

export interface CommandReading {
  readonly state: CommandState;
  /** Whether a job exists is known for good (accepted, or never will be). */
  readonly settled: boolean;
  /** The job's acceptance: its fact (confirmed) or, before it, an accepted/duplicate result. */
  readonly accepted: {
    readonly by: 'fact' | 'result';
    readonly seq: number;
    readonly at: number;
  } | null;
  /** The `accepted` fact arrived. */
  readonly confirmed: boolean;
  /** How many distinct `accepted` facts (more than one breaks exactly-once on the device). */
  readonly acceptedFacts: number;
  readonly job: JobState | null;
  readonly started: { readonly seq: number; readonly at: number } | null;
  readonly completedAt: number | null;
  readonly rejection: string | null;
  /** From an `expired` or `unknown` answer to the latest delivery. */
  readonly seqAfterExpiry: number | null;
  /** In the failed condition now (no final answer after the last `expiresAt` plus the margin). */
  readonly failed: boolean;
  /**
   * An `accepted`/`duplicate` result whose `accepted` fact has not arrived although the CNC's
   * final-through passed its `acceptedSeq` and `acceptedAt` (or its run ended): the
   * `command-unconfirmed` incident.
   */
  readonly unconfirmed: boolean;
  /** The command's device run ended (a newer epoch is known). */
  readonly epochEnded: boolean;
  /** A delivery is due now (the first one, or a resend). */
  readonly send: boolean;
}

/** Reads one command at wall time `now`. */
export function readCommand(
  input: CommandInputs,
  now: number,
  policy: CommandPolicy = DEFAULT_POLICY,
): CommandReading {
  const mine = (item: { readonly equipment: string }): boolean =>
    item.equipment === input.equipment;
  // Results of another device run or equipment answer another command (ADR-0029: keyed by
  // command id and device epoch).
  const results = input.results
    .filter(mine)
    .map((r) => r.value)
    .filter((v) => v.deviceEpoch === input.deviceEpoch);
  const facts = input.facts.filter((f) => mine(f) && f.epoch === input.deviceEpoch);
  const acceptedFacts = facts.filter((f) => f.transition === 'accepted');
  const acceptedSeqs = new Set(acceptedFacts.map((f) => f.seq));
  const firstFact = [...acceptedFacts].sort((a, b) => a.seq - b.seq)[0];
  // `accepted` and `duplicate` are sticky: no later answer revokes them.
  const sticky = results.find(
    (v): v is Extract<CommandResultValue, { result: 'accepted' | 'duplicate' }> =>
      v.result === 'accepted' || v.result === 'duplicate',
  );
  const accepted = firstFact
    ? { by: 'fact' as const, seq: firstFact.seq, at: firstFact.sourceTime }
    : sticky
      ? { by: 'result' as const, seq: sticky.acceptedSeq, at: Date.parse(sticky.acceptedAt) }
      : null;
  // `rejected` is final for the command id, but `command-conflict` is no refusal of this job: the
  // device holds another job under the id, so nothing is settled until its run ends.
  const refusals = accepted
    ? []
    : results.filter(
        (v): v is Extract<CommandResultValue, { result: 'rejected' }> => v.result === 'rejected',
      );
  const rejected = refusals.find((v) => v.code !== 'command-conflict');
  const conflict = refusals.find((v) => v.code === 'command-conflict');
  const newest = Math.max(input.device.newestEpoch ?? -1, input.device.epoch ?? -1);
  const epochEnded = newest > input.deviceEpoch;
  const latest = input.attempts.reduce<
    { issuedAt: number; expiresAt: number; published: boolean } | undefined
  >(
    (last, attempt) => (last === undefined || attempt.expiresAt >= last.expiresAt ? attempt : last),
    undefined,
  );
  // `expired` and `unknown` hold only for the delivery they answer, named by its `expiresAt`.
  const forLatest =
    latest === undefined
      ? []
      : results.filter(
          (v): v is Extract<CommandResultValue, { result: 'expired' | 'unknown' }> =>
            (v.result === 'expired' || v.result === 'unknown') &&
            Date.parse(v.expiresAt) === latest.expiresAt,
        );
  const expiredLatest = forLatest.some((v) => v.result === 'expired');
  const unknownLatest = forLatest.some((v) => v.result === 'unknown');
  const seqAfterExpiry = forLatest.reduce<number | null>(
    (max, v) =>
      v.seqAfterExpiry === null
        ? max
        : max === null
          ? v.seqAfterExpiry
          : Math.max(max, v.seqAfterExpiry),
    null,
  );
  const started = facts.filter((f) => f.transition === 'started').sort((a, b) => a.seq - b.seq)[0];
  const completed = facts.find((f) => f.transition === 'completed');
  const job: JobState | null = accepted
    ? completed
      ? 'completed'
      : epochEnded
        ? 'lost'
        : started
          ? 'started'
          : 'accepted'
    : null;
  // Every acceptance happened before `expiresAt` on the device's clock, so its fact has a number
  // at most `seqAfterExpiry`: once every number up to it arrived without one, there is no job.
  // "Every number up to it": from the stream's start (`receivedThrough`, a stream received from
  // 1), or from a number the device emitted before the command existed (`before`): the
  // acceptance can only lie above that one. A gap written off as an incident is not received.
  const before = input.device.before ?? null;
  const receivedFrom =
    before === null
      ? null
      : (input.device.seen?.find(([lo, hi]) => lo <= before && before <= hi)?.[1] ?? null);
  const through = Math.max(input.device.receivedThrough ?? -1, receivedFrom ?? -1);
  const settledBySeq =
    seqAfterExpiry !== null &&
    !expiredLatest &&
    input.device.epoch === input.deviceEpoch &&
    through >= seqAfterExpiry;
  const exhausted = input.attempts.filter((a) => a.published).length >= policy.maxAttempts;
  let state: CommandState;
  if (accepted) state = 'accepted';
  else if (rejected) state = 'rejected';
  else if (epochEnded) state = 'epoch-ended';
  else if (conflict) state = 'conflict';
  else if (latest === undefined) state = 'queued';
  else if (expiredLatest && exhausted) state = 'expired';
  else if (settledBySeq) state = 'not-accepted';
  else if (!expiredLatest && now >= latest.expiresAt + policy.failMarginMs) state = 'failed';
  else if (unknownLatest && !expiredLatest) state = 'unknown';
  else state = 'sent';
  const settled = ['accepted', 'rejected', 'epoch-ended', 'expired', 'not-accepted'].includes(
    state,
  );
  const answeredLatest = forLatest.length > 0;
  const send =
    !settled &&
    !exhausted &&
    state !== 'conflict' &&
    (latest === undefined ||
      !latest.published ||
      expiredLatest ||
      (!answeredLatest && now - latest.issuedAt >= policy.resendMs));
  const unconfirmed =
    sticky !== undefined &&
    acceptedFacts.length === 0 &&
    ((input.device.epoch !== null && input.device.epoch > input.deviceEpoch) ||
      (input.device.epoch === input.deviceEpoch &&
        input.device.settledSeq !== null &&
        input.device.settledSeq >= sticky.acceptedSeq &&
        input.device.settledTime !== null &&
        input.device.settledTime >= Date.parse(sticky.acceptedAt)));
  const prior = input.previous;
  if (prior?.settled === true && prior.state !== 'accepted' && accepted === null) {
    state = prior.state;
    return {
      state,
      settled: true,
      accepted,
      confirmed: false,
      acceptedFacts: 0,
      job: null,
      started: null,
      completedAt: null,
      rejection: rejected ? rejected.code : conflict ? conflict.code : null,
      seqAfterExpiry,
      failed: false,
      unconfirmed: false,
      epochEnded,
      send: false,
    };
  }
  return {
    state,
    settled,
    accepted,
    confirmed: acceptedFacts.length > 0,
    acceptedFacts: acceptedSeqs.size,
    job,
    started: started ? { seq: started.seq, at: started.sourceTime } : null,
    completedAt: completed ? completed.sourceTime : null,
    rejection: rejected ? rejected.code : conflict ? conflict.code : null,
    seqAfterExpiry,
    failed: state === 'failed',
    unconfirmed,
    epochEnded,
    send,
  };
}
