/**
 * Lots and operator per cycle (Phase 8 plan "Device facts for traceability", ADR-0033): one fold
 * over the device event stream, used by the simulator's machine server and by the MES's golden
 * harness, so the two can't attach them differently.
 *
 * - The `material-consumed` events of a part on a machine come before that part's
 *   `cycle-complete` there, and attach to that cycle, in consumption order. Material taken for a
 *   cycle that never completes in the stream is reported by no cycle.
 * - The operator of a cycle is the station's operator at the cycle's start, which is the instant
 *   of the part's first `material-consumed` on that machine (the latest `operator` event of the
 *   machine before it). A machine that never had an `operator` event has none (`null`), and so
 *   does a cycle that consumed nothing (no start is known).
 */

export interface LotRef {
  readonly material: string;
  readonly lot: string;
}

export interface Attachment {
  readonly lots: readonly LotRef[];
  readonly operator: string | null;
}

/**
 * The fields the fold reads; any other event passes through. The simulator's `PlantEvent` union
 * is assignable to it.
 */
export interface ConsumptionEvent {
  readonly type: string;
  readonly machineId?: string;
  readonly partId?: number;
  readonly material?: string;
  readonly lotId?: string;
  readonly operatorId?: string | null;
}

interface Pending {
  readonly lots: LotRef[];
  readonly operator: string | null;
}

const partKey = (machineId: string, partId: number): string =>
  `${machineId}\u0000${String(partId)}`;

/** The fold, one event at a time (the machine server's live path). */
export class ConsumptionTracker {
  readonly #operator = new Map<string, string | null>();
  readonly #pending = new Map<string, Pending>();

  /** Records an event; for a `cycle-complete`, returns what attaches to it. */
  record(event: ConsumptionEvent): Attachment | null {
    const { machineId, partId } = event;
    switch (event.type) {
      case 'operator':
        if (machineId !== undefined) this.#operator.set(machineId, event.operatorId ?? null);
        return null;
      case 'material-consumed': {
        if (machineId === undefined || partId === undefined) return null;
        const { material, lotId } = event;
        if (material === undefined || lotId === undefined) {
          throw new RangeError(`material-consumed of part ${String(partId)} without a lot`);
        }
        const key = partKey(machineId, partId);
        let pending = this.#pending.get(key);
        if (!pending) {
          pending = { lots: [], operator: this.#operator.get(machineId) ?? null };
          this.#pending.set(key, pending);
        }
        pending.lots.push({ material, lot: lotId });
        return null;
      }
      case 'cycle-complete': {
        if (machineId === undefined || partId === undefined) return null;
        const key = partKey(machineId, partId);
        const pending = this.#pending.get(key);
        this.#pending.delete(key);
        return pending
          ? { lots: [...pending.lots], operator: pending.operator }
          : { lots: [], operator: null };
      }
      default:
        return null;
    }
  }
}

/**
 * The fold over a whole stream: for each event, what attaches to it if it is a `cycle-complete`,
 * else `null` (the array is aligned with `events`).
 */
export function attachConsumption(events: readonly ConsumptionEvent[]): (Attachment | null)[] {
  const tracker = new ConsumptionTracker();
  return events.map((event) => tracker.record(event));
}
