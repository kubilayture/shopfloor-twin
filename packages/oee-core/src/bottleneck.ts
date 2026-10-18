/**
 * The designed bottleneck per product (ADR-0036, Phase 9 plan): the operation with the largest
 * effective cycle, its ideal cycle divided by the number of machines that run it, ties by routing
 * order. Derived from the routing (`products.yaml`) and the equipment (`plant.yaml`), so no
 * configuration key names it and neither configuration hash changes.
 */
import { compare, fraction, type Fraction } from './fraction.ts';
import type { Millis } from './intervals.ts';

export interface RoutingInput {
  /** The routing in order (`products.yaml` `operations`): ties go to the earlier operation. */
  readonly operations: readonly string[];
  /** Every machine and the operation it runs (`plant.yaml`). */
  readonly equipment: readonly { readonly id: string; readonly operation: string }[];
  /** Ideal cycle time in integer ms per product and operation. */
  readonly idealCycleMs: Readonly<Record<string, Readonly<Record<string, Millis>>>>;
}

export interface Bottleneck {
  readonly product: string;
  readonly operation: string;
  /** The machines of the operation, in configuration order. */
  readonly equipment: readonly string[];
  readonly idealCycleMs: Millis;
  /** Ideal cycle ÷ machines: the ms of line time one good unit is worth at the bottleneck. */
  readonly effectiveCycleMs: Fraction;
}

function positive(value: Millis, what: string): bigint {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${what} must be a positive integer, got ${String(value)}`);
  }
  return BigInt(value);
}

/**
 * The bottleneck of each product, keyed by product in the order of `idealCycleMs`. Throws when an
 * operation of the routing has no machine or a product has no ideal cycle time for it. The designed
 * bottleneck holds whatever the plant is doing: when only one of two parallel machines has work,
 * that shows as a lower line OEE, not as another bottleneck.
 */
export function deriveBottlenecks(routing: RoutingInput): Record<string, Bottleneck> {
  if (routing.operations.length === 0) {
    throw new RangeError('the routing has no operations');
  }
  const machines = new Map<string, string[]>(routing.operations.map((op) => [op, []]));
  for (const item of routing.equipment) {
    machines.get(item.operation)?.push(item.id);
  }
  for (const [operation, ids] of machines) {
    if (ids.length === 0) {
      throw new RangeError(`no machine runs ${operation}`);
    }
  }
  const result: Record<string, Bottleneck> = {};
  for (const [product, cycles] of Object.entries(routing.idealCycleMs)) {
    let best: Bottleneck | undefined;
    for (const operation of routing.operations) {
      const ideal = cycles[operation];
      if (ideal === undefined) {
        throw new RangeError(`no ideal cycle time for ${product} at ${operation}`);
      }
      const equipment = machines.get(operation) ?? [];
      const effectiveCycleMs = fraction(
        positive(ideal, `ideal cycle time of ${product} at ${operation}`),
        BigInt(equipment.length),
      );
      // Strictly larger only: a tie keeps the earlier operation of the routing.
      if (best === undefined || compare(effectiveCycleMs, best.effectiveCycleMs) > 0) {
        best = { product, operation, equipment, idealCycleMs: ideal, effectiveCycleMs };
      }
    }
    if (best !== undefined) result[product] = best;
  }
  return result;
}
