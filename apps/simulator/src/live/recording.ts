/**
 * The live recording (#236, Phase 9 plan P9-09, ADR-0037 amendment): what a live run took from
 * outside, as a `scenario.json` document a headless run replays (`GET /api/v1/scenario/recorded`,
 * `headless --timeline <file>`).
 *
 * - Every job the line accepted (a MES `LoadOrder` call, or a dispatch given at the start), in
 *   acceptance order, with the simulation time of the acceptance and the number of events the run
 *   had processed by then (`acceptedAt`, `afterEvents`): the exact point between two events where
 *   the call found the run. A job accepted while the run was still idle at its start time is
 *   written as a plain start-time dispatch, as the goldens list theirs. A duplicate or refused call
 *   (`Duplicate`, `expired`, `epoch-mismatch`, an invalid argument, a full queue, `not-attached`,
 *   `not-running`) changes nothing in the line and is not recorded.
 * - The failure and drift injections (one numbering) and the console actions the line accepted, as
 *   the run took them: the headless run accepts them at the start, which equals the live run for
 *   every one accepted before the start or mid-run for a later time (#235's external lane); one
 *   posted mid-run for the simulation time itself is the limit #235 recorded.
 *
 * The document ends (`end`) one millisecond after the simulation time the run had processed, so
 * the replay's event log equals the live log line for line, or later when an accepted injection or
 * action is due after that (the live log is then a prefix of the replay's).
 */
import type { SimTime } from '@shopfloor/sim-core';
import { isoTime } from '../headless/serialize.ts';
import type {
  ConsoleAction,
  FailureInjection,
  LeakDrift,
  ProductionMode,
  RecordedDispatch,
} from '../plant/line.ts';

const DAY = 86_400_000;

export interface RecordingInput {
  readonly seed: number;
  readonly start: SimTime;
  /** How far the run has processed events (`simulation.now`). */
  readonly simNow: SimTime;
  readonly production: ProductionMode;
  /** The run's `configSha256`, named in the description. */
  readonly configSha256: string;
  /** The configuration folder, relative to the repository root (`config/plant`). */
  readonly config: string;
  /** The stock file's name when the run used one (`SIM_STOCK`); it must sit beside the document. */
  readonly stock?: string | undefined;
  readonly dispatches: readonly RecordedDispatch[];
  readonly injections: readonly FailureInjection[];
  readonly drifts: readonly LeakDrift[];
  readonly actions: readonly ConsoleAction[];
}

export interface RecordedDispatchJson {
  readonly commandId: string;
  readonly machine: string;
  readonly orderId: string;
  readonly product: string;
  readonly quantity: number;
  readonly notBefore: string;
  readonly acceptedAt?: string;
  readonly afterEvents?: number;
}

export type RecordedInjectionJson =
  | {
      readonly at: string;
      readonly machine: string;
      readonly code: string;
      readonly repairMs?: number;
    }
  | {
      readonly kind: 'leak-drift';
      readonly at: string;
      readonly until: string;
      readonly machine: string;
      readonly shift: number;
    };

export type RecordedActionJson =
  | { readonly kind: 'lot-block' | 'lot-release'; readonly at: string; readonly lot: string }
  | { readonly kind: 'tool-breakage'; readonly at: string; readonly machine: string }
  | { readonly kind: 'operators-absent'; readonly shift: string; readonly operators: string[] };

/** A recorded live run: a `scenario.json` document (`plant-config`'s scenario schema). */
export interface RecordedScenario {
  readonly description: string;
  readonly seed: number;
  readonly start: string;
  readonly days: number;
  readonly end: string;
  readonly config: string;
  readonly stock?: string;
  readonly production?: 'orders';
  readonly dispatches?: readonly RecordedDispatchJson[];
  readonly injections?: readonly RecordedInjectionJson[];
  readonly actions?: readonly RecordedActionJson[];
}

/** The time an accepted injection or action first touches the run. */
const dueAt = (item: { at: SimTime } | { start: SimTime }): SimTime =>
  'at' in item ? item.at : item.start;

export function recordScenario(input: RecordingInput): RecordedScenario {
  const { start, simNow } = input;
  const end = Math.max(
    simNow + 1,
    ...input.injections.map((i) => i.at + 1),
    ...input.drifts.map((d) => d.at + 1),
    ...input.actions.map((a) => dueAt(a) + 1),
  );
  const dispatches = input.dispatches.map((d): RecordedDispatchJson => {
    const base = {
      commandId: d.commandId,
      machine: d.machine,
      orderId: d.orderId,
      product: d.product,
      quantity: d.quantity,
      notBefore: isoTime(d.notBefore),
    };
    // Accepted while idle at the start (nothing processed yet): a plain start-time dispatch.
    return d.acceptedAt === start && d.afterEvents === 0
      ? base
      : { ...base, acceptedAt: isoTime(d.acceptedAt), afterEvents: d.afterEvents };
  });
  const injections = [
    ...input.injections.map((i) => ({
      id: i.id,
      json: {
        at: isoTime(i.at),
        machine: i.machine,
        code: i.code,
        ...(i.repairMs === undefined ? {} : { repairMs: i.repairMs }),
      } satisfies RecordedInjectionJson,
    })),
    ...input.drifts.map((d) => ({
      id: d.id,
      json: {
        kind: 'leak-drift',
        at: isoTime(d.at),
        until: isoTime(d.until),
        machine: d.machine,
        shift: d.shift,
      } satisfies RecordedInjectionJson,
    })),
  ]
    // Failures and drifts share one numbering: the headless run numbers them in list order.
    .sort((a, b) => a.id - b.id)
    .map((item) => item.json);
  const actions = [...input.actions]
    .sort((a, b) => a.id - b.id)
    .map((a): RecordedActionJson => {
      switch (a.kind) {
        case 'lot-block':
        case 'lot-release':
          return { kind: a.kind, at: isoTime(a.at), lot: a.lot };
        case 'tool-breakage':
          return { kind: a.kind, at: isoTime(a.at), machine: a.machine };
        case 'operators-absent':
          return { kind: a.kind, shift: a.shift, operators: [...a.operators] };
      }
    });
  return {
    description:
      `Recorded from a live ${input.production} run (seed ${String(input.seed)}, configSha256 ` +
      `${input.configSha256}) at simulation time ${isoTime(simNow)}: ${String(dispatches.length)} ` +
      `accepted dispatches at their points of the run, ${String(injections.length)} injections ` +
      `and ${String(actions.length)} console actions (#236).`,
    seed: input.seed,
    start: isoTime(start),
    days: Math.max(1, Math.ceil((end - start) / DAY)),
    end: isoTime(end),
    config: input.config,
    ...(input.stock === undefined ? {} : { stock: input.stock }),
    ...(input.production === 'orders' ? { production: 'orders' as const } : {}),
    ...(dispatches.length === 0 ? {} : { dispatches }),
    ...(injections.length === 0 ? {} : { injections }),
    ...(actions.length === 0 ? {} : { actions }),
  };
}
