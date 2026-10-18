/**
 * Each CNC's queue for `oee-core`'s `jobWindows`, from the orders module's command state (#231,
 * ADR-0036 "the queue contract" and its P9-04 amendment). Pure: no I/O, so the rules for unknown and
 * lost facts are tested on their own.
 *
 * - **Who is in the queue:** every command dispatched to the CNC whose acceptance is not refuted:
 *   accepted (by its fact or its result), or not settled yet (its acceptance still unknown), or one
 *   whose job facts arrived without an acceptance. A command settled without a job (rejected,
 *   expired, not accepted, its run ended unanswered) is refuted and left out. A queue built from
 *   job facts alone would let a written-off gap give a job's cycles to its predecessor (H16).
 * - **Order:** acceptance order, per CNC and device epoch (one device run): dispatch order
 *   (`queuePosition`), with the commands whose acceptance sequence is known put in sequence order
 *   among their own places, so a command of unknown acceptance keeps its dispatch place.
 * - **Lost, not merely missing:** a fact is lost once the CNC's final-through (ADR-0018: a gap
 *   written off counts as closed) has passed a later fact of the same device, or once the job's run
 *   ended (a newer device epoch). Device sequence numbers and plant times rise together, so "a
 *   later fact" is read from times: `accepted` comes before the job's `started` (and `completed`);
 *   `completed` comes before the next job's `started`, and is the very instant of the job's last
 *   OP10 cycle (ADR-0030), so once every cycle is known and nothing follows on the CNC, a
 *   final-through past that instant without the fact means it is lost.
 */
import type { Millis, QueuedJob } from '@shopfloor/oee-core';

/** What the queue needs of one dispatch command (the orders module's `CommandRecord`). */
export interface QueueCommand {
  readonly commandId: string;
  readonly orderId: string;
  readonly equipment: string;
  readonly deviceEpoch: number;
  readonly quantity: number;
  readonly notBefore: Millis;
  /** Dispatch order (the orders module's queue position, global). */
  readonly queuePosition: number;
  readonly settled: boolean;
  /** The acceptance: its job fact, or the command result's `acceptedAt` (null: unknown). */
  readonly acceptedBy: 'fact' | 'result' | null;
  readonly acceptedSeq: number | null;
  readonly acceptedAt: Millis | null;
  /** The job's run ended before `completed` (the orders module's job state `lost`). */
  readonly jobLost: boolean;
  readonly startedAt: Millis | null;
  readonly completedAt: Millis | null;
}

/** How far one CNC's device stream is known (`Ingest.deviceProgress`). */
export interface DeviceCut {
  /** The stream's current device epoch; null before any fact. */
  readonly epoch: number | null;
  /** ADR-0018's final-through time in that epoch; null before any settled fact. */
  readonly finalThrough: Millis | null;
}

/** One CNC's queue in one device epoch, in acceptance order. */
export interface CommandQueue {
  readonly machine: string;
  readonly epoch: number;
  /** A newer device run exists: every unfinished job of this one is lost. */
  readonly ended: boolean;
  /** The cut-off of open windows: the final-through (exclusive), or the run's last known time. */
  readonly until: Millis;
  readonly commands: readonly QueueCommand[];
}

/** Whether the command's acceptance is not refuted (it belongs in its CNC's queue). */
export function inQueue(command: QueueCommand): boolean {
  return (
    command.acceptedBy !== null ||
    command.startedAt !== null ||
    command.completedAt !== null ||
    !command.settled
  );
}

/** Commands of one CNC and epoch in acceptance order (see the module comment). */
export function acceptanceOrder(commands: readonly QueueCommand[]): QueueCommand[] {
  const byDispatch = [...commands].sort(
    (a, b) => a.queuePosition - b.queuePosition || (a.commandId < b.commandId ? -1 : 1),
  );
  const slots = byDispatch.flatMap((c, i) => (c.acceptedSeq === null ? [] : [i]));
  const known = slots
    .map((i) => byDispatch[i])
    .filter((c) => c !== undefined)
    .sort(
      (a, b) => (a.acceptedSeq ?? 0) - (b.acceptedSeq ?? 0) || a.queuePosition - b.queuePosition,
    );
  const ordered = [...byDispatch];
  slots.forEach((slot, k) => {
    const command = known[k];
    if (command) ordered[slot] = command;
  });
  return ordered;
}

const latestTime = (commands: readonly QueueCommand[]): Millis => {
  let latest = 0;
  for (const c of commands) {
    for (const at of [c.acceptedAt, c.startedAt, c.completedAt]) {
      if (at !== null && at > latest) latest = at;
    }
  }
  return latest;
};

/**
 * Every CNC's queues from the commands (all of them: other orders' jobs on the same CNC decide
 * head times), grouped per machine and device epoch, each in acceptance order and holding only
 * the commands whose acceptance is not refuted. `cuts` gives each machine's device progress.
 */
export function commandQueues(
  commands: readonly QueueCommand[],
  cuts: ReadonlyMap<string, DeviceCut>,
): CommandQueue[] {
  const groups = new Map<string, QueueCommand[]>();
  for (const command of commands.filter(inQueue)) {
    const key = `${command.equipment}\u0000${String(command.deviceEpoch)}`;
    groups.set(key, [...(groups.get(key) ?? []), command]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const machine = first?.equipment ?? '';
    const epoch = first?.deviceEpoch ?? 0;
    const cut = cuts.get(machine);
    const ended = cut?.epoch !== null && cut?.epoch !== undefined && cut.epoch > epoch;
    const current = cut?.epoch === epoch;
    return {
      machine,
      epoch,
      ended,
      until: current ? (cut.finalThrough ?? 0) : ended ? latestTime(group) : 0,
      commands: acceptanceOrder(group),
    };
  });
}

/** The final-through of the queue's own run, or Infinity once a newer run ended it. */
function passed(queue: CommandQueue, cut: DeviceCut | undefined): Millis | null {
  if (queue.ended) return Number.POSITIVE_INFINITY;
  return cut?.epoch === queue.epoch ? cut.finalThrough : null;
}

/**
 * The `oee-core` job of the queue's `index`-th command, with what the command state, its OP10
 * cycles (`cycleEnds`, attributed by unit; undefined when not read) and the CNC's progress tell:
 * `accepted` (the fact), `acceptedAt` (the result), and whether a fact is lost (module comment).
 */
export function queuedJob(
  queue: CommandQueue,
  index: number,
  cut: DeviceCut | undefined,
  cycleEnds?: readonly Millis[],
): QueuedJob {
  const command = queue.commands[index];
  if (!command)
    throw new RangeError(`no command ${String(index)} in the queue of ${queue.machine}`);
  const next = queue.commands[index + 1];
  const through = passed(queue, cut);
  const beyond = (at: Millis | null): boolean => at !== null && through !== null && through > at;
  const exists = command.acceptedBy !== null || command.startedAt !== null;
  const firstFact = command.startedAt ?? command.completedAt;
  const acceptedLost =
    command.acceptedBy === null && firstFact !== null && (queue.ended || beyond(firstFact));
  const ends = cycleEnds ?? [];
  const lastCycle = ends.length === 0 ? null : ends.reduce((a, b) => (b > a ? b : a));
  const completedLost =
    command.completedAt === null &&
    exists &&
    (queue.ended ||
      command.jobLost ||
      (next !== undefined && beyond(next.startedAt)) ||
      (next === undefined &&
        cycleEnds !== undefined &&
        command.quantity > 0 &&
        ends.length === command.quantity &&
        beyond(lastCycle)));
  return {
    id: command.commandId,
    machine: queue.machine,
    ...(command.acceptedBy === 'fact' && command.acceptedAt !== null
      ? { accepted: command.acceptedAt }
      : {}),
    ...(command.acceptedBy === 'result' && command.acceptedAt !== null
      ? { acceptedAt: command.acceptedAt }
      : {}),
    ...(acceptedLost ? { acceptedLost: true } : {}),
    notBefore: command.notBefore,
    ...(command.startedAt === null ? {} : { started: command.startedAt }),
    ...(command.completedAt === null ? {} : { completed: command.completedAt }),
    ...(completedLost ? { completedLost: true } : {}),
    quantity: command.quantity,
    ...(cycleEnds === undefined ? {} : { cycleEnds: [...cycleEnds] }),
  };
}

/**
 * The part of a queue an order's windows need: each of its jobs with its predecessor (head time)
 * and its successor (attribution boundary, the cap of a lost end). `[from, to)` indices, empty
 * when the order has no job in the queue.
 */
export function orderSlice(queue: CommandQueue, orderId: string): { from: number; to: number } {
  const indices = queue.commands.flatMap((c, i) => (c.orderId === orderId ? [i] : []));
  if (indices.length === 0) return { from: 0, to: 0 };
  const first = indices[0] ?? 0;
  const last = indices.at(-1) ?? 0;
  return { from: Math.max(0, first - 1), to: Math.min(queue.commands.length, last + 2) };
}
