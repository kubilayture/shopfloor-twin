import { CAUSES } from '@shopfloor/contracts';
import { availabilityLoss, type AvailabilityLoss, type Millis } from '@shopfloor/oee-core';
import { classifyCause, type PlantConfig } from '@shopfloor/plant-config';
import { NO_SHIFT } from '@shopfloor/shift-calendar';
import type { Piece } from './pieces.ts';

/** How downtime records are derived (#119): the threshold of `oee.yaml` and the reason rules. */
export interface DowntimeRules {
  readonly microStopThresholdMs: Millis;
  /** The auto reason of (state, cause): the first matching rule of `reasons.yaml`, else UNCODED. */
  readonly classify: (state: string, cause: string | null) => string;
  /**
   * Time outside planned busy time though in a shift (#175, ADR-0021 amendment): under
   * `scheduledTime: orders`, Idle with cause `NO-ORDER`. Never a loss, so never a record.
   */
  readonly unplanned?: (state: string, cause: string | null) => boolean;
}

/** The rules of a plant configuration: `oee.yaml`'s threshold and rule, `reasons.yaml`'s rules. */
export const downtimeRules = (config: Pick<PlantConfig, 'oee' | 'reasons'>): DowntimeRules => ({
  microStopThresholdMs: config.oee.microStopThresholdMs,
  classify: (state, cause) => classifyCause(config.reasons.rules, state, cause),
  ...(config.oee.scheduledTime === 'orders'
    ? { unplanned: (state: string, cause: string | null) => isNoOrderIdle(state, cause) }
    : {}),
});

/** Idle for want of a startable order (ADR-0030): what the `orders` rule leaves unplanned. */
export const isNoOrderIdle = (state: string, cause: string | null): boolean =>
  state === 'Idle' && cause === CAUSES.noOrder;

/** One downtime record as the module derives it. */
export interface DerivedRecord {
  /** The later of the interval's start and its shift bucket's start: the key. */
  readonly from: Millis;
  /** Null while the interval is open and this is its last stored bucket. */
  readonly to: Millis | null;
  readonly intervalStart: Millis;
  readonly shiftKey: string;
  readonly state: string;
  readonly cause: string | null;
  readonly loss: AvailabilityLoss;
  readonly reason: string;
  readonly provisional: boolean;
}

/**
 * The downtime records of whole intervals' pieces (in time order): one per availability-loss
 * interval and scheduled shift bucket (ADR-0021). A Stopped interval counts from the micro-stop
 * threshold on, measured over its whole length (so far, if open: it can only grow, so a record
 * once made stays). Pieces in the `no-shift` bucket make none: nothing is planned there, so
 * nothing is lost. `openStart` is the start of the open interval, if any; its last record has no
 * end. A record is provisional while it is open or any of its pieces is.
 */
export function deriveRecords(
  pieces: readonly Piece[],
  rules: DowntimeRules,
  openStart: Millis | undefined,
): DerivedRecord[] {
  const intervals = new Map<Millis, Piece[]>();
  for (const piece of pieces) {
    const list = intervals.get(piece.intervalStart);
    if (list) list.push(piece);
    else intervals.set(piece.intervalStart, [piece]);
  }
  const records: DerivedRecord[] = [];
  for (const [start, parts] of intervals) {
    const first = parts[0];
    const last = parts.at(-1);
    if (!first || !last) continue;
    if (rules.unplanned?.(first.state, first.cause) === true) continue;
    const loss = availabilityLoss(first.state, last.to - start, rules.microStopThresholdMs);
    if (!loss) continue;
    const reason = rules.classify(first.state, first.cause);
    const open = start === openStart;
    let group: Piece[] = [];
    const flush = (): void => {
      const head = group[0];
      const tail = group.at(-1);
      if (!head || !tail || head.shiftKey === NO_SHIFT) return;
      const ending = open && tail === last;
      records.push({
        from: head.from,
        to: ending ? null : tail.to,
        intervalStart: start,
        shiftKey: head.shiftKey,
        state: head.state,
        cause: head.cause,
        loss,
        reason,
        provisional: ending || group.some((piece) => piece.provisional),
      });
    };
    for (const piece of parts) {
      if (group[0] && group[0].shiftKey !== piece.shiftKey) {
        flush();
        group = [];
      }
      group.push(piece);
    }
    flush();
  }
  return records;
}
